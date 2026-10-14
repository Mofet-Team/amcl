import { Hover, MarkupKind, Position } from 'vscode-languageserver';
import { Analysis } from '../../language/analyze';
import { ClSymbol, referenceAt } from '../../language/binder';
import { fieldNumber, ioOf, pointStates } from '../../language/eb';
import { builtin } from '../../language/builtins';
import { parameterInfo, POINT_TYPES, TYPE_NAMES } from '../../language/parameters';
import { FileSummary } from '../../language/summary';
import { rangeContains } from '../../language/types';
import { formatBox, HARDWARE_NAME, HardwareUse, WorkspaceIndex } from '../../language/workspace';
import { classifyPoint, programAt, splitComment } from './shared';
import { targetAt } from './crossfile';

export interface HoverContext {
  uri: string;
  analysis: Analysis;
  summary: FileSummary;
  index: WorkspaceIndex;
  /** Source lines of the hovered document. */
  lines: string[];
  /** Short, workspace-relative name for a document URI. */
  display: (uri: string) => string;
}


/** Above this many, the list of other names for a storage element is cut short. */
const MAX_ALIASES = 8;

export function hover(ctx: HoverContext, pos: Position): Hover | undefined {
  const { analysis, summary, index } = ctx;
  const target = targetAt(analysis, summary, index, pos);
  const ref = referenceAt(analysis.binding, pos);
  const sym = ref?.symbol;

  let md: string | undefined;
  const word = wordAt(ctx.lines[pos.line] ?? '', pos.character);
  if (word?.object && target?.kind !== 'storage') {
    // The PARAM of `point.PARAM`, unless it is a storage element, which has its own hover.
    md = parameterSection(ctx, word.object, word.text);
    if (md) return { contents: { kind: MarkupKind.Markdown, value: md }, range: lineRange(pos.line, word) };
  }
  if (!sym && word && !word.object) {
    const b = builtin(word.text);
    if (b) {
      const value = `\`\`\`cl\n${b.signature}\n\`\`\`\n\n${b.description}${b.dialect ? `\n\n*${b.dialect === 'AM' ? 'CL/AM only' : 'CL/AM background blocks only'}*` : ''}`;
      return { contents: { kind: MarkupKind.Markdown, value }, range: lineRange(pos.line, word) };
    }
  }
  if (sym?.kind === 'local') {
    md = [localBlock(ctx, sym), target?.kind === 'storage' ? storageSection(ctx, target.key, sym.name) : undefined]
      .filter(Boolean)
      .join('\n\n---\n\n');
  } else if (target?.kind === 'storage') {
    md = storageSection(ctx, target.key, undefined, true);
  } else if (target?.kind === 'point' && HARDWARE_NAME.test(target.name)) {
    md = hardwareSection(ctx, target.name, pos);
  } else if (target?.kind === 'point') {
    md = pointSection(ctx, target.name);
  } else if (sym) {
    md = declarationBlock(ctx, sym);
  }
  if (!md) return undefined;
  const range = summary.storage.find((u) => rangeContains(u.range, pos))?.range ?? ref?.ident.range;
  return { contents: { kind: MarkupKind.Markdown, value: md }, range };
}

// ------------------------------------------------------------------ sections

/** A LOCAL as `NAME: TYPE AT slot`, with the type spelled out even when it is the default. */
function localBlock(ctx: HoverContext, sym: ClSymbol): string {
  const { comment } = splitComment(ctx.lines[sym.range.start.line] ?? '');
  const parts = [`\`\`\`cl\n${sym.ident.text}: ${sym.detail ?? 'NUMBER'}\n\`\`\``];
  if (comment) parts.push(comment);
  return parts.join('\n\n');
}

/** The declaring line as CL, and its trailing comment as text. */
function declarationBlock(ctx: HoverContext, sym: ClSymbol): string {
  const line = ctx.lines[sym.range.start.line] ?? '';
  const { code, comment } = splitComment(line);
  const what = KIND_LABEL[sym.kind];
  const parts = [`\`\`\`cl\n${code.trim()}\n\`\`\``];
  if (comment) parts.push(comment);
  if (what && !code.trim().toUpperCase().startsWith(what.toUpperCase())) parts.unshift(`*${what}*`);
  return parts.join('\n\n');
}

function storageSection(ctx: HoverContext, key: string, ownName: string | undefined, withTitle = false): string {
  const { index } = ctx;
  const out: string[] = [];
  if (withTitle) out.push(`**${index.describeKey(key)}**`);
  else out.push(`Storage: ${index.describeKey(key)}`);

  const point = index.storagePoint(key);
  if (point && point.name !== ownName) out.push(`Point **${point.name}**${point.fields.PTDESC ? `: ${point.fields.PTDESC}` : ''}`);

  // Leave out the hovered LOCAL itself.
  const others = index.storageLocals(key).filter((l) => !(l.name === ownName && l.uri === ctx.uri));
  if (others.length) {
    const shown = others.slice(0, MAX_ALIASES).map((l) => `\`${l.name}\` in ${link(ctx, l.uri, l.range.start.line)}`);
    const more = others.length > MAX_ALIASES ? `, and ${others.length - MAX_ALIASES} more` : '';
    out.push(`Also mapped as ${shown.join(', ')}${more}`);
  }
  return out.join('\n\n');
}

function pointSection(ctx: HoverContext, name: string): string | undefined {
  const { index } = ctx;
  const p = index.point(name);
  const programs = index.programsFor(name);
  if (!p && !programs.length) return undefined;

  const out: string[] = [];
  const type = p ? POINT_TYPES[p.type] ?? p.type : 'Point';
  out.push(`**${p?.name ?? name.toUpperCase()}** · ${type}`);
  if (p?.fields.PTDESC) out.push(p.fields.PTDESC);

  if (p) {
    const facts: string[] = [];
    const ucn = fieldNumber(p, 'NTWKNUM');
    const node = fieldNumber(p, 'NODENUM');
    const lcn = index.networkOf(p);
    if (ucn !== undefined && node !== undefined) facts.push(`${p.fields.NODETYP ?? 'node'} ${pad(ucn)}/${pad(node)}${lcn ? ` (LCN ${lcn})` : ''}`);
    // Where the point is: its I/O channel, its wiring, its box element, or its controller slot.
    const io = ioOf(p);
    if (io?.channel) facts.push(`I/O \`${io.channel.address}\`${io.channel.card ? ` (${io.channel.card})` : ''}`);
    else if (p.type === 'NUMERNIM' || p.type === 'FLAGNIM') facts.push(`${p.type === 'NUMERNIM' ? 'NN' : 'FL'}(${p.fields.SLOTNUM})`);
    else if (!io && p.fields.SLOTNUM) facts.push(`slot ${p.fields.SLOTNUM}`);
    if (p.fields.UNIT) facts.push(`unit ${p.fields.UNIT}`);
    if (p.fields.EUDESC) facts.push(`EU ${p.fields.EUDESC}`);
    if (p.fields.KEYWORD) facts.push(`keyword ${p.fields.KEYWORD}`);
    if (p.fields.ASSOCDSP) facts.push(`display ${p.fields.ASSOCDSP}`);
    if (facts.length) out.push(facts.join(' · '));
    if (io && !io.channel) {
      const list = (xs: string[]) => xs.map((x) => `\`${x}\``).join(', ');
      const wiring = [io.inputs.length ? `In: ${list(io.inputs)}` : '', io.outputs.length ? `Out: ${list(io.outputs)}` : ''];
      out.push(wiring.filter(Boolean).join(' · '));
    }
    const states = pointStates(p);
    if (states.length) out.push(`States: ${states.map((st, i) => `${i} \`${st}\``).join(' · ')}`);
    out.push(`Defined in ${link(ctx, index.pointLocation(p.name)!.uri, p.line)}`);
    // A box Numeric or Flag point is a name for one box element; show who else uses it.
    const slot = fieldNumber(p, 'SLOTNUM');
    if ((p.type === 'NUMERNIM' || p.type === 'FLAGNIM') && ucn !== undefined && node !== undefined && slot !== undefined) {
      const box = index.boxOfPoint(p);
      if (box) out.push(storageSection(ctx, `BOX:${box}:${p.type === 'NUMERNIM' ? 'NN' : 'FL'}:${slot}`, p.name));
    }
  }
  for (const prog of programs) {
    out.push(`${prog.kind === 'sequence' ? 'SEQUENCE' : 'BLOCK'} ${prog.name} in ${link(ctx, prog.uri, prog.range.start.line)}`);
  }
  return out.join('\n\n');
}

function parameterSection(ctx: HoverContext, object: string, param: string): string | undefined {
  const { cls, type } = classifyPoint(ctx.index, object);
  const info = parameterInfo(cls, param);
  const p = ctx.index.point(object);
  const uses = type ? ctx.index.parameterUse(type).get(param.toUpperCase()) : undefined;
  if (!info && !uses) return undefined;
  const out = [`**${object.toUpperCase()}.${param.toUpperCase()}**${info ? ` · ${TYPE_NAMES[info.type]}` : ''}`];
  if (info) out.push(info.description);
  const states = info?.type === 'SDE' && p ? pointStates(p) : info?.states;
  if (states?.length) out.push(`States: ${states.map((s) => `\`${s}\``).join(' · ')}`);
  if (uses && type) out.push(`Used ${uses}× on ${POINT_TYPES[type] ?? type} points in the workspace`);
  return out.join('\n\n');
}

/** An I/O channel such as `!DI16S06`: the points built on it and wired to it, in this HPM. */
function hardwareSection(ctx: HoverContext, name: string, pos: Position): string {
  const [, kind, card, channel] = HARDWARE_NAME.exec(name)!;
  const bound = programAt(ctx.analysis.file.units, pos);
  const box = bound ? ctx.index.boxOfProgram(bound) : undefined;
  const uses = ctx.index.hardwareUses(name, box);
  const where = box ? ` in ${formatBox(box)}` : '';
  const out = [`**${name.toUpperCase()}** · ${CHANNEL_KIND[kind.toUpperCase()]} card ${card}, channel ${channel}${where}`];
  if (!uses.length) {
    out.push(`Nothing in the point database is connected to this channel${where}.`);
    return out.join('\n\n');
  }
  const role = (u: HardwareUse) => (u.role === 'channel' ? 'built on this channel' : `${u.role}${u.param ? ` .${u.param}` : ''}`);
  const lines = uses.map((u) => {
    const at = box ? '' : ` (${formatBox(u.box)})`;
    const desc = u.point.fields.PTDESC ? ` · ${u.point.fields.PTDESC}` : '';
    return `- **${u.point.name}**${at} · ${POINT_TYPES[u.point.type] ?? u.point.type}, ${role(u)}${desc}`;
  });
  out.push(lines.join('\n'));
  return out.join('\n\n');
}

const CHANNEL_KIND: Record<string, string> = {
  AI: 'Analog input',
  AO: 'Analog output',
  DI: 'Digital input',
  DO: 'Digital output',
};

// ------------------------------------------------------------------ helpers

/** The identifier around a column, and the point before it when it follows a dot. */
function wordAt(line: string, character: number): { text: string; start: number; end: number; object?: string } | undefined {
  const isWord = (c: string | undefined) => !!c && /[\w$!\u0590-\u05ff]/.test(c);
  let start = character;
  let end = character;
  while (isWord(line[start - 1])) start--;
  while (isWord(line[end])) end++;
  if (start === end) return undefined;
  const object = line[start - 1] === '.' ? /([!$\w\\]+)$/.exec(line.slice(0, start - 1))?.[1] : undefined;
  return { text: line.slice(start, end), start, end, object };
}

function lineRange(line: number, w: { start: number; end: number }) {
  return { start: { line, character: w.start }, end: { line, character: w.end } };
}

const KIND_LABEL: Partial<Record<ClSymbol['kind'], string>> = {
  phase: 'phase',
  step: 'step',
  label: 'label',
  handler: 'handler',
  subroutine: 'subroutine',
  constant: 'constant',
  argument: 'argument',
  function: 'function',
  parameter: 'parameter',
  enumState: 'enumeration state',
  external: 'external point',
};



function link(ctx: HoverContext, uri: string, line: number): string {
  return `[${ctx.display(uri)}:${line + 1}](${uri}#L${line + 1})`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
