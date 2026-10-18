import { DocumentSymbol, SymbolKind } from 'vscode-languageserver';
import { ClSymbol, SymbolKind as ClKind } from '../../language/binder';
import { Expr, Unit } from '../../language/ast';
import { comparePositions, Range } from '../../language/types';
import { walk } from '../../language/walk';

const KIND: Record<ClKind, SymbolKind> = {
  sequence: SymbolKind.Module,
  block: SymbolKind.Module,
  handler: SymbolKind.Event,
  subroutine: SymbolKind.Function,
  package: SymbolKind.Package,
  custom: SymbolKind.Struct,
  paramList: SymbolKind.Interface,
  enumeration: SymbolKind.Enum,
  enumState: SymbolKind.EnumMember,
  phase: SymbolKind.Class,
  step: SymbolKind.Method,
  label: SymbolKind.Key,
  local: SymbolKind.Variable,
  constant: SymbolKind.Constant,
  external: SymbolKind.Object,
  parameter: SymbolKind.Property,
  function: SymbolKind.Function,
  argument: SymbolKind.Variable,
};

/**
 * The CL word for structural symbols, shown first in their detail. The outline's tooltip names
 * the LSP kind ("class", "method"), which an extension cannot change, so the word is there instead.
 */
const KEYWORD: Partial<Record<ClKind, string>> = {
  sequence: 'SEQUENCE',
  block: 'BLOCK',
  subroutine: 'SUBROUTINE',
  package: 'PACKAGE',
  enumeration: 'ENUMERATION',
  phase: 'PHASE',
  step: 'STEP',
  label: 'label',
};

/** Declaration lists run to dozens of names; past this many they are grouped under one node. */
const GROUP_OVER = 3;

/** LOCAL groups, in the order they are shown. */
const LOCAL_GROUPS = [
  'Box numerics', 'Box flags', 'Box times', 'Box strings',
  'Numerics', 'Flags', 'Times', 'Strings',
  'In other sequences', 'Constants', 'Variables',
];

/**
 * Outline of a file. `units` are the parsed units the symbols were bound from, in the same
 * order; with them, each program also lists the box timers it uses.
 */
export function documentSymbols(symbols: ClSymbol[], units?: Unit[], unused = new Set<ClSymbol>()): DocumentSymbol[] {
  return symbols.map((sym, i) => toDocumentSymbol(sym, unused, units?.[i]));
}

function toDocumentSymbol(sym: ClSymbol, unused: Set<ClSymbol>, unit?: Unit): DocumentSymbol {
  const externals = sym.children.filter((c) => c.kind === 'external');
  const locals = sym.children.filter((c) => c.kind === 'local' || c.kind === 'constant');
  const others = sym.children.filter((c) => !externals.includes(c) && !locals.includes(c));
  const nested = unit?.kind === 'package' ? unit.units : undefined;
  const children = [
    ...group('EXTERNAL', externals, 'points', unused),
    ...groupLocals(locals, unused),
    ...(unit && unit.kind !== 'package' ? timers(unit) : []),
    ...others.map((c) => toDocumentSymbol(c, unused, nested?.find((u) => u.name?.range === c.ident.range))),
  ];
  return {
    name: sym.ident.text || sym.name,
    detail: [unused.has(sym) && 'unused', KEYWORD[sym.kind], sym.detail].filter(Boolean).join(' · ') || undefined,
    kind: KIND[sym.kind],
    range: sym.range,
    selectionRange: sym.ident.range,
    children,
  };
}

/** Wrap `members` in one node when there are enough of them to clutter the outline. */
function group(name: string, members: ClSymbol[], noun: string, unused: Set<ClSymbol>): DocumentSymbol[] {
  const items = members.map((m) => toDocumentSymbol(m, unused));
  if (members.length <= GROUP_OVER) return items;
  return [container(name, `${members.length} ${noun}`, items)];
}

/**
 * LOCALs grouped by storage, mirroring the "-- BOX FLAGS --" / "-- MOD NUMERICS --" sections
 * programs are usually written in.
 */
function groupLocals(locals: ClSymbol[], unused: Set<ClSymbol>): DocumentSymbol[] {
  const item = (l: ClSymbol) => toDocumentSymbol(l, unused);
  if (locals.length <= GROUP_OVER) return locals.map(item);
  const byGroup = new Map<string, ClSymbol[]>();
  for (const l of locals) {
    const g = localGroup(l);
    byGroup.set(g, [...(byGroup.get(g) ?? []), l]);
  }
  const children =
    byGroup.size > 1
      ? LOCAL_GROUPS.filter((g) => byGroup.has(g)).map((g) =>
          container(g, `${byGroup.get(g)!.length}`, byGroup.get(g)!.map(item)),
        )
      : locals.map(item);
  return [container('LOCAL', `${locals.length} variables`, children)];
}

function localGroup(sym: ClSymbol): string {
  const d = sym.declaration;
  if (sym.kind === 'constant' || d?.kind === 'constant') return 'Constants';
  if (d?.kind !== 'local' || !d.at) return 'Variables';
  const point = d.at.point?.name;
  const param = d.at.param.name;
  const kind = param === 'NN' ? 'numerics' : param === 'FL' ? 'flags' : param === 'TIME' ? 'times' : 'strings';
  if (!point) return kind[0].toUpperCase() + kind.slice(1);
  if (point === '!BOX' || /^\$NM\d+[NB]\d+$/.test(point)) return `Box ${kind}`;
  return 'In other sequences';
}

/**
 * Box timers a unit uses: `!BOX.TMCMD(2)`, `!BOX.TMPV(2)`, `$NM03N09.TMSP(5)`. They are not
 * declared, so the outline lists each timer once, at its first use.
 */
function timers(unit: Unit): DocumentSymbol[] {
  const found = new Map<string, { box: string; index: number; params: Set<string>; first: Range; last: Range }>();
  const visit = (e: Expr) => {
    if (e.kind !== 'apply' || e.callee.kind !== 'member' || e.callee.object.kind !== 'name') return;
    const param = e.callee.property.name;
    const arg = e.args[0];
    if (!/^TM[A-Z]+$/.test(param) || e.args.length !== 1 || arg.kind !== 'number') return;
    const box = e.callee.object.id.text.toUpperCase();
    const index = Number(arg.value);
    const key = `${box}:${index}`;
    const t = found.get(key);
    if (t) {
      t.params.add(param);
      t.last = e.range;
    } else found.set(key, { box, index, params: new Set([param]), first: e.range, last: e.range });
  };
  walk({ units: [unit], directives: [], commentLines: [], multiLineStatements: [] }, { expr: visit });
  if (!found.size) return [];
  const entries = [...found.values()]
    .sort((a, b) => a.box.localeCompare(b.box) || a.index - b.index)
    .map((t) => ({
      name: `${t.box === '!BOX' ? '' : `${t.box} `}timer ${t.index}`,
      detail: [...t.params].sort().join(', '),
      kind: SymbolKind.Variable,
      range: t.first,
      selectionRange: t.first,
    }));
  // TIMERS is a summary, not a section of code: it covers only the first timer use, so that
  // "Follow Cursor" in the Outline view highlights the phase or step the cursor is in.
  const node = container('TIMERS', `${entries.length}`, entries);
  const first = entries.reduce((a, e) => (comparePositions(e.range.start, a.range.start) < 0 ? e : a));
  return [{ ...node, range: first.range, selectionRange: first.selectionRange }];
}

function container(name: string, detail: string, children: DocumentSymbol[]): DocumentSymbol {
  const ranges = children.map((c) => c.range);
  const start = ranges.reduce((a, r) => (comparePositions(r.start, a) < 0 ? r.start : a), ranges[0].start);
  const end = ranges.reduce((a, r) => (comparePositions(r.end, a) > 0 ? r.end : a), ranges[0].end);
  const first = children.find((c) => c.range.start === start) ?? children[0];
  return { name, detail, kind: SymbolKind.Namespace, range: { start, end }, selectionRange: first.selectionRange, children };
}
