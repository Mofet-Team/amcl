import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TextDecoder } from 'util';
import { describe, expect, it } from 'vitest';
import { pathToUri, readText, uriToPath } from '../src/server/loader';

describe('file URIs', () => {
  it('spells paths as VS Code does, so a file is one entry in the index', () => {
    expect(pathToUri('/plant/u1/a b$(2).CL')).toBe('file:///plant/u1/a%20b%24%282%29.CL');
    expect(uriToPath('file:///plant/u1/a%20b%24%282%29.CL')).toBe('/plant/u1/a b$(2).CL');
    expect(uriToPath('untitled:Untitled-1')).toBeUndefined();
  });
});

describe('reading files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcl-'));
  const file = path.join(dir, 'a.EB');
  fs.writeFileSync(file, Buffer.from('&N A\nPTDESC   = "AB\0\0"\n', 'latin1'));
  const decoder = new TextDecoder('windows-1255');

  it('skips a file with NUL bytes as binary, unless they are to be read as spaces', async () => {
    expect(await readText(file, decoder)).toBeUndefined();
    expect(await readText(file, decoder, true)).toBe('&N A\nPTDESC   = "AB  "\n');
  });
});
