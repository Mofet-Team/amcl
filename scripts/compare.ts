// Compare the extension's diagnostics with the compiler's, on files whose source matches their
// .LS listing. Compiler warnings sit under a caret in the listing; this measures how many of them
// the extension reproduces (recall), how many of its own it adds (false positives), and lists
// every error the extension reports on code the compiler accepted.
//
// usage: node dist/compare.js <cl-dir> [eb-dir] [ncf-dir]
import * as fs from 'fs';
import * as path from 'path';
import { analyze } from '../src/language/analyze';
import { orientDescriptors, parseEb, PointRecord } from '../src/language/eb';
import { lint } from '../src/language/lint';
import { parseNcf } from '../src/language/ncf';
import { summarize } from '../src/language/summary';
import { WorkspaceIndex } from '../src/language/workspace';

const [clDir, ebDir, ncfDir] = process.argv.slice(2);
const dec = new TextDecoder('windows-1255');
const walk = (d: string, re: RegExp, o: string[] = []): string[] => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'docs') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, re, o);
    else if (re.test(e.name)) o.push(p);
  }
  return o;
};

/** Compiler messages in a listing: source line (0-based), column, text. */
function listingMessages(listing: string): { source: string[]; messages: { line: number; char: number; text: string }[] } {
  const source: string[] = [];
  const messages: { line: number; char: number; text: string }[] = [];
  let carets: number[] = [];
  for (const l of listing.split(/\r?\n/)) {
    const src = /^( {0,5}\d{1,6})( {0,5}\d{1,6}| {6}) {2}(.*)$/.exec(l);
    if (src && Number(src[1]) === source.length + 1) {
      source.push(src[3]);
      carets = [];
      continue;
    }
    if (/^\s+\^[\s^]*$/.test(l)) {
      carets = [...l].flatMap((c, i) => (c === '^' ? [i - 14] : []));
      continue;
    }
    const msg = /^\s*\*\*(WARNING|NOTE|ERROR)\s*\*\*\s+(.*?)\s*$/.exec(l);
    if (msg) messages.push({ line: source.length - 1, char: carets.shift() ?? -1, text: msg[2] });
  }
  return { source, messages };
}

const trimmed = (lines: string[]) => {
  const out = lines.map((l) => l.trimEnd());
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
};

// Index the workspace and the point database, as the server would.
const index = new WorkspaceIndex();
if (ebDir) {
  const recs: PointRecord[] = [];
  for (const f of walk(ebDir, /\.eb$/i)) recs.push(...parseEb(dec.decode(fs.readFileSync(f)), f));
  orientDescriptors(recs);
  index.setPoints(recs, (f) => f);
}
if (ncfDir) index.setNetworks(walk(ncfDir, /^NCF.*\.(XX|WF)$/i).flatMap((f) => parseNcf(fs.readFileSync(f, 'latin1'), f) ?? []));
const texts = new Map<string, string>();
for (const f of walk(clDir, /\.cl$/i)) {
  const b = fs.readFileSync(f);
  if (b.includes(0)) continue;
  const t = dec.decode(b);
  texts.set(f, t);
  index.setFile(f, summarize(analyze(t)));
}
const env = ebDir
  ? { point: (n: string) => index.point(n), boxOfProgram: (b: string) => index.boxOfProgram(b), boxOfPoint: (p: PointRecord) => index.boxOfPoint(p) }
  : undefined;

const MAP: Record<string, string> = {
  unused: 'Defined But Not Referenced',
  'string-length': 'String exceeded maximum allowable length and was shortened to 64 characters',
  'loop-never-repeated': 'Loop was never repeated',
  'serial-iop': 'This LOCAL variable is mapped to a Serial Interface IOP parameter',
};
const score = new Map<string, { tp: number; fn: number; fp: number; fnEx: string[]; fpEx: string[] }>();
// Warnings that need the point database to be current, reported but not scored.
const errors = new Map<string, { count: number; ex: string[] }>();
const others = new Map<string, { count: number; ex: string[] }>();
let checked = 0;
const verified = new Set<string>();

for (const [f, text] of texts) {
  const ls = f.replace(/\.cl$/i, (e) => (e === '.CL' ? '.LS' : '.ls'));
  if (!fs.existsSync(ls)) continue;
  const { source, messages } = listingMessages(dec.decode(fs.readFileSync(ls)));
  const lines = text.split(/\r?\n|\r/);
  const a = trimmed(source);
  const b = trimmed(lines);
  if (a.length !== b.length || a.some((l, i) => l !== b[i])) continue;
  checked++;
  verified.add(f);

  const analysis = analyze(text);
  const mine = lint(analysis.file, analysis.binding, env);
  const rel = path.relative(clDir, f);
  const at = (line: number) => `${rel}:${line + 1}  ${lines[line]?.trim().slice(0, 80)}`;

  for (const [code, compilerText] of Object.entries(MAP)) {
    const s = score.get(code) ?? { tp: 0, fn: 0, fp: 0, fnEx: [], fpEx: [] };
    const theirs = messages.filter((m) => m.text === compilerText).map((m) => `${m.line}:${m.char}`);
    const ours = mine.filter((d) => d.code === code).map((d) => `${d.range.start.line}:${d.range.start.character}`);
    // When two messages share a column, the compiler moves the second caret right by one.
    const near = (k: string, set: Set<string>) => {
      const [l, c] = k.split(':').map(Number);
      return set.has(k) || set.has(`${l}:${c - 1}`) || set.has(`${l}:${c + 1}`);
    };
    const theirSet = new Set(theirs);
    const ourSet = new Set(ours);
    for (const k of theirSet) {
      if (near(k, ourSet)) s.tp++;
      else {
        s.fn++;
        if (s.fnEx.length < 5) s.fnEx.push(`${at(Number(k.split(':')[0]))}  (col ${Number(k.split(':')[1]) + 1})`);
      }
    }
    for (const k of ourSet) {
      if (!near(k, theirSet)) {
        s.fp++;
        if (s.fpEx.length < 5) s.fpEx.push(`${at(Number(k.split(':')[0]))}  (col ${Number(k.split(':')[1]) + 1})`);
      }
    }
    score.set(code, s);
  }
  for (const d of [...mine, ...analysis.diagnostics]) {
    if (MAP[d.code]) continue;
    const bucket = d.severity === 1 ? errors : others;
    const key = `${d.code}: ${d.message.replace(/\b[\w$!]+\b(?= is| mixed| has|\()/, 'X')}`.slice(0, 120);
    const e = bucket.get(d.code) ?? { count: 0, ex: [] };
    e.count++;
    if (e.ex.length < 4) e.ex.push(`${at(d.range.start.line)}\n          ${d.message}`);
    bucket.set(d.code, e);
    void key;
  }
}

console.log(`${checked} files whose source matches their listing\n`);
console.log('Compiler warnings reproduced (exact line and column):');
for (const [code, s] of score) {
  const recall = s.tp + s.fn ? ((100 * s.tp) / (s.tp + s.fn)).toFixed(1) : '-';
  const precision = s.tp + s.fp ? ((100 * s.tp) / (s.tp + s.fp)).toFixed(1) : '-';
  console.log(`  ${code.padEnd(20)} compiler ${s.tp + s.fn}, matched ${s.tp}, missed ${s.fn}, extra ${s.fp}   recall ${recall}%  precision ${precision}%`);
  for (const e of s.fnEx) console.log(`      missed: ${e}`);
  for (const e of s.fpEx) console.log(`      extra:  ${e}`);
}
console.log('\nErrors on code the compiler accepted (each one is a false positive):');
if (!errors.size) console.log('  none');
for (const [code, e] of errors) {
  console.log(`  ${code}: ${e.count}`);
  for (const x of e.ex) console.log(`      ${x}`);
}
console.log('\nOther warnings (no compiler counterpart):');
for (const [code, e] of others) {
  console.log(`  ${code}: ${e.count}`);
  for (const x of e.ex) console.log(`      ${x}`);
}

// Programs whose header comment names a different HPM than the point database: a moved point.
if (process.env.AMCL_HPM_CHECK) {
  const byFile = new Map<string, number>();
  for (const [f, text] of texts) {
    if (!verified.has(f)) continue;
    const analysis = analyze(text);
    const n = lint(analysis.file, analysis.binding, env).filter((d) => d.code === 'remote-access').length;
    if (n) byFile.set(f, n);
  }
  let moved = 0;
  let same = 0;
  for (const [f, n] of byFile) {
    const text = texts.get(f)!;
    const header = /HPM\.?\s*0?(\d+)/i.exec(text.split(/\r?\n/).slice(0, 3).join(' '))?.[1];
    const bound = analyze(text).file.units.find((u) => u.kind === 'sequence') as { point?: { name: string } } | undefined;
    const db = bound?.point && index.point(bound.point.name)?.fields.NODENUM;
    const differs = header !== undefined && db !== undefined && Number(header) !== Number(db);
    if (differs) moved += n;
    else {
      same += n;
      const ls = fs.readFileSync(f.replace(/\.cl$/i, (e) => (e === '.CL' ? '.LS' : '.ls')), 'latin1');
      const date = /(\d\d)\/(\d\d)\/(\d\d) \d\d:/.exec(ls)?.slice(1).join('/');
      console.log(`  same HPM per header: ${path.relative(clDir, f)} (header HPM ${header}, database node ${db}, compiled ${date}): ${n}`);
    }
  }
  console.log(`remote-access in all files: ${moved + same}; in programs whose header names another HPM than the database: ${moved}`);
}
