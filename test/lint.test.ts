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

describe('lint: compiler errors found before compiling', () => {
  const NEW = new Set(['local-location', 'local-type', 'array-bounds', 'external-order', 'loop-counter', 'loop-range', 'repeat', 'handler', 'initiate', 'structure']);
  const found = (src: string) => check(src).filter((m) => NEW.has(m.split(':')[0]));
  const hpmDecl = (decls: string) => found(hpm('EXIT', decls));

  it('checks LOCAL locations and their types', () => {
    expect(hpmDecl('LOCAL A AT NN(1)\nLOCAL B: LOGICAL AT FL(2)\nLOCAL C: TIME AT TIME(1)\nLOCAL D: STRING AT STR16(2)\nLOCAL E: ON/OFF AT FL(3)\nLOCAL F: ARRAY (1..3) AT NN(4)')).toEqual([]);
    expect(hpmDecl('LOCAL A: LOGICAL AT NN(1)')).toEqual(['local-type: A LOGICAL LOCAL maps to FL, not NN (HP27-610 Table 2-4)']);
    expect(hpmDecl('LOCAL A AT FL(1)')).toEqual(['local-type: A NUMBER LOCAL maps to NN, not FL (HP27-610 Table 2-4)']);
    expect(hpmDecl('LOCAL A AT PV(1)')).toEqual(['local-location: A LOCAL maps to NN, FL, TIME or STRn, not PV (HP27-610 Table 2-4)']);
    expect(hpmDecl('LOCAL A AT NN(1.5)')).toEqual(['local-location: The location index must be an integer']);
    expect(hpmDecl('LOCAL A: ON/OFF/AUTO AT FL(1)')).toEqual(['local-type: A LOCAL state list has exactly two states (HP27-610 §2.6.2.1)']);
    expect(hpmDecl('LOCAL A, B AT NN(1)')[0]).toMatch(/^local-location: Only one variable per LOCAL/);
    expect(found('SEQUENCE S (PM; POINT S)\nLOCAL C: TIME AT TIME(1)\nPHASE P\nSET C = 1 SECS\nEND S')).toEqual(['local-location: A LOCAL maps to NN or FL, not TIME (HP27-610 Table 2-4)']);
  });

  it('allows two LOCALs on one location, as aliases', () => {
    expect(hpmDecl('LOCAL A AT NN(1)\nLOCAL B AT NN(1)')).toEqual([]);
  });

  it('checks array bounds', () => {
    expect(hpmDecl('LOCAL A: ARRAY (5..3) AT NN(1)')).toEqual(['array-bounds: The lower bound must be less than the upper bound (HP27-610 §2.6.2.2)']);
  });

  it('wants the EXTERNAL of a point before LOCALs on it', () => {
    expect(hpmDecl('EXTERNAL R2\nLOCAL A AT R2.NN(1)')).toEqual([]);
    expect(hpmDecl('LOCAL A AT R2.NN(1)\nEXTERNAL R2')).toEqual(['external-order: The LOCAL must follow EXTERNAL R2 (HP27-610 §2.6.2.2)']);
    expect(hpmDecl('LOCAL A AT R3.NN(1)')).toEqual(['external-order: R3 is not declared EXTERNAL']);
    expect(hpmDecl('LOCAL A AT S.NN(1)').filter((m) => m.startsWith('external-order'))).toEqual([]);
  });

  it('checks loop counters, ranges and REPEATs', () => {
    const loop = (body: string, decls = 'LOCAL I AT NN(1)') => found(hpm(body, decls));
    expect(loop('L: LOOP FOR I IN 1..5\nREPEAT L')).toEqual([]);
    expect(loop('L: LOOP FOR J IN 1..5\nREPEAT L')).toEqual(['loop-counter: Loop counter J is not declared']);
    expect(loop('L: LOOP FOR I IN 1..5\nREPEAT L', 'LOCAL I: LOGICAL AT FL(1)')).toEqual([
      'loop-counter: Loop counter I must be a scalar Number LOCAL or subroutine argument (HP27-610 §3.2.9.2)',
    ]);
    expect(loop('L: LOOP FOR I IN 1..5\nREPEAT L', 'LOCAL I = 3')[0]).toMatch(/^loop-counter: .* must be a scalar Number/);
    expect(loop('L: LOOP FOR I IN 20..10\nREPEAT L')).toEqual([
      'loop-range: The loop counts up from 20 and never reaches 10: decrementing loops are not supported (HP27-610 §3.2.9.3)',
    ]);
    expect(loop('L: SET !BOX.NN(2) = 1\nREPEAT L')).toEqual(['repeat: L does not label a LOOP (HP27-610 §3.2.10)']);
    expect(loop('L: LOOP FOR I IN 1..5\nIF I = 2 THEN REPEAT L\nREPEAT L')).toEqual([
      'repeat: Loop L already has a REPEAT: a loop has only one (HP27-610 §3.2.10)',
    ]);
  });

  it('accepts a loop counter that is a subroutine argument', () => {
    expect(found('SUBROUTINE SUB (N: IN NUMBER)\nL: LOOP FOR N IN 1..3\nREPEAT L\nEND SUB')).toEqual([]);
  });

  const withHandlers = (phase: string, handlers: string) => `SEQUENCE S (HPM; POINT S)\nPHASE P ${phase}\nEXIT\nEND S\n${handlers}`;

  it('checks handler types, RESTART and RESUME', () => {
    const hold = 'HOLD HANDLER H1\nEXIT\nRESTART\nRESUME PHASE P\nEND H1';
    const emergency = 'EMERGENCY HANDLER E1\nEXIT\nEND E1';
    expect(found(withHandlers('(HOLD H1; EMERGENCY E1)', `${hold}\n${emergency}`))).toEqual([]);
    expect(found(withHandlers('(SHUTDOWN H1)', hold))).toEqual(['handler: H1 is a HOLD handler, not SHUTDOWN']);
    expect(found(withHandlers('', 'EMERGENCY HANDLER E1\nEXIT\nRESTART\nEXIT\nEND E1'))).toEqual([
      'handler: An EMERGENCY handler cannot have a RESTART section (HP27-610 §4.4)',
    ]);
    expect(found(`SEQUENCE S (HPM; POINT S)\nPHASE P\nRESUME PHASE P\nEND S`)).toEqual([
      'handler: RESUME is allowed only in the RESTART section of a handler (HP27-610 §3.2.17)',
    ]);
  });

  it('checks ENB statements', () => {
    const handlers = 'HOLD HANDLER H1\nEXIT\nEND H1\nHOLD HANDLER H2\nEXIT\nEND H2';
    const enb = (stmt: string) => found(`SEQUENCE S (HPM; POINT S)\nPHASE P\n${stmt}\nEND S\n${handlers}`);
    expect(enb('ENB HOLD H1')).toEqual([]);
    expect(enb('ENB HOLD H1, HOLD H2')).toEqual(['handler: HOLD appears twice in this ENB (HP27-610 §3.2.6)']);
    expect(enb('ENB EMERGENCY H1')).toEqual(['handler: H1 is a HOLD handler, not EMERGENCY']);
  });

  it('does not let a GOTO STEP cross a RESTART heading', () => {
    const h = 'HOLD HANDLER H1\nSTEP A\nGOTO STEP B\nRESTART\nSTEP B\nGOTO STEP C\nSTEP C\nEXIT\nEND H1';
    expect(found(withHandlers('(HOLD H1)', h))).toEqual(['handler: A GOTO cannot cross the RESTART heading to step B (HP27-610 §4.4)']);
  });

  it('checks INITIATE of the program itself', () => {
    const seq = (stmt: string) => found(`SEQUENCE S (HPM; POINT S)\nEXTERNAL M\nPHASE P\n${stmt}\nEND S`);
    expect(seq('INITIATE M (WHEN ERROR FAIL)')).toEqual([]);
    expect(seq('INITIATE HOLD')).toEqual([]);
    expect(seq('INITIATE HOLD (WHEN ERROR FAIL)')).toEqual([
      "initiate: WHEN ERROR is not allowed on INITIATE of this program's own handler (HP27-610 §3.2.15.4)",
    ]);
    expect(seq('INITIATE S')).toEqual(["initiate: S is this program's own point: a sequence cannot INITIATE itself"]);
  });

  it('checks the structure of routines', () => {
    expect(found(hpm('STEP A\nEXIT'))).toEqual(['structure: A routine with steps begins with a STEP heading (HP27-610 §4.1.2)']);
    expect(found('SEQUENCE S (HPM; POINT S)\nPHASE P\nPHASE Q\nEXIT\nEND S')).toEqual([
      'structure: This PHASE has no statements: it must contain executable statements',
    ]);
    expect(found('SEQUENCE S (HPM; POINT S)\nPHASE P\nSTEP A\nSTEP B\nEXIT\nEND S')).toEqual([
      'structure: This STEP has no statements: it must contain executable statements',
    ]);
  });
});
