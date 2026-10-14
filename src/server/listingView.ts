import { Position, Range } from 'vscode-languageserver';
import { Analysis } from '../language/analyze';
import { ListedLine, Listing, placeMessages } from '../language/listing';
import { FileSummary, summarize } from '../language/summary';
import { Severity } from '../language/types';

/**
 * The CL source behind a listing, for hovers and navigation in the listing. A listing of a whole
 * compile (.LS) holds every source line, so its own source column is analyzed and positions map
 * between the two. An error listing (.LE) holds only the lines with errors, so the current source
 * file is analyzed instead and listing lines are matched to it by their text.
 */
export interface ListingView {
  /** The document CL features run on: the listing itself, or the source file. */
  uri: string;
  lines: string[];
  analysis: Analysis;
  summary: FileSummary;
  /** The listing holds the whole source: ranges in `uri` map back with `toListing`. */
  whole: boolean;
  /** A listing position to a position in `lines`. */
  toSource(pos: Position): Position | undefined;
  /** A range in `lines` to the listing, when the listing shows those lines. */
  toListing(range: Range): Range | undefined;
}

/** Columns before the source text: line number and object location. */
const prefix = (s: ListedLine) => s.raw.length - s.text.length;
const indentOf = (s: string) => s.length - s.trimStart().length;

/** The listing numbers every source line from 1, as an .LS file does. */
export function isWhole(listing: Listing): boolean {
  return listing.source.length > 0 && listing.source.every((s, i) => s.number === i + 1);
}

/**
 * The listing's own source column. A listing cuts lines at its page width; where the source file
 * (`current`) has the same line in full, its text is analyzed instead.
 */
export function wholeView(uri: string, listing: Listing, analyze: (text: string) => Analysis, current?: string[]): ListingView {
  const src = listing.source;
  const lines = src.map((s, i) => {
    const listed = s.text.trimEnd();
    const full = current?.[i];
    return full && full.length > listed.length && full.startsWith(listed) ? full : s.text;
  });
  const byListingLine = new Map(src.map((s, i) => [s.listingLine, i]));
  const analysis = analyze(lines.join('\n'));
  const at = (line: number, character: number): Position | undefined =>
    src[line] ? { line: src[line].listingLine, character: character + prefix(src[line]) } : undefined;
  return {
    uri,
    lines,
    analysis,
    summary: summarize(analysis),
    whole: true,
    toSource(pos) {
      const i = byListingLine.get(pos.line);
      return i === undefined ? undefined : { line: i, character: Math.max(0, pos.character - prefix(src[i])) };
    },
    toListing(r) {
      const start = at(r.start.line, r.start.character);
      const end = at(r.end.line, r.end.character);
      return start && end ? { start, end } : undefined;
    },
  };
}

export function sourceView(listing: Listing, uri: string, lines: string[], analyze: (text: string) => Analysis): ListingView {
  // Place each listed line in the current source, as messages are placed.
  const probes = listing.source.map((context) => ({ kind: '', text: '', severity: Severity.Error, listingLine: context.listingLine, context }));
  const placed = placeMessages({ source: listing.source, messages: probes }, lines).placed;
  // Column shift from the listing to the source line, which may be indented differently.
  const toSource = new Map<number, { line: number; shift: number }>();
  const toListing = new Map<number, { line: number; shift: number }>();
  for (const p of placed) {
    const s = p.message.context!;
    const shift = indentOf(lines[p.line]) - prefix(s) - indentOf(s.text);
    toSource.set(s.listingLine, { line: p.line, shift });
    toListing.set(p.line, { line: s.listingLine, shift: -shift });
  }
  const analysis = analyze(lines.join('\n'));
  const at = (line: number, character: number): Position | undefined => {
    const m = toListing.get(line);
    return m ? { line: m.line, character: Math.max(0, character + m.shift) } : undefined;
  };
  return {
    uri,
    lines,
    analysis,
    summary: summarize(analysis),
    whole: false,
    toSource(pos) {
      const m = toSource.get(pos.line);
      return m ? { line: m.line, character: Math.max(0, pos.character + m.shift) } : undefined;
    },
    toListing(r) {
      const start = at(r.start.line, r.start.character);
      const end = at(r.end.line, r.end.character);
      return start && end ? { start, end } : undefined;
    },
  };
}
