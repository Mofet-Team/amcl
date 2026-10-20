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
  'LOCAL CNT = 3+1',
  'LOCAL B: NUMBER ARRAY(1..CNT) AT NN(20)',
  'EXTERNAL DOSV2',
  'EXTERNAL R2TC2',
  'PHASE P',
  'IF DOSV.PV = OPEN THEN SET F = ON',
  'SET N = R2TC.PV',
  'SET A(2) = N + 1',
  'SET A(N) = 0',
  'CALL SUM (A, N)',
  'SET B(4) = B(1)',
  'SET R2TC2.NN(3) = R2TC2.NN(4)',
  'END S1',
].join('\n');

function hints(options: InlayHintOptions = { locals: true, points: true }, range = { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } }) {
  const index = new WorkspaceIndex();
  index.setPoints(
    parseEb(
      [point('MIXER', 'PRMODNIM', 'Mixer program'), point('DOSV', 'DICMPNIM', 'Dosing line'), point('R2TC', 'REGCLNIM'), point('DOSV2', 'DICMPNIM', 'Second line'), point('R2TC2', 'REGCLNIM')].join('\n'),
      'db/a.EB',
    ),
    (f) => f,
  );
  const analysis = analyze(src);
  const summary = summarize(analysis);
  index.setFile('S1.CL', summary);
  return inlayHints(analysis, summary, index, range, options).map((h) => `${h.position.line + 1}:${h.position.character} ${h.label}`);
}

describe('inlay hints', () => {
  it('shows the storage element after each use of a LOCAL, and the element or range of an array', () => {
    expect(hints({ locals: true, points: false })).toEqual([
      '11:28 !BOX.FL(21)',
      '12:5 NN(12)',
      // A(2) is the second element; A(N) and the whole array A cover all three.
      '13:8 NN(6)',
      '13:12 NN(12)',
      '14:7 NN(12)',
      '14:8 NN(5..7)',
      '15:11 NN(5..7)',
      '15:14 NN(12)',
      // CNT is a constant: B is NN(20..23).
      '16:8 NN(23)',
      '16:15 NN(20)',
    ]);
  });

  it('shows the descriptor, else the type in brackets, after the bound point, each EXTERNAL entry and each use', () => {
    expect(hints({ locals: false, points: true })).toEqual([
      '1:29 Mixer program',
      '2:19 Dosing line',
      '2:25 [Regulatory Control]',
      '8:14 Second line',
      '9:14 [Regulatory Control]',
      // After the whole access: `DOSV.PV`, `R2TC2.NN(3)`.
      '11:10 Dosing line',
      '12:15 [Regulatory Control]',
      '17:15 [Regulatory Control]',
    ]);
  });

  it('gives only the hints in the range asked for, and none when turned off', () => {
    expect(hints(undefined, { start: { line: 11, character: 0 }, end: { line: 11, character: 99 } })).toEqual(['12:5 NN(12)', '12:15 [Regulatory Control]']);
    expect(hints({ locals: false, points: false })).toEqual([]);
  });
});
