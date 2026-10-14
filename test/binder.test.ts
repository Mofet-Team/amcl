import { describe, expect, it } from 'vitest';
import { analyze } from '../src/language/analyze';
import { referenceAt, referencesTo } from '../src/language/binder';
import { fixture, lineOf, pos } from './helpers';

/** Where the name at `needle` (occurrence n) resolves to, as the text of the defining line. */
function resolve(text: string, needle: string, occurrence = 0): string | undefined {
  const { binding } = analyze(text);
  const ref = referenceAt(binding, pos(text, needle, occurrence));
  return ref?.symbol && lineOf(text, ref.symbol.ident.range.start).trim();
}

describe('binder: HPM sequence', () => {
  const text = fixture('reactor.cl');

  it('has no diagnostics on the fixture', () => {
    expect(analyze(text).diagnostics).toEqual([]);
  });

  it('resolves a GOTO to a label in the same step', () => {
    expect(resolve(text, 'HOT', 0)).toBe('HOT: SEND (WAIT): "Temperature ""high"""');
  });

  it('resolves a GOTO to a label in another step of the phase', () => {
    expect(resolve(text, 'HOT', 2)).toBe('HOT: SEND (WAIT): "Temperature ""high"""');
  });

  it('resolves GOTO STEP, GOTO PHASE and RESUME PHASE', () => {
    expect(resolve(text, 'ST01', 1)).toBe('STEP ST01');
    expect(resolve(text, 'HEAT', 0)).toBe('PHASE HEAT (KEEPENB)');
    expect(resolve(text, 'PREPARE', 1)).toBe('PHASE PREPARE (ALARM 5 MINS; HOLD HLD1)');
  });

  it('resolves handler names in ENB and PHASE headings', () => {
    expect(resolve(text, 'HLD1', 0)).toBe('HOLD HANDLER HLD1 (WHEN FAGIT = ON; INVOKE_IF_ERROR)');
    expect(resolve(text, 'SHDN1', 0)).toBe('SHUTDOWN HANDLER SHDN1');
  });

  it('resolves CALL, REPEAT, LOOP counters and END', () => {
    expect(resolve(text, 'CHECK', 0)).toBe('SUBROUTINE CHECK (N: IN NUMBER; F: OUT LOGICAL)');
    expect(resolve(text, 'LOOP1', 1)).toBe('LOOP1: LOOP FOR I IN 1..5');
    expect(resolve(text, 'REACT1', 2)).toBe('SEQUENCE REACT1 (HPM; POINT REACT1)');
  });

  it('resolves locals, constants and externals, including from handlers and subroutines', () => {
    expect(resolve(text, 'NBATCH', 1)).toBe('LOCAL NBATCH AT NN(1)');
    expect(resolve(text, 'TMAX', 1)).toBe('LOCAL TMAX = 85.5');
    expect(resolve(text, 'TI100', 1)).toBe('&       TI100, REACT2');
    expect(resolve(text, 'REACT2', 1)).toBe('&       TI100, REACT2');
    expect(resolve(text, 'FAGIT', 4)).toBe('LOCAL FAGIT: LOGICAL AT !BOX.FL(21)   -- box flag');
    expect(resolve(text, 'TMAX', 2)).toBe('LOCAL TMAX = 85.5');
  });

  it('resolves subroutine arguments inside the subroutine', () => {
    expect(resolve(text, 'N >', 0)).toBe('SUBROUTINE CHECK (N: IN NUMBER; F: OUT LOGICAL)');
  });

  it('finds every reference to a local', () => {
    const { binding } = analyze(text);
    const ref = referenceAt(binding, pos(text, 'NBATCH'))!;
    expect(referencesTo(binding, ref.symbol!).length).toBe(7);
  });
});

describe('binder: AM package', () => {
  const text = fixture('package.cl');

  it('has no diagnostics on the fixture', () => {
    expect(analyze(text).diagnostics).toEqual([]);
  });

  it('resolves CDS parameters, enumeration states and parameter list types from a block', () => {
    expect(resolve(text, 'LIMIT', 1)).toBe('PARAMETER LIMIT "high limit"');
    expect(resolve(text, 'SHADE', 1)).toBe('PARAMETER SHADE: COLOR');
    expect(resolve(text, 'RED', 1)).toBe('ENUMERATION COLOR = RED/GREEN/BLUE');
    expect(resolve(text, 'VALVE', 1)).toBe('PARAM_LIST VALVE');
    expect(resolve(text, 'COLOR', 1)).toBe('ENUMERATION COLOR = RED/GREEN/BLUE');
  });

  it('resolves DEFINE functions, their arguments, off-LCN externals and CALL', () => {
    expect(resolve(text, 'DIST', 1)).toBe('DEFINE DIST(P, Q) = SQRT(P * P + Q * Q)');
    expect(resolve(text, 'P * P', 0)).toBe('DEFINE DIST(P, Q) = SQRT(P * P + Q * Q)');
    expect(resolve(text, 'NET\\B200', 1)).toBe('EXTERNAL A100, NET\\B200');
    expect(resolve(text, 'LOG_IT', 0)).toBe('SUBROUTINE LOG_IT (V: IN NUMBER)');
  });
});

describe('checks', () => {
  it('reports undefined control-flow names', () => {
    const src = 'SEQUENCE S (HPM; POINT S)\nPHASE P (HOLD H9)\nGOTO NOWHERE\nGOTO STEP X\nGOTO PHASE Q\nCALL SUB\nCALL SET_BAD(A)\nCALL FILE$OPEN(A)\nEND S';
    expect(analyze(src).diagnostics.map((d) => d.message)).toEqual([
      "Undefined handler 'H9'",
      "Undefined label 'NOWHERE'",
      "Undefined step 'X'",
      "Undefined phase 'Q'",
      "Undefined subroutine 'SUB'",
    ]);
  });
});
