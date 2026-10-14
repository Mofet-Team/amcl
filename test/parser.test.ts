import { describe, expect, it } from 'vitest';
import { Statement, Unit } from '../src/language/ast';
import { parse } from '../src/language/parser';
import { fixture } from './helpers';

const errors = (src: string) => parse(src).diagnostics.filter((d) => d.severity === 1).map((d) => d.message);

function only<K extends Unit['kind']>(src: string, kind: K): Extract<Unit, { kind: K }> {
  const { file, diagnostics } = parse(src);
  expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  expect(file.units[0].kind).toBe(kind);
  return file.units[0] as Extract<Unit, { kind: K }>;
}

const seq = (body: string) => `SEQUENCE S (HPM; POINT S)\nPHASE P\n${body}\nEND S`;
const firstStatement = (body: string): Statement => only(seq(body), 'sequence').phases[0].routine.statements[0];

describe('parser: fixtures', () => {
  it('parses the HPM fixture without diagnostics', () => {
    const { file, diagnostics } = parse(fixture('reactor.cl'));
    expect(diagnostics).toEqual([]);
    expect(file.units.map((u) => [u.kind, u.name?.text])).toEqual([
      ['sequence', 'REACT1'],
      ['handler', 'HLD1'],
      ['handler', 'SHDN1'],
      ['subroutine', 'CHECK'],
    ]);
    const s = file.units[0] as Extract<Unit, { kind: 'sequence' }>;
    expect(s.phases.map((p) => p.name?.text)).toEqual(['PREPARE', 'HEAT']);
    expect(s.phases[0].routine.steps.map((st) => st.name?.text)).toEqual(['ST01', 'ST02']);
    expect(s.phases[0].handlers).toMatchObject([{ type: 'HOLD', name: { text: 'HLD1' } }]);
    expect(s.declarations.map((d) => d.kind)).toEqual(['external', 'local', 'local', 'local', 'local', 'local', 'local', 'constant']);
    const handler = file.units[1] as Extract<Unit, { kind: 'handler' }>;
    expect(handler.iolClause?.name).toBe('INVOKE_IF_ERROR');
    expect(handler.restart?.routine.statements[0].kind).toBe('resume');
  });

  it('parses the AM package fixture without diagnostics', () => {
    const { file, diagnostics } = parse(fixture('package.cl'));
    expect(diagnostics).toEqual([]);
    const pkg = file.units[0] as Extract<Unit, { kind: 'package' }>;
    expect(pkg.units.map((u) => u.kind)).toEqual(['paramList', 'enumeration', 'custom', 'block', 'subroutine']);
    const custom = pkg.units[2] as Extract<Unit, { kind: 'custom' }>;
    expect(custom.declarations).toHaveLength(4);
    expect(custom.declarations[0]).toMatchObject({ kind: 'parameter', description: '"high limit"' });
    const block = pkg.units[3] as Extract<Unit, { kind: 'block' }>;
    expect(block).toMatchObject({ generic: true, order: '1', insertionPoint: { name: 'BACKGRND' }, access: { name: 'PROGRAM' } });
  });
});

describe('parser: statements', () => {
  it('parses a conditional SET', () => {
    const s = firstStatement('SET X = (WHEN A > 1: 1; WHEN OTHERS: 0)');
    expect(s).toMatchObject({ kind: 'set', value: { kind: 'when', arms: [{}, { condition: undefined }] } });
  });

  it('parses WHEN ERROR on SET and the timeout clause on WAIT', () => {
    expect(firstStatement('SET A.OP = 5 (WHEN ERROR GOTO L)')).toMatchObject({ onError: { statement: { kind: 'goto' } } });
    expect(firstStatement('WAIT A.PV > 5 (WHEN 5 MINS: GOTO L) (WHEN ERROR FAIL)')).toMatchObject({
      timeout: { time: { kind: 'time' }, statement: { kind: 'goto' } },
      onError: { statement: { kind: 'fail' } },
    });
  });

  it('keeps an argument list apart from a WHEN ERROR clause after a name', () => {
    expect(firstStatement('SET A = B.PV (WHEN ERROR EXIT)')).toMatchObject({ value: { kind: 'member' }, onError: {} });
  });

  it('parses multi-part time literals', () => {
    const s = firstStatement('WAIT 1 DAYS 2 HOURS (X) MINS 4 SECS');
    expect(s).toMatchObject({ kind: 'wait', value: { kind: 'time', parts: [{ unit: 'DAYS' }, { unit: 'HOURS' }, { unit: 'MINS' }, { unit: 'SECS' }] } });
  });

  it('attaches ELSE lines to the IF before them', () => {
    const s = firstStatement('IF A THEN EXIT\nELSE IF B THEN FAIL\nELSE PAUSE');
    expect(s).toMatchObject({ kind: 'if', branches: [{}, {}], elseBody: [{ kind: 'pause' }] });
    expect(s.endLine).toBe(4);
  });

  it('parses state changes, SEND forms, ENB, INITIATE and READ', () => {
    expect(firstStatement('OPEN V1, V2 (WHEN ERROR GOTO L)')).toMatchObject({ kind: 'stateChange', state: { name: 'OPEN' }, targets: [{}, {}] });
    expect(firstStatement('SEND (WAIT) CRT_ONLY: "x", A')).toMatchObject({ kind: 'send', wait: true, items: [{}, {}] });
    expect(firstStatement('ENB HOLD H1, EMERGENCY E1')).toMatchObject({ handlers: [{ type: 'HOLD' }, { type: 'EMERGENCY' }] });
    expect(firstStatement('INITIATE MIXER: HOLD (WHEN ERROR EXIT)')).toMatchObject({ handlerType: 'HOLD', onError: {} });
    expect(firstStatement('READ NN(1), FL(1) FROM A.PV, $NM10N01.FL(3)')).toMatchObject({ kind: 'read', targets: [{}, {}], sources: [{}, {}] });
  });

  it('accepts a stray semicolon after a statement, as the compiler does', () => {
    expect(errors(seq('SET A = 1;'))).toEqual([]);
  });
});

describe('parser: errors', () => {
  it('reports END names that do not match', () => {
    expect(errors('SEQUENCE S (HPM; POINT S)\nPHASE P\nEXIT\nEND T')).toEqual(['END T does not match SEQUENCE S']);
  });

  it('reports a missing END', () => {
    expect(errors('SUBROUTINE A\nEXIT\nSUBROUTINE B\nEXIT\nEND B')).toEqual(['Missing END A for this SUBROUTINE']);
  });

  it('reports an IF nested in a consequent', () => {
    expect(errors(seq('IF A THEN IF B THEN EXIT'))[0]).toMatch(/IF cannot be nested/);
  });

  it('reports a missing THEN once per statement', () => {
    expect(errors(seq('IF A = B EXIT'))).toEqual(['Expected THEN']);
  });

  it('reports an ELSE with no IF', () => {
    expect(errors(seq('ELSE EXIT'))).toEqual(['ELSE without a matching IF']);
  });

  it('reports statements without a heading once and still parses them', () => {
    const { file, diagnostics } = parse('LOCAL A AT NN(1)\nSET A = 1\nGOTO L\nL: EXIT');
    expect(diagnostics.map((d) => d.message)).toEqual(['Missing SEQUENCE or BLOCK heading before this line']);
    expect(file.units).toHaveLength(1);
  });
});

describe('parser: PHASE headings and RESTART sections', () => {
  const heading = (src: string) => parse(src).diagnostics.filter((d) => d.code === 'heading').map((d) => d.message);

  it('reports clauses a PHASE heading may have once, and KEEPENB with handlers', () => {
    expect(heading('SEQUENCE S (HPM; POINT S)\nPHASE P (ALARM 1 MINS; ALARM 2 MINS)\nEXIT\nEND S')).toEqual(['A PHASE heading has one ALARM clause']);
    expect(heading('SEQUENCE S (HPM; POINT S)\nPHASE P (HOLD A; HOLD B)\nEXIT\nEND S')).toEqual(['HOLD appears twice in this PHASE heading (HP27-610 §4.1.4.2)']);
    expect(heading('SEQUENCE S (HPM; POINT S)\nPHASE P (KEEPENB; HOLD A)\nEXIT\nEND S')).toEqual([
      'A PHASE heading names handlers or KEEPENB, not both (HP27-610 §4.1.4.2)',
    ]);
  });

  it('reports a second RESTART and keeps its statements', () => {
    const { file, diagnostics } = parse('HOLD HANDLER H\nEXIT\nRESTART\nPAUSE\nRESTART\nFAIL\nEND H');
    expect(diagnostics.map((d) => d.message)).toEqual(['A handler has one RESTART section']);
    const h = file.units[0] as Extract<Unit, { kind: 'handler' }>;
    expect(h.restart?.routine.statements.map((s) => s.kind)).toEqual(['pause', 'fail']);
  });
});
