import { describe, expect, it } from 'vitest';
import { formatCl, learnColumns } from '../src/language/format';

const apply = (text: string, edits: ReturnType<typeof formatCl>) => {
  const lines = text.split('\n');
  for (const e of edits) lines[e.range.start.line] = e.newText;
  return lines.join('\n');
};
const format = (lines: string[], options = {}) => apply(lines.join('\n'), formatCl(lines.join('\n'), options)).split('\n');

const FILE = [
  '   SEQUENCE S (HPM; POINT S)',
  '   EXTERNAL A100, B200',
  '   LOCAL N AT NN(1)',
  '   PHASE P',
  'STEP S1',
  '   SET N=1   ',
  '   WAIT N>0',
  '     IF N>0 THEN',
  '&        (SET N=2;',
  '&         EXIT)',
  ' set N = 3 -- keep  this   comment',
  'L1: SEND: "two  spaces  stay"',
  '   ELSE EXIT',
  'END S',
];

describe('format', () => {
  it('learns the column of each kind of line', () => {
    expect(learnColumns(FILE.join('\n'))).toMatchObject({ unit: 3, declaration: 3, phase: 3, step: 0, statement: 3, label: 0, end: 0 });
  });

  it('moves stray lines to the file\'s column, with their continuation lines', () => {
    expect(format(FILE)).toEqual([
      '   SEQUENCE S (HPM; POINT S)',
      '   EXTERNAL A100, B200',
      '   LOCAL N AT NN(1)',
      '   PHASE P',
      'STEP S1',
      '   SET N=1',
      '   WAIT N>0',
      '   IF N>0 THEN',
      '&      (SET N=2;',
      '&       EXIT)',
      '   SET N = 3 -- keep  this   comment',
      'L1: SEND: "two  spaces  stay"',
      '   ELSE EXIT',
      'END S',
    ]);
  });

  it('formats again to the same text', () => {
    const once = format(FILE);
    expect(format(once)).toEqual(once);
  });

  it('takes columns from the options before the file', () => {
    expect(format(['SEQUENCE S (HPM; POINT S)', 'PHASE P', 'SET N=1', 'END S'], { columns: { statement: 4, end: 2 } })).toEqual([
      'SEQUENCE S (HPM; POINT S)',
      'PHASE P',
      '    SET N=1',
      '  END S',
    ]);
  });

  it('can leave keyword case and trailing spaces alone', () => {
    expect(format(['  set N=1  ', '  SET N=2'], { uppercaseKeywords: false, trimTrailingSpaces: false })).toEqual(['  set N=1  ', '  SET N=2']);
  });

  it('formats only the selected lines', () => {
    const text = ['  SET A=1', ' SET B=2  ', ' SET C=3  ', '  SET D=4', '  SET E=5'].join('\n');
    expect(apply(text, formatCl(text, {}, 1, 1)).split('\n')).toEqual(['  SET A=1', '  SET B=2', ' SET C=3  ', '  SET D=4', '  SET E=5']);
  });

  it('keeps & and % in column 1, and a tight & tight', () => {
    expect(format(['%PAGE', '    SET A=1', '  SET B = A +', '&2', '    SET C=1'])).toEqual(['%PAGE', '    SET A=1', '    SET B = A +', '&2', '    SET C=1']);
  });

  it('does not move a line past column 132', () => {
    const long = `SET A = ${'B + '.repeat(30)}1`;
    expect(long.length).toBe(129);
    expect(format(['      SET X=1', '      SET Y=1', long])[2]).toBe(long);
  });

  it('changes nothing when the result would lex differently', () => {
    // An unterminated string runs to the end of the line, so trimming would change it.
    expect(formatCl('  SET A=1\n  SEND: "open   ')).toEqual([]);
  });
});
