import { Diagnostic, Range, Severity } from './types';

export const enum TokenKind {
  Ident,
  Number,
  String,
  Punct,
  Directive,
  Unknown,
}

export interface Token {
  kind: TokenKind;
  /** Source text exactly as written. */
  text: string;
  /** Upper-cased text for identifiers and directives, with a leading `'` removed. */
  upper: string;
  line: number;
  start: number;
  end: number;
}

/** One statement: a physical line plus the `&` continuation lines that follow it. */
export interface LogicalLine {
  tokens: Token[];
  startLine: number;
  endLine: number;
}

export interface LexResult {
  lines: LogicalLine[];
  /** Ranges of whole-line comments, used for folding. */
  commentLines: number[];
  diagnostics: Diagnostic[];
}

const IDENT_CHAR = /[A-Za-z0-9_$]|[^\x00-\x7F]/;
/**
 * Statement keywords that begin a new statement when they follow a blank or comment line, even
 * on an `&` line. The compiler treats a column-1 `&` like a space, and production code relies on it.
 */
const STATEMENT_START = new Set([
  'SET', 'READ', 'WRITE', 'IF', 'GOTO', 'LOOP', 'REPEAT', 'CALL', 'ENB', 'INITIATE', 'RESUME', 'PAUSE',
  'WAIT', 'FAIL', 'EXIT', 'ABORT', 'SEND', 'END', 'LOCAL', 'EXTERNAL', 'PARAMETER', 'DEFINE', 'PHASE',
  'STEP', 'SEQUENCE', 'BLOCK', 'SUBROUTINE',
]);
const DIGIT = /[0-9]/;
const TWO_CHAR = new Set(['**', '..', '<>', '<=', '>=']);
const ONE_CHAR = new Set(['+', '-', '*', '/', '<', '>', '=', '(', ')', ',', ';', ':', '.']);

export function tokenRange(t: Token): Range {
  return { start: { line: t.line, character: t.start }, end: { line: t.line, character: t.end } };
}

export function lex(text: string): LexResult {
  const physical = text.split(/\r?\n|\r/);
  const lines: LogicalLine[] = [];
  const commentLines: number[] = [];
  const diagnostics: Diagnostic[] = [];
  let current: LogicalLine | undefined;
  /** A blank or comment line seen since the last statement line. */
  let gapLine = -1;

  const error = (line: number, start: number, end: number, message: string, severity = Severity.Error) =>
    diagnostics.push({
      range: { start: { line, character: start }, end: { line, character: end } },
      message,
      severity,
      code: 'syntax',
    });

  physical.forEach((src, lineNo) => {
    const continuation = src.startsWith('&');
    const tokens = lexLine(src, lineNo, continuation ? 1 : 0, error);

    if (tokens.length === 0) {
      if (/^\s*--/.test(src)) commentLines.push(lineNo);
      if (!continuation) {
        if (current && gapLine < 0) gapLine = lineNo;
        return;
      }
    }

    if (continuation) {
      if (!current) {
        error(lineNo, 0, 1, 'Continuation line with no statement to continue');
        current = { tokens: [], startLine: lineNo, endLine: lineNo };
        lines.push(current);
      } else if (gapLine >= 0) {
        const first = tokens[0];
        if (first && first.kind === TokenKind.Ident && STATEMENT_START.has(first.upper)) {
          current = { tokens, startLine: lineNo, endLine: lineNo };
          lines.push(current);
          gapLine = -1;
          return;
        }
        error(lineNo, 0, 1, 'Blank and comment lines are not allowed between continuation lines (HP27-610 §2.2.3)', Severity.Warning);
      }
      current.tokens.push(...tokens);
      current.endLine = lineNo;
      gapLine = -1;
      return;
    }

    current = { tokens, startLine: lineNo, endLine: lineNo };
    lines.push(current);
    gapLine = -1;
  });

  return { lines, commentLines, diagnostics };
}

function lexLine(
  src: string,
  line: number,
  from: number,
  error: (line: number, start: number, end: number, message: string, severity?: Severity) => void,
): Token[] {
  const tokens: Token[] = [];
  const push = (kind: TokenKind, start: number, end: number, upper?: string) => {
    const text = src.slice(start, end);
    tokens.push({ kind, text, upper: upper ?? text.toUpperCase(), line, start, end });
  };
  let i = from;

  if (from === 0 && src[0] === '%') {
    let j = 1;
    while (j < src.length && /[A-Za-z_]/.test(src[j])) j++;
    push(TokenKind.Directive, 0, j);
    const name = src.slice(0, j).toUpperCase();
    if (name === '%INCLUDE_SOURCE' || name === '%INCLUDE_EQUIPMENT_LIST' || name === '%INCLUDE_SET' || name === '%RELAX') {
      const rest = src.slice(j).replace(/--.*$/, '');
      const m = rest.match(/\S+/);
      if (m && m.index !== undefined) push(TokenKind.String, j + m.index, j + m.index + m[0].length);
      return tokens;
    }
    i = j;
  }

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') {
      if (c === '\t') error(line, i, i + 1, 'Tab characters are not allowed in CL source (HP27-610 §2.2.1)', Severity.Warning);
      i++;
      continue;
    }
    if (c === '-' && src[i + 1] === '-') break;

    const start = i;
    if (c === '"') {
      i++;
      for (;;) {
        if (i >= src.length) {
          error(line, start, i, 'Unterminated string: a string cannot continue onto the next line');
          break;
        }
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      push(TokenKind.String, start, i);
      continue;
    }

    if (DIGIT.test(c)) {
      while (i < src.length && IDENT_CHAR.test(src[i])) i++;
      const word = src.slice(start, i);
      if (/^\d+$/.test(word)) {
        if (src[i] === '.' && DIGIT.test(src[i + 1] ?? '')) {
          i++;
          while (DIGIT.test(src[i] ?? '')) i++;
          const exp = src.slice(i).match(/^[eE][+-]?\d+/);
          if (exp) i += exp[0].length;
        }
        push(TokenKind.Number, start, i);
      } else {
        i = readOffLcn(src, i);
        push(TokenKind.Ident, start, i);
      }
      continue;
    }

    // Letters of the local script (Hebrew at this site) are identifier letters, as Katakana is in
    // the manual's grammar. Self-defined enumeration states use them: `SET XV.OP = פתוח`.
    if (/[A-Za-z_$]/.test(c) || isLocalLetter(c) || (c === '!' && /[A-Za-z]/.test(src[i + 1] ?? ''))) {
      i++;
      while (i < src.length && IDENT_CHAR.test(src[i])) i++;
      i = readOffLcn(src, i);
      push(TokenKind.Ident, start, i);
      continue;
    }

    if (c === "'" && IDENT_CHAR.test(src[i + 1] ?? '')) {
      i++;
      while (i < src.length && IDENT_CHAR.test(src[i])) i++;
      push(TokenKind.Ident, start, i, src.slice(start + 1, i).toUpperCase());
      continue;
    }

    const two = src.slice(i, i + 2);
    if (TWO_CHAR.has(two)) {
      push(TokenKind.Punct, i, i + 2);
      i += 2;
      continue;
    }
    if (ONE_CHAR.has(c)) {
      push(TokenKind.Punct, i, i + 1);
      i++;
      continue;
    }

    i++;
    if (c !== '&') {
      // Report a run of unexpected characters once.
      while (i < src.length && /[^\sA-Za-z0-9_$"'!.,;:()=<>+*\/-]/.test(src[i]) && !isLocalLetter(src[i])) i++;
      error(line, start, i, `Unexpected character${i - start > 1 ? 's' : ''} '${src.slice(start, i)}'`);
    } else if (c === '&') {
      error(line, start, i, "A continuation '&' must be in column 1");
    }
    push(TokenKind.Unknown, start, i);
  }
  return tokens;
}

function isLocalLetter(c: string): boolean {
  return c.charCodeAt(0) > 127 && /\p{L}/u.test(c);
}

/** Off-LCN references are written `net\tag`. Lex them as one identifier. */
function readOffLcn(src: string, i: number): number {
  if (src[i] === '\\' && IDENT_CHAR.test(src[i + 1] ?? '')) {
    i++;
    while (i < src.length && IDENT_CHAR.test(src[i])) i++;
  }
  return i;
}
