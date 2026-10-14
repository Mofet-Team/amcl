// Formatting that keeps each file in its owner's style. The column of each kind of line (unit
// headings, PHASE, STEP, declarations, statements, labels, END...) is learned from the file, or
// taken from a .clformat.json, and stray lines are moved to it; continuation lines move with
// their statement. Comments, strings, column-1 `&` and `%`, and alignment within a line are left
// alone. A result whose tokens differ from the original in any way is thrown away.

import { lex, LogicalLine, Token, TokenKind } from './lexer';
import { RESERVED } from './parser';
import { Range } from './types';

export const LINE_KINDS = ['unit', 'phase', 'step', 'restart', 'declaration', 'statement', 'label', 'else', 'end'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export interface FormatOptions {
  /** Column of each kind of line; kinds not given are learned from the file. */
  columns?: Partial<Record<LineKind, number>>;
  trimTrailingSpaces?: boolean;
  uppercaseKeywords?: boolean;
  /** Moving a line never takes it past this column. */
  maxLineLength?: number;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

const UNIT_WORDS = new Set(['SEQUENCE', 'SUBROUTINE', 'BLOCK', 'PACKAGE', 'CUSTOM', 'PARAM_LIST', 'ENUMERATION']);
const DECLARATION_WORDS = new Set(['LOCAL', 'EXTERNAL', 'PARAMETER', 'DEFINE']);
const HANDLER_TYPES = new Set(['HOLD', 'SHUTDOWN', 'EMERGENCY']);

function kindOf(tokens: Token[]): LineKind | undefined {
  const [a, b] = tokens;
  if (!a || a.kind !== TokenKind.Ident) return undefined;
  if (b?.kind === TokenKind.Punct && b.text === ':' && !RESERVED.has(a.upper)) return 'label';
  if (UNIT_WORDS.has(a.upper) || (HANDLER_TYPES.has(a.upper) && b?.upper === 'HANDLER')) return 'unit';
  if (DECLARATION_WORDS.has(a.upper)) return 'declaration';
  switch (a.upper) {
    case 'PHASE':
      return 'phase';
    case 'STEP':
      return 'step';
    case 'RESTART':
      return 'restart';
    case 'ELSE':
      return 'else';
    case 'END':
      return 'end';
  }
  return 'statement';
}

/** Logical lines that begin a line of their own, not an `&` line or a directive. */
function movable(physical: string[], lines: LogicalLine[]): { line: LogicalLine; kind: LineKind; column: number }[] {
  return lines.flatMap((line) => {
    const first = line.tokens[0];
    if (!first || first.line !== line.startLine || physical[line.startLine].startsWith('&')) return [];
    const kind = kindOf(line.tokens);
    return kind ? [{ line, kind, column: first.start }] : [];
  });
}

/**
 * Options read from a .clformat.json, keeping only values of the right type and range. Returns the
 * options and a description of each value left out.
 */
export function readFormatRules(raw: unknown): { options: FormatOptions; problems: string[] } {
  const options: FormatOptions = {};
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { options, problems: ['the file is not a JSON object'] };
  const r = raw as Record<string, unknown>;
  const column = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 200;
  if (r.columns !== undefined) {
    if (!r.columns || typeof r.columns !== 'object' || Array.isArray(r.columns)) problems.push('"columns" is not an object');
    else {
      options.columns = {};
      for (const [k, v] of Object.entries(r.columns)) {
        if (!(LINE_KINDS as readonly string[]).includes(k)) problems.push(`"columns.${k}" is not a kind of line`);
        else if (!column(v)) problems.push(`"columns.${k}" must be a whole number from 0 to 200`);
        else options.columns[k as LineKind] = v as number;
      }
    }
  }
  for (const key of ['trimTrailingSpaces', 'uppercaseKeywords'] as const) {
    if (r[key] === undefined) continue;
    if (typeof r[key] === 'boolean') options[key] = r[key] as boolean;
    else problems.push(`"${key}" must be true or false`);
  }
  if (r.maxLineLength !== undefined) {
    const v = r.maxLineLength;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 40) options.maxLineLength = v;
    else problems.push('"maxLineLength" must be a whole number of 40 or more');
  }
  for (const k of Object.keys(r)) {
    if (!['columns', 'trimTrailingSpaces', 'uppercaseKeywords', 'maxLineLength'].includes(k)) problems.push(`"${k}" is not a formatting rule`);
  }
  return { options, problems };
}

/** The column each kind of line is most often at in this file. */
export function learnColumns(text: string): Partial<Record<LineKind, number>> {
  const physical = text.split(/\r?\n|\r/);
  const counts = new Map<LineKind, Map<number, number>>();
  for (const m of movable(physical, lex(text).lines)) {
    const c = counts.get(m.kind) ?? new Map<number, number>();
    c.set(m.column, (c.get(m.column) ?? 0) + 1);
    counts.set(m.kind, c);
  }
  const out: Partial<Record<LineKind, number>> = {};
  for (const [kind, c] of counts) {
    // The most frequent column; on a tie, the smaller.
    out[kind] = [...c].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
  }
  return out;
}

/** Edits that format `text`, or only the lines from `fromLine` to `toLine`. */
export function formatCl(text: string, options: FormatOptions = {}, fromLine = 0, toLine = Number.MAX_SAFE_INTEGER): TextEdit[] {
  const physical = text.split(/\r?\n|\r/);
  const lexed = lex(text);
  const learned = learnColumns(text);
  const maxLength = options.maxLineLength ?? 132;
  const target = (kind: LineKind): number | undefined =>
    options.columns?.[kind] ?? learned[kind] ?? (kind === 'else' ? (options.columns?.statement ?? learned.statement) : undefined);

  const out = [...physical];
  const inRange = (line: number) => line >= fromLine && line <= toLine;

  if (options.uppercaseKeywords !== false) {
    for (const l of lexed.lines) {
      for (const t of l.tokens) {
        if (t.kind !== TokenKind.Ident || !RESERVED.has(t.upper) || t.text === t.upper || !inRange(t.line)) continue;
        const s = out[t.line];
        out[t.line] = s.slice(0, t.start) + t.upper + s.slice(t.end);
      }
    }
  }

  for (const m of movable(physical, lexed.lines)) {
    const want = target(m.kind);
    if (want === undefined || want === m.column || !inRange(m.line.startLine)) continue;
    const delta = want - m.column;
    const moved = new Map<number, string>();
    moved.set(m.line.startLine, ' '.repeat(want) + out[m.line.startLine].slice(m.column));
    for (let i = m.line.startLine + 1; i <= m.line.endLine; i++) {
      const s = out[i];
      if (!s.startsWith('&')) continue;
      const gap = s.length - 1 - s.slice(1).trimStart().length;
      // Keep at least one space where there was one; `&SET` stays tight.
      const newGap = gap === 0 ? 0 : Math.max(1, gap + delta);
      moved.set(i, '&' + ' '.repeat(newGap) + s.slice(1 + gap));
    }
    // Moving a statement must not push any of its lines past the column the compiler reads.
    const fits = [...moved].every(([i, s]) => s.trimEnd().length <= Math.max(maxLength, out[i].trimEnd().length));
    if (fits) for (const [i, s] of moved) out[i] = s;
  }

  if (options.trimTrailingSpaces !== false) {
    for (let i = 0; i < out.length; i++) if (inRange(i)) out[i] = out[i].trimEnd();
  }

  if (!sameProgram(physical, out)) return [];
  const edits: TextEdit[] = [];
  out.forEach((s, i) => {
    if (s !== physical[i]) edits.push({ range: { start: { line: i, character: 0 }, end: { line: i, character: physical[i].length } }, newText: s });
  });
  return edits;
}

/** Same tokens on the same lines, same comments, and column 1 untouched where it matters. */
function sameProgram(before: string[], after: string[]): boolean {
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after[i];
    if ((a.startsWith('&') || a.startsWith('%')) !== (b.startsWith('&') || b.startsWith('%'))) return false;
    if ((a.startsWith('&') || a.startsWith('%')) && a[0] !== b[0]) return false;
    if (comment(a) !== comment(b)) return false;
  }
  const x = lex(before.join('\n'));
  const y = lex(after.join('\n'));
  if (x.lines.length !== y.lines.length) return false;
  return x.lines.every((l, i) => {
    const m = y.lines[i];
    if (l.startLine !== m.startLine || l.endLine !== m.endLine || l.tokens.length !== m.tokens.length) return false;
    return l.tokens.every((t, j) => {
      const u = m.tokens[j];
      return t.kind === u.kind && t.line === u.line && (t.kind === TokenKind.Ident ? t.upper === u.upper : t.text === u.text);
    });
  });
}

/** The `--` comment of a line, outside strings, without trailing spaces. */
function comment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] === '"') inString = !inString;
    else if (!inString && line[i] === '-' && line[i + 1] === '-') return line.slice(i).trimEnd();
  }
  return '';
}
