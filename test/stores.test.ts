import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { TextDocumentEdit } from 'vscode-languageserver';
import { analyze, Analysis } from '../src/language/analyze';
import { parseEb } from '../src/language/eb';
import { FileSummary, summarize } from '../src/language/summary';
import { WorkspaceIndex } from '../src/language/workspace';
import { prepareRename, rename } from '../src/server/features/rename';
import { storeUses } from '../src/server/features/stores';
import { StoreUse } from '../src/shared/programs';
import { pos } from './helpers';

const dir = path.join(__dirname, 'fixtures', 'ws');
const fixtures = Object.fromEntries(['MIXER.CL', 'DOSER.CL', 'AMBLK.CL'].map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

function build(files: Record<string, string> = fixtures) {
  const index = new WorkspaceIndex();
  const analyses = new Map<string, Analysis>();
  const summaries = new Map<string, FileSummary>();
  for (const [f, text] of Object.entries(files)) {
    analyses.set(f, analyze(text));
    summaries.set(f, summarize(analyses.get(f)!));
    index.setFile(f, summaries.get(f)!);
  }
  const eb = fs.readFileSync(path.join(dir, 'db/HPM09.EB'), 'utf8');
  index.setPoints(parseEb(eb, 'HPM09.EB'), (f) => f);
  const text = (u: string) => (u === 'HPM09.EB' ? eb : files[u]);
  const lineOf = (u: string, line: number) => text(u).split('\n')[line] ?? '';
  const storesAt = (file: string, needle: string, occurrence = 0, offset = 0) =>
    storeUses(analyses.get(file)!, summaries.get(file)!, index, pos(files[file], needle, occurrence, offset), lineOf);
  const ctx = (file: string) => ({ uri: file, version: 1, analysis: analyses.get(file)!, summary: summaries.get(file)!, index });
  const renameAt = (file: string, needle: string, newName: string, occurrence = 0) =>
    rename(ctx(file), pos(files[file], needle, occurrence), newName);
  const prepareAt = (file: string, needle: string, occurrence = 0) => prepareRename(analyses.get(file)!, index, pos(files[file], needle, occurrence));
  return { storesAt, renameAt, prepareAt };
}

const brief = (uses: StoreUse[]) => uses.map((u) => `${u.program}:${u.line + 1}${u.name ? ` ${u.name}` : ''}`);

/** `FILE:line:column text` of each edit. */
function edits(result: ReturnType<ReturnType<typeof build>['renameAt']>): string[] {
  if (!result || 'error' in result) throw new Error(result ? result.error : 'no rename');
  return (result.edit.documentChanges as TextDocumentEdit[]).flatMap((c) =>
    c.edits.map((e) => `${c.textDocument.uri}:${e.range.start.line + 1}:${e.range.start.character} ${e.newText}`),
  );
}

const errorOf = (result: unknown) => (result as { error?: string } | undefined)?.error;

describe('who stores', () => {
  it('lists the stores and reads of a box flag through every LOCAL and direct access, with its tag', () => {
    const found = build().storesAt('MIXER.CL', 'AGITATE', 1)!;
    expect(found.title).toMatch(/box FL\(21\)/);
    expect(brief(found.stores)).toEqual(['AMBLK:3', 'MIXER:7 AGITATE']);
    expect(brief(found.reads)).toEqual(['DOSER:6 READY']);
    expect(found.reads[0].text).toBe('WAIT READY = ON AND !DI11S01.PVFL = ON');
    expect(found.tag?.name).toBe('AGIT_ON');
  });

  it('finds a slot of a sequence from the LOCAL of another program mapped onto it', () => {
    const found = build().storesAt('DOSER.CL', 'QTY', 1)!;
    expect(found.title).toBe('DOSER.NN(5)');
    expect(brief(found.stores)).toEqual(['AMBLK:4', 'DOSER:7', 'MIXER:8 DOSE_QTY']);
    expect(brief(found.reads)).toEqual(['DOSER:7 QTY']);
  });

  it('lists the accesses of one parameter of a point', () => {
    const found = build().storesAt('MIXER.CL', 'FT100.PV', 0, 'FT100.'.length)!;
    expect(found.title).toBe('FT100.PV');
    expect(found.stores).toEqual([]);
    expect(brief(found.reads)).toEqual(['MIXER:11 FT100.PV']);
  });

  it('lists every parameter of a point, its slots included, from its name', () => {
    const found = build().storesAt('AMBLK.CL', 'DOSER', 1)!;
    expect(found.title).toBe('DOSER, every parameter');
    expect(brief(found.stores)).toEqual(['AMBLK:4 DOSER.NN', 'DOSER:7', 'MIXER:8 DOSE_QTY']);
  });

  it('has nothing to say on a keyword or an unmapped name', () => {
    expect(build().storesAt('MIXER.CL', 'PHASE')).toBeUndefined();
    expect(build().storesAt('MIXER.CL', '!BOX')).toBeUndefined();
  });
});

describe('rename', () => {
  it('renames a LOCAL everywhere in its file', () => {
    expect(edits(build().renameAt('MIXER.CL', 'LEVEL', 'TOP'))).toEqual(['MIXER.CL:5:10 TOP', 'MIXER.CL:9:32 TOP']);
  });

  it('renames only in its file, naming the programs that call the same storage the same', () => {
    const files = {
      ...fixtures,
      'OTHER.CL': ['SEQUENCE OTHER (HPM; POINT OTHER)', 'EXTERNAL !BOX, MIXER', 'LOCAL AGITATE: LOGICAL AT !BOX.FL(21)', 'LOCAL M AT MIXER.NN(1)', 'PHASE ONE', 'SET AGITATE = OFF', 'END OTHER'].join('\n'),
    };
    const result = build(files).renameAt('MIXER.CL', 'AGITATE', 'STIR');
    expect(edits(result)).toEqual(['MIXER.CL:3:10 STIR', 'MIXER.CL:7:8 STIR']);
    // DOSER names the same flag READY: only a LOCAL of the same name is mentioned.
    expect(result && !('error' in result) && result.elsewhere).toEqual(['OTHER']);
  });

  it('refuses a name declared twice', () => {
    const files = { 'D.CL': ['SEQUENCE D (HPM; POINT D)', 'LOCAL X AT NN(1)', 'LOCAL X AT NN(2)', 'PHASE RUN', 'SET X = 1', 'END D'].join('\n') };
    expect(errorOf(build(files).prepareAt('D.CL', 'X'))).toMatch(/declared more than once \(lines 2, 3\)/);
  });

  it('renames a phase and keeps a quoted name quoted', () => {
    const files = { 'Q.CL': ['SEQUENCE Q (HPM; POINT Q)', "LOCAL 'X AT NN(1)", 'PHASE RUN', "SET 'X = 1", 'GOTO PHASE RUN', 'END Q'].join('\n') };
    const { renameAt } = build(files);
    expect(edits(renameAt('Q.CL', 'X', 'Y'))).toEqual(["Q.CL:2:6 'Y", "Q.CL:4:4 'Y"]);
    expect(edits(renameAt('Q.CL', 'RUN', 'GO'))).toEqual(['Q.CL:3:6 GO', 'Q.CL:5:11 GO']);
    expect(errorOf(renameAt('Q.CL', 'RUN', 'TOOLONGNAME'))).toMatch(/at most 8 characters/);
  });

  it('refuses names that would change what the code means', () => {
    const { renameAt } = build();
    expect(errorOf(renameAt('MIXER.CL', 'LEVEL', 'AGITATE'))).toMatch(/already used in this file, on line 3/);
    expect(errorOf(renameAt('MIXER.CL', 'LEVEL', 'SET'))).toMatch(/reserved word/);
    expect(errorOf(renameAt('MIXER.CL', 'LEVEL', 'FT100'))).toMatch(/point in the point database/);
    expect(errorOf(renameAt('MIXER.CL', 'LEVEL', 'ABS'))).toMatch(/built-in/);
    expect(errorOf(renameAt('MIXER.CL', 'LEVEL', 'NN'))).toMatch(/parameter of the bound point/);
    expect(errorOf(renameAt('MIXER.CL', 'LEVEL', '1X'))).toMatch(/not a CL name/);
  });

  it('refuses points and program names', () => {
    const { prepareAt } = build();
    expect(errorOf(prepareAt('MIXER.CL', 'TANK_LVL', 1))).toMatch(/is a point/);
    expect(errorOf(prepareAt('MIXER.CL', 'MIXER', 0))).toMatch(/program name/);
    expect(prepareAt('MIXER.CL', 'LEVEL')).toEqual({ range: expect.anything(), placeholder: 'LEVEL' });
  });
});
