import { Analysis } from './analyze';
import { Expr, Ident } from './ast';
import { ClSymbol } from './binder';
import { Range } from './types';
import { walk } from './walk';

/** Storage parameters of Process Module, box and Array points. */
export const SLOT_PARAMS = new Set(['NN', 'FL', 'TIME', 'STR8', 'STR16', 'STR32', 'STR64']);

/**
 * One access to a storage location, before it is resolved to a workspace-wide key. Resolution
 * needs the point database and the other files, so it happens in the workspace index.
 */
export interface StorageUse {
  /** Point before the parameter (`!BOX`, `$NM01N05`, `REACT2`); undefined for the bound point. */
  point?: string;
  /** NN, FL, TIME, STRn, or PV for a box Numeric or Flag point. */
  param: string;
  /** Element index; undefined for PV. */
  index?: number;
  /** Bound point of the program the use is in. */
  bound?: string;
  /** The `param(index)` part (or the `.PV`), which is where the cursor selects the storage. */
  range: Range;
  /** For `LOCAL x AT ...`: the local's name, its declaration, every reference to it in this file, and the stores among them. */
  local?: { name: string; decl: Range; refs: Range[]; writes?: Range[] };
  /** A direct access (`!BOX.FL(21)`) that stores: the target of SET, READ or a LOOP. */
  written?: boolean;
}

export interface ProgramSummary {
  kind: 'sequence' | 'block';
  name: string;
  nameRange: Range;
  point?: string;
  dialect?: string;
}

export interface SymbolSummary {
  name: string;
  kind: 'sequence' | 'block' | 'handler' | 'subroutine' | 'phase' | 'step' | 'package' | 'paramList' | 'enumeration' | 'custom';
  range: Range;
  container?: string;
  /** `HOLD HANDLER` for handlers. */
  detail?: string;
}

export interface FileSummary {
  programs: ProgramSummary[];
  /** Every occurrence of a point name: EXTERNAL entries, uses, program headings. */
  pointRefs: { name: string; range: Range; isDeclaration: boolean }[];
  storage: StorageUse[];
  symbols: SymbolSummary[];
  /** `point.PARAM` accesses, counted: used to rank parameter completions by real use. */
  members: { point: string; param: string; count: number }[];
}

export function summarize(a: Analysis): FileSummary {
  const programs: ProgramSummary[] = [];
  const pointRefs: FileSummary['pointRefs'] = [];
  const storage: StorageUse[] = [];
  const symbols: SymbolSummary[] = [];
  const memberCounts = new Map<string, { point: string; param: string; count: number }>();
  // References to each LOCAL, keyed by the position of its defining name.
  const key = (r: Range) => `${r.start.line}:${r.start.character}`;
  const bySymbol = new Map<ClSymbol, Range[]>();
  for (const ref of a.binding.references) {
    const sym = ref.symbol;
    if (!sym) continue;
    if (sym.kind === 'external') pointRefs.push({ name: sym.name, range: ref.ident.range, isDeclaration: ref.isDefinition });
    if (sym.kind === 'local') {
      const list = bySymbol.get(sym) ?? [];
      list.push(ref.ident.range);
      bySymbol.set(sym, list);
    }
  }
  const localRefs = new Map<string, Range[]>();
  for (const [sym, refs] of bySymbol) localRefs.set(key(sym.ident.range), refs);

  const slotUse = (e: Expr): { point?: Ident; param: Ident; index?: number; range: Range } | undefined => {
    // NN(3) on the bound point, or P.NN(3) on another point. Only constant indices can be keyed.
    if (e.kind === 'apply' && e.args.length === 1 && e.args[0].kind === 'number') {
      const index = Number(e.args[0].value);
      if (!Number.isInteger(index)) return undefined;
      if (e.callee.kind === 'name' && SLOT_PARAMS.has(e.callee.id.name)) {
        return { param: e.callee.id, index, range: { start: e.callee.range.start, end: e.range.end } };
      }
      if (e.callee.kind === 'member' && e.callee.object.kind === 'name' && SLOT_PARAMS.has(e.callee.property.name)) {
        return { point: e.callee.object.id, param: e.callee.property, index, range: { start: e.callee.property.range.start, end: e.range.end } };
      }
    }
    if (e.kind === 'member' && e.object.kind === 'name' && (e.property.name === 'PV' || e.property.name === 'PVFL')) {
      return { point: e.object.id, param: e.property, range: e.property.range };
    }
    return undefined;
  };

  // Stores: targets of SET and READ, and LOOP counters, keyed by position.
  const written = new Set<string>();
  const markTarget = (t: Expr) => {
    const id = t.kind === 'name' ? t.id : t.kind === 'apply' && t.callee.kind === 'name' ? t.callee.id : undefined;
    if (id) written.add(key(id.range));
    const use = slotUse(t);
    if (use) written.add(key(use.range));
  };

  walk(a.file, {
    statement(st) {
      if (st.kind === 'set' || st.kind === 'read') st.targets.forEach(markTarget);
      if (st.kind === 'loop' && st.counter) written.add(key(st.counter.range));
    },
    unit(unit) {
      if ((unit.kind === 'sequence' || unit.kind === 'block') && unit.name) {
        programs.push({
          kind: unit.kind,
          name: unit.name.name,
          nameRange: unit.name.range,
          point: unit.point?.name,
          dialect: unit.kind === 'sequence' ? unit.dialect?.name : undefined,
        });
      }
      if ((unit.kind === 'sequence' || unit.kind === 'block') && unit.point) {
        pointRefs.push({ name: unit.point.name, range: unit.point.range, isDeclaration: false });
      }
      if (unit.name && unit.kind !== 'enumeration') {
        const detail = unit.kind === 'handler' ? `${unit.handlerType} HANDLER` : undefined;
        symbols.push({ name: unit.name.text, kind: unit.kind as SymbolSummary['kind'], range: unit.headerRange, detail });
      }
      if (unit.kind === 'sequence' && unit.name) {
        for (const p of unit.phases) {
          if (p.name) symbols.push({ name: p.name.text, kind: 'phase', range: p.range, container: unit.name.text });
          for (const st of p.routine.steps) {
            if (st.name) symbols.push({ name: st.name.text, kind: 'step', range: st.range, container: `${unit.name.text} › ${p.name?.text ?? ''}` });
          }
        }
      }
    },
    declaration(d, _unit, main) {
      if (d.kind !== 'local' || !d.at || d.at.index?.kind !== 'number') return;
      const index = Number(d.at.index.value);
      const bound = main && (main.kind === 'sequence' || main.kind === 'block') ? main.point?.name : undefined;
      const range = { start: d.at.param.range.start, end: d.at.range.end };
      for (const n of d.names) {
        storage.push({
          point: d.at.point?.name,
          param: d.at.param.name,
          index,
          bound,
          range,
          local: { name: n.name, decl: n.range, refs: localRefs.get(key(n.range)) ?? [n.range] },
        });
      }
    },
    expr(e, _unit, main) {
      if (e.kind === 'member' && e.object.kind === 'name') {
        const k = `${e.object.id.name}.${e.property.name}`;
        const m = memberCounts.get(k);
        if (m) m.count++;
        else memberCounts.set(k, { point: e.object.id.name, param: e.property.name, count: 1 });
      }
      const use = slotUse(e);
      if (!use) return;
      const bound = main && (main.kind === 'sequence' || main.kind === 'block') ? main.point?.name : undefined;
      storage.push({ point: use.point?.name, param: use.param.name, index: use.index, bound, range: use.range, written: written.has(key(use.range)) || undefined });
    },
  });
  for (const u of storage) if (u.local) u.local.writes = u.local.refs.filter((r) => written.has(key(r)));

  return { programs, pointRefs, storage, symbols, members: [...memberCounts.values()] };
}
