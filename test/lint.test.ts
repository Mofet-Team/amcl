import { describe, expect, it } from 'vitest';
import { analyze } from '../src/language/analyze';
import { PointRecord } from '../src/language/eb';
import { lint, LintEnvironment } from '../src/language/lint';

/** `code: message` of each lint diagnostic, for a source text. */
function check(src: string, env?: LintEnvironment): string[] {
  const a = analyze(src);
  return lint(a.file, a.binding, env).map((d) => `${d.code}: ${d.message}`);
}

const codes = (src: string, env?: LintEnvironment) => check(src, env).map((m) => m.split(':')[0]);

/** An HPM sequence that uses every name it declares, with `body` in its only phase. */
const hpm = (body: string, decls = '') => `SEQUENCE S (HPM; POINT S)\nEXTERNAL !BOX\n${decls}\nPHASE P\nSET !BOX.NN(1) = 0\n${body}\nEND S`;
const am = (body: string) => `BLOCK B (POINT B; AT BACKGRND)\n${body}\nEND B`;

describe('lint', () => {
  it('reports unused names as the compiler does, faded', () => {
    const a = analyze(hpm('L1: EXIT\nGOTO L2\nL2: EXIT', 'LOCAL USED AT NN(1)\nLOCAL IDLE AT NN(2)\nEXTERNAL SPARE\nLOCAL K = 5') + '\nSUBROUTINE NEVER\nEXIT\nEND NEVER');
    const out = lint(a.file, a.binding).filter((d) => d.code === 'unused');
    expect(out.map((d) => d.message)).toEqual([
      'USED is defined but not referenced',
      'IDLE is defined but not referenced',
      'SPARE is defined but not referenced',
      'K is defined but not referenced',
      'L1 is defined but not referenced',
      'NEVER is defined but not referenced',
    ]);
    expect(out[0].tags).toEqual([1]);
  });

  it('reports strings over 64 characters and messages over 60', () => {
    expect(codes(hpm(`SEND: "${'x'.repeat(65)}"`))).toEqual(['string-length', 'send-length']);
    expect(codes(hpm(`SEND: "${'x'.repeat(61)}"`))).toEqual(['send-length']);
    expect(codes(hpm(`SEND: "${'x'.repeat(30)}", !BOX.NN(1), "${'y'.repeat(30)}"`))).toEqual([]);
    // "" is one character.
    expect(codes(hpm(`SEND: "${'""'.repeat(30)}"`))).toEqual([]);
  });

  it('reports a LOOP that is never repeated, and one without a label', () => {
    expect(check(hpm('LP: LOOP FOR I IN 1..3\nEXIT', 'LOCAL I AT NN(1)'))).toContain('loop-never-repeated: Loop LP is never repeated: no REPEAT LP in this step');
    expect(codes(hpm('LP: LOOP FOR I IN 1..3\nREPEAT LP', 'LOCAL I AT NN(1)'))).toEqual([]);
    expect(codes(hpm('LOOP'))).toEqual(['loop-label']);
  });

  it('reports AND and OR mixed without parentheses', () => {
    expect(check(hpm('IF !BOX.FL(1) AND !BOX.FL(2) OR !BOX.FL(3) THEN EXIT'))).toEqual([
      'mixed-logic: AND mixed with OR needs parentheses (HP27-610 §2.7.2.4)',
    ]);
    expect(codes(hpm('IF (!BOX.FL(1) AND !BOX.FL(2)) OR !BOX.FL(3) THEN EXIT'))).toEqual([]);
    expect(codes(hpm('IF !BOX.FL(1) AND !BOX.FL(2) AND !BOX.NN(3) > 1 THEN EXIT'))).toEqual([]);
  });

  it('reports storage out of range', () => {
    expect(codes(hpm('SET NN(81) = 1\nSET FL(128) = ON\nSET TIME(5) = 0 SECS\nSET NN(0) = 1'))).toEqual(['slot-range', 'slot-range', 'slot-range', 'slot-range']);
    expect(codes(hpm('SET NN(80) = 1\nSET FL(127) = ON\nSET !BOX.NN(4095) = 1'))).toEqual([]);
    expect(check(hpm('SET !BOX.FL(4096) = ON'))[0]).toMatch(/beyond 4095; map an Array point/);
    expect(codes(hpm('', 'LOCAL X AT NN(99)'))).toContain('slot-range');
  });

  it('reports names over 8 characters in CL/HPM only', () => {
    expect(codes(hpm('EXIT').replace('PHASE P', 'PHASE TOOLONGNAME'))).toEqual(['name-length']);
    expect(codes(am('CALL SHIFT_RECORDS') + '\nSUBROUTINE SHIFT_RECORDS\nEXIT\nEND SHIFT_RECORDS')).toEqual([]);
  });

  it('reports declarations after the first PHASE', () => {
    expect(codes('SEQUENCE S (HPM; POINT S)\nPHASE P\nLOCAL X AT NN(1)\nSET X = 1\nEND S')).toEqual(['decl-after-phase']);
    expect(codes(hpm('EXIT'))).toEqual([]);
  });

  it('reports duplicate labels, steps, phases and declarations', () => {
    const src = 'SEQUENCE S (HPM; POINT S)\nLOCAL A AT NN(1)\nLOCAL A AT NN(2)\nPHASE P\nSTEP X\nL: SET A = 1\nGOTO L\nSTEP X\nEXIT\nPHASE P\nEXIT\nEND S';
    expect(check(src).filter((m) => m.startsWith('duplicate'))).toEqual([
      'duplicate: A is already defined as a name on line 2',
      'duplicate: P is already defined as a phase on line 4',
      'duplicate: X is already defined as a step on line 5',
    ]);
  });

  it('reports statements a dialect does not have', () => {
    expect(check(am('WAIT 5 SECS\nSEND (WAIT): "x"\nSET X = 1 (WHEN ERROR EXIT)'))).toEqual([
      'dialect: WAIT is not available in CL/AM (AM27-610 §3.2)',
      'dialect: SEND (WAIT) is not available in CL/AM',
      'dialect: WHEN ERROR is not available in CL/AM',
    ]);
    expect(codes('SEQUENCE S (PM; POINT S)\nPHASE P\nSET NN(1) = 1 (WHEN ERROR EXIT)\nEND S')).toEqual(['dialect']);
    expect(codes(hpm('EXIT', 'DEFINE F(X) = X * 2'))).toEqual(['dialect']);
  });

  it("reports the bound point named in EXTERNAL or before its own parameters", () => {
    expect(codes(hpm('SET S.NN(4) = 1', 'EXTERNAL S'))).toEqual(['external-bound', 'external-bound']);
  });

  it('reports / and MOD in LOCAL constants', () => {
    expect(codes(hpm('SET !BOX.NN(2) = K', 'LOCAL K = 10 / 2'))).toEqual(['const-expr']);
    expect(codes(hpm('SET !BOX.NN(2) = K', 'LOCAL K = 10 * 2 + 1'))).toEqual([]);
  });

  it('reports subroutines nested deeper than one level', () => {
    const src = hpm('CALL A') + '\nSUBROUTINE A\nCALL B\nEND A\nSUBROUTINE B\nCALL C\nEND B\nSUBROUTINE C\nEXIT\nEND C';
    expect(check(src)).toEqual(['call-depth: B is itself called from a subroutine, so it cannot call C: subroutines nest one level (runtime error 110)']);
  });

  it('reports WAIT on an absolute time but not on a condition', () => {
    expect(codes(hpm('WAIT Date_Time + 5 MINS'))).toEqual(['wait-absolute']);
    expect(codes(hpm('WAIT Date_Time > TIME(1)\nWAIT !BOX.FL(1) AND Date_Time > TIME(1)'))).toEqual([]);
  });

  describe('with a point database', () => {
    const point = (name: string, type: string, node: number, extra: Record<string, string> = {}): PointRecord => ({
      name, type, file: 'x.EB', line: 0, fields: { NODETYP: 'HPM', NTWKNUM: '01', NODENUM: String(node), ...extra },
    });
    const db = new Map([
      ['S', point('S', 'PRMODNIM', 9)],
      ['NEAR', point('NEAR', 'DICMPNIM', 9)],
      ['FAR', point('FAR', 'DICMPNIM', 7)],
      ['SER', point('SER', 'ARRAY', 9, { EXTDATA: 'IO_FL' })],
    ]);
    const env: LintEnvironment = {
      point: (n) => db.get(n.toUpperCase()),
      boxOfProgram: () => 'A/1:9',
      boxOfPoint: (p) => `A/1:${p.fields.NODENUM}`,
    };

    it('warns about access to a point the database places in another node', () => {
      const src = hpm('SET NEAR.MODATTR = PROGRAM\nSET FAR.MODATTR = PROGRAM\nCLOSE FAR\nREAD NN(1) FROM FAR.PV\nINITIATE FAR', 'EXTERNAL NEAR, FAR');
      expect(codes(src, env)).toEqual(['remote-access', 'remote-access']);
      expect(check(src, env)[0]).toMatch(/places FAR in HPM 01\/07 \(LCN A\), not this program's HPM 01\/09 \(LCN A\)/);
    });

    it('notes LOCALs on serial-interface Array points', () => {
      expect(check(hpm('SET X = ON', 'EXTERNAL SER\nLOCAL X: LOGICAL AT SER.FL(1)'), env)).toEqual([
        'serial-iop: X is mapped to a Serial Interface IOP parameter (SER, IO_FL)',
      ]);
    });
  });
});
