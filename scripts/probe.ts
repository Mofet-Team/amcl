// Build the workspace index for a CL directory and a point database, and report what resolves.
// usage: node dist/probe.js <cl-dir> <eb-dir> [FILE.CL NAME]  -- NAME: a LOCAL whose storage to trace
import * as fs from 'fs';
import * as path from 'path';
import { analyze } from '../src/language/analyze';
import { parseEb, PointRecord } from '../src/language/eb';
import { summarize } from '../src/language/summary';
import { WorkspaceIndex } from '../src/language/workspace';

const [clDir, ebDir, traceFile, traceName] = process.argv.slice(2);
const decoder = new TextDecoder('windows-1255');
const walk = (d: string, re: RegExp, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'docs') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, re, out);
    else if (re.test(e.name)) out.push(p);
  }
  return out;
};

const index = new WorkspaceIndex();
let t = Date.now();
const records: PointRecord[] = [];
for (const f of walk(ebDir, /\.eb$/i)) records.push(...parseEb(decoder.decode(fs.readFileSync(f)), f));
index.setPoints(records, (f) => f);
console.log(`EB: ${records.length} records, ${index.pointCount} points, ${Date.now() - t} ms`);

t = Date.now();
const summaries = new Map<string, ReturnType<typeof summarize>>();
for (const f of walk(clDir, /\.cl$/i)) {
  const buf = fs.readFileSync(f);
  if (buf.includes(0)) continue;
  const s = summarize(analyze(decoder.decode(buf)));
  summaries.set(f, s);
  index.setFile(f, s);
}
console.log(`CL: ${index.fileCount} files, ${Date.now() - t} ms`);

let bound = 0;
let inDb = 0;
let boxUses = 0;
let boxResolved = 0;
const keys = new Map<string, Set<string>>();
t = Date.now();
for (const [f, s] of summaries) {
  for (const p of s.programs) {
    if (!p.point) continue;
    bound++;
    if (index.point(p.point)) inDb++;
  }
  for (const u of s.storage) {
    const key = index.storageKey(u);
    if (u.point === '!BOX') {
      boxUses++;
      if (key && !/^BOX:G/.test(key)) boxResolved++;
    }
    if (key) keys.set(key, (keys.get(key) ?? new Set()).add(f));
  }
}
const shared = [...keys.values()].filter((s) => s.size > 1).length;
console.log(`programs with a bound point: ${bound}, found in the point database: ${inDb}`);
console.log(`!BOX uses: ${boxUses}, resolved to a concrete box: ${boxResolved}`);
console.log(`storage keys: ${keys.size}, used by more than one file: ${shared} (${Date.now() - t} ms)`);

if (traceFile && traceName) {
  const f = path.join(clDir, traceFile);
  const s = summaries.get(f)!;
  const use = s.storage.find((u) => u.local?.name === traceName.toUpperCase());
  if (!use) throw new Error(`no LOCAL ${traceName} with AT in ${traceFile}`);
  const key = index.storageKey(use)!;
  console.log(`\n${traceName} -> ${key} (${index.describeKey(key)})`);
  for (const l of index.storageDefinitions(key)) console.log(`  defined ${path.relative(clDir, l.uri)}:${l.range.start.line + 1}`);
  const refs = index.storageReferences(key, false);
  const byFile = new Map<string, number>();
  for (const r of refs) byFile.set(r.uri, (byFile.get(r.uri) ?? 0) + 1);
  for (const [u, n] of byFile) console.log(`  ${n} refs in ${path.relative(clDir, u)}`);
}

// Cost of keeping the index in the server, and of the first query after an edit (full rebuild).
(globalThis as { gc?: () => void }).gc?.();
console.log(`\nheap after indexing: ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`);
const someFile = [...summaries.keys()][0];
index.setFile(someFile, summaries.get(someFile)!);
t = Date.now();
index.storageReferences('BOX:1:9:FL:21', true);
console.log(`first query after an edit: ${Date.now() - t} ms`);
t = Date.now();
index.storageReferences('BOX:1:9:FL:21', true);
console.log(`next query: ${Date.now() - t} ms`);
