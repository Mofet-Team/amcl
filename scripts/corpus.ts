// Parse every .CL file under a directory and report diagnostics. The production corpus compiled
// on the TPS, so every syntax error reported here is a parser bug.
//
// With --verified, only files whose source matches the source column of their .LS listing are
// checked: those compiled exactly as they are.
//
// usage: npm run corpus -- <dir> [--verified] [--show N] [--code CODE] [--all-severities]
import * as fs from 'fs';
import * as path from 'path';
import { analyze } from '../src/language/analyze';
import { BUILTIN_SUBROUTINES } from '../src/language/checks';
import { parseListing } from '../src/language/listing';
import { foldingRanges } from '../src/server/features/folding';
import { documentSymbols } from '../src/server/features/outline';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) {
  console.error('usage: corpus <dir> [--show N] [--code CODE]');
  process.exit(2);
}
const show = Number(args[args.indexOf('--show') + 1]) || 20;
const codeFilter = args.includes('--code') ? args[args.indexOf('--code') + 1] : undefined;
const verifiedOnly = args.includes('--verified');
const allSeverities = args.includes('--all-severities');
const decoder = new TextDecoder('windows-1255');

function matchesListing(file: string, text: string): boolean {
  const ls = file.replace(/\.cl$/i, (e) => (e === '.CL' ? '.LS' : '.ls'));
  if (!fs.existsSync(ls)) return false;
  const trimmed = (lines: string[]) => {
    const out = lines.map((l) => l.trimEnd());
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  };
  const listed = trimmed(parseListing(decoder.decode(fs.readFileSync(ls))).source.map((s) => s.text));
  const source = trimmed(text.split(/\r?\n|\r/));
  return listed.length === source.length && listed.every((l, i) => l === source[i]);
}

function walk(d: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'docs' || e.name === 'node_modules') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.cl$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(dir);
const unresolved = new Map<string, { count: number; examples: string[] }>();
let resolvedRefs = 0;
const byMessage = new Map<string, { count: number; examples: string[] }>();
let failedFiles = 0;
let checked = 0;
let total = 0;
const started = Date.now();
let slowest = { ms: 0, file: '', lines: 0 };
for (const f of files) {
  const buf = fs.readFileSync(f);
  if (buf.includes(0)) continue; // binary file with a .CL name
  const text = decoder.decode(buf);
  if (verifiedOnly && !matchesListing(f, text)) continue;
  checked++;
  const t0 = performance.now();
  const analysis = analyze(text);
  documentSymbols(analysis.binding.symbols, analysis.file.units);
  foldingRanges(analysis.file);
  const ms = performance.now() - t0;
  if (ms > slowest.ms) slowest = { ms, file: path.relative(dir, f), lines: text.split('\n').length };
  const { diagnostics, binding } = analysis;
  const lines = text.split(/\r?\n|\r/);
  // Control-flow names must always resolve in code that compiled.
  for (const r of binding.references) {
    if (r.isDefinition || r.kind === 'value' || r.kind === 'type') continue;
    if (r.symbol) {
      resolvedRefs++;
      continue;
    }
    if (r.kind === 'subroutine' && (BUILTIN_SUBROUTINES.has(r.ident.name) || r.ident.name.includes('$'))) continue;
    const e = unresolved.get(r.kind) ?? { count: 0, examples: [] };
    e.count++;
    if (e.examples.length < 4) e.examples.push(`${path.relative(dir, f)}:${r.ident.range.start.line + 1}  ${lines[r.ident.range.start.line]?.trim().slice(0, 90)}`);
    unresolved.set(r.kind, e);
  }
  const relevant = diagnostics.filter((d) => (allSeverities || d.severity === 1) && (!codeFilter || d.code === codeFilter));
  if (relevant.length) failedFiles++;
  for (const d of relevant) {
    total++;
    const e = byMessage.get(d.message) ?? { count: 0, examples: [] };
    e.count++;
    if (e.examples.length < 3) {
      e.examples.push(`${path.relative(dir, f)}:${d.range.start.line + 1}:${d.range.start.character + 1}  ${lines[d.range.start.line]?.trim().slice(0, 100)}`);
    }
    byMessage.set(d.message, e);
  }
}
console.log(`${files.length} files, ${checked} checked, ${failedFiles} with errors, ${total} errors, ${Date.now() - started} ms`);
console.log(`slowest: ${slowest.file} (${slowest.lines} lines) ${slowest.ms.toFixed(1)} ms`);
console.log(`${resolvedRefs} control-flow references resolved`);
for (const [kind, e] of unresolved) {
  console.log(`\nunresolved ${kind}: ${e.count}`);
  for (const ex of e.examples) console.log(`     ${ex}`);
}
for (const [message, e] of [...byMessage].sort((a, b) => b[1].count - a[1].count).slice(0, show)) {
  console.log(`\n${e.count}  ${message}`);
  for (const ex of e.examples) console.log(`     ${ex}`);
}
