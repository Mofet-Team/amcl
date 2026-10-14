// Positions follow LSP conventions (zero-based line and UTF-16 character) so the server can pass
// them through unchanged, but this module has no dependency on the LSP libraries.

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export const enum Severity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface Diagnostic {
  range: Range;
  message: string;
  severity: Severity;
  code: string;
}

export function comparePositions(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}

export function rangeContains(range: Range, pos: Position): boolean {
  return comparePositions(range.start, pos) <= 0 && comparePositions(pos, range.end) <= 0;
}

export function spanRanges(first: Range, last: Range): Range {
  return { start: first.start, end: last.end };
}
