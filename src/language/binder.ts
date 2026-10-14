import { Declaration, Expr, Ident, Phase, Routine, SourceFile, Statement, Step, TypeSpec, Unit } from './ast';
import { comparePositions, Position, Range, rangeContains } from './types';

export type SymbolKind =
  | 'sequence'
  | 'block'
  | 'handler'
  | 'subroutine'
  | 'package'
  | 'custom'
  | 'paramList'
  | 'enumeration'
  | 'enumState'
  | 'phase'
  | 'step'
  | 'label'
  | 'local'
  | 'constant'
  | 'external'
  | 'parameter'
  | 'function'
  | 'argument';

export interface ClSymbol {
  kind: SymbolKind;
  /** Upper-cased name. */
  name: string;
  /** The defining occurrence of the name. */
  ident: Ident;
  /** The whole definition, for outline and folding. */
  range: Range;
  /** Short description: type, storage slot, handler type... */
  detail?: string;
  /** The declaration that defines a variable-like symbol. */
  declaration?: Declaration;
  children: ClSymbol[];
}

/** What a name in a given position is expected to refer to. */
export type ReferenceKind = 'label' | 'step' | 'phase' | 'handler' | 'subroutine' | 'value' | 'unit' | 'type';

export interface Reference {
  ident: Ident;
  kind: ReferenceKind;
  /** Undefined when the name is unresolved, a built-in, or a parameter of another point. */
  symbol?: ClSymbol;
  isDefinition: boolean;
}

export interface Binding {
  /** Top-level symbols in document order, with children nested. */
  symbols: ClSymbol[];
  /** Every definition and use, sorted by position. */
  references: Reference[];
}

const UNIT_SYMBOL_KIND: Record<Unit['kind'], SymbolKind> = {
  sequence: 'sequence',
  block: 'block',
  handler: 'handler',
  subroutine: 'subroutine',
  package: 'package',
  custom: 'custom',
  paramList: 'paramList',
  enumeration: 'enumeration',
};

/** Names a statement can see, innermost first. */
class Scope {
  private readonly names = new Map<string, ClSymbol>();

  constructor(readonly parent?: Scope) {}

  define(sym: ClSymbol): void {
    if (!this.names.has(sym.name)) this.names.set(sym.name, sym);
  }

  lookup(name: string): ClSymbol | undefined {
    return this.names.get(name) ?? this.parent?.lookup(name);
  }
}

/** Where a statement sits, for resolving labels and steps. */
interface Context {
  values: Scope;
  /** Labels of the current step, then of the whole routine. */
  labels: Scope;
  steps: Scope;
  phases: Scope;
  handlers: Scope;
  subroutines: Scope;
}

export function bind(file: SourceFile): Binding {
  return new Binder(file).run();
}

class Binder {
  private readonly references: Reference[] = [];
  private readonly fileValues = new Scope();
  private readonly fileTypes = new Scope();
  private readonly fileUnits = new Scope();
  private readonly fileHandlers = new Scope();
  private readonly fileSubroutines = new Scope();

  constructor(private readonly file: SourceFile) {}

  run(): Binding {
    const symbols = this.declareUnits(this.file.units);
    this.bindUnits(this.file.units, symbols, this.fileValues);
    this.references.sort((a, b) => comparePositions(a.ident.range.start, b.ident.range.start));
    return { symbols, references: this.references };
  }

  private symbol(kind: SymbolKind, ident: Ident, range: Range, detail?: string, declaration?: Declaration): ClSymbol {
    const sym: ClSymbol = { kind, name: ident.name, ident, range, detail, declaration, children: [] };
    this.references.push({ ident, kind: 'value', symbol: sym, isDefinition: true });
    return sym;
  }

  private ref(ident: Ident | undefined, kind: ReferenceKind, symbol: ClSymbol | undefined): void {
    if (ident) this.references.push({ ident, kind, symbol, isDefinition: false });
  }

  // ---------------------------------------------------------------- pass 1: unit-level names

  /** Create symbols for units and their global names so later units can refer to earlier ones and vice versa. */
  private declareUnits(units: Unit[]): ClSymbol[] {
    const out: ClSymbol[] = [];
    for (const unit of units) {
      const sym = unit.name
        ? this.symbol(UNIT_SYMBOL_KIND[unit.kind], unit.name, unit.range, unitDetail(unit))
        : ({ kind: UNIT_SYMBOL_KIND[unit.kind], name: unit.kind.toUpperCase(), ident: { text: unitLabel(unit), name: '', range: unit.headerRange }, range: unit.range, children: [] } as ClSymbol);
      out.push(sym);
      switch (unit.kind) {
        case 'handler':
          if (unit.name) this.fileHandlers.define(sym);
          break;
        case 'subroutine':
          if (unit.name) this.fileSubroutines.define(sym);
          break;
        case 'paramList':
        case 'enumeration':
          if (unit.name) this.fileTypes.define(sym);
          if (unit.kind === 'enumeration') {
            for (const st of unit.states) {
              const state = this.symbol('enumState', st, st.range, unit.name?.text);
              sym.children.push(state);
              this.fileValues.define(state);
            }
          }
          break;
        case 'custom':
          // CDS parameters become parameters of the points the package is attached to; blocks in
          // the file refer to them by bare name.
          for (const d of unit.declarations) {
            if (d.kind !== 'parameter') continue;
            for (const n of d.names) {
              const p = this.symbol('parameter', n, d.range, typeText(d.type) ?? 'NUMBER', d);
              sym.children.push(p);
              this.fileValues.define(p);
            }
          }
          break;
        case 'package':
          sym.children.push(...this.declareUnits(unit.units));
          break;
        default:
          if (unit.name) this.fileUnits.define(sym);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- pass 2: bodies

  /**
   * Bind units in order. A SEQUENCE or BLOCK starts a program group; the handlers and subroutines
   * that follow it see its declarations.
   */
  private bindUnits(units: Unit[], symbols: ClSymbol[], outer: Scope): void {
    let groupValues = outer;
    let groupPhases = new Scope();
    units.forEach((unit, i) => {
      const sym = symbols[i];
      if (unit.kind === 'sequence' || unit.kind === 'block') {
        groupValues = new Scope(outer);
        groupPhases = new Scope();
        this.declare(unit.declarations, groupValues, sym);
        this.bindDeclarations(unit.declarations, groupValues);
        if (unit.point) this.ref(unit.point, 'value', undefined);
        if (unit.kind === 'block') {
          this.ref(unit.paramList, 'type', unit.paramList && this.fileTypes.lookup(unit.paramList.name));
          if (unit.when) this.expr(unit.when, groupValues);
        }
      }
      const ctx: Context = {
        values: groupValues,
        labels: new Scope(),
        steps: new Scope(),
        phases: groupPhases,
        handlers: this.fileHandlers,
        subroutines: this.fileSubroutines,
      };
      switch (unit.kind) {
        case 'sequence':
          this.bindSequence(unit.phases, sym, ctx);
          break;
        case 'block':
          this.bindRoutine(unit.routine, sym, ctx);
          break;
        case 'handler': {
          const values = new Scope(groupValues);
          this.declare(unit.declarations, values, sym);
          this.bindDeclarations(unit.declarations, values);
          if (unit.when) this.expr(unit.when, values);
          const hctx = { ...ctx, values };
          // Step names are unique across a handler and its RESTART section.
          const steps = new Scope();
          this.bindRoutine(unit.routine, sym, { ...hctx, steps }, steps);
          if (unit.restart) this.bindRoutine(unit.restart.routine, sym, { ...hctx, steps }, steps);
          break;
        }
        case 'subroutine': {
          const values = new Scope(groupValues);
          for (const arg of unit.args) {
            for (const n of arg.names) {
              const a = this.symbol('argument', n, n.range, `${arg.mode} ${typeText(arg.type) ?? 'NUMBER'}`);
              sym.children.push(a);
              values.define(a);
            }
            this.bindType(arg.type);
          }
          this.declare(unit.declarations, values, sym);
          this.bindDeclarations(unit.declarations, values);
          this.bindRoutine(unit.routine, sym, { ...ctx, values });
          break;
        }
        case 'package':
          this.bindUnits(unit.units, sym.children, outer);
          break;
        case 'custom':
        case 'paramList':
          for (const d of unit.declarations) if (d.kind === 'parameter') this.bindType(d.type);
          if (unit.kind === 'paramList') {
            for (const d of unit.declarations) {
              if (d.kind !== 'parameter') continue;
              for (const n of d.names) sym.children.push(this.symbol('parameter', n, d.range, typeText(d.type) ?? 'NUMBER', d));
            }
          }
          break;
      }
      if (unit.endName) {
        this.ref(unit.endName, 'unit', unit.name && unit.endName.name === unit.name.name ? sym : undefined);
      }
    });
  }

  private declare(decls: Declaration[], scope: Scope, owner: ClSymbol): void {
    for (const d of decls) {
      switch (d.kind) {
        case 'local':
          for (const n of d.names) {
            const s = this.symbol('local', n, d.range, localDetail(d), d);
            owner.children.push(s);
            scope.define(s);
          }
          break;
        case 'constant': {
          const s = this.symbol('constant', d.name, d.range, `= ${exprText(d.value)}`, d);
          owner.children.push(s);
          scope.define(s);
          break;
        }
        case 'external':
          for (const n of d.names) {
            const s = this.symbol('external', n, n.range, 'external point', d);
            owner.children.push(s);
            scope.define(s);
          }
          break;
        case 'parameter':
          for (const n of d.names) {
            const s = this.symbol('parameter', n, d.range, typeText(d.type) ?? 'NUMBER', d);
            owner.children.push(s);
            scope.define(s);
          }
          break;
        case 'define': {
          const s = this.symbol('function', d.name, d.range, `(${d.params.map((p) => p.text).join(', ')})`, d);
          owner.children.push(s);
          scope.define(s);
          break;
        }
      }
    }
  }

  private bindDeclarations(decls: Declaration[], scope: Scope): void {
    for (const d of decls) {
      switch (d.kind) {
        case 'local':
          this.bindType(d.type);
          if (d.at) {
            if (d.at.point) this.ref(d.at.point, 'value', scope.lookup(d.at.point.name));
            if (d.at.index) this.expr(d.at.index, scope);
          }
          break;
        case 'constant':
          this.expr(d.value, scope);
          break;
        case 'parameter':
          this.bindType(d.type);
          for (const a of d.attributes) if (a.value) this.expr(a.value, scope);
          break;
        case 'define': {
          const inner = new Scope(scope);
          for (const p of d.params) inner.define(this.symbol('argument', p, p.range, 'function argument'));
          if (d.value) this.expr(d.value, inner);
          break;
        }
      }
    }
  }

  private bindType(type: TypeSpec | undefined): void {
    if (type?.kind === 'named') {
      const sym = this.fileTypes.lookup(type.name.name);
      if (sym) this.ref(type.name, 'type', sym);
    }
  }

  // ---------------------------------------------------------------- phases, steps, statements

  private bindSequence(phases: Phase[], owner: ClSymbol, ctx: Context): void {
    const phaseSyms = phases.map((p) => {
      if (!p.name) return undefined;
      const s = this.symbol('phase', p.name, p.range, p.keepEnb ? 'KEEPENB' : undefined);
      owner.children.push(s);
      ctx.phases.define(s);
      return s;
    });
    phases.forEach((p, i) => {
      if (p.alarm) this.expr(p.alarm, ctx.values);
      for (const h of p.handlers) this.ref(h.name, 'handler', ctx.handlers.lookup(h.name.name));
      this.bindRoutine(p.routine, phaseSyms[i] ?? owner, { ...ctx, steps: new Scope() });
    });
  }

  /** Bind a routine's steps and statements. `steps` is shared when a handler's RESTART continues it. */
  private bindRoutine(routine: Routine, owner: ClSymbol, ctx: Context, steps = ctx.steps): void {
    const routineLabels = new Scope(ctx.labels);
    const stepScopes = routine.steps.map(() => new Scope(routineLabels));
    // Labels may be targets of forward GOTOs, so declare them all first.
    this.declareLabels(routine.statements, routineLabels, owner);
    routine.steps.forEach((st, i) => {
      const sym = st.name ? this.symbol('step', st.name, st.range) : undefined;
      if (sym) {
        owner.children.push(sym);
        steps.define(sym);
      }
      this.declareLabels(st.statements, stepScopes[i], sym ?? owner);
    });
    // A GOTO may name a label in another step of the routine; fall back to them.
    routine.steps.forEach((st, i) => {
      for (const stmt of st.statements) {
        if (stmt.label) {
          const sym = stepScopes[i].lookup(stmt.label.name);
          if (sym) routineLabels.define(sym);
        }
      }
    });
    const rctx: Context = { ...ctx, labels: routineLabels, steps };
    for (const stmt of routine.statements) this.statement(stmt, rctx);
    routine.steps.forEach((st: Step, i) => {
      for (const stmt of st.statements) this.statement(stmt, { ...rctx, labels: stepScopes[i] });
    });
  }

  private declareLabels(statements: Statement[], scope: Scope, owner: ClSymbol): void {
    statements.forEach((stmt, i) => {
      if (!stmt.label) return;
      // A loop's label covers its body, down to the REPEAT that closes it.
      let range = stmt.range;
      if (stmt.kind === 'loop') {
        const name = stmt.label.name;
        const end = statements.slice(i + 1).find((s) => s.kind === 'repeat' && s.target?.name === name);
        if (end) range = { start: stmt.range.start, end: end.range.end };
      }
      const sym = this.symbol('label', stmt.label, range, stmt.kind === 'loop' ? 'LOOP' : undefined);
      owner.children.push(sym);
      scope.define(sym);
    });
  }

  private statement(stmt: Statement, ctx: Context): void {
    const v = ctx.values;
    switch (stmt.kind) {
      case 'set':
        stmt.targets.forEach((t) => this.expr(t, v));
        this.expr(stmt.value, v);
        if (stmt.onError) this.statement(stmt.onError.statement, ctx);
        break;
      case 'read':
      case 'write':
        stmt.targets.forEach((t) => this.expr(t, v));
        stmt.sources.forEach((t) => this.expr(t, v));
        if (stmt.onError) this.statement(stmt.onError.statement, ctx);
        break;
      case 'stateChange':
        this.ref(stmt.state, 'value', this.fileValues.lookup(stmt.state.name));
        stmt.targets.forEach((t) => this.expr(t, v));
        if (stmt.onError) this.statement(stmt.onError.statement, ctx);
        break;
      case 'goto':
        if (stmt.targetKind === 'label') this.ref(stmt.target, 'label', stmt.target && ctx.labels.lookup(stmt.target.name));
        else if (stmt.targetKind === 'step') this.ref(stmt.target, 'step', stmt.target && ctx.steps.lookup(stmt.target.name));
        else this.ref(stmt.target, 'phase', stmt.target && ctx.phases.lookup(stmt.target.name));
        break;
      case 'resume':
        this.ref(stmt.target, 'phase', stmt.target && ctx.phases.lookup(stmt.target.name));
        break;
      case 'repeat':
        this.ref(stmt.target, 'label', stmt.target && ctx.labels.lookup(stmt.target.name));
        break;
      case 'if':
        for (const b of stmt.branches) {
          this.expr(b.condition, v);
          if (b.onError) this.statement(b.onError.statement, ctx);
          b.body.forEach((s) => this.statement(s, ctx));
        }
        stmt.elseBody?.forEach((s) => this.statement(s, ctx));
        break;
      case 'loop':
        if (stmt.counter) this.ref(stmt.counter, 'value', v.lookup(stmt.counter.name));
        if (stmt.low) this.expr(stmt.low, v);
        if (stmt.high) this.expr(stmt.high, v);
        break;
      case 'call':
        this.ref(stmt.target, 'subroutine', stmt.target && ctx.subroutines.lookup(stmt.target.name));
        stmt.args.forEach((a) => this.expr(a, v));
        break;
      case 'enb':
        for (const h of stmt.handlers) this.ref(h.name, 'handler', ctx.handlers.lookup(h.name.name));
        break;
      case 'initiate':
        if (stmt.target) this.ref(stmt.target, 'value', v.lookup(stmt.target.name));
        if (stmt.onError) this.statement(stmt.onError.statement, ctx);
        break;
      case 'wait':
        if (stmt.value) this.expr(stmt.value, v);
        if (stmt.timeout) {
          this.expr(stmt.timeout.time, v);
          this.statement(stmt.timeout.statement, ctx);
        }
        if (stmt.onError) this.statement(stmt.onError.statement, ctx);
        break;
      case 'send':
        if (stmt.destination) this.expr(stmt.destination, v);
        stmt.items.forEach((e) => this.expr(e, v));
        break;
    }
  }

  private expr(e: Expr, scope: Scope): void {
    switch (e.kind) {
      case 'name':
        this.ref(e.id, 'value', scope.lookup(e.id.name));
        break;
      case 'member':
        // Only the point is resolved; the property is a parameter of that point.
        this.expr(e.object, scope);
        break;
      case 'apply':
        this.expr(e.callee, scope);
        e.args.forEach((a) => this.expr(a, scope));
        break;
      case 'unary':
        this.expr(e.operand, scope);
        break;
      case 'binary':
        this.expr(e.left, scope);
        this.expr(e.right, scope);
        break;
      case 'in':
        this.expr(e.value, scope);
        this.expr(e.low, scope);
        this.expr(e.high, scope);
        break;
      case 'time':
        e.parts.forEach((p) => this.expr(p.value, scope));
        break;
      case 'when':
        for (const arm of e.arms) {
          if (arm.condition) this.expr(arm.condition, scope);
          this.expr(arm.value, scope);
        }
        break;
      case 'paren':
        this.expr(e.inner, scope);
        break;
    }
  }
}

// ------------------------------------------------------------------ queries

/** The reference (definition or use) whose name contains `pos`. */
export function referenceAt(binding: Binding, pos: Position): Reference | undefined {
  const refs = binding.references;
  let lo = 0;
  let hi = refs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = refs[mid].ident.range;
    if (comparePositions(r.end, pos) < 0) lo = mid + 1;
    else if (comparePositions(r.start, pos) > 0) hi = mid - 1;
    else {
      // Prefer a resolved reference when two share a position (definition and use).
      const hits = refs.filter((x) => rangeContains(x.ident.range, pos));
      return hits.find((x) => x.symbol) ?? hits[0];
    }
  }
  return undefined;
}

export function referencesTo(binding: Binding, sym: ClSymbol): Reference[] {
  return binding.references.filter((r) => r.symbol === sym);
}

// ------------------------------------------------------------------ text helpers

export function typeText(t: TypeSpec | undefined): string | undefined {
  if (!t) return undefined;
  const arr = t.array ? ` ARRAY (${t.array.map(exprText).join(', ')})` : '';
  switch (t.kind) {
    case 'named':
      return t.name.text.toUpperCase() + arr;
    case 'states':
      return t.states.map((s) => s.text).join('/') + arr;
    case 'array':
      return `NUMBER${arr}`;
  }
}

function localDetail(d: Extract<Declaration, { kind: 'local' }>): string {
  const type = typeText(d.type) ?? 'NUMBER';
  if (!d.at) return type;
  const point = d.at.point ? `${d.at.point.text}.` : '';
  const index = d.at.index ? `(${exprText(d.at.index)})` : '';
  return `${type} AT ${point}${d.at.param.text}${index}`;
}

function unitDetail(unit: Unit): string | undefined {
  switch (unit.kind) {
    case 'sequence':
      return unit.dialect && unit.point ? `${unit.dialect.text}; POINT ${unit.point.text}` : undefined;
    case 'block':
      return [unit.point ? `POINT ${unit.point.text}` : unit.generic ? 'GENERIC' : undefined, unit.insertionPoint && `AT ${unit.insertionPoint.text}`]
        .filter(Boolean)
        .join('; ');
    case 'handler':
      return `${unit.handlerType} HANDLER`;
    case 'enumeration':
      return unit.states.map((s) => s.text).join('/');
  }
  return undefined;
}

function unitLabel(unit: Unit): string {
  return unit.kind === 'custom' ? 'CUSTOM' : unit.kind === 'package' ? 'PACKAGE' : '(no heading)';
}

export function exprText(e: Expr): string {
  switch (e.kind) {
    case 'number':
    case 'string':
      return e.value;
    case 'name':
      return e.id.text;
    case 'member':
      return `${exprText(e.object)}.${e.property.text}`;
    case 'apply':
      return `${exprText(e.callee)}(${e.args.map(exprText).join(', ')})`;
    case 'unary':
      return e.op === 'NOT' ? `NOT ${exprText(e.operand)}` : `${e.op}${exprText(e.operand)}`;
    case 'binary':
      return e.op === '..' ? `${exprText(e.left)}..${exprText(e.right)}` : `${exprText(e.left)} ${e.op} ${exprText(e.right)}`;
    case 'in':
      return `${exprText(e.value)}${e.negated ? ' NOT' : ''} IN ${exprText(e.low)}..${exprText(e.high)}`;
    case 'time':
      return e.parts.map((p) => `${exprText(p.value)} ${p.unit}`).join(' ');
    case 'when':
      return '(WHEN ...)';
    case 'paren':
      return `(${exprText(e.inner)})`;
    case 'error':
      return '?';
  }
}
