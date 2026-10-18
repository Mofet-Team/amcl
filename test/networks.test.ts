import { describe, expect, it } from 'vitest';
import { analyze } from '../src/language/analyze';
import { parseEb } from '../src/language/eb';
import { parseNcf } from '../src/language/ncf';
import { summarize } from '../src/language/summary';
import { formatBox, WorkspaceIndex } from '../src/language/workspace';

// Two LCNs whose HPMs share numbers: each has an HPM at UCN 01 / node 09, with a box flag FL(21)
// and a valve on channel !DI16S06. UCN numbers are only unique within an LCN.
const point = (name: string, type: string, ucn: number, node: number, extra = '') =>
  `{IDF NET>X>Y.DB, ENTITY ${name}( )}\n&T ${type}\n&N ${name}\nNODETYP  = HPM\nNTWKNUM  = ${ucn}\nNODENUM  = ${node}\n${extra}`;

const dbA = [point('SEQA', 'PRMODNIM', 1, 9), point('VALVEA', 'DICMPNIM', 1, 9, 'DISRC(1) = !DI16S06.PVFL'), point('OTHERA', 'NUMERNIM', 2, 3)].join('\n');
const dbB = [point('SEQB', 'PRMODNIM', 1, 9), point('VALVEB', 'DICMPNIM', 1, 9, 'DISRC(1) = !DI16S06.PVFL'), point('OTHERB', 'NUMERNIM', 5, 3)].join('\n');
const program = (seq: string, valve: string) =>
  `SEQUENCE ${seq} (HPM; POINT ${seq})\nEXTERNAL !BOX, ${valve}, $NM01N09\nLOCAL F: LOGICAL AT !BOX.FL(21)\nPHASE P\nIF ${valve}.PV = OPEN THEN SET F = ON\nSET $NM01N09.FL(22) = ON\nEND ${seq}`;

function build(withNcf: boolean) {
  const index = new WorkspaceIndex();
  index.setPoints([...parseEb(dbA, 'db/A/BC1/a.EB'), ...parseEb(dbB, 'db/B/BC2/b.EB')], (f) => f);
  if (withNcf) {
    const ncf = (ucns: number[]) => `{NETWORK CONFIGURATION FILE}\nSYSTEM DESCRIPTOR : PLANT\n${ucns.map((u) => `UNIVERSAL CONTROL NETWORK : ${u}`).join('\n')}`;
    index.setNetworks([parseNcf(ncf([1, 2, 3]), 'net/A/sys/NCF.XX')!, parseNcf(ncf([1, 5]), 'net/B/sys/NCF.XX')!]);
  }
  const files = { 'A.CL': program('SEQA', 'VALVEA'), 'B.CL': program('SEQB', 'VALVEB') };
  const summaries = Object.fromEntries(Object.entries(files).map(([f, t]) => [f, summarize(analyze(t))]));
  for (const [f, s] of Object.entries(summaries)) index.setFile(f, s);
  /** Storage key of the first storage use on `point` (`!BOX`, `$NM01N09`) in a file. */
  const key = (file: 'A.CL' | 'B.CL', point: string) =>
    index.storageKey(summaries[file].storage.find((u) => u.point === point)!, summaries[file]);
  return { index, key };
}

describe('several LCNs', () => {
  it('keeps HPMs with the same UCN and node number on different LCNs apart', () => {
    const { index, key } = build(false);
    expect(key('A.CL', '!BOX')).toBe('BOX:#1/1:9:FL:21');
    expect(key('B.CL', '!BOX')).toBe('BOX:#2/1:9:FL:21');
    expect(index.storageLocals('BOX:#1/1:9:FL:21').map((l) => l.uri)).toEqual(['A.CL']);
  });

  it('resolves $NMxxNyy on the LCN of the program it is in', () => {
    const { key } = build(false);
    expect(key('A.CL', '$NM01N09')).toBe('BOX:#1/1:9:FL:22');
    expect(key('B.CL', '$NM01N09')).toBe('BOX:#2/1:9:FL:22');
  });

  it('keeps hardware channels of different LCNs apart', () => {
    const { index } = build(false);
    const own = index.boxOfProgram('SEQA')!;
    expect(index.hardwareUses('!DI16S06', own).map((u) => u.point.name)).toEqual(['VALVEA']);
    expect(index.hardwareUses('!DI16S06').map((u) => u.point.name).sort()).toEqual(['VALVEA', 'VALVEB']);
  });

  it('names LCNs from network configuration files by their UCN numbers', () => {
    const { index, key } = build(true);
    expect(key('A.CL', '!BOX')).toBe('BOX:A/1:9:FL:21');
    expect(key('B.CL', '!BOX')).toBe('BOX:B/1:9:FL:21');
    expect(index.networkOf(index.point('VALVEB')!)).toBe('B');
    expect(formatBox(index.boxOfPoint(index.point('VALVEA')!)!)).toBe('HPM 01/09 (LCN A)');
  });

  it('puts folders on one LCN when a program references points in both', () => {
    const index = new WorkspaceIndex();
    index.setPoints([...parseEb(point('P1', 'DICMPNIM', 1, 9), 'db/X1/a.EB'), ...parseEb(point('P2', 'DICMPNIM', 2, 4), 'db/X2/b.EB')], (f) => f);
    index.setFile('AM.CL', summarize(analyze('BLOCK B (POINT AMPT; AT BACKGRND)\nEXTERNAL P1, P2\nSET P1.MODATTR, P2.MODATTR = PROGRAM\nEND B')));
    expect(index.networkOf(index.point('P1')!)).toBe(index.networkOf(index.point('P2')!));
  });
});

describe('several LCNs: programs the database does not place', () => {
  it('puts a CL/AM block on the LCN of the points it uses, and leaves one that uses none unplaced', async () => {
    const { programItems } = await import('../src/server/programs');
    const { index } = build(true);
    index.setFile('AM1.CL', summarize(analyze('BLOCK W1 (POINT AM1; AT GENERAL)\nEXTERNAL VALVEB\nIF VALVEB.PV = OPEN THEN EXIT\nEND W1')));
    index.setFile('AM2.CL', summarize(analyze('BLOCK W2 (POINT AM2; AT GENERAL)\nEXIT\nEND W2')));
    const items = programItems(index);
    expect(items.find((p) => p.name === 'W1')).toMatchObject({ lcn: 'B', hpm: 'CL/AM' });
    expect(items.find((p) => p.name === 'W2')).toMatchObject({ hpm: 'CL/AM' });
    expect(items.find((p) => p.name === 'W2')!.lcn).toBeUndefined();
    expect(items.find((p) => p.name === 'SEQA')).toMatchObject({ lcn: 'A', hpm: 'HPM 01/09' });
  });
});
