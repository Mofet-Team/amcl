import { describe, expect, it } from 'vitest';
import { analyze } from '../src/language/analyze';
import { parseEb } from '../src/language/eb';
import { summarize } from '../src/language/summary';
import { WorkspaceIndex } from '../src/language/workspace';
import { inlayHints, InlayHintOptions } from '../src/server/features/inlayHints';

const point = (name: string, type: string, desc?: string) =>
  `{IDF NET>X>Y.DB, ENTITY ${name}( )}\n&T ${type}\n&N ${name}\nNODETYP  = HPM\nNTWKNUM  = 1\nNODENUM  = 9\n${desc ? `PTDESC   = "${desc}"\n` : ''}`;

const src = [
  'SEQUENCE S1 (HPM; POINT MIXER)',
  'EXTERNAL !BOX, DOSV, R2TC, NOPE',
  'LOCAL N AT NN(12)',
  'LOCAL F: LOGICAL AT !BOX.FL(21)',
  'LOCAL A: NUMBER ARRAY(1..3) AT NN(5)',
  'PHASE P',
  'IF DOSV.PV = OPEN THEN SET F = ON',
  'SET N = R2TC.PV',
  'SET A(2) = N + 1',
  'END S1',
].join('\n');

function hints(options: InlayHintOptions = { locals: true, points: true }, range = { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } }) {
  const index = new WorkspaceIndex();
  index.setPoints(
    parseEb([point('MIXER', 'PRMODNIM', 'Mixer program'), point('DOSV', 'DICMPNIM', 'Dosing line'), point('R2TC', 'REGCLNIM')].join('\n'), 'db/a.EB'),
    (f) => f,
  );
  const summary = summarize(analyze(src));
  index.setFile('S1.CL', summary);
  return inlayHints(summary, index, src.split('\n'), range, options).map((h) => `${h.position.line + 1}:${h.position.character} ${h.label}`);
}

describe('inlay hints', () => {
  it('shows the storage element after each use of a LOCAL, not at its declaration or before a subscript', () => {
    expect(hints({ locals: true, points: false })).toEqual(['7:28 !BOX.FL(21)', '8:5 NN(12)', '9:12 NN(12)']);
  });

  it('shows the descriptor, else the type, of EXTERNAL entries and the bound point, only for points in the database', () => {
    expect(hints({ locals: false, points: true })).toEqual([
      '1:29 Mixer program',
      '2:19 Dosing line',
      '2:25 Regulatory Control',
    ]);
  });

  it('gives only the hints in the range asked for, and none when turned off', () => {
    expect(hints(undefined, { start: { line: 7, character: 0 }, end: { line: 7, character: 99 } })).toEqual(['8:5 NN(12)']);
    expect(hints({ locals: false, points: false })).toEqual([]);
  });
});
