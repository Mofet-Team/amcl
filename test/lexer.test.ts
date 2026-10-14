import { describe, expect, it } from 'vitest';
import { lex, TokenKind } from '../src/language/lexer';

const texts = (src: string) => lex(src).lines.map((l) => l.tokens.map((t) => t.text));

describe('lexer', () => {
  it('joins & continuation lines into one statement', () => {
    const { lines } = lex('IF A THEN (SET B = 1;\n&  SET C = 2)\nELSE SET D = 3');
    expect(lines).toHaveLength(2);
    expect(lines[0].startLine).toBe(0);
    expect(lines[0].endLine).toBe(1);
    expect(lines[0].tokens.map((t) => t.line)).toContain(1);
  });

  it('drops comments, including on continuation lines', () => {
    expect(texts('SET A = 1 -- set A\n& + 2 -- more')).toEqual([['SET', 'A', '=', '1', '+', '2']]);
  });

  it('reads tags that start with digits as identifiers and numbers as numbers', () => {
    const toks = lex('SET 12_REACT.NN(41) = 1000 + 1.5E2 + 10.02e-1').lines[0].tokens;
    expect(toks[1]).toMatchObject({ kind: TokenKind.Ident, text: '12_REACT' });
    expect(toks.filter((t) => t.kind === TokenKind.Number).map((t) => t.text)).toEqual(['41', '1000', '1.5E2', '10.02e-1']);
  });

  it('keeps 1..5 as a range, not a decimal', () => {
    expect(texts('LOOP FOR I IN 1..5')[0]).toEqual(['LOOP', 'FOR', 'I', 'IN', '1', '..', '5']);
  });

  it('reads "" inside a string as a quote', () => {
    const t = lex('SEND: "say ""hi"" now", X').lines[0].tokens;
    expect(t[2]).toMatchObject({ kind: TokenKind.String, text: '"say ""hi"" now"' });
  });

  it('reports an unterminated string', () => {
    const { diagnostics } = lex('SEND: "oops');
    expect(diagnostics[0].message).toMatch(/Unterminated string/);
  });

  it('reads system, hardware and off-LCN names as single identifiers', () => {
    expect(texts('EXTERNAL !BOX, $NM01N05, !DI01S02, NET\\B200')[0]).toEqual([
      'EXTERNAL', '!BOX', ',', '$NM01N05', ',', '!DI01S02', ',', 'NET\\B200',
    ]);
  });

  it('accepts Hebrew letters in identifiers (self-defined enumeration states)', () => {
    const t = lex('IF XV.PV = פתוח THEN SET M.OP = 12_סגור').lines[0].tokens;
    expect(t.filter((x) => x.kind === TokenKind.Ident).map((x) => x.text)).toContain('פתוח');
    expect(t.filter((x) => x.kind === TokenKind.Ident).map((x) => x.text)).toContain('12_סגור');
    expect(lex('IF XV.PV = פתוח THEN EXIT').diagnostics).toEqual([]);
  });

  it('starts a new statement at a keyword on an & line after a blank line, as the compiler does', () => {
    const { lines, diagnostics } = lex('CLOSE A,\n& B\n\n&  IF X THEN EXIT');
    expect(lines.map((l) => l.tokens[0].text)).toEqual(['CLOSE', 'IF']);
    expect(diagnostics).toEqual([]);
  });

  it('warns about a blank line inside a continued statement', () => {
    const { lines, diagnostics } = lex('SET A = 1 +\n\n& 2');
    expect(lines).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: 2 });
  });

  it('reports a tab character as a warning', () => {
    expect(lex('SET\tA = 1').diagnostics[0]).toMatchObject({ severity: 2, message: expect.stringMatching(/Tab/) });
  });

  it('reads %INCLUDE_SOURCE with a path argument', () => {
    const t = lex('%INCLUDE_SOURCE NET>CL>COMMON.CL').lines[0].tokens;
    expect(t.map((x) => [x.kind, x.text])).toEqual([
      [TokenKind.Directive, '%INCLUDE_SOURCE'],
      [TokenKind.String, 'NET>CL>COMMON.CL'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(texts('SET A = 1\r\nSET B = 2\r\n')).toEqual([['SET', 'A', '=', '1'], ['SET', 'B', '=', '2']]);
  });
});
