import { describe, expect, it } from 'vitest';
import { DocumentSymbol } from 'vscode-languageserver';
import { analyze } from '../src/language/analyze';
import { Position } from '../src/language/types';
import { documentSymbols } from '../src/server/features/outline';
import { fixture, pos } from './helpers';

/** The outline path "Follow Cursor" selects: the deepest symbols whose range holds the position. */
function pathAt(symbols: DocumentSymbol[], p: Position): string[] {
  const inside = (s: DocumentSymbol) =>
    (s.range.start.line < p.line || (s.range.start.line === p.line && s.range.start.character <= p.character)) &&
    (s.range.end.line > p.line || (s.range.end.line === p.line && s.range.end.character >= p.character));
  const hit = symbols.find(inside);
  return hit ? [hit.name, ...pathAt(hit.children ?? [], p)] : [];
}

describe('outline ranges for Follow Cursor', () => {
  const text = fixture('reactor.cl');
  const a = analyze(text);
  const syms = documentSymbols(a.binding.symbols, a.file.units);
  const at = (needle: string, occurrence = 0) => pathAt(syms, pos(text, needle, occurrence));

  it('selects the phase, step and label the cursor is in', () => {
    expect(at('SET NBATCH = NBATCH + 1')).toEqual(['REACT1', 'PREPARE', 'ST01']);
    expect(at('SEND (WAIT)')).toEqual(['REACT1', 'PREPARE', 'ST01', 'HOT']);
    expect(at('CALL CHECK')).toEqual(['REACT1', 'PREPARE', 'ST02', 'LOOP1']);
    expect(at('START PUMP1')).toEqual(['REACT1', 'HEAT']);
  });

  it('selects declarations, handlers and subroutines', () => {
    expect(at('LOCAL NBATCH')).toEqual(['REACT1', 'LOCAL', 'Numerics', 'NBATCH']);
    expect(at('TI100,')).toEqual(['REACT1', 'EXTERNAL', 'TI100']);
    expect(at('STOP PUMP1')).toEqual(['HLD1']);
    expect(at('IF N > TMAX')).toEqual(['CHECK']);
  });
});
