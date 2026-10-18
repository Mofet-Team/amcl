import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/language/analyze';
import { parseEb } from '../src/language/eb';
import { summarize } from '../src/language/summary';
import { Location, WorkspaceIndex } from '../src/language/workspace';
import { crossDefinition, targetAt, workspaceSymbols } from '../src/server/features/crossfile';
import { complete } from '../src/server/features/completion';
import { hover } from '../src/server/features/hover';
import { pos } from './helpers';

const dir = path.join(__dirname, 'fixtures', 'ws');
const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
const FILES = ['MIXER.CL', 'DOSER.CL', 'AMBLK.CL'];

function build(withDatabase: boolean) {
  const index = new WorkspaceIndex();
  const analyses = new Map(FILES.map((f) => [f, analyze(read(f))]));
  const summaries = new Map(FILES.map((f) => [f, summarize(analyses.get(f)!)]));
  for (const f of FILES) index.setFile(f, summaries.get(f)!);
  if (withDatabase) index.setPoints(parseEb(read('db/HPM09.EB'), 'HPM09.EB'), (f) => f);
  /** The workspace target under the `occurrence`-th `needle` in `file`, offset into it. */
  const target = (file: string, needle: string, occurrence = 0, offset = 0) =>
    targetAt(analyses.get(file)!, summaries.get(file)!, index, pos(read(file), needle, occurrence, offset));
  /** Hover text at the `occurrence`-th `needle` in `file`. */
  const hoverAt = (file: string, needle: string, occurrence = 0, offset = 0) => {
    const h = hover(
      { uri: file, analysis: analyses.get(file)!, summary: summaries.get(file)!, index, lines: read(file).split('\n'), display: (u) => u },
      pos(read(file), needle, occurrence, offset),
    );
    return h && (h.contents as { value: string }).value;
  };
  return { index, target, hoverAt };
}

/**
 * Completion labels for a document whose text has `|` where the cursor is, analysed against
 * the fixture workspace (with the point database).
 */
function completeAt(source: string): { labels: string[]; items: ReturnType<typeof complete>['items'] } {
  const { index } = build(true);
  const lines = source.split('\n');
  const line = lines.findIndex((l) => l.includes('|'));
  const character = lines[line].indexOf('|');
  lines[line] = lines[line].replace('|', '');
  const result = complete({ analysis: analyze(lines.join('\n')), index, lines }, { line, character });
  const sorted = [...result.items].sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label));
  return { labels: sorted.map((i) => i.label), items: sorted };
}

const program = (body: string) =>
  [
    'SEQUENCE MIXER (HPM; POINT MIXER)',
    'EXTERNAL !BOX, XV1, DOSER',
    'LOCAL RUNNING: LOGICAL AT !BOX.FL(21)   -- agitator running',
    'LOCAL COUNT AT NN(3)',
    'PHASE FILL',
    'STEP S1',
    'AGAIN: SET COUNT = COUNT + 1',
    'STEP S2',
    body,
    'END MIXER',
  ].join('\n');

/** `FILE:line: text` for each location, sorted, for readable assertions. */
function show(locs: Location[]): string[] {
  return locs
    .map((l) => {
      if (l.uri === 'HPM09.EB') return `EB:${read('db/HPM09.EB').split('\n')[l.range.start.line].trim()}`;
      const line = read(l.uri).split('\n')[l.range.start.line];
      return `${l.uri}:${line.slice(l.range.start.character, l.range.end.character)}`;
    })
    .sort();
}

describe('workspace index with a point database', () => {
  const { index, target } = build(true);

  it('resolves !BOX, $NMxxNyy, $NMxxByy and a Flag point to one box element', () => {
    const t = target('MIXER.CL', 'FL(21)');
    expect(t).toEqual({ kind: 'storage', key: 'BOX:/1:9:FL:21' });
    expect(index.describeKey('BOX:/1:9:FL:21')).toBe('HPM 01/09 box FL(21)');
    expect(target('DOSER.CL', 'FL(21)')).toEqual(t);
    expect(target('AMBLK.CL', 'FL(21)')).toEqual(t);
  });

  it('finds every LOCAL mapped onto a box element, and the database point', () => {
    const t = target('MIXER.CL', 'AGITATE', 1)!;
    expect(t).toEqual({ kind: 'storage', key: 'BOX:/1:9:FL:21' });
    expect(show(index.storageDefinitions((t as { key: string }).key))).toEqual([
      'DOSER.CL:READY',
      'EB:&N AGIT_ON',
      'MIXER.CL:AGITATE',
    ]);
  });

  it('finds every access to a box element under any name', () => {
    expect(show(index.storageReferences('BOX:/1:9:FL:21', false))).toEqual([
      'AMBLK.CL:FL(21)',
      'DOSER.CL:READY',
      'MIXER.CL:AGITATE',
    ]);
    expect(show(index.storageReferences('BOX:/1:9:FL:21', true))).toEqual([
      'AMBLK.CL:FL(21)',
      'DOSER.CL:FL(21)',
      'DOSER.CL:READY',
      'DOSER.CL:READY',
      'EB:&N AGIT_ON',
      'MIXER.CL:AGITATE',
      'MIXER.CL:AGITATE',
      'MIXER.CL:FL(21)',
    ]);
  });

  it("links a LOCAL on another sequence's slot to that sequence's LOCAL and direct uses", () => {
    const t = target('MIXER.CL', 'DOSE_QTY', 1)!;
    expect(t).toEqual({ kind: 'storage', key: 'PM:DOSER:NN:5' });
    expect(show(index.storageReferences('PM:DOSER:NN:5', false))).toEqual([
      'AMBLK.CL:NN(5)',
      'DOSER.CL:NN(5)',
      'DOSER.CL:QTY',
      'MIXER.CL:DOSE_QTY',
    ]);
  });

  it('treats a box Numeric point PV as its box element', () => {
    expect(target('MIXER.CL', 'TANK_LVL.PV', 0, 9)).toEqual({ kind: 'storage', key: 'BOX:/1:9:NN:300' });
    expect(target('MIXER.CL', 'LEVEL', 1)).toEqual({ kind: 'storage', key: 'BOX:/1:9:NN:300' });
  });

  it('maps an Array point without external data onto the box', () => {
    expect(target('MIXER.CL', 'FL(2)')).toEqual({ kind: 'storage', key: 'BOX:/1:9:FL:1002' });
    expect(target('DOSER.CL', 'FL(1002)')).toEqual({ kind: 'storage', key: 'BOX:/1:9:FL:1002' });
  });

  it('goes from a point name to its program and its database record', () => {
    expect(target('MIXER.CL', 'DOSER', 2)).toEqual({ kind: 'point', name: 'DOSER' });
    expect(show(index.pointDefinitions('DOSER'))).toEqual(['DOSER.CL:DOSER', 'EB:&N DOSER']);
    expect(show(index.pointReferences('DOSER', false))).toEqual([
      'AMBLK.CL:DOSER', // SET DOSER.NN(5)
      'DOSER.CL:DOSER', // POINT DOSER in the heading
      'MIXER.CL:DOSER', // LOCAL DOSE_QTY AT DOSER.NN(5)
      'MIXER.CL:DOSER', // INITIATE DOSER
    ]);
  });

  it('goes from a hardware channel to the database entries of the points on it', () => {
    const { index } = build(true);
    const text = read('DOSER.CL');
    const a = analyze(text);
    const at = pos(text, '!DI11S01', 1);
    const target = targetAt(a, summarize(a), index, at);
    expect(target).toEqual({ kind: 'point', name: '!DI11S01' });
    expect(show(crossDefinition(target, index, a, at))).toEqual(['EB:&N XV1']);
  });

  it('finds points by I/O address in workspace symbols', () => {
    const found = (q: string) => workspaceSymbols(index, q).map((s) => `${s.name} ${s.containerName}`);
    expect(found('DI11S0')).toEqual(['XV1 !DI11S01.PVFL · HPM 01/09 · DICMPNIM FEED VALVE']);
    expect(found('!AI03S12')).toEqual(['FT100 !AI03S12 · HPM 01/09 · ANINNIM FEED FLOW']);
  });

  it('searches programs, phases and database points', () => {
    const names = (q: string) => workspaceSymbols(index, q).map((s) => `${s.name}:${s.kind}`);
    expect(names('dose')).toEqual(['DOSER:2', 'DOSE:5', 'DOSER:19']);
    expect(names('AGT')).toEqual(['AGIT_ON:19']);
  });
});

describe('hover', () => {
  const { hoverAt } = build(true);

  it('shows a LOCAL, its storage, the database point and its other names', () => {
    const h = hoverAt('MIXER.CL', 'AGITATE', 1)!;
    expect(h).toContain('AGITATE: LOGICAL AT !BOX.FL(21)');
    expect(h).toContain('Storage: HPM 01/09 box FL(21)');
    expect(h).toContain('Point **AGIT_ON**: AGITATOR RUN REQUEST');
    expect(h).toContain('Also mapped as `READY` in [DOSER.CL:3](DOSER.CL#L3)');
    expect(h).not.toContain('`AGITATE` in');
  });

  it("shows a point's type, descriptor, location and database entry", () => {
    const h = hoverAt('MIXER.CL', 'TANK_LVL', 1)!;
    expect(h).toContain('**TANK_LVL** · Numeric (box variable)');
    expect(h).toContain('TANK LEVEL');
    expect(h).toContain('HPM 01/09 · NN(300) · EU %');
    expect(h).toContain('Defined in [HPM09.EB:');
  });

  it('shows the I/O channel of an I/O point instead of its controller slot', () => {
    const h = hoverAt('MIXER.CL', 'FT100', 1)!;
    expect(h).toContain('**FT100** · Analog Input');
    expect(h).toContain('HPM 01/09 · I/O `!AI03S12` (HLAI) · EU M3/H');
    expect(h).not.toContain('slot');
  });

  it('shows the I/O wiring of a DigComp', () => {
    const h = hoverAt('MIXER.CL', 'CLOSE XV1', 0, 6)!;
    expect(h).toContain('In: `!DI11S01.PVFL`, `!DI11S02.PVFL` · Out: `!DO33S01.SO`');
    expect(h).not.toContain('slot');
  });

  it('shows what is connected to a hardware channel in this HPM', () => {
    const h = hoverAt('DOSER.CL', '!DI11S01', 1)!;
    expect(h).toBe(
      '**!DI11S01** · Digital input card 11, channel 01 in HPM 01/09\n\n' +
        '- **XV1** · Digital Composite, input .PVFL · FEED VALVE',
    );
  });

  it('shows the program bound to a sequence point', () => {
    const h = hoverAt('MIXER.CL', 'INITIATE DOSER', 0, 10)!;
    expect(h).toContain('**DOSER** · Process Module (sequence slot)');
    expect(h).toContain('SEQUENCE DOSER in [DOSER.CL:1](DOSER.CL#L1)');
  });

  it('shows the storage element, not the parameter, on a slot', () => {
    expect(hoverAt('MIXER.CL', 'DOSER.NN', 0, 6)).toContain('**DOSER.NN(5)**');
  });

  it('shows a box element under the cursor in an expression', () => {
    const h = hoverAt('AMBLK.CL', 'FL(21)')!;
    expect(h).toContain('**HPM 01/09 box FL(21)**');
    expect(h).toContain('`AGITATE` in');
    expect(h).toContain('`READY` in');
  });

  it('treats PV of a box Numeric point as its box element', () => {
    const h = hoverAt('MIXER.CL', 'TANK_LVL.PV', 0, 9)!;
    expect(h).toContain('**HPM 01/09 box NN(300)**');
    expect(h).toContain('Point **TANK_LVL**: TANK LEVEL');
    expect(h).toContain('`LEVEL` in');
  });

  it('shows the declaration of other symbols', () => {
    expect(hoverAt('MIXER.CL', 'PHASE RUN', 0, 6)).toBe('```cl\nPHASE RUN\n```');
  });
});

describe('completion', () => {
  it("offers a DigComp's own states after OP = and PV <>", () => {
    expect(completeAt(program('SET XV1.OP = |')).labels).toEqual(['CLOSE', 'OPEN']);
    expect(completeAt(program('WAIT XV1.PV <> |')).labels).toEqual(['CLOSE', 'OPEN', 'MOVING', 'BAD']);
    expect(completeAt(program('SET XV1.MODATTR, DOSER.FL(2) = |')).labels).toEqual(['ON', 'OFF']);
  });

  it('offers standard enumerations', () => {
    expect(completeAt(program('SET XV1.MODATTR = PR|')).labels).toEqual(['OPERATOR', 'PROGRAM', 'NORMAL', 'NONE']);
    expect(completeAt(program('SET DOSER.PROCMOD = |')).labels).toContain('NORM');
    expect(completeAt(program('SET !BOX.TMCMD(2) = |')).labels).toEqual(['NONE', 'START', 'STOP', 'RESET', 'RESTSTRT']);
  });

  it("offers a point type's parameters after a dot", () => {
    const { labels, items } = completeAt(program('SET XV1.|'));
    expect(labels).toEqual(expect.arrayContaining(['MODATTR', 'OP', 'PV', 'CMDDISFL']));
    expect(items.find((i) => i.label === 'MODATTR')!.documentation).toMatchObject({ value: expect.stringContaining('PROGRAM') });
    // Workspace use ranks parameters: MIXER.CL and AMBLK.CL use DOSER.NN most.
    expect(completeAt(program('SET DOSER.|')).labels[0]).toBe('NN');
    expect(completeAt(program('SET !BOX.|')).labels).toEqual(expect.arrayContaining(['TMCMD', 'TMPV', 'NN', 'FL']));
  });

  it('offers points that have a state after a state word', () => {
    expect(completeAt(program('CLOSE |')).labels[0]).toBe('XV1');
  });

  it('offers database points of the same HPM on an EXTERNAL line, without declared ones', () => {
    const { labels, items } = completeAt(program('').replace('EXTERNAL !BOX, XV1, DOSER', 'EXTERNAL !BOX, XV1, DOSER, |'));
    expect(labels).toEqual(['AGIT_ON', 'ARR1', 'FT100', 'MIXER', 'TANK_LVL']);
    expect(items.find((i) => i.label === 'TANK_LVL')!.detail).toBe('TANK LEVEL · Numeric (box variable)');
  });

  it('offers labels, steps and phases after GOTO', () => {
    expect(completeAt(program('GOTO |')).labels).toEqual(['AGAIN', 'PHASE', 'STEP']);
    expect(completeAt(program('GOTO STEP |')).labels).toEqual(['S1', 'S2']);
    expect(completeAt(program('GOTO PHASE |')).labels).toEqual(['FILL']);
  });

  it('shows how each LOCAL is mapped, and its comment', () => {
    const local = completeAt(program('SET |')).items.find((i) => i.label === 'RUNNING')!;
    expect(local.detail).toBe('LOGICAL AT !BOX.FL(21)');
    expect(local.documentation).toBe('agitator running');
    const point = completeAt(program('SET |')).items.find((i) => i.label === 'XV1')!;
    expect(point.detail).toBe('FEED VALVE · Digital Composite');
  });

  it('offers nothing in strings and comments', () => {
    expect(completeAt(program('SEND: "XV1.|"')).labels).toEqual([]);
    expect(completeAt(program('EXIT -- XV1.|')).labels).toEqual([]);
  });
});

describe('workspace index without a point database', () => {
  const { target } = build(false);

  it('infers that two sequences share an HPM from a LOCAL on the other sequence', () => {
    const mixer = target('MIXER.CL', 'FL(21)');
    expect(mixer).toMatchObject({ kind: 'storage', key: expect.stringMatching(/^BOX:G/) });
    expect(target('DOSER.CL', 'FL(21)')).toEqual(mixer);
  });

  it('does not treat PV of an unknown point as storage', () => {
    expect(target('MIXER.CL', 'TANK_LVL.PV', 0, 9)).toBeUndefined();
  });
});

describe('CL Programs view data', () => {
  it('places programs in their HPM, lists their parts, and reads their listings', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { analyze } = await import('../src/language/analyze');
    const { parseEb } = await import('../src/language/eb');
    const { summarize } = await import('../src/language/summary');
    const { WorkspaceIndex } = await import('../src/language/workspace');
    const { programItems, programParts, programStatus } = await import('../src/server/programs');
    const { parseListing } = await import('../src/language/listing');
    const ws = path.join(__dirname, 'fixtures', 'ws');
    const index = new WorkspaceIndex();
    index.setPoints(parseEb(fs.readFileSync(path.join(ws, 'db', 'HPM09.EB'), 'utf8'), 'HPM09.EB'), (f) => f);
    for (const f of ['MIXER.CL', 'DOSER.CL', 'AMBLK.CL']) index.setFile(`file:///${f}`, summarize(analyze(fs.readFileSync(path.join(ws, f), 'utf8'))));

    const items = programItems(index).sort((a, b) => a.name.localeCompare(b.name));
    expect(items.map((p) => [p.name, p.kind, p.hpm])).toEqual([
      ['DOSER', 'sequence', 'HPM 01/09'],
      ['MIXER', 'sequence', 'HPM 01/09'],
      ['WATCH', 'block', 'CL/AM'],
    ]);

    const reactor = summarize(analyze(fs.readFileSync(path.join(__dirname, 'fixtures', 'reactor.cl'), 'utf8')));
    const parts = programParts(reactor, 'REACT1');
    expect(parts.map((p) => [p.kind, p.name, p.detail ?? '', (p.children ?? []).map((c) => c.name).join(',')])).toEqual([
      ['phase', 'PREPARE', '', 'ST01,ST02'],
      ['phase', 'HEAT', '', ''],
      ['handler', 'HLD1', 'HOLD HANDLER', ''],
      ['handler', 'SHDN1', 'SHUTDOWN HANDLER', ''],
      ['subroutine', 'CHECK', '', ''],
    ]);

    const le = parseListing(fs.readFileSync(path.join(__dirname, 'fixtures', 'listing', 'VALVE.LE'), 'utf8'));
    const valve = fs.readFileSync(path.join(__dirname, 'fixtures', 'listing', 'VALVE.CL'), 'utf8').split('\n');
    expect(programStatus('u', [{ path: 'VALVE.LE', kind: 'LE', mtime: 0, listing: le }], valve)).toEqual({ uri: 'u', errors: 2, changed: false, noListing: false });
    expect(programStatus('u', [], valve)).toEqual({ uri: 'u', errors: 0, changed: false, noListing: true });
  });
});

describe('CL Shared Storage view data', () => {
  it('lists storage two sequences use, with who stores to it and who reads it', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { analyze } = await import('../src/language/analyze');
    const { parseEb } = await import('../src/language/eb');
    const { summarize } = await import('../src/language/summary');
    const { WorkspaceIndex } = await import('../src/language/workspace');
    const { sharedStorage, storageAccesses } = await import('../src/server/programs');
    const ws = path.join(__dirname, 'fixtures', 'ws');
    const index = new WorkspaceIndex();
    index.setPoints(parseEb(fs.readFileSync(path.join(ws, 'db', 'HPM09.EB'), 'utf8'), 'HPM09.EB'), (f) => f);
    for (const f of ['MIXER.CL', 'DOSER.CL', 'AMBLK.CL']) index.setFile(`file:///ws/${f}`, summarize(analyze(fs.readFileSync(path.join(ws, f), 'utf8'))));

    const slots = sharedStorage(index);
    const brief = slots.map((s) => `${s.hpm} ${s.ownerKind} ${s.owner} ${s.param}(${s.index}) ${s.names.join('/')} ${s.programs}p ${s.writers}w`).sort();
    // FL(1002): MIXER reads ARR1.FL(2), which the database maps onto it; DOSER stores to it directly.
    // AGIT_ON is the box Flag point at FL(21).
    expect(brief).toEqual([
      'HPM 01/09 box Box FL(1002)  2p 1w',
      'HPM 01/09 box Box FL(21) AGITATE/READY/AGIT_ON 3p 2w',
      'HPM 01/09 module DOSER NN(5) DOSE_QTY/QTY 3p 3w',
    ]);

    const flag = slots.find((s) => s.param === 'FL' && s.index === 21)!;
    expect(storageAccesses(index, flag.key).map((a) => `${a.program} ${a.name ?? 'direct'} w${a.writes} r${a.reads}`)).toEqual([
      'AMBLK direct w1 r0',
      'MIXER AGITATE w1 r0',
      'DOSER READY w0 r1',
    ]);
  });

  it('counts copies of one program, bound to the same point, once', async () => {
    const { analyze } = await import('../src/language/analyze');
    const { summarize } = await import('../src/language/summary');
    const { WorkspaceIndex } = await import('../src/language/workspace');
    const { sharedStorage } = await import('../src/server/programs');
    const src = 'SEQUENCE A (HPM; POINT A)\nEXTERNAL !BOX\nLOCAL F: LOGICAL AT !BOX.FL(7)\nPHASE P\nSET F = ON\nEND A';
    const index = new WorkspaceIndex();
    index.setFile('file:///A.CL', summarize(analyze(src)));
    index.setFile('file:///A_OLD.CL', summarize(analyze(src)));
    expect(sharedStorage(index)).toEqual([]);
  });
});
