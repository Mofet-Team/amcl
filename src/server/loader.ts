import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TextDecoder } from 'util';
import { URI } from 'vscode-uri';

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.vscode', 'out', 'dist']);

/** VS Code encoding ids (`windows1255`, `iso88598`, `utf8`) to WHATWG labels for TextDecoder. */
export function decoderFor(vscodeEncoding: string | undefined): TextDecoder {
  const id = (vscodeEncoding ?? 'windows1255').toLowerCase();
  const label = id.startsWith('utf8')
    ? 'utf-8'
    : id.replace(/^windows(\d+)$/, 'windows-$1').replace(/^iso8859(\d+)$/, 'iso-8859-$1').replace(/^cp(\d+)$/, 'windows-$1');
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder('windows-1255');
  }
}

export function uriToPath(uri: string): string | undefined {
  return uri.startsWith('file:') ? URI.parse(uri).fsPath : undefined;
}

/**
 * A path as VS Code spells it (`file:///c%3A/…` on Windows, `$` and `(` escaped): the index and
 * caches compare URIs as strings, and open documents come with VS Code's spelling.
 */
export function pathToUri(p: string): string {
  return URI.file(p).toString();
}

/** All files under `roots` whose name matches `re`, skipping build and VCS directories. */
export async function findFiles(roots: string[], re: RegExp): Promise<string[]> {
  const out: string[] = [];
  const visit = async (p: string): Promise<void> => {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(p);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (re.test(p)) out.push(p);
      return;
    }
    if (!stat.isDirectory()) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && (SKIP_DIRS.has(e.name) || e.name.startsWith('.'))) continue;
      const child = path.join(p, e.name);
      if (e.isDirectory()) await visit(child);
      else if (re.test(e.name)) out.push(child);
    }
  };
  for (const r of roots) await visit(r);
  return out;
}

/**
 * A text file, or undefined when it cannot be read. `blankNul`: NUL bytes are read as spaces;
 * otherwise a file with one is taken for binary and skipped.
 */
export async function readText(p: string, decoder: TextDecoder, blankNul = false): Promise<string | undefined> {
  try {
    const buf = await fs.promises.readFile(p);
    if (buf.includes(0)) {
      // A binary file with a source extension: skip it rather than index garbage.
      if (!blankNul) return undefined;
      for (let i = buf.indexOf(0); i >= 0; i = buf.indexOf(0, i + 1)) buf[i] = 0x20;
    }
    return decoder.decode(buf);
  } catch {
    return undefined;
  }
}

/** Resolve `amcl.pointDatabase` entries: absolute, `~/`, or relative to a workspace folder. */
export function resolvePaths(entries: string[], workspaceRoots: string[]): string[] {
  const home = os.homedir();
  const out: string[] = [];
  for (const e of entries) {
    // `~`, `~/db` and, on Windows, `~\db`.
    const expanded = /^~([\\/]|$)/.test(e) ? path.join(home, e.slice(2)) : e;
    if (path.isAbsolute(expanded)) out.push(expanded);
    else for (const r of workspaceRoots) out.push(path.join(r, expanded));
  }
  return out;
}
