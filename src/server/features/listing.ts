import { Diagnostic, DiagnosticSeverity, DocumentSymbol, Hover, MarkupKind, Position, SymbolKind } from 'vscode-languageserver';
import { ListedLine, Listing, ListingMessage } from '../../language/listing';
import { describeSource } from '../../language/messages';
import { Severity } from '../../language/types';
import { escapeMarkdown } from '../../shared/markdown';

export const COMPILER_SOURCE = 'CL compiler';

/**
 * How a compiler message shows in the editor. Notes are hints: kept out of the Problems panel,
 * since "All enabled abnormal handlers are disabled" follows nearly every PHASE heading.
 */
export function compilerSeverity(m: ListingMessage): DiagnosticSeverity {
  return m.severity === Severity.Information ? DiagnosticSeverity.Hint : (m.severity as DiagnosticSeverity);
}

export function compilerCode(m: ListingMessage): string {
  return m.severity === Severity.Error ? 'compiler-error' : m.severity === Severity.Warning ? 'compiler-warning' : 'compiler-note';
}

/** Where a message points in the listing itself: the caret, else its source line, else itself. */
function listingRange(m: ListingMessage) {
  const c = m.context;
  if (!c) return { start: { line: m.listingLine, character: 0 }, end: { line: m.listingLine, character: 0 } };
  if (m.caret === undefined) {
    const start = c.raw.length - c.text.trimStart().length;
    return { start: { line: c.listingLine, character: start }, end: { line: c.listingLine, character: c.raw.trimEnd().length } };
  }
  let end = m.caret;
  while (end < c.raw.length && /[A-Za-z0-9_$]|\P{ASCII}/u.test(c.raw[end])) end++;
  return { start: { line: c.listingLine, character: m.caret }, end: { line: c.listingLine, character: Math.max(end, m.caret + 1) } };
}

/** The listing's own messages, as diagnostics on the listing file. */
export function listingDiagnostics(listing: Listing, disabled: Set<string>): Diagnostic[] {
  return listing.messages
    .filter((m) => !disabled.has(compilerCode(m)))
    .map((m) => ({
      range: listingRange(m),
      message: m.text,
      severity: compilerSeverity(m),
      code: compilerCode(m),
      source: COMPILER_SOURCE,
    }));
}

const GROUPS: [Severity, string][] = [
  [Severity.Error, 'Errors'],
  [Severity.Warning, 'Warnings'],
  [Severity.Information, 'Notes'],
];

/** Outline of a listing: its messages, grouped by severity, each named with its source line. */
export function listingSymbols(listing: Listing): DocumentSymbol[] {
  const out: DocumentSymbol[] = [];
  for (const [severity, name] of GROUPS) {
    const ms = listing.messages.filter((m) => m.severity === severity);
    if (!ms.length) continue;
    const children = ms.map((m): DocumentSymbol => {
      const range = { start: { line: m.context?.listingLine ?? m.listingLine, character: 0 }, end: { line: m.listingLine, character: 0 } };
      return {
        name: m.text,
        detail: m.context?.number !== undefined ? `line ${m.context.number}` : undefined,
        kind: severity === Severity.Error ? SymbolKind.Event : SymbolKind.Key,
        range,
        selectionRange: listingRange(m),
      };
    });
    const range = { start: children[0].range.start, end: children[children.length - 1].range.end };
    out.push({ name: `${name} (${ms.length})`, kind: SymbolKind.Namespace, range, selectionRange: range, children });
  }
  return out;
}

/** The source line a listing line shows or reports on, for going to the source. */
export function listedLineAt(listing: Listing, line: number): { listed: ListedLine; caret?: number } | undefined {
  const message = listing.messages.find((m) => m.listingLine === line || (m.context?.listingLine === line && m.caret !== undefined));
  if (message?.context) return { listed: message.context, caret: message.listingLine === line ? message.caret : undefined };
  const listed = listing.source.find((s) => s.listingLine === line);
  return listed ? { listed } : undefined;
}

/** Hover on a message line: what the compiler pass and severity mean. */
export function listingHover(listing: Listing, position: Position): Hover | undefined {
  const m = listing.messages.find((x) => x.listingLine === position.line);
  if (!m) return undefined;
  const lines = [`**${escapeMarkdown(m.text)}**`];
  if (m.catalog) {
    lines.push('', `${m.catalog.severity}, reported by ${describeSource(m.catalog.source)}.`);
    if (m.catalog.severity === 'Fatal') lines.push('', 'The compiler stopped here: later errors may be hidden.');
    if (m.catalog.source.startsWith('P1')) lines.push('', 'Syntax errors can hide type errors: compile again after fixing them.');
  }
  if (m.context?.number !== undefined) lines.push('', `Source line ${m.context.number}. Go to Definition opens it in the source.`);
  return { contents: { kind: MarkupKind.Markdown, value: lines.join('\n') } };
}
