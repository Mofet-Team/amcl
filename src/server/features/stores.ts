import { Position } from 'vscode-languageserver';
import { Analysis } from '../../language/analyze';
import { FileSummary } from '../../language/summary';
import { Range, rangeContains } from '../../language/types';
import { WorkspaceIndex } from '../../language/workspace';
import { StoreUse, StoreUses } from '../../shared/programs';
import { targetAt } from './crossfile';

interface Access {
  uri: string;
  range: Range;
  name?: string;
  written: boolean;
}

/**
 * Who stores to what is at a position, and who reads it, across the workspace: a storage element
 * (a LOCAL mapped onto it, `NN(3)`, `!BOX.FL(21)`), a point's parameter (`REACT2.SP`), or a
 * point (every parameter of it). Undefined when the position is on none of these.
 */
export function storeUses(
  a: Analysis,
  summary: FileSummary,
  index: WorkspaceIndex,
  pos: Position,
  lineOf: (uri: string, line: number) => string,
): StoreUses | undefined {
  const target = targetAt(a, summary, index, pos);
  const member = summary.memberRefs.find((m) => rangeContains(m.range, pos));
  let title: string;
  let accesses: Access[];
  let tag: StoreUses['tag'];
  if (target?.kind === 'storage') {
    title = index.describeKey(target.key);
    accesses = storageAccesses(index, target.key);
    const point = (index.storageEntries().get(target.key) ?? []).find((e) => e.kind === 'point' && e.point);
    if (point) tag = { ...use(point, point.point!.name, lineOf), descriptor: point.point!.fields.PTDESC?.trim() || undefined };
  } else if (member) {
    title = `${member.point}.${member.param}`;
    accesses = index.memberUses(member.point, member.param).map((m) => ({ uri: m.uri, range: m.range, name: `${member.point}.${m.param}`, written: !!m.written }));
  } else if (target?.kind === 'point' && !/^[!$]/.test(target.name)) {
    // Not `!BOX`, `$NM01N09` or `!DI11S01`: those name another box in each HPM.
    // Every parameter: through `P.PARAM`, and the slots of a Process Module point however reached.
    const name = target.name.toUpperCase();
    title = `${name}, every parameter`;
    accesses = index.memberUses(name).map((m) => ({ uri: m.uri, range: m.range, name: `${name}.${m.param}`, written: !!m.written }));
    for (const key of index.storageEntries().keys()) if (key.startsWith(`PM:${name}:`)) accesses.push(...storageAccesses(index, key));
  } else return undefined;

  const seen = new Set<string>();
  const unique = accesses.filter((x) => {
    const k = `${x.uri}|${x.range.start.line}:${x.range.start.character}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const order = (x: StoreUse, y: StoreUse) => x.program.localeCompare(y.program) || x.uri.localeCompare(y.uri) || x.line - y.line || x.character - y.character;
  return {
    title,
    stores: unique.filter((x) => x.written).map((x) => use(x, x.name, lineOf)).sort(order),
    reads: unique.filter((x) => !x.written).map((x) => use(x, x.name, lineOf)).sort(order),
    tag,
  };
}

/** Each access to a storage key: every reference of a LOCAL mapped onto it but its declaration, and direct accesses. */
function storageAccesses(index: WorkspaceIndex, key: string): Access[] {
  const out: Access[] = [];
  for (const e of index.storageEntries().get(key) ?? []) {
    if (e.kind === 'local' && e.local) {
      const at = (r: Range) => `${r.start.line}:${r.start.character}`;
      const writes = new Set((e.local.writes ?? []).map(at));
      for (const r of e.local.refs) {
        if (at(r) === at(e.local.decl)) continue;
        out.push({ uri: e.uri, range: r, name: e.local.name, written: writes.has(at(r)) });
      }
    } else if (e.kind === 'use') {
      out.push({ uri: e.uri, range: e.range, written: !!e.written });
    }
  }
  return out;
}

function use(x: { uri: string; range: Range }, name: string | undefined, lineOf: (uri: string, line: number) => string): StoreUse {
  return {
    uri: x.uri,
    line: x.range.start.line,
    character: x.range.start.character,
    end: x.range.end.line === x.range.start.line ? x.range.end.character : x.range.start.character,
    program: programOf(x.uri),
    name,
    text: lineOf(x.uri, x.range.start.line).trim(),
  };
}

/** The file name without `.cl`. */
export const programOf = (uri: string) => decodeURIComponent(uri.replace(/^.*\//, '')).replace(/\.cl$/i, '');
