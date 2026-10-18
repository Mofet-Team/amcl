import { describe, expect, it } from 'vitest';
import { analyze } from '../src/language/analyze';
import { lint, longLines } from '../src/language/lint';
import { quickFixes, TextEdit } from '../src/language/quickfix';

/** Apply edits, last first so positions stay valid. */
function apply(text: string, edits: TextEdit[]): string {
  const lines = text.split('\n');
  const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  return [...edits]
    .sort((a, b) => offset(b.range.start) - offset(a.range.start))
    .reduce((t, e) => t.slice(0, offset(e.range.start)) + e.newText + t.slice(offset(e.range.end)), text);
}

/** The text after the first fix for the first diagnostic with `code` (and `message` text). */
function fixed(text: string, code: string, message = ''): string {
  const a = analyze(text);
  const all = [...a.diagnostics, ...lint(a.file, a.binding), ...longLines(text.split('\n'))];
  const d = all.find((x) => x.code === code && x.message.includes(message));
  if (!d) throw new Error(`no ${code} diagnostic`);
  const [fix] = quickFixes(text.split('\n'), a, d);
  if (!fix) throw new Error(`no fix for ${d.message}`);
  return apply(text, fix.edits);
}

const seq = (decls: string, body: string) => `SEQUENCE S (HPM; POINT S)\n${decls}\nPHASE P\n${body}\nEND S`;

describe('quick fixes', () => {
  it('adds an undeclared point to the last EXTERNAL list', () => {
    expect(fixed(seq('   EXTERNAL XV1', '   SET XV2.OP = ON\n   SET XV1.OP = ON'), 'undeclared-point')).toBe(seq('   EXTERNAL XV1, XV2', '   SET XV2.OP = ON\n   SET XV1.OP = ON'));
  });

  it('continues a full EXTERNAL list on an & line', () => {
    const full = `   EXTERNAL ${Array.from({ length: 21 }, (_, i) => `XVALVE${String(i).padStart(2, '0')}`).join(', ')}`;
    const out = fixed(seq(full, '   OPEN NEWPOINT'), 'state-change').split('\n');
    expect(out[1]).toBe(`${full},`);
    expect(out[2]).toBe(`&           NEWPOINT`);
  });

  it('writes a new EXTERNAL line when there is none, and puts it above the LOCAL that needs it', () => {
    expect(fixed(seq('   LOCAL N AT XV9.NN(1)', '   SET N = 1'), 'external-order')).toBe(seq('   EXTERNAL XV9\n   LOCAL N AT XV9.NN(1)', '   SET N = 1'));
  });

  it('removes unused declarations, from lists too', () => {
    expect(fixed(seq('   EXTERNAL XV1\n   LOCAL IDLE AT NN(2)\n   LOCAL N AT NN(1)', '   SET N = XV1.PV'), 'unused', 'IDLE')).toBe(
      seq('   EXTERNAL XV1\n   LOCAL N AT NN(1)', '   SET N = XV1.PV'),
    );
    expect(fixed(seq('   EXTERNAL XV1, SPARE, XV2', '   SET XV1.OP = XV2.PV'), 'unused', 'SPARE')).toBe(seq('   EXTERNAL XV1, XV2', '   SET XV1.OP = XV2.PV'));
    expect(fixed(seq('   EXTERNAL XV1,\n&           SPARE', '   SET XV1.OP = ON'), 'unused', 'SPARE')).toBe(seq('   EXTERNAL XV1', '   SET XV1.OP = ON'));
    expect(fixed(seq('   EXTERNAL SPARE,\n&           XV1', '   SET XV1.OP = ON'), 'unused', 'SPARE')).toBe(seq('   EXTERNAL \n&           XV1', '   SET XV1.OP = ON'));
  });

  it('removes an unused label but keeps the statement in its column, and leaves LOOP labels alone', () => {
    expect(fixed(seq('', 'L1: EXIT'), 'unused', 'L1')).toBe(seq('', '    EXIT'));
    const loop = seq('   LOCAL I AT NN(1)', 'L: LOOP FOR I IN 1..2\n   EXIT');
    const a = analyze(loop);
    const d = lint(a.file, a.binding).find((x) => x.code === 'unused' && x.message.startsWith('L '))!;
    expect(quickFixes(loop.split('\n'), a, d)).toEqual([]);
  });

  it('continues a line past column 132 between tokens, or moves code indented past it', () => {
    const long = `   SET N = ${Array.from({ length: 40 }, (_, i) => `N${i}`).join(' + ')}`;
    const out = fixed(seq('   LOCAL N AT NN(1)', long), 'line-length').split('\n');
    // Lines 0-2 are the heading, the LOCAL and PHASE.
    expect(out[3].length).toBeLessThanOrEqual(132);
    expect(out[4].startsWith('&      ')).toBe(true);
    expect(out[3].trimEnd() + ' ' + out[4].slice(1).trimStart()).toBe(long);
    expect(fixed(seq('   LOCAL N AT NN(1)', `   SET N = 1\n${' '.repeat(140)}SET N = 2`), 'line-length').split('\n')[4]).toBe('   SET N = 2');
  });

  it('puts a space between a Hebrew state and THEN', () => {
    const text = seq('   EXTERNAL XV1', '   IF XV1.PV=\u05d9\u05d3\u05e0\u05d9THEN EXIT');
    expect(fixed(text, 'syntax')).toBe(seq('   EXTERNAL XV1', '   IF XV1.PV=\u05d9\u05d3\u05e0\u05d9 THEN EXIT'));
  });
});

describe('quick fixes: undefined names', () => {
  const fixesFor = (text: string, taken?: (p: string, param: string, i: number) => boolean) => {
    const a = analyze(text);
    const d = lint(a.file, a.binding).find((x) => x.code === 'undefined')!;
    return quickFixes(text.split('\n'), a, d, taken);
  };

  it('declares a name used as a condition as a LOGICAL flag on the first free slot', () => {
    const text = seq('   LOCAL F1: LOGICAL AT FL(1)\n   LOCAL N AT NN(1)', '   SET F1 = ON\n   SET N = 1\n   IF ntest THEN EXIT');
    const [fix] = fixesFor(text);
    expect(fix.title).toBe('Declare NTEST as LOCAL: LOGICAL AT FL(2)');
    // Into the flags, after FL(1), laid out like it.
    expect(apply(text, fix.edits)).toBe(seq('   LOCAL F1: LOGICAL AT FL(1)\n   LOCAL NTEST: LOGICAL AT FL(2)\n   LOCAL N AT NN(1)', '   SET F1 = ON\n   SET N = 1\n   IF ntest THEN EXIT'));
  });

  it('puts the declaration in its section, in slot order, in the section\'s layout', () => {
    const flags = '-- MOD FLAGS --\n    LOCAL FA     :LOGICAL AT FL(1)    -- first\n    LOCAL FBB    :LOGICAL AT FL(3)';
    const nums = '-- MOD NUMERICS --\n    LOCAL N1        AT NN(1)\n    LOCAL N2        AT NN(2)';
    const text = seq(`${flags}\n${nums}`, '    SET N1 = TOTAL\n    IF FX THEN SET N2 = 1\n    SET FA = ON\n    SET FBB = ON');
    const a = analyze(text);
    const fix = (name: string) => {
      const d = lint(a.file, a.binding).find((x) => x.code === 'undefined' && x.message.includes(` ${name}:`))!;
      return quickFixes(text.split('\n'), a, d).find((f) => f.title.startsWith('Declare'))!;
    };
    // A flag between FL(1) and FL(3), colons in their column, no comment copied.
    expect(apply(text, fix('FX').edits).split('\n').slice(2, 5)).toEqual(['    LOCAL FA     :LOGICAL AT FL(1)    -- first', '    LOCAL FX     :LOGICAL AT FL(2)', '    LOCAL FBB    :LOGICAL AT FL(3)']);
    // A number after the numerics.
    expect(apply(text, fix('TOTAL').edits).split('\n').slice(4, 8)).toEqual(['-- MOD NUMERICS --', '    LOCAL N1        AT NN(1)', '    LOCAL N2        AT NN(2)', '    LOCAL TOTAL     AT NN(3)']);
  });

  it('declares a name used as a number on NN, past arrays, and skips slots other programs use', () => {
    const text = seq('   LOCAL A: ARRAY (1..3) AT NN(1)', '   SET A(1) = TOTAL + 1');
    expect(fixesFor(text)[0].title).toBe('Declare TOTAL as LOCAL AT NN(4)');
    expect(fixesFor(text, (point, param, i) => point === 'S' && param === 'NN' && i === 4)[0].title).toBe('Declare TOTAL as LOCAL AT NN(5)');
  });

  it('knows a name compared with ON is a flag, and offers a declared name a letter away', () => {
    const text = seq('   LOCAL FREADY: LOGICAL AT FL(1)', '   IF FREADY = ON AND FRAEDY = ON THEN EXIT');
    expect(fixesFor(text).map((f) => f.title)).toEqual(['Change to FREADY', 'Declare FRAEDY as LOCAL: LOGICAL AT FL(2)']);
  });
});

describe('quick fixes: removing from lists keeps comments', () => {
  it('removes a last name on a line of its own without the comment of the line before', () => {
    const text = seq('   EXTERNAL XV1, XV2,      -- valves\n&           SPARE', '   SET XV1.OP = XV2.PV');
    expect(fixed(text, 'unused', 'SPARE')).toBe(seq('   EXTERNAL XV1, XV2      -- valves', '   SET XV1.OP = XV2.PV'));
  });

  it('keeps the comment on the removed name\'s line', () => {
    const text = seq('   EXTERNAL XV1,\n&           SPARE   -- old valve', '   SET XV1.OP = ON');
    expect(fixed(text, 'unused', 'SPARE')).toBe(seq('   EXTERNAL XV1\n&              -- old valve', '   SET XV1.OP = ON'));
  });
});
