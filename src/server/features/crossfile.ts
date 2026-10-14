import { Location, Position, SymbolInformation, SymbolKind } from 'vscode-languageserver';
import { Analysis } from '../../language/analyze';
import { referenceAt } from '../../language/binder';
import { FileSummary } from '../../language/summary';
import { comparePositions, rangeContains } from '../../language/types';
import { ioOf } from '../../language/eb';
import { formatBox, HARDWARE_NAME, WorkspaceIndex } from '../../language/workspace';
import { programAt } from './shared';

/** What the cursor is on, as far as the workspace is concerned. */
export type Target = { kind: 'storage'; key: string } | { kind: 'point'; name: string } | undefined;

export function targetAt(a: Analysis, summary: FileSummary, index: WorkspaceIndex, pos: Position): Target {
  // The `NN(41)` of `X.NN(41)`, `!BOX.FL(21)`, `NN(3)`, or the AT part of a LOCAL.
  const use = summary.storage.find((u) => rangeContains(u.range, pos));
  const useKey = use && index.storageKey(use, summary);
  if (useKey) return { kind: 'storage', key: useKey };

  const ref = referenceAt(a.binding, pos);
  if (!ref) return undefined;
  const sym = ref.symbol;
  if (sym?.kind === 'local') {
    const decl = summary.storage.find((u) => u.local && sameStart(u.local.decl, sym.ident.range));
    const key = decl && index.storageKey(decl, summary);
    return key ? { kind: 'storage', key } : undefined;
  }
  if (sym?.kind === 'external') return { kind: 'point', name: sym.name };
  // Undeclared names that are points: a program's own bound point, a point in the database, or
  // an I/O channel.
  const name = ref.ident.name;
  if (!sym && ref.kind === 'value' && (HARDWARE_NAME.test(name) || index.point(name) || index.pointDefinitions(name).length)) {
    return { kind: 'point', name: ref.ident.name };
  }
  return undefined;
}

export function crossDefinition(target: Target, index: WorkspaceIndex, a: Analysis, pos: Position): Location[] {
  if (!target) return [];
  if (target.kind === 'storage') return index.storageDefinitions(target.key);
  if (HARDWARE_NAME.test(target.name)) {
    // The database entries of the points built on or wired to the channel, in this HPM.
    const bound = programAt(a.file.units, pos);
    const box = bound ? index.boxOfProgram(bound) : undefined;
    return index.hardwareUses(target.name, box).map((u) => {
      const loc = index.pointLocation(u.point.name)!;
      return { uri: loc.uri, range: loc.range };
    });
  }
  return index.pointDefinitions(target.name);
}

export function crossReferences(target: Target, index: WorkspaceIndex, includeDeclaration: boolean): Location[] {
  if (!target) return [];
  return target.kind === 'storage'
    ? index.storageReferences(target.key, includeDeclaration)
    : index.pointReferences(target.name, includeDeclaration);
}

/** Workspace symbol search over programs, handlers, subroutines, phases, steps and database points. */
export function workspaceSymbols(index: WorkspaceIndex, query: string, limit = 500): SymbolInformation[] {
  const q = query.toUpperCase();
  const matches = (name: string) => fuzzy(name.toUpperCase(), q);
  const out: SymbolInformation[] = [];
  const kinds: Record<string, SymbolKind> = {
    sequence: SymbolKind.Module,
    block: SymbolKind.Module,
    handler: SymbolKind.Event,
    subroutine: SymbolKind.Function,
    phase: SymbolKind.Class,
    step: SymbolKind.Method,
    package: SymbolKind.Package,
    paramList: SymbolKind.Interface,
    custom: SymbolKind.Struct,
    enumeration: SymbolKind.Enum,
  };
  for (const { uri, summary } of index.symbols()) {
    for (const s of summary.symbols) {
      if (!matches(s.name)) continue;
      out.push(SymbolInformation.create(s.name, kinds[s.kind], s.range, uri, s.container));
      if (out.length >= limit) return out;
    }
  }
  // A query that looks like an I/O address (DI16S06, !AI06S04) finds the points on that channel.
  const address = /^!?(AI|AO|DI|DO)\d/i.test(query) ? q.replace(/^!/, '') : undefined;
  for (const p of index.allPoints()) {
    const io = address ? ioOf(p) : undefined;
    const wired = io ? [io.channel?.address, ...io.inputs, ...io.outputs].find((x) => x?.toUpperCase().replace(/^!/, '').startsWith(address!)) : undefined;
    if (!wired && !matches(p.name)) continue;
    const loc = index.pointLocation(p.name)!;
    const desc = p.fields.PTDESC ? ` ${p.fields.PTDESC}` : '';
    const box = wired ? index.boxOfPoint(p) : undefined;
    const node = box ? ` · ${formatBox(box)}` : '';
    out.push(SymbolInformation.create(p.name, SymbolKind.Object, loc.range, loc.uri, `${wired ? `${wired}${node} · ` : ''}${p.type}${desc}`));
    if (out.length >= limit) break;
  }
  return out;
}

/** Characters of `query` appear in `name` in order. */
function fuzzy(name: string, query: string): boolean {
  let i = 0;
  for (const c of name) if (c === query[i]) i++;
  return i === query.length;
}

function sameStart(a: { start: Position }, b: { start: Position }): boolean {
  return comparePositions(a.start, b.start) === 0;
}

