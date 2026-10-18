import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticRelatedInformation, DiagnosticSeverity } from 'vscode-languageserver';
import { LintDiagnostic } from '../language/lint';
import { Listing, parseListing, placeMessages } from '../language/listing';
import { Severity } from '../language/types';
import { COMPILER_SOURCE, compilerCode, compilerSeverity } from './features/listing';
import { isWhole } from './listingView';
import { CompiledSource } from '../shared/programs';

export const LISTING_FILE = /\.(ls|le)$/i;

export interface ListingFile {
  path: string;
  /** LS: the listing of a compile; LE: the error listing of a failed one. */
  kind: 'LS' | 'LE';
  mtime: number;
  listing: Listing;
}

/** Compiler warnings the extension reports itself, by its own diagnostic code. */
const TWINS: Record<string, string> = {
  'Defined but not referenced': 'unused',
  'Loop was never repeated': 'loop-never-repeated',
  'This LOCAL variable is mapped to a Serial Interface IOP parameter': 'serial-iop',
  'String exceeded maximum allowable length and was shortened to <value> characters': 'string-length',
};

const stemOf = (p: string) => path.basename(p).replace(/\.[^.]*$/, '').toUpperCase();

/** Siblings of `p` with the same name and an extension matching `ext`, in any letter case. */
function siblings(p: string, ext: RegExp): string[] {
  const dir = path.dirname(p);
  const stem = stemOf(p);
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => ext.test(n) && stemOf(n) === stem)
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

export class ListingStore {
  private cache = new Map<string, ListingFile>();

  constructor(private decode: (bytes: Buffer) => string) {}

  load(p: string): ListingFile | undefined {
    let mtime: number;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch {
      this.cache.delete(p);
      return undefined;
    }
    const hit = this.cache.get(p);
    if (hit && hit.mtime === mtime) return hit;
    let text: string;
    try {
      text = this.decode(fs.readFileSync(p));
    } catch {
      return undefined;
    }
    const file: ListingFile = { path: p, kind: /\.le$/i.test(p) ? 'LE' : 'LS', mtime, listing: parseListing(text) };
    this.cache.set(p, file);
    return file;
  }

  invalidate(p: string): void {
    this.cache.delete(p);
  }

  clear(): void {
    this.cache.clear();
  }

  /** The listings of a CL source that describe its latest compile. */
  companions(clPath: string): ListingFile[] {
    const files = siblings(clPath, LISTING_FILE).flatMap((p) => this.load(p) ?? []);
    const ls = files.find((f) => f.kind === 'LS');
    // An error listing from an earlier, failed compile is superseded by a clean one.
    return files.filter((f) => !(f.kind === 'LE' && ls?.listing.errorCount === 0 && ls.mtime >= f.mtime));
  }

  /** The CL source a listing belongs to. */
  sourceOf(listingPath: string): string | undefined {
    return siblings(listingPath, /\.cl$/i)[0];
  }
}

/**
 * Compiler messages from `files`, placed on the current lines of their source. Warnings the
 * extension already reports on the same line (`ours`) are left out.
 */
export function compilerDiagnostics(
  files: ListingFile[],
  lines: string[],
  ours: LintDiagnostic[],
  disabled: Set<string>,
  uriOf: (p: string) => string,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const reported = new Set(ours.map((d) => `${d.code}:${d.range.start.line}`));
  for (const file of files) {
    const { placed, lost, stale } = placeMessages(file.listing, lines);
    const uri = uriOf(file.path);
    const name = path.basename(file.path);
    const related = (listingLine: number, message: string): DiagnosticRelatedInformation => ({
      location: { uri, range: { start: { line: listingLine, character: 0 }, end: { line: listingLine, character: 0 } } },
      message,
    });
    for (const p of placed) {
      const m = p.message;
      const code = compilerCode(m);
      const twin = m.catalog && TWINS[m.catalog.text];
      if (disabled.has(code) || (twin && reported.has(`${twin}:${p.line}`))) continue;
      const key = `${p.line}:${p.start}:${m.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        range: { start: { line: p.line, character: p.start }, end: { line: p.line, character: p.end } },
        message: m.text,
        severity: compilerSeverity(m),
        code,
        source: stale ? `${COMPILER_SOURCE}, earlier compile` : COMPILER_SOURCE,
        relatedInformation: [related(m.listingLine, `${m.kind} in ${name}`)],
      });
    }
    if (lost.length && !disabled.has('compiler-stale')) {
      const errors = lost.some((m) => m.severity === Severity.Error);
      out.push({
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        message: `${lost.length} compiler message${lost.length === 1 ? ' is' : 's are'} on lines changed since the compile that wrote ${name}`,
        severity: errors ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
        code: 'compiler-stale',
        source: COMPILER_SOURCE,
        relatedInformation: lost.slice(0, 20).map((m) => related(m.listingLine, `${m.kind}: ${m.text}`)),
      });
    }
  }
  return out;
}

/**
 * The source of the last compile, from a listing beside the file: the whole .LS when there is one.
 * Lines the listing cut at its page width are taken from the current source where it starts the
 * same, so they do not show as changes.
 */
export function compiledSource(files: ListingFile[], current: string[] | undefined): CompiledSource | undefined {
  const pick = files.find((f) => f.kind === 'LS' && isWhole(f.listing)) ?? files.find((f) => f.kind === 'LS') ?? files.find((f) => f.kind === 'LE');
  if (!pick) return undefined;
  const base = { listing: path.basename(pick.path), kind: pick.kind, compiled: pick.listing.compiled };
  if (!isWhole(pick.listing)) return { ...base, whole: false, lines: [] };
  const listed = pick.listing.source.map((s) => s.text.trimEnd());
  const width = Math.max(0, ...listed.map((l) => l.length));
  const lines = listed.map((l, i) => {
    const now = current?.[i]?.trimEnd();
    return now !== undefined && l.length >= width - 1 && now.length > l.length && now.startsWith(l) ? now : l;
  });
  return { ...base, whole: true, lines };
}
