import { Position } from 'vscode-languageserver';
import { Unit } from '../../language/ast';
import { CLASS_OF_TYPE, PointClass } from '../../language/parameters';
import { rangeContains } from '../../language/types';
import { WorkspaceIndex } from '../../language/workspace';

/** Database type and point class of a point name, including `!BOX` and workspace sequence points. */
export function classifyPoint(index: WorkspaceIndex, pointName: string): { type?: string; cls?: PointClass } {
  const upper = pointName.toUpperCase();
  if (upper === '!BOX' || /^\$NM\d+[NB]\d+$/.test(upper)) return { type: 'PM_BOX', cls: 'Box' };
  const p = index.point(upper);
  if (p) return { type: p.type, cls: CLASS_OF_TYPE[p.type] };
  if (index.programsFor(upper).some((x) => x.kind === 'sequence')) return { type: 'PRMODNIM', cls: 'ProcMod' };
  return {};
}

/** Code and `--` comment of a line, ignoring `--` inside strings. */
export function splitComment(line: string): { code: string; comment?: string } {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inString = !inString;
    else if (!inString && line[i] === '-' && line[i + 1] === '-') {
      const comment = line.slice(i + 2).replace(/^-+/, '').trim();
      return { code: line.slice(0, i), comment: comment || undefined };
    }
  }
  return { code: line };
}

/** Bound point of the SEQUENCE or BLOCK containing a position. */
export function programAt(units: Unit[], pos: Position): string | undefined {
  let bound: string | undefined;
  for (const u of units) {
    if (u.kind === 'package') {
      const inner = programAt(u.units, pos);
      if (inner) return inner;
      continue;
    }
    if (u.kind === 'sequence' || u.kind === 'block') bound = u.point?.name;
    if (rangeContains(u.range, pos)) return bound;
  }
  return undefined;
}
