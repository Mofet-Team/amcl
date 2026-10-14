import {
  createConnection,
  DocumentSymbol,
  FoldingRange,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  InitializeParams,
  InitializeResult,
  Location,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze, Analysis } from '../language/analyze';
import { orientDescriptors, parseEb, PointRecord } from '../language/eb';
import { COMPILER_COLUMNS, lint, LintDiagnostic, LintEnvironment, longLines, unusedSymbols } from '../language/lint';
import { NetworkConfig, parseNcf } from '../language/ncf';
import { FileSummary, summarize } from '../language/summary';
import { WorkspaceIndex } from '../language/workspace';
import { crossDefinition, crossReferences, targetAt, workspaceSymbols } from './features/crossfile';
import { complete } from './features/completion';
import { foldingRanges } from './features/folding';
import { listedLineAt, listingDiagnostics, listingHover, listingSymbols } from './features/listing';
import { signatureHelp } from './features/signature';
import { hover } from './features/hover';
import { definition, documentHighlights, references } from './features/navigation';
import { documentSymbols } from './features/outline';
import { decoderFor, findFiles, pathToUri, readText, resolvePaths, uriToPath } from './loader';
import { compilerDiagnostics, LISTING_FILE, ListingStore } from './listings';
import { isWhole, ListingView, sourceView, wholeView } from './listingView';
import { Listing, parseListing, placeMessages } from '../language/listing';
import { Severity } from '../language/types';
import { FormatOptions, formatCl, learnColumns, readFormatRules } from '../language/format';

/** Settings under `amcl.*`, plus the encoding VS Code uses for CL files. */
interface Settings {
  encoding?: string;
  pointDatabase?: string[];
  /** `auto` converts Hebrew descriptors from the TPS's visual order; `asStored` shows them as is. */
  hebrewDescriptors?: 'auto' | 'asStored';
  /** Diagnostic codes not to report. */
  disabledDiagnostics?: string[];
  /** Network configuration files (NCF.XX), or folders holding them, to name LCNs. */
  networkConfig?: string[];
  /** Characters per line past which code is reported; the compiler reads 132. */
  lineLength?: number;
}

const CL_FILE = /\.cl$/i;
const EB_FILE = /\.eb$/i;
const NCF_FILE = /(^|[\\/])NCF[^\\/]*\.(XX|WF)$/i;

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const index = new WorkspaceIndex();
const cache = new Map<string, { version: number; analysis: Analysis; summary: FileSummary }>();

let settings: Settings = {};
let workspaceRoots: string[] = [];
let decoder = decoderFor(undefined);
const listings = new ListingStore((bytes) => decoder.decode(bytes));
const listingCache = new Map<string, { version: number; listing: Listing }>();

function analyzeText(uri: string, text: string): Analysis {
  try {
    return analyze(text);
  } catch (err) {
    // A parser bug must not take the server down; log it and serve an empty result.
    connection.console.error(`amcl: analysis failed for ${uri}: ${(err as Error).stack ?? err}`);
    return analyze('');
  }
}

function analysisOf(doc: TextDocument): { analysis: Analysis; summary: FileSummary } {
  const hit = cache.get(doc.uri);
  if (hit && hit.version === doc.version) return hit;
  const analysis = analyzeText(doc.uri, doc.getText());
  const summary = summarize(analysis);
  const entry = { version: doc.version, analysis, summary };
  cache.set(doc.uri, entry);
  index.setFile(doc.uri, summary);
  return entry;
}

function withDoc<T>(uri: string, fallback: T, f: (doc: TextDocument, a: Analysis, s: FileSummary) => T): T {
  const doc = documents.get(uri);
  if (!doc || isListing(doc)) return fallback;
  const { analysis, summary } = analysisOf(doc);
  return f(doc, analysis, summary);
}

const isListing = (doc: TextDocument) => doc.languageId === 'cl-listing';

function listingOf(doc: TextDocument): Listing {
  const hit = listingCache.get(doc.uri);
  if (hit && hit.version === doc.version) return hit.listing;
  const listing = parseListing(doc.getText());
  listingCache.set(doc.uri, { version: doc.version, listing });
  return listing;
}

const viewCache = new Map<string, { version: number; sourceText?: string; view: ListingView }>();

/** The CL source behind an open listing, for hovers and navigation in it. */
function viewOf(doc: TextDocument): ListingView | undefined {
  const listing = listingOf(doc);
  const hit = viewCache.get(doc.uri);
  if (isWhole(listing) && hit && hit.version === doc.version) return hit.view;
  const p = uriToPath(doc.uri);
  const source = p && listings.sourceOf(p);
  const lines = source ? linesOf(source) : undefined;
  if (isWhole(listing)) {
    const view = wholeView(doc.uri, listing, (t) => analyzeText(doc.uri, t), lines);
    viewCache.set(doc.uri, { version: doc.version, view });
    return view;
  }
  // An error listing with only some lines: work on the source file beside it.
  if (!source || !lines) return undefined;
  const text = lines.join('\n');
  if (hit && hit.version === doc.version && hit.sourceText === text) return hit.view;
  const view = sourceView(listing, pathToUri(source), lines, (t) => analyzeText(source, t));
  viewCache.set(doc.uri, { version: doc.version, sourceText: text, view });
  return view;
}

/** Locations found in a listing's view, moved back into the listing when they are in it. */
function fromView(doc: TextDocument, view: ListingView, locations: Location[]): Location[] {
  if (!view.whole) return locations;
  return locations.flatMap((l) => {
    if (l.uri !== view.uri) return [l];
    const range = view.toListing(l.range);
    return range ? [{ uri: doc.uri, range }] : [];
  });
}

function symbolsFromView(view: ListingView, symbols: DocumentSymbol[]): DocumentSymbol[] {
  return symbols.flatMap((s) => {
    const range = view.toListing(s.range);
    const selectionRange = view.toListing(s.selectionRange);
    if (!range || !selectionRange) return [];
    return [{ ...s, range, selectionRange, children: s.children && symbolsFromView(view, s.children) }];
  });
}

/** The lines of a file: the open document's, else the saved file's. */
function linesOf(p: string): string[] | undefined {
  const doc = documents.get(pathToUri(p));
  if (doc) return doc.getText().split(/\r?\n|\r/);
  try {
    return decoder.decode(fs.readFileSync(p)).split(/\r?\n|\r/);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ indexing

async function indexFile(p: string): Promise<void> {
  const uri = pathToUri(p);
  if (documents.get(uri)) return; // the open document is the source of truth
  const text = await readText(p, decoder);
  if (text === undefined) index.deleteFile(uri);
  else index.setFile(uri, summarize(analyzeText(uri, text)));
}

async function loadPointDatabase(): Promise<void> {
  const roots = [...workspaceRoots, ...resolvePaths(settings.pointDatabase ?? [], workspaceRoots)];
  const files = await findFiles(roots, EB_FILE);
  const records: PointRecord[] = [];
  for (const f of files) {
    const text = await readText(f, decoder);
    if (text) records.push(...parseEb(text, f));
  }
  if (settings.hebrewDescriptors !== 'asStored') orientDescriptors(records);
  index.setPoints(records, pathToUri);
  const networks: NetworkConfig[] = [];
  for (const f of await findFiles(resolvePaths(settings.networkConfig ?? [], workspaceRoots), NCF_FILE)) {
    // The file holds binary fields; its text parts are ASCII.
    const text = await fs.promises.readFile(f, 'latin1').catch(() => undefined);
    const ncf = text && parseNcf(text, f);
    if (ncf) networks.push(ncf);
  }
  index.setNetworks(networks);
  connection.console.info(`amcl: point database: ${index.pointCount} points from ${files.length} .EB files`);
  warnIfMissing('amcl.pointDatabase', settings.pointDatabase, files.length > 0);
  warnIfMissing('amcl.networkConfig', settings.networkConfig, networks.length > 0);
}

/** A setting that names folders, none of which hold anything here: often a path from another machine. */
function warnIfMissing(name: string, entries: string[] | undefined, found: boolean): void {
  if (found || !entries?.length) return;
  const message = `${name}: nothing found in ${entries.join(', ')}. Add the folder as it is on this machine; entries that do not exist are skipped.`;
  connection.console.warn(`amcl: ${message}`);
  void connection.window.showWarningMessage(message);
}

async function indexWorkspace(): Promise<void> {
  const progress = await connection.window.createWorkDoneProgress();
  progress.begin('Indexing CL files', 0, undefined, false);
  try {
    await loadPointDatabase();
    const files = await findFiles(workspaceRoots, CL_FILE);
    for (let i = 0; i < files.length; i++) {
      await indexFile(files[i]);
      if (i % 50 === 0) {
        progress.report(Math.round((i / files.length) * 100), `${i} / ${files.length}`);
        // Let requests from the editor through while indexing a large workspace.
        await new Promise((r) => setImmediate(r));
      }
    }
    connection.console.info(`amcl: indexed ${index.fileCount} CL files`);
    listings.clear();
    for (const p of await findFiles(workspaceRoots, /\.le$/i)) {
      const source = listings.sourceOf(p);
      if (source) publishClosed(source);
    }
  } finally {
    progress.done();
  }
}

// ------------------------------------------------------------------ lifecycle

connection.onInitialize((params: InitializeParams): InitializeResult => {
  workspaceRoots = (params.workspaceFolders ?? [])
    .map((f) => uriToPath(f.uri))
    .filter((p): p is string => !!p);
  settings = (params.initializationOptions as Settings | undefined) ?? {};
  decoder = decoderFor(settings.encoding);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: { label: 'CL' },
      workspaceSymbolProvider: true,
      foldingRangeProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      hoverProvider: true,
      completionProvider: { triggerCharacters: ['.'] },
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [';'] },
    },
    serverInfo: { name: 'amcl' },
  };
});

connection.onInitialized(() => {
  void connection.client.register(DidChangeWatchedFilesNotification.type, {
    watchers: [{ globPattern: '**/*.{CL,cl,Cl,cL,EB,eb,Eb,eB,LS,ls,Ls,lS,LE,le,Le,lE}' }],
  });
  // Database-dependent checks of documents opened during indexing need the finished index.
  void indexWorkspace().then(republishAll);
});

connection.onNotification('amcl/settings', (next: Settings) => {
  const reloadAll = next.encoding !== settings.encoding;
  const reloadDb =
    reloadAll ||
    next.hebrewDescriptors !== settings.hebrewDescriptors ||
    JSON.stringify(next.networkConfig ?? []) !== JSON.stringify(settings.networkConfig ?? []) ||
    JSON.stringify(next.pointDatabase ?? []) !== JSON.stringify(settings.pointDatabase ?? []);
  settings = next;
  decoder = decoderFor(settings.encoding);
  if (reloadAll) void indexWorkspace().then(republishAll);
  else if (reloadDb) void loadPointDatabase().then(republishAll);
  else republishAll();
});

let ebReload: NodeJS.Timeout | undefined;
connection.onDidChangeWatchedFiles(({ changes }) => {
  for (const c of changes) {
    const p = uriToPath(c.uri);
    if (!p) continue;
    if (EB_FILE.test(p)) {
      clearTimeout(ebReload);
      ebReload = setTimeout(() => void loadPointDatabase().then(republishAll), 500);
    } else if (CL_FILE.test(p)) {
      if (c.type === FileChangeType.Deleted) index.deleteFile(c.uri);
      else void indexFile(p);
      publishClosed(p);
    } else if (LISTING_FILE.test(p)) {
      listings.invalidate(p);
      const source = listings.sourceOf(p);
      const doc = source && documents.get(pathToUri(source));
      if (doc) publishDiagnostics(doc);
      else if (source) publishClosed(source);
    }
  }
});

// ------------------------------------------------------------------ diagnostics

const pending = new Map<string, NodeJS.Timeout>();

const lintEnvironment: LintEnvironment = {
  point: (name) => index.point(name),
  boxOfProgram: (bound) => index.boxOfProgram(bound),
  boxOfPoint: (p) => index.boxOfPoint(p),
};

function publishDiagnostics(doc: TextDocument): void {
  const disabled = new Set(settings.disabledDiagnostics ?? []);
  if (isListing(doc)) {
    void connection.sendDiagnostics({ uri: doc.uri, version: doc.version, diagnostics: listingDiagnostics(listingOf(doc), disabled) });
    return;
  }
  const { analysis } = analysisOf(doc);
  const found: LintDiagnostic[] = [
    ...analysis.diagnostics,
    ...lint(analysis.file, analysis.binding, lintEnvironment),
    ...longLines(doc.getText().split(/\r?\n|\r/), settings.lineLength || COMPILER_COLUMNS),
  ];
  const p = uriToPath(doc.uri);
  const compiler = p
    ? compilerDiagnostics(listings.companions(p), doc.getText().split(/\r?\n|\r/), found, disabled, pathToUri)
    : [];
  const diagnostics: Diagnostic[] = found
    .filter((d) => !disabled.has(d.code))
    .map((d) => ({
      range: d.range,
      message: d.message,
      severity: d.severity as DiagnosticSeverity,
      code: d.code,
      source: 'cl',
      tags: d.tags as DiagnosticTag[] | undefined,
    }));
  closedPublished.delete(doc.uri);
  void connection.sendDiagnostics({ uri: doc.uri, version: doc.version, diagnostics: [...diagnostics, ...compiler] });
}

/** Closed sources with errors from their error listing, published so the Problems panel lists every failed compile. */
const closedPublished = new Set<string>();

function publishClosed(clPath: string): void {
  const uri = pathToUri(clPath);
  if (documents.get(uri)) return;
  const disabled = new Set(settings.disabledDiagnostics ?? []);
  const errorListings = listings.companions(clPath).filter((f) => f.kind === 'LE');
  const lines = errorListings.length ? linesOf(clPath) : undefined;
  const diagnostics = lines ? compilerDiagnostics(errorListings, lines, [], disabled, pathToUri) : [];
  if (diagnostics.length) closedPublished.add(uri);
  else if (!closedPublished.delete(uri)) return;
  void connection.sendDiagnostics({ uri, diagnostics });
}

/** Re-check open documents when something they depend on changes (settings, the index). */
function republishAll(): void {
  for (const doc of documents.all()) publishDiagnostics(doc);
  for (const uri of [...closedPublished]) {
    const p = uriToPath(uri);
    if (p) publishClosed(p);
  }
}

documents.onDidChangeContent(({ document }) => {
  clearTimeout(pending.get(document.uri));
  pending.set(document.uri, setTimeout(() => {
    pending.delete(document.uri);
    const current = documents.get(document.uri);
    if (current) publishDiagnostics(current);
  }, 200));
});

documents.onDidClose(({ document }) => {
  clearTimeout(pending.get(document.uri));
  pending.delete(document.uri);
  cache.delete(document.uri);
  listingCache.delete(document.uri);
  viewCache.delete(document.uri);
  void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  if (isListing(document)) return;
  // Fall back to the saved file, which may differ from the discarded edits.
  const p = uriToPath(document.uri);
  if (p) {
    void indexFile(p);
    publishClosed(p);
  } else index.deleteFile(document.uri);
});

// ------------------------------------------------------------------ requests

connection.onDocumentSymbol(({ textDocument }) => {
  const doc = documents.get(textDocument.uri);
  if (doc && isListing(doc)) {
    const view = viewOf(doc);
    const messages = listingSymbols(listingOf(doc));
    if (!view?.whole) return messages;
    const a = view.analysis;
    return [...symbolsFromView(view, documentSymbols(a.binding.symbols, a.file.units, unusedSymbols(a.binding))), ...messages];
  }
  return withDoc(textDocument.uri, [], (_, a) => documentSymbols(a.binding.symbols, a.file.units, unusedSymbols(a.binding)));
});

/** From a line of a listing to that line in the current source. */
function listingDefinition(doc: TextDocument, line: number): Location | undefined {
  const listing = listingOf(doc);
  const at = listedLineAt(listing, line);
  const p = uriToPath(doc.uri);
  const source = at && p && listings.sourceOf(p);
  const lines = source && linesOf(source);
  if (!at || !source || !lines) return undefined;
  const probe = { kind: '', text: '', severity: Severity.Error, listingLine: line, context: at.listed, caret: at.caret };
  const placed = placeMessages({ source: [], messages: [probe] }, lines).placed[0];
  if (!placed) return undefined;
  const range = at.caret === undefined
    ? { start: { line: placed.line, character: placed.start }, end: { line: placed.line, character: placed.start } }
    : { start: { line: placed.line, character: placed.start }, end: { line: placed.line, character: placed.end } };
  return { uri: pathToUri(source), range };
}

connection.onWorkspaceSymbol(({ query }) => workspaceSymbols(index, query));

connection.onFoldingRanges(({ textDocument }) => {
  const doc = documents.get(textDocument.uri);
  if (doc && isListing(doc)) {
    const view = viewOf(doc);
    if (!view?.whole) return [];
    return foldingRanges(view.analysis.file).flatMap((f): FoldingRange[] => {
      const start = view.toListing({ start: { line: f.startLine, character: 0 }, end: { line: f.startLine, character: 0 } });
      const end = view.toListing({ start: { line: f.endLine, character: 0 }, end: { line: f.endLine, character: 0 } });
      return start && end ? [{ ...f, startLine: start.start.line, endLine: end.start.line }] : [];
    });
  }
  return withDoc(textDocument.uri, [], (_, a) => foldingRanges(a.file));
});

connection.onDefinition(({ textDocument, position }) => {
  const doc = documents.get(textDocument.uri);
  if (doc && isListing(doc)) {
    // On a message line: its source line. On a name: its definition. Elsewhere: the source line.
    const onMessage = listingOf(doc).messages.some((m) => m.listingLine === position.line);
    const view = onMessage ? undefined : viewOf(doc);
    const at = view?.toSource(position);
    if (view && at) {
      // The listing's own definition first: the same LOCAL is also in the source file.
      const local = definition(view.analysis.binding, view.uri, at);
      const found = fromView(doc, view, local ? [local] : crossDefinition(targetAt(view.analysis, view.summary, index, at), index, view.analysis, at));
      if (found.length) return found;
    }
    return listingDefinition(doc, position.line);
  }
  return withDoc<Location | Location[] | undefined>(textDocument.uri, undefined, (doc, a, s) => {
    const cross = crossDefinition(targetAt(a, s, index, position), index, a, position);
    return cross.length ? cross : definition(a.binding, doc.uri, position);
  });
});

connection.onReferences(({ textDocument, position, context }) => {
  const listingDoc = documents.get(textDocument.uri);
  if (listingDoc && isListing(listingDoc)) {
    const view = viewOf(listingDoc);
    const at = view?.toSource(position);
    if (!view || !at) return [];
    const target = targetAt(view.analysis, view.summary, index, at);
    const found = target
      ? crossReferences(target, index, context.includeDeclaration)
      : references(view.analysis.binding, view.uri, at, context.includeDeclaration);
    return fromView(listingDoc, view, found);
  }
  return withDoc(textDocument.uri, [], (doc, a, s) => {
    const target = targetAt(a, s, index, position);
    const cross = crossReferences(target, index, context.includeDeclaration);
    return target ? cross : references(a.binding, doc.uri, position, context.includeDeclaration);
  });
});

connection.onHover(({ textDocument, position }) => {
  const doc = documents.get(textDocument.uri);
  if (doc && isListing(doc)) {
    const message = listingHover(listingOf(doc), position);
    if (message) return message;
    const view = viewOf(doc);
    const at = view?.toSource(position);
    if (!view || !at) return null;
    const h = hover({ uri: view.uri, analysis: view.analysis, summary: view.summary, index, lines: view.lines, display }, at);
    if (!h) return null;
    const range = h.range && (view.whole ? view.toListing(h.range) : undefined);
    return { contents: h.contents, range };
  }
  return withDoc(textDocument.uri, null, (doc, analysis, summary) =>
    hover({ uri: doc.uri, analysis, summary, index, lines: doc.getText().split(/\r?\n|\r/), display }, position) ?? null,
  );
});

connection.onCompletion(({ textDocument, position }) =>
  withDoc(textDocument.uri, null, (doc, analysis) =>
    complete({ analysis, index, lines: doc.getText().split(/\r?\n|\r/) }, position),
  ),
);

connection.onSignatureHelp(({ textDocument, position }) =>
  withDoc(textDocument.uri, null, (doc, analysis) => signatureHelp(analysis, doc.getText().split(/\r?\n|\r/), position)),
);

/** A document URI relative to the workspace folder it is in. */
function display(uri: string): string {
  const p = uriToPath(uri);
  if (!p) return uri;
  const root = workspaceRoots.find((r) => p.startsWith(r + path.sep));
  // Outside the workspace (a point database elsewhere), the folder and file name are enough.
  return root ? path.relative(root, p) : path.join(path.basename(path.dirname(p)), path.basename(p));
}

connection.onDocumentHighlight(({ textDocument, position }) => {
  const doc = documents.get(textDocument.uri);
  if (doc && isListing(doc)) {
    const view = viewOf(doc);
    const at = view?.whole ? view.toSource(position) : undefined;
    if (!view || !at) return [];
    return documentHighlights(view.analysis.binding, at).flatMap((h) => {
      const range = view.toListing(h.range);
      return range ? [{ ...h, range }] : [];
    });
  }
  return withDoc(textDocument.uri, [], (_, a) => documentHighlights(a.binding, position));
});

// ------------------------------------------------------------------ formatting

/** The nearest .clformat.json above a file, if any. */
function formatRules(uri: string): FormatOptions {
  const p = uriToPath(uri);
  const defaults: FormatOptions = { maxLineLength: settings.lineLength || COMPILER_COLUMNS };
  if (!p) return defaults;
  for (let dir = path.dirname(p); ; dir = path.dirname(dir)) {
    const file = path.join(dir, '.clformat.json');
    if (fs.existsSync(file)) {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        void connection.window.showWarningMessage(`amcl: ${file} is not valid JSON, so it was not used: ${(err as Error).message}`);
        return defaults;
      }
      const { options, problems } = readFormatRules(raw);
      if (problems.length) void connection.window.showWarningMessage(`amcl: ${file}: ${problems.join('; ')}. Those rules were not used.`);
      return { ...defaults, ...options };
    }
    if (path.dirname(dir) === dir) return defaults;
  }
}

connection.onDocumentFormatting(({ textDocument }) => {
  const doc = documents.get(textDocument.uri);
  if (!doc || isListing(doc)) return [];
  return formatCl(doc.getText(), formatRules(doc.uri));
});

connection.onDocumentRangeFormatting(({ textDocument, range }) => {
  const doc = documents.get(textDocument.uri);
  if (!doc || isListing(doc)) return [];
  // A selection that ends at the start of a line does not include that line.
  const last = range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line;
  return formatCl(doc.getText(), formatRules(doc.uri), range.start.line, last);
});

/** The columns a file uses, for the client to write into a new .clformat.json. */
connection.onRequest('amcl/learnFormat', ({ uri }: { uri: string }) => {
  const doc = documents.get(uri);
  return doc ? learnColumns(doc.getText()) : {};
});

documents.listen(connection);
connection.listen();
