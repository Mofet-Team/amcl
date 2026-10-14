import { describe, expect, it } from 'vitest';
import { analyze } from '../src/language/analyze';
import { foldingRanges } from '../src/server/features/folding';
import { documentSymbols } from '../src/server/features/outline';
import { fixture } from './helpers';

/** Small deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

function exercise(text: string) {
  const a = analyze(text);
  documentSymbols(a.binding.symbols, a.file.units);
  foldingRanges(a.file);
}

describe('robustness', () => {
  const sources = [fixture('reactor.cl'), fixture('package.cl')];

  it('survives every truncation of the fixtures (as while typing)', () => {
    for (const src of sources) {
      for (let i = 0; i <= src.length; i += 3) expect(() => exercise(src.slice(0, i))).not.toThrow();
    }
  });

  it('survives random line deletions, duplications and token damage', () => {
    const rand = rng(42);
    const junk = ['(', ')', ';', ':', '&', '"', 'END', 'IF', 'ELSE', 'PHASE', 'STEP', 'WHEN', '..', '=', ',', '.', '%'];
    for (const src of sources) {
      for (let round = 0; round < 300; round++) {
        const lines = src.split('\n');
        const n = 1 + Math.floor(rand() * 4);
        for (let k = 0; k < n; k++) {
          const i = Math.floor(rand() * lines.length);
          const op = rand();
          if (op < 0.3) lines.splice(i, 1);
          else if (op < 0.5) lines.splice(i, 0, lines[Math.floor(rand() * lines.length)]);
          else {
            const line = lines[i] ?? '';
            const at = Math.floor(rand() * (line.length + 1));
            lines[i] = line.slice(0, at) + junk[Math.floor(rand() * junk.length)] + line.slice(at);
          }
        }
        const text = lines.join('\n');
        expect(() => exercise(text), text).not.toThrow();
      }
    }
  });

  it('handles empty and whitespace-only input', () => {
    for (const t of ['', '\n', '   \n\n', '&', '--', 'END', '"', '%']) expect(() => exercise(t)).not.toThrow();
  });
});
