import { describe, expect, it } from 'vitest';
import { DocumentSymbol, FoldingRangeKind } from 'vscode-languageserver';
import { analyze } from '../src/language/analyze';
import { foldingRanges } from '../src/server/features/folding';
import { definition, documentHighlights, references } from '../src/server/features/navigation';
import { hover } from '../src/server/features/hover';
import { documentSymbols } from '../src/server/features/outline';
import { unusedSymbols } from '../src/language/lint';
import { WorkspaceIndex } from '../src/language/workspace';
import { summarize } from '../src/language/summary';
import { fixture, pos } from './helpers';

const tree = (syms: DocumentSymbol[]): unknown[] =>
  syms.map((s) => (s.children?.length ? { [s.name]: tree(s.children) } : s.name));

describe('outline', () => {
  it('lists phases beside the sequence, nests steps and labels, and groups long EXTERNAL and LOCAL lists', () => {
    const a = analyze(fixture('reactor.cl'));
    const syms = documentSymbols(a.binding.symbols, a.file.units);
    expect(tree(syms)).toEqual([
      {
        REACT1: [
          { EXTERNAL: ['!BOX', '$NM01N05', 'FV101', 'PUMP1', 'TI100', 'REACT2'] },
          {
            LOCAL: [
              { 'Box flags': ['FAGIT'] },
              { Numerics: ['NBATCH', 'I'] },
              { Flags: ['STATES'] },
              { Times: ['T1'] },
              { 'In other sequences': ['NTEMP'] },
              { Constants: ['TMAX'] },
            ],
          },
        ],
      },
      { PREPARE: [{ ST01: ['HOT'] }, { ST02: ['LOOP1'] }] },
      'HEAT',
      'HLD1',
      'SHDN1',
      { CHECK: ['N', 'F'] },
    ]);
  });

  it('gives every symbol a selection range inside its range', () => {
    const check = (s: DocumentSymbol) => {
      expect(s.selectionRange.start.line).toBeGreaterThanOrEqual(s.range.start.line);
      expect(s.selectionRange.end.line).toBeLessThanOrEqual(s.range.end.line);
      s.children?.forEach(check);
    };
    for (const f of ['reactor.cl', 'package.cl']) {
      const a = analyze(fixture(f));
      documentSymbols(a.binding.symbols, a.file.units).forEach(check);
    }
  });

  it('labels unused names "unused" in the outline', () => {
    const a = analyze(fixture('reactor.cl'));
    const syms = documentSymbols(a.binding.symbols, a.file.units, unusedSymbols(a.binding));
    const flat = (xs: DocumentSymbol[]): DocumentSymbol[] => xs.flatMap((x) => [x, ...flat(x.children ?? [])]);
    const all = flat(syms);
    expect(all.find((x) => x.name === 'STATES')!.detail).toBe('unused · OPEN/CLOSE AT FL(2)');
    expect(all.find((x) => x.name === '$NM01N05')!.detail).toBe('unused · external point');
    expect(all.find((x) => x.name === 'NBATCH')!.detail).toBe('NUMBER AT NN(1)');
  });

  it('shows storage slots as detail', () => {
    const syms = documentSymbols(analyze(fixture('reactor.cl')).binding.symbols);
    const boxFlags = syms[0].children!.find((c) => c.name === 'LOCAL')!.children!.find((c) => c.name === 'Box flags')!;
    const fagit = boxFlags.children!.find((c) => c.name === 'FAGIT')!;
    expect(fagit.detail).toBe('LOGICAL AT !BOX.FL(21)');
  });

  it('splits LOCALs into named storage groups and lists box timers', () => {
    const src = [
      'SEQUENCE S (HPM; POINT S)',
      'EXTERNAL !BOX, OTHER',
      ...[1, 2, 3].map((i) => `LOCAL BF${i}: LOGICAL AT !BOX.FL(${i})`),
      ...[1, 2, 3, 4].map((i) => `LOCAL N${i} AT NN(${i})`),
      ...[1, 2].map((i) => `LOCAL BN${i} AT !BOX.NN(${i})`),
      'LOCAL X AT OTHER.NN(41)',
      'LOCAL K = 5',
      'PHASE P',
      'SET !BOX.TMCMD(2) = START',
      'WAIT !BOX.TMPV(2) > 10',
      'SET $NM03N09.TMSP(5) = 30',
      'SET !BOX.TMCMD(02) = STOP',
      'END S',
    ].join('\n');
    const a = analyze(src);
    const seq = documentSymbols(a.binding.symbols, a.file.units)[0];
    const locals = seq.children!.find((c) => c.name === 'LOCAL')!;
    expect(locals.detail).toBe('11 variables');
    expect(tree(locals.children!)).toEqual([
      { 'Box numerics': ['BN1', 'BN2'] },
      { 'Box flags': ['BF1', 'BF2', 'BF3'] },
      { Numerics: ['N1', 'N2', 'N3', 'N4'] },
      { 'In other sequences': ['X'] },
      { Constants: ['K'] },
    ]);
    const timers = seq.children!.find((c) => c.name === 'TIMERS')!;
    // The TIMERS node must not span the phases between timer uses ("Follow Cursor").
    expect(timers.range).toEqual(timers.children![0].range);
    expect(timers.children!.map((t) => `${t.name} (${t.detail})`)).toEqual([
      'timer 2 (TMCMD, TMPV)',
      '$NM03N09 timer 5 (TMSP)',
    ]);
  });
});

describe('folding', () => {
  const text = fixture('reactor.cl');
  const ranges = foldingRanges(analyze(text).file);

  it('folds units, phases, steps, the header comment and declarations', () => {
    const at = (needle: string) => ranges.find((r) => r.startLine === pos(text, needle).line);
    expect(at('SEQUENCE REACT1')).toMatchObject({ endLine: pos(text, 'END REACT1').line });
    expect(at('PHASE PREPARE')).toMatchObject({ endLine: pos(text, 'GOTO PHASE HEAT').line });
    expect(at('STEP ST01')).toMatchObject({ endLine: pos(text, 'HOT:').line });
    expect(at('EXTERNAL')).toMatchObject({ kind: FoldingRangeKind.Imports, endLine: pos(text, 'LOCAL TMAX').line });
    expect(at('IF NTEMP')).toMatchObject({ endLine: pos(text, 'ELSE GOTO HOT').line });
  });

  it('never reports two ranges on one line', () => {
    const starts = ranges.map((r) => r.startLine);
    expect(new Set(starts).size).toBe(starts.length);
  });
});

describe('navigation', () => {
  const text = fixture('reactor.cl');
  const { binding } = analyze(text);

  it('goes to a definition', () => {
    expect(definition(binding, 'u', pos(text, 'GOTO STEP ST01', 0, 10))?.range.start).toEqual(pos(text, 'ST01'));
  });

  it('finds references with and without the declaration', () => {
    const at = pos(text, 'PUMP1', 1);
    expect(references(binding, 'u', at, true)).toHaveLength(4);
    expect(references(binding, 'u', at, false)).toHaveLength(3);
  });

  it('highlights unresolved names such as enumeration states by name', () => {
    expect(documentHighlights(binding, pos(text, 'PROGRAM'))).toHaveLength(1);
    expect(documentHighlights(binding, pos(text, 'STOP PUMP1'))).toHaveLength(2);
  });
});

describe('hover without a workspace', () => {
  const text = fixture('reactor.cl');
  const analysis = analyze(text);
  const at = (needle: string, occurrence = 0, offset = 0) => {
    const h = hover(
      { uri: 'u', analysis, summary: summarize(analysis), index: new WorkspaceIndex(), lines: text.split('\n'), display: (u) => u },
      pos(text, needle, occurrence, offset),
    );
    return h && (h.contents as { value: string }).value;
  };

  it('shows built-in functions', () => {
    expect(at('BADVAL')).toBe('```cl\nBadval(x)\n```\n\nON when x is bad (NaN). Conditions only: cannot be stored or sent.');
  });

  it('shows a LOCAL with its type spelled out, and its comment', () => {
    expect(at('NBATCH', 1)).toBe('```cl\nNBATCH: NUMBER AT NN(1)\n```\n\n---\n\nStorage: REACT1.NN(1)');
    expect(at('FAGIT', 2)).toContain('```cl\nFAGIT: LOGICAL AT !BOX.FL(21)\n```\n\nbox flag');
  });

  it("shows a parameter's meaning and fixed states", () => {
    expect(at('FV101.MODATTR', 0, 7)).toContain('**FV101.MODATTR** · Enumeration');
  });
});

describe('outline: CL words', () => {
  it('names structural entries with their CL word, since the tooltip shows the LSP kind', async () => {
    const { analyze } = await import('../src/language/analyze');
    const { documentSymbols } = await import('../src/server/features/outline');
    const a = analyze(
      'SEQUENCE S (HPM; POINT S)\nPHASE P (KEEPENB)\nSTEP A\nL: EXIT\nPHASE Q (HOLD H; SHUTDOWN D)\nEXIT\nEND S\nHOLD HANDLER H\nEXIT\nEND H\nSHUTDOWN HANDLER D\nEXIT\nEND D\nSUBROUTINE SUB\nEXIT\nEND SUB',
    );
    const flat = (ss: any[]): any[] => ss.flatMap((x) => [x, ...flat(x.children ?? [])]);
    const detail = (name: string) => flat(documentSymbols(a.binding.symbols, a.file.units)).find((x) => x.name === name)?.detail;
    expect(detail('S')).toBe('SEQUENCE · HPM; POINT S');
    expect(detail('P')).toBe('PHASE · KEEPENB');
    expect(detail('Q')).toBe('PHASE · HOLD H; SHUTDOWN D');
    expect(detail('D')).toBe('SHUTDOWN HANDLER');
    expect(detail('A')).toBe('STEP');
    expect(detail('L')).toMatch(/^(unused · )?label$/);
    expect(detail('H')).toBe('HOLD HANDLER');
    expect(detail('SUB')).toMatch(/^(unused · )?SUBROUTINE$/);
  });
});
