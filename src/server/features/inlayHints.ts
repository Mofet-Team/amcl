import { InlayHint, MarkupKind, Range as LspRange } from 'vscode-languageserver';
import { POINT_TYPES } from '../../language/parameters';
import { FileSummary } from '../../language/summary';
import { Position, Range } from '../../language/types';
import { WorkspaceIndex } from '../../language/workspace';

export interface InlayHintOptions {
  /** The storage element after each use of a LOCAL. */
  locals: boolean;
  /** The descriptor (else the type) after each EXTERNAL entry and bound point. */
  points: boolean;
}

/** Hints in `range` of a file: where its LOCALs live, and what its points are. */
export function inlayHints(summary: FileSummary, index: WorkspaceIndex, lines: string[], range: LspRange, options: InlayHintOptions): InlayHint[] {
  const out: InlayHint[] = [];
  const within = (r: Range) => !before(r.end, range.start) && !before(range.end, r.start);
  if (options.locals) {
    for (const u of summary.storage) {
      if (!u.local || u.index === undefined) continue;
      const label = `${u.point ? `${u.point}.` : ''}${u.param}(${u.index})`;
      for (const r of u.local.refs) {
        // The declaration names its slot already; `X(2)` would read as `X NN(5)(2)`.
        if (sameStart(r, u.local.decl) || !within(r) || /^\s*\(/.test((lines[r.end.line] ?? '').slice(r.end.character))) continue;
        out.push({ position: r.end, label, paddingLeft: true });
      }
    }
  }
  if (options.points) {
    const headings = summary.programs.flatMap((p) => (p.pointRange ? [p.pointRange] : []));
    for (const ref of summary.pointRefs) {
      if (!within(ref.range) || !(ref.isDeclaration || headings.some((h) => sameStart(h, ref.range)))) continue;
      const p = index.point(ref.name);
      if (!p) continue;
      const type = POINT_TYPES[p.type] ?? p.type;
      const desc = p.fields.PTDESC?.trim();
      out.push({
        position: ref.range.end,
        // The descriptor tells points apart; the type is mostly the same along an EXTERNAL list.
        label: desc || type,
        paddingLeft: true,
        tooltip: { kind: MarkupKind.Markdown, value: `**${p.name}** · ${type}${desc ? `\n\n${desc}` : ''}` },
      });
    }
  }
  return out.sort((a, b) => a.position.line - b.position.line || a.position.character - b.position.character);
}

const before = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.character < b.character);
const sameStart = (a: Range, b: Range) => a.start.line === b.start.line && a.start.character === b.start.character;
