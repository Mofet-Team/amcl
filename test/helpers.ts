import * as fs from 'fs';
import * as path from 'path';
import { Position } from '../src/language/types';

export function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

/** Position of the `occurrence`-th match of `needle` (0-based), plus `offset` characters. */
export function pos(text: string, needle: string, occurrence = 0, offset = 0): Position {
  let at = -1;
  for (let i = 0; i <= occurrence; i++) {
    at = text.indexOf(needle, at + 1);
    if (at < 0) throw new Error(`'${needle}' occurrence ${occurrence} not found`);
  }
  const before = text.slice(0, at + offset);
  const line = before.split('\n').length - 1;
  return { line, character: before.length - before.lastIndexOf('\n') - 1 };
}

/** The line of `text` that a position is on. */
export function lineOf(text: string, p: Position): string {
  return text.split('\n')[p.line];
}
