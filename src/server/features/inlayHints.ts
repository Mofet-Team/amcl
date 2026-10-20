import { InlayHint, MarkupKind, Range as LspRange } from 'vscode-languageserver';
import { Analysis } from '../../language/analyze';
import { POINT_TYPES } from '../../language/parameters';
import { FileSummary, StorageUse } from '../../language/summary';
import { Position, Range } from '../../language/types';
import { constantNumber, walk } from '../../language/walk';
import { WorkspaceIndex } from '../../language/workspace';
import { escapeMarkdown } from '../../shared/markdown';

export interface InlayHintOptions {
  /** The storage element after each use of a LOCAL. */
  locals: boolean;
  /** The descriptor (else the type) after each use of a point, its EXTERNAL entry and the bound point. */
  points: boolean;
}

/** Hints in `range` of a file: where its LOCALs live, and what its points are. */
export function inlayHints(a: Analysis, summary: FileSummary, index: WorkspaceIndex, range: LspRange, options: InlayHintOptions): InlayHint[] {
  const out: InlayHint[] = [];
  const within = (r: Range) => !before(r.end, range.start) && !before(range.end, r.start);
  if (options.locals) localHints(a, summary, within, out);
  if (options.points) pointHints(a, summary, index, within, out);
  return out.sort((x, y) => x.position.line - y.position.line || x.position.character - y.position.character);
}

function localHints(a: Analysis, summary: FileSummary, within: (r: Range) => boolean, out: InlayHint[]): void {
  const byRef = new Map<string, { use: StorageUse; ref: Range }>();
  for (const use of summary.storage) {
    if (!use.local || use.index === undefined) continue;
    // The declaration names its location already.
    for (const ref of use.local.refs) if (!sameStart(ref, use.local.decl)) byRef.set(key(ref.start), { use, ref });
  }
  // `A(2)` is one element of the array: its slot goes after the subscript.
  const subscripted = new Set<string>();
  walk(a.file, {
    expr(e) {
      if (e.kind !== 'apply' || e.callee.kind !== 'name' || e.args.length !== 1) return;
      const k = key(e.callee.range.start);
      const use = byRef.get(k)?.use;
      if (!use?.local?.array) return;
      subscripted.add(k);
      if (!within(e.range)) return;
      const { low, size } = use.local.array;
      const i = constantNumber(e.args[0]);
      const element = low !== undefined && size !== undefined && i !== undefined && i >= low && i < low + size ? use.index! + i - low : undefined;
      out.push({ position: e.range.end, label: element === undefined ? slotLabel(use, true) : slotLabel({ ...use, index: element }, false), paddingLeft: true });
    },
  });
  for (const [k, { use, ref }] of byRef) {
    if (!subscripted.has(k) && within(ref)) out.push({ position: ref.end, label: slotLabel(use, !!use.local!.array), paddingLeft: true });
  }
}

/** `NN(12)`, `!BOX.FL(3)`; for a whole array `NN(5..7)`, or `NN(5..)` when its size is not known. */
function slotLabel(use: StorageUse, whole: boolean): string {
  const size = use.local?.array?.size;
  const at = whole ? `${use.index}..${size !== undefined ? use.index! + size - 1 : ''}` : `${use.index}`;
  return `${use.point ? `${use.point}.` : ''}${use.param}(${at})`;
}

function pointHints(a: Analysis, summary: FileSummary, index: WorkspaceIndex, within: (r: Range) => boolean, out: InlayHint[]): void {
  // `TAG.PV` and `TAG.SO(2)`: the descriptor goes after the access, not between the tag and its parameter.
  const endOf = new Map<string, Position>();
  walk(a.file, {
    expr(e) {
      const member = e.kind === 'member' ? e : e.kind === 'apply' && e.callee.kind === 'member' ? e.callee : undefined;
      if (member?.object.kind !== 'name') return;
      const k = key(member.object.id.range.start);
      const seen = endOf.get(k);
      if (!seen || before(seen, e.range.end)) endOf.set(k, e.range.end);
    },
  });
  // Once per line: `IF T.PV<>0 AND T.PV<>165` needs it after the first use only.
  const shown = new Set<string>();
  for (const ref of summary.pointRefs) {
    const p = index.point(ref.name);
    if (!p || shown.has(`${ref.range.start.line}|${p.name}`)) continue;
    shown.add(`${ref.range.start.line}|${p.name}`);
    const position = endOf.get(key(ref.range.start)) ?? ref.range.end;
    if (!within({ start: ref.range.start, end: position })) continue;
    const type = POINT_TYPES[p.type] ?? p.type;
    const desc = p.fields.PTDESC?.trim();
    out.push({
      position,
      // The descriptor tells points apart; a type in brackets is not mistaken for one.
      label: desc || `[${type}]`,
      paddingLeft: true,
      tooltip: { kind: MarkupKind.Markdown, value: `**${escapeMarkdown(p.name)}** · ${type}${desc ? `\n\n${escapeMarkdown(desc)}` : ''}` },
    });
  }
}

const key = (p: Position) => `${p.line}:${p.character}`;
const before = (x: Position, y: Position) => x.line < y.line || (x.line === y.line && x.character < y.character);
const sameStart = (x: Range, y: Range) => x.start.line === y.start.line && x.start.character === y.start.character;
