import { describe, expect, it } from 'vitest';
import { analyze } from '../src/language/analyze';
import { openCall, signatureHelp } from '../src/server/features/signature';
import { fixture } from './helpers';

/** Signature help where `|` marks the cursor. */
function helpAt(source: string) {
  const lines = source.split('\n');
  const line = lines.findIndex((l) => l.includes('|'));
  const character = lines[line].indexOf('|');
  lines[line] = lines[line].replace('|', '');
  const h = signatureHelp(analyze(lines.join('\n')), lines, { line, character });
  return h && { label: h.signatures[0].label, active: h.activeParameter };
}

describe('signature help', () => {
  const reactor = fixture('reactor.cl');

  it('shows a user subroutine with modes and types, and the current argument', () => {
    const src = reactor.replace('CALL CHECK (NBATCH, FAGIT)', 'CALL CHECK (NBATCH, |');
    expect(helpAt(src)).toEqual({ label: 'CHECK (N: IN NUMBER; F: OUT LOGICAL)', active: 1 });
  });

  it('shows built-in functions and subroutines', () => {
    const src = reactor.replace('SET NBATCH = NBATCH + 1', 'SET NBATCH = MAX(NBATCH, |');
    expect(helpAt(src)).toEqual({ label: 'Max(x, y, ...)', active: 1 });
    const call = reactor.replace('SET NBATCH = NBATCH + 1', 'CALL MODIFY_STRING(S, |');
    expect(helpAt(call)).toMatchObject({ label: 'Modify_String(status, target, target_pos, count, source, source_pos)', active: 1 });
  });

  it('shows DEFINE functions', () => {
    const pkg = fixture('package.cl').replace('SET X = DIST(A100.PV, NET\\B200.PV)', 'SET X = DIST(A100.PV, |');
    expect(helpAt(pkg)).toEqual({ label: 'DIST(P, Q) = SQRT(P * P + Q * Q)', active: 1 });
  });

  it('follows & continuation lines and ignores nested parentheses and strings', () => {
    const src = reactor.replace('CALL CHECK (NBATCH, FAGIT)', 'CALL CHECK ((NBATCH + 1) * 2,\n&  |');
    expect(helpAt(src)).toEqual({ label: 'CHECK (N: IN NUMBER; F: OUT LOGICAL)', active: 1 });
    expect(openCall('SEND: "a(b", MAX(1, "x,y", ')).toEqual({ name: 'MAX', argument: 2 });
  });

  it('gives nothing for storage slots and outside calls', () => {
    expect(helpAt(reactor.replace('SET NBATCH = NBATCH + 1', 'SET NN(|'))).toBeNull();
    expect(helpAt(reactor.replace('SET NBATCH = NBATCH + 1', 'SET NBATCH = |'))).toBeNull();
  });
});
