// Compiler listings: the .LS file of every compile, and the .LE error listing of a failed one.
// A listing prints each source line after its line number and object location; a message
// follows the line it is about, under a line of carets that marks the columns:
//
//      26           LOCAL FMSG1  :LOGICAL AT FL(1)
//                         ^
//    **WARNING **  Defined But Not Referenced
//
// An error listing compiled with -NL holds only the lines with messages, and older compilers
// print no line numbers there at all, so a message also keeps the text of its line, and is placed
// in the current source by that text.

import { lookupMessage, CompilerMessage } from './messages';
import { Severity } from './types';

/** A source line as the listing prints it. */
export interface ListedLine {
  /** Zero-based line in the listing file. */
  listingLine: number;
  /** The whole listing line, to measure caret columns against. */
  raw: string;
  /** The source line number, when the listing prints one. */
  number?: number;
  /** The source text: after the number columns, or the whole line when there are none. */
  text: string;
}

export interface ListingMessage {
  /** ERROR, WARNING, NOTE, ... as the listing prints it. */
  kind: string;
  text: string;
  severity: Severity;
  /** Zero-based line of the message in the listing file. */
  listingLine: number;
  /** The source line the message is about. */
  context?: ListedLine;
  /** Column of the caret in the listing line, when there is one. */
  caret?: number;
  catalog?: CompilerMessage;
}

export interface Listing {
  /** Numbered source lines, in order. */
  source: ListedLine[];
  messages: ListingMessage[];
  /** From "No errors detected" or "Number of errors detected: N". */
  errorCount?: number;
  /** File name of the main source, from "The following source file(s) were referenced". */
  mainSource?: string;
}

const NUMBERED = /^( {0,5}\d{1,6})( {0,5}\d{1,6}| {6}) {2}(.*)$/;
const CARETS = /^\s+\^[\s^]*$/;
const MESSAGE = /^\s*\*\*\s*([A-Z]+)\s*\*\*\s*(.*?)\s*$/;
const HEADER = /^\s*(CL V\d|Line\s+Loc\b|\f)/;

function severityOf(kind: string, catalog: CompilerMessage | undefined): Severity {
  switch (kind) {
    case 'ERROR':
    case 'SEVERE':
    case 'FATAL':
      return Severity.Error;
    case 'WARNING':
      return Severity.Warning;
    case 'NOTE':
      return Severity.Information;
  }
  if (catalog?.severity === 'Warning') return Severity.Warning;
  if (catalog?.severity === 'Note') return Severity.Information;
  return Severity.Error;
}

export function parseListing(text: string): Listing {
  const lines = text.split(/\r?\n|\r/);
  const numbered = lines.some((l) => NUMBERED.test(l));
  const source: ListedLine[] = [];
  const messages: ListingMessage[] = [];
  let context: ListedLine | undefined;
  let carets: number[] = [];
  let errorCount: number | undefined;
  let mainSource: string | undefined;

  lines.forEach((raw, i) => {
    const msg = MESSAGE.exec(raw);
    if (msg && msg[2]) {
      const catalog = lookupMessage(msg[2]);
      messages.push({
        kind: msg[1],
        text: msg[2],
        severity: severityOf(msg[1], catalog),
        listingLine: i,
        context,
        caret: carets.shift(),
        catalog,
      });
      return;
    }
    if (CARETS.test(raw)) {
      carets = [...raw].flatMap((c, col) => (c === '^' ? [col] : []));
      return;
    }
    const count = /No errors detected/i.exec(raw) ? 0 : /errors detected\s*:?\s*(\d+)/i.exec(raw)?.[1];
    if (count !== undefined) {
      errorCount = Number(count);
      return;
    }
    const main = /^\s*(\S+)\s+\(Main Source File\)/i.exec(raw);
    if (main) {
      mainSource = main[1].split(/[>\\/]/).pop();
      return;
    }
    if (numbered) {
      const m = NUMBERED.exec(raw);
      const last = source[source.length - 1]?.number ?? 0;
      if (m && Number(m[1]) > last) {
        context = { listingLine: i, raw, number: Number(m[1]), text: m[3] };
        source.push(context);
        carets = [];
      }
    } else if (raw.trim() && !HEADER.test(raw)) {
      context = { listingLine: i, raw, text: raw };
      carets = [];
    }
  });
  return { source, messages, errorCount, mainSource };
}

export interface PlacedMessage {
  message: ListingMessage;
  line: number;
  start: number;
  end: number;
}

export interface Placement {
  placed: PlacedMessage[];
  /** Messages whose line is no longer in the source. */
  lost: ListingMessage[];
  /** The listed source differs from the current source: the file changed since that compile. */
  stale: boolean;
}

const indentOf = (s: string) => s.length - s.trimStart().length;
const WORD = /[A-Za-z0-9_$]|\P{ASCII}/u;

/** Range of the token at `col`, or of the whole line when there is no column. */
function span(line: string, col: number | undefined): { start: number; end: number } {
  if (col === undefined) return { start: indentOf(line), end: line.trimEnd().length };
  const start = Math.max(0, Math.min(col, line.length));
  let end = start;
  while (end < line.length && WORD.test(line[end])) end++;
  return { start, end: Math.max(end, Math.min(start + 1, line.length)) };
}

/** Place listing messages on the lines of the current source, following edits since the compile. */
export function placeMessages(listing: Listing, lines: string[]): Placement {
  const trimmed = lines.map((l) => l.trim());
  const stale = listing.source.some((s) => (lines[s.number! - 1] ?? '').trimEnd() !== s.text.trimEnd());
  const placed: PlacedMessage[] = [];
  const lost: ListingMessage[] = [];
  // Lines moved by edits since the compile move together, so search near the last one placed.
  let drift = 0;
  let previous = 0;

  for (const m of listing.messages) {
    const c = m.context;
    if (!c) {
      lost.push(m);
      continue;
    }
    const want = c.text.trim();
    let line: number | undefined;
    if (c.number !== undefined && trimmed[c.number - 1] === want) line = c.number - 1;
    else if (want) {
      const near = c.number !== undefined ? c.number - 1 + drift : previous;
      let best = Infinity;
      trimmed.forEach((t, i) => {
        if (t === want && Math.abs(i - near) < best) {
          best = Math.abs(i - near);
          line = i;
        }
      });
    }
    if (line === undefined) {
      lost.push(m);
      continue;
    }
    if (c.number !== undefined) drift = line - (c.number - 1);
    previous = line;
    // Caret column in the listed text, then in the current line, which may be indented differently.
    const listed = m.caret === undefined ? undefined : m.caret - (c.raw.length - c.text.length);
    const col = listed === undefined ? undefined : listed - indentOf(c.text) + indentOf(lines[line]);
    placed.push({ message: m, line, ...span(lines[line], col === undefined ? undefined : Math.max(col, 0)) });
  }
  return { placed, lost, stale };
}
