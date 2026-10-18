import { describe, expect, it } from 'vitest';
import { analyze } from '../src/language/analyze';
import { PointRecord } from '../src/language/eb';
import { lint, LintEnvironment } from '../src/language/lint';
import { Severity } from '../src/language/types';

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
      ['FARPM', point('FARPM', 'PRMODNIM', 7)],
      ['AI1', point('AI1', 'ANINNIM', 9)],
      ['DO1', point('DO1', 'DOUTNIM', 9)],
      ['OTHERUCN', { ...point('OTHERUCN', 'DICMPNIM', 4), fields: { NTWKNUM: '05', NODENUM: '4' } }],
      ...Array.from({ length: 13 }, (_, i) => [`AO${i}`, point(`AO${i}`, 'ANOUTNIM', 9)] as [string, PointRecord]),
    ]);
    const env: LintEnvironment = {
      point: (n) => db.get(n.toUpperCase()),
      boxOfProgram: () => 'A/1:9',
      boxOfPoint: (p) => `A/${Number(p.fields.NTWKNUM)}:${p.fields.NODENUM}`,
    };

    it('warns about access to a point the database places in another node', () => {
      const src = hpm('SET NEAR.MODATTR = PROGRAM\nSET FAR.MODATTR = PROGRAM\nCLOSE FAR\nREAD NN(1) FROM FAR.PV\nINITIATE FARPM', 'EXTERNAL NEAR, FAR, FARPM');
      expect(codes(src, env)).toEqual(['remote-access', 'remote-access']);
      expect(check(src, env)[0]).toMatch(/places FAR in HPM 01\/07 \(LCN A\), not this program's HPM 01\/09 \(LCN A\)/);
    });

    const dbFound = (src: string) => check(src, env).filter((m) => /^(parameter|read-only|initiate|external-ucn|prefetch)/.test(m));

    it('warns about parameters the point type does not have, and stores to view-only ones', () => {
      expect(dbFound(hpm('SET NEAR.OP = NEAR.PV\nSET NEAR.MODATTR = PROGRAM', 'EXTERNAL NEAR'))).toEqual([]);
      expect(dbFound(hpm('SET NEAR.SPEED = 1', 'EXTERNAL NEAR'))).toEqual([
        'parameter: The point database has NEAR as a Digital Composite, which has no parameter SPEED',
      ]);
      expect(dbFound(hpm('SET AI1.PVHIFL = ON', 'EXTERNAL AI1'))).toEqual(['read-only: PVHIFL of an Analog Input is view-only: a program cannot store to it']);
    });

    it('warns about INITIATE of a point that is not a process module', () => {
      expect(dbFound(hpm('INITIATE NEAR', 'EXTERNAL NEAR'))).toEqual([
        'initiate: The point database has NEAR as a Digital Composite: only a process module runs a sequence to INITIATE',
      ]);
    });

    it('warns about EXTERNAL points on another UCN, but not about box names', () => {
      expect(dbFound(hpm('SET OTHERUCN.OP = OFF', 'EXTERNAL OTHERUCN, $NM05N04'))[0]).toMatch(
        /^external-ucn: The point database places OTHERUCN in HPM 05\/04 \(LCN A\), off this program's UCN/,
      );
    });

    it('counts prefetches per step, and finds them in ALARM clauses and CALLs', () => {
      const ao = Array.from({ length: 13 }, (_, i) => `AO${i}`);
      const reads = ao.map((n) => `SET NN(2) = ${n}.OP`).join('\n');
      expect(dbFound(hpm(reads, `EXTERNAL ${ao.join(', ')}`))).toEqual([
        'prefetch: This step reads 13 I/O module parameters; a step can prefetch 12 (HP27-610 §2.5.5): add a STEP heading',
      ]);
      // AI PVs and stores are not prefetched.
      expect(dbFound(hpm(`SET NN(2) = AI1.PV\n${ao.map((n) => `SET ${n}.OP = 0`).join('\n')}`, `EXTERNAL AI1, ${ao.join(', ')}`))).toEqual([]);
      const seq = (phase: string, body: string) => `SEQUENCE S (HPM; POINT S)\nEXTERNAL AO0, DO1\nPHASE P ${phase}\n${body}\nEND S\nSUBROUTINE SUB (X)\nEXIT\nEND SUB`;
      expect(dbFound(seq('(ALARM AO0.OP SECS)', 'EXIT'))).toEqual([
        'prefetch: AO0.OP needs a prefetch, which a PHASE ALARM clause cannot have (HP27-610 §4.1.4.2)',
      ]);
      expect(dbFound(seq('', 'CALL SUB (AO0.OP)\nCALL SUB (DO1.SO)'))).toEqual([
        'prefetch: AO0.OP needs a prefetch, which a CALL argument cannot have (HP27-610 §3.2.13.2)',
      ]);
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

  it('warns of two LOCALs on one location, and notes a name for an array element', () => {
    const aliases = (decls: string) => {
      const a = analyze(hpm('EXIT', decls));
      return lint(a.file, a.binding)
        .filter((d) => d.code === 'local-alias')
        .map((d) => `${d.severity === Severity.Warning ? 'warning' : 'note'} ${d.range.start.line}: ${d.message}`);
    };
    expect(aliases('LOCAL A AT NN(1)\nLOCAL B AT NN(1)')).toEqual(['warning 3: NN(1) is also LOCAL A (line 3): a store to either changes both']);
    expect(aliases('EXTERNAL R2\nLOCAL A: LOGICAL AT R2.FL(5)\nLOCAL B: LOGICAL AT R2.FL(5)')).toEqual(['warning 4: FL(5) is also LOCAL A (line 4): a store to either changes both']);
    expect(aliases('LOCAL A: NUMBER ARRAY (1..5) AT NN(10)\nLOCAL B AT NN(12)')).toEqual(['note 3: NN(12) is also A(3) (line 3): a store to either changes both']);
    expect(aliases('LOCAL A: NUMBER ARRAY (0..4) AT NN(10)\nLOCAL B: NUMBER ARRAY (1..3) AT NN(13)')).toEqual(['note 3: NN(13..14) is also in array A (line 3): a store to either changes both']);
    expect(aliases('LOCAL A AT NN(12)\nLOCAL B: NUMBER ARRAY (1..5) AT NN(10)')).toEqual(['note 3: NN(12) is also LOCAL A (line 3): a store to either changes both']);
    // Different elements, parameters or points are not aliases.
    expect(aliases('EXTERNAL R2\nLOCAL A AT NN(1)\nLOCAL B AT NN(2)\nLOCAL C: LOGICAL AT FL(1)\nLOCAL D AT R2.NN(1)\nLOCAL E: NUMBER ARRAY (1..5) AT NN(10)\nLOCAL F AT NN(15)')).toEqual([]);
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

describe('lint: CALL arguments', () => {
  const found = (src: string) => check(src).filter((m) => /^(call-args|argument-mode|duplicate)/.test(m));
  const SUB = 'SUBROUTINE SUB (X: NUMBER; B: OUT LOGICAL; C: IN OUT NUMBER ARRAY (1..3))\nSET B = ON\nEND SUB';
  const call = (stmt: string, decls = '') =>
    found(`SEQUENCE S (HPM; POINT S)\nLOCAL N AT NN(1)\nLOCAL F: LOGICAL AT FL(1)\nLOCAL A: ARRAY (1..3) AT NN(2)\n${decls}\nPHASE P\n${stmt}\nEND S\n${SUB}`);

  it('accepts a CALL that matches its subroutine', () => {
    expect(call('CALL SUB (N, F, A)')).toEqual([]);
    expect(call('CALL SUB (5, F, A)')).toEqual([]);
    expect(call('CALL SUB (A(2), F, A)')).toEqual([]);
  });

  it('counts arguments', () => {
    expect(call('CALL SUB (N, F)')).toEqual(['call-args: SUB takes 3 arguments, not 2: too few arguments']);
    expect(call('CALL SUB (N, F, A, N)')).toEqual(['call-args: SUB takes 3 arguments, not 4: too many arguments']);
  });

  it('wants a variable for OUT and IN OUT, and no expressions', () => {
    expect(call('CALL SUB (N, ON, A)')).toEqual([]);
    expect(call('CALL SUB (N, 1, A)')).toEqual(['call-args: Argument 2 (B) is OUT: pass a variable (HP27-610 §3.2.13.2)']);
    expect(call('CALL SUB (N + 1, F, A)')).toEqual([
      'call-args: Argument 1 (X): only built-in subroutines take expressions; pass a variable or a constant (HP27-610 §3.2.13.2)',
    ]);
  });

  it('wants constant indices', () => {
    expect(call('CALL SUB (A(N), F, A)')).toEqual([
      'call-args: Argument 1 (X): an array element passed to a subroutine needs a constant index (HP27-610 §3.2.13.2)',
    ]);
  });

  it('compares the types of LOCALs and literals', () => {
    expect(call('CALL SUB (F, F, A)')).toEqual(['call-args: Argument 1 (X): type mismatch, the subroutine takes NUMBER and this is LOGICAL']);
    expect(call('CALL SUB (N, F, N)')).toEqual(['call-args: Argument 3 (C): type mismatch, the subroutine takes NUMBER ARRAY and this is NUMBER']);
    expect(call('CALL SUB (A, F, A)')).toEqual(['call-args: Argument 1 (X): type mismatch, the subroutine takes NUMBER and this is NUMBER ARRAY']);
  });

  it('checks built-in subroutines and functions', () => {
    expect(call('CALL SET_BAD (N)\nSET N = MAX(N, 1, 2)')).toEqual([]);
    expect(call('CALL SET_BAD (N, N)')).toEqual(['call-args: Set_Bad(x) takes 1 argument, not 2']);
    expect(call('SET N = ABS(N, 1)')).toEqual(['call-args: Abs(x) takes 1 argument, not 2']);
    // A local array with the name of a built-in is the array.
    expect(call('SET N = SUM(1)', 'LOCAL SUM: ARRAY (1..2) AT NN(9)')).toEqual([]);
  });

  it('does not let a subroutine set an IN argument, or pass on an element of an array argument', () => {
    const sub = (body: string) => found(`SUBROUTINE T (X: NUMBER; Y: OUT NUMBER; Z: IN NUMBER ARRAY (1..2))\n${body}\nEND T\n${SUB}`);
    expect(sub('SET Y = X')).toEqual([]);
    expect(sub('SET X = 1\nSET Y = 0')).toEqual(['argument-mode: X is an IN argument: it can be read, not set (HP27-610 §4.5.1.2)']);
    expect(sub('SET Y = Z(1)\nCALL SUB (Z(1), Y, Z)').filter((m) => /pass on/.test(m))).toEqual([
      'call-args: Argument 1 (X): a subroutine cannot pass on one element of its array argument (HP27-610 §3.2.13.2)',
    ]);
    // Passed where SUB takes OUT (X) and IN OUT (Z): both could be set.
    expect(sub('SET Y = X\nCALL SUB (X, X, Z)').filter((m) => m.startsWith('argument-mode'))).toEqual([
      'argument-mode: X is an IN argument: it can be read, not set (HP27-610 §4.5.1.2)',
      'argument-mode: Z is an IN argument: it can be read, not set (HP27-610 §4.5.1.2)',
    ]);
  });

  it('reports an argument named twice', () => {
    expect(found('SUBROUTINE T (X, X: NUMBER)\nEXIT\nEND T')).toEqual(['duplicate: X is already defined as a subroutine argument on line 1']);
  });
});
describe('lint: line length', () => {
  it('reports code past column 132, which the compiler drops', async () => {
    const { longLines } = await import('../src/language/lint');
    const code = `${' '.repeat(136)}IF A THEN GOTO L`;
    const comment = `    SET A = 1 -- ${'x'.repeat(130)}`;
    const string = `    SEND: "${'-'.repeat(125)}--"`;
    const d = longLines(['    SET A = 1', code, comment, string, ' '.repeat(200)]);
    expect(d.map((x) => [x.range.start.line, x.range.start.character, x.range.end.character, x.code])).toEqual([
      [1, 132, 152, 'line-length'],
      [3, 132, 139, 'line-length'],
    ]);
    expect(d[0].message).toMatch(/^The compiler reads 132 columns and drops the rest of this line/);
  });

  it('takes a lower limit', async () => {
    const { longLines } = await import('../src/language/lint');
    expect(longLines([`    SET A = ${'1 + '.repeat(25)}1`], 95).map((x) => x.message)).toEqual(['This line is longer than 95 characters (amcl.lineLength)']);
  });
});

describe('lint: stray words and undeclared points', () => {
  const found = (body: string, decls = 'EXTERNAL XV1') =>
    check(`SEQUENCE S (HPM; POINT S)\n${decls}\nPHASE P\n${body}\nEND S`).filter((m) => /^(state-change|undeclared-point)/.test(m));

  it('accepts state changes of declared points', () => {
    expect(found('OPEN XV1\nCLOSE XV1 (WHEN ERROR FAIL)')).toEqual([]);
  });

  it('reports a word alone, which is not a statement', () => {
    expect(found('asdf')).toEqual(['state-change: asdf is not a statement; a state change names its points, as in OPEN XV1']);
  });

  it('reports words that read as a state change of an undeclared point', () => {
    expect(found('hello world')).toEqual([
      'state-change: world is not declared EXTERNAL: hello world reads as a state change of point world',
    ]);
    expect(found('OPEN N', 'EXTERNAL XV1\nLOCAL N AT NN(1)')).toEqual(['state-change: N is a LOCAL: a state change sets the OP of a point (HP27-610 §3.2.5)']);
  });

  it('allows at most 16 points in one state change', () => {
    const names = Array.from({ length: 17 }, (_, i) => `V${i}`);
    expect(found(`OPEN ${names.join(', ')}`, `EXTERNAL ${names.join(', ')}`)).toEqual(['state-change: A state change sets at most 16 points (HP27-610 §3.2.5)']);
  });

  it('reports each use of a point without an EXTERNAL', () => {
    expect(found('SET XV2.OP = ON\nIF XV2.PV = ON THEN SET S.NN(1) = 1')).toEqual(['undeclared-point: XV2 is not declared EXTERNAL', 'undeclared-point: XV2 is not declared EXTERNAL']);
    expect(found('SET !BOX.NN(1) = $NM01N05.NN(1)')).toEqual([]);
  });

  it('leaves CL/AM alone, where a state word alone sets the bound point', () => {
    expect(check('BLOCK B (POINT B; AT GENERAL)\nON\nEND B').filter((m) => /^(state-change|undeclared-point)/.test(m))).toEqual([]);
  });
});

describe('lint: undefined names on the right of =', () => {
  const found = (stmt: string) =>
    check(`SEQUENCE S (HPM; POINT S)\nEXTERNAL XV1\nLOCAL N AT NN(1)\nLOCAL F: LOGICAL AT FL(1)\nLOCAL S2: OPEN/CLOSE AT FL(2)\nPHASE P\n${stmt}\nEND S\nSUBROUTINE SUB (A)\nEXIT\nEND SUB`).filter((m) =>
      m.startsWith('undefined'),
    );

  it('wants names declared where a value is needed', () => {
    for (const stmt of ['SET N = qwer', 'SET N = qwer + 1', 'IF qwer THEN EXIT', 'IF N = qwer THEN EXIT', 'WAIT N > qwer', 'SET N = NN(qwer)', 'IF F AND qwer THEN EXIT', 'SET N = ABS(qwer)']) {
      expect(found(stmt), stmt).toEqual(['undefined: Undefined name qwer: not a LOCAL, constant, EXTERNAL or argument']);
    }
  });

  it('knows the states of LOCALs', () => {
    expect(found('SET F = ON\nSET S2 = OPEN\nIF S2 = CLOSE THEN EXIT')).toEqual([]);
    expect(found('SET F = qwer')).toEqual(['undefined: Undefined name qwer: not declared, and not ON or OFF']);
    expect(found('SET S2 = qwer')).toEqual(['undefined: Undefined name qwer: not declared, and not OPEN or CLOSE']);
  });

  it('leaves a name beside a point parameter alone: it may be one of the point\'s states', () => {
    expect(found('SET XV1.OP = qwer\nIF XV1.PV = qwer THEN EXIT\nCALL SUB(qwer)\nSET N = NOW')).toEqual([]);
  });

  it('reports an IF without THEN once, not every word after it', () => {
    // A state written against THEN reads as one name, and the IF loses its THEN.
    const a = analyze('SEQUENCE S (HPM; POINT S)\nEXTERNAL XV1\nPHASE P\nIF XV1.PV=\u05d9\u05d3\u05e0\u05d9THEN\n&  (SET XV1.MODATTR = PROGRAM;\n&  GOTO C)\nC: EXIT\nEND S');
    const errors = [...a.diagnostics, ...lint(a.file, a.binding)].filter((d) => d.severity === 1);
    // A Hebrew state against THEN, then `(`, reads as a call, so the one error is inside it; nothing follows it.
    expect(errors).toHaveLength(1);
    expect([3, 4, 5]).toContain(errors[0].range.start.line);
  });
});

describe('lint: indices of stored-to parameters', () => {
  it('checks the index of an indexed point in a SET target', () => {
    const found = check('SEQUENCE S (HPM; POINT S)\nEXTERNAL ARR\nLOCAL I AT NN(1)\nPHASE P\nSET I = 1\nSET ARR(I).PV = 1\nSET ARR(QWER).PV = 2\nEND S').filter((m) => m.startsWith('undefined'));
    expect(found).toEqual(['undefined: Undefined name QWER: not a LOCAL, constant, EXTERNAL or argument']);
  });
});
