// Semantic checks beyond syntax. Each has a stable code so users can tell them apart. Rules that
// the compiler enforces are errors; rules the compiler warns about, or that fail at run time,
// are warnings. Section tags cite HP27-610 (CL/HPM) and AM27-610 (CL/AM).

import { Declaration, Expr, HandlerRef, Ident, Routine, SourceFile, Statement, TypeSpec, Unit } from './ast';
import { Binding, ClSymbol } from './binder';
import { PointRecord } from './eb';
import { POINT_TYPES } from './parameters';
import { isViewOnly, typeHasParameter } from './pointParameters';
import { Diagnostic, Range, Severity } from './types';
import { BUILTINS } from './builtins';
import { formatBox } from './workspace';
import { walkExpr } from './walk';

/** Point database access, when one is loaded. */
export interface LintEnvironment {
  point(name: string): PointRecord | undefined;
  /** `net/ucn:node` of the HPM a program's bound point is in. */
  boxOfProgram(boundPoint: string): string | undefined;
  /** `net/ucn:node` of the node a point is in. */
  boxOfPoint(p: PointRecord): string | undefined;
}

type Dialect = 'HPM' | 'APM' | 'PM' | 'AM';

/** Process Module storage per sequence slot [HP27-610 Table 2-4]. */
const SLOT_LIMITS: Record<string, number> = { NN: 80, FL: 127, TIME: 4, STR8: 16, STR16: 8, STR32: 4, STR64: 2 };
/** CL sees box variables up to this index; beyond it, use an Array point [HP09 §15]. */
const BOX_LIMIT = 4095;
const NAME_LIMIT = 8;
const STRING_LIMIT = 64;
const CRT_LIMIT = 60;
const STEP_LIMIT = 255;

/** Diagnostic tags as LSP numbers: 1 = unnecessary (shown faded). */
export const UNNECESSARY = 1;

export interface LintDiagnostic extends Diagnostic {
  tags?: number[];
}

export function lint(file: SourceFile, binding: Binding, env?: LintEnvironment): LintDiagnostic[] {
  return new Linter(file, binding, env).run();
}

class Linter {
  private readonly out: LintDiagnostic[] = [];
  /** What each name resolved to, by its occurrence. */
  private readonly resolved = new Map<Ident, ClSymbol | undefined>();
  /** Handler types by handler name, for checking ENB and PHASE headings. */
  private readonly handlerTypes = new Map<string, string>();
  /** True while checking a handler's RESTART section. */
  private inRestart = false;
  private readonly undeclared = new Set<Ident>();
  /** Subroutines of the file by name, for checking CALLs. */
  private readonly subroutines = new Map<string, Extract<Unit, { kind: 'subroutine' }>>();

  constructor(
    private readonly file: SourceFile,
    private readonly binding: Binding,
    private readonly env: LintEnvironment | undefined,
  ) {
    for (const r of binding.references) this.resolved.set(r.ident, r.symbol);
    const all = (us: Unit[]): Unit[] => us.flatMap((u) => (u.kind === 'package' ? all(u.units) : [u]));
    for (const u of all(file.units)) {
      if (u.kind === 'handler' && u.name) this.handlerTypes.set(u.name.name, u.handlerType);
      if (u.kind === 'subroutine' && u.name) this.subroutines.set(u.name.name, u);
    }
  }

  run(): LintDiagnostic[] {
    this.units(this.file.units, undefined);
    this.argumentModes();
    this.unused();
    this.callDepth();
    return this.out;
  }

  private report(range: Range, code: string, message: string, severity: Severity, tags?: number[]): void {
    this.out.push({ range, code, message, severity, tags });
  }

  // ---------------------------------------------------------------- units

  private units(units: Unit[], packageMain: Unit | undefined): void {
    let main: Unit | undefined = packageMain;
    for (const unit of units) {
      if (unit.kind === 'package') {
        this.units(unit.units, undefined);
        continue;
      }
      if (unit.kind === 'sequence' || unit.kind === 'block') main = unit;
      const owner = unit.kind === 'handler' || unit.kind === 'subroutine' ? main : unit;
      const dialect: Dialect | undefined =
        owner?.kind === 'block' ? 'AM' : owner?.kind === 'sequence' ? (owner.dialect?.name as Dialect | undefined) : undefined;
      const bound = owner && (owner.kind === 'sequence' || owner.kind === 'block') ? owner.point?.name : undefined;
      this.unit(unit, dialect, bound);
    }
  }

  private unit(unit: Unit, dialect: Dialect | undefined, bound: string | undefined): void {
    // The 8-character limit is the US's [HP27-610 §2.2.5.1]; CL/AM compiles longer names.
    if (unit.name && dialect !== 'AM' && ['sequence', 'handler', 'subroutine'].includes(unit.kind)) this.nameLength(unit.name, unit.kind);
    this.declarations(unit, dialect, bound);
    this.duplicateDeclarations(unit.declarations);
    if (dialect && dialect !== 'AM') this.localStorage(unit, dialect, bound);
    if (dialect && dialect !== 'AM') this.externalNetwork(unit, bound);

    const routines: Routine[] = [];
    switch (unit.kind) {
      case 'sequence': {
        const phases = new Map<string, Ident>();
        for (const p of unit.phases) {
          if (!p.name) continue;
          if (dialect !== 'AM') this.nameLength(p.name, 'phase');
          this.duplicate(phases, p.name, 'phase');
          if (p.alarm) this.expressions(p.alarm, unit, dialect, bound);
          if (p.alarm && dialect !== 'AM') {
            for (const m of this.prefetches(p.alarm, bound)) {
              this.report(m.range, 'prefetch', `${exprText(m)} needs a prefetch, which a PHASE ALARM clause cannot have (HP27-610 §4.1.4.2)`, Severity.Warning);
            }
          }
          this.handlerRefs(p.handlers);
          if (!p.routine.statements.length && !p.routine.steps.length) this.empty(p.name.range, 'PHASE');
        }
        routines.push(...unit.phases.map((p) => p.routine));
        this.declarationsBeforePhases(unit);
        break;
      }
      case 'block':
        if (unit.when) this.expressions(unit.when, unit, dialect, bound);
        routines.push(unit.routine);
        break;
      case 'handler':
        if (unit.when) this.expressions(unit.when, unit, dialect, bound);
        if (dialect === 'AM') this.report(unit.headerRange, 'dialect', 'CL/AM has no abnormal condition handlers', Severity.Error);
        routines.push(unit.routine);
        if (unit.restart && unit.handlerType === 'EMERGENCY') {
          this.report(unit.restart.range, 'handler', 'An EMERGENCY handler cannot have a RESTART section (HP27-610 §4.4)', Severity.Error);
        }
        if (unit.restart) this.gotoAcrossRestart(unit.routine, unit.restart.routine);
        if (!unit.routine.statements.length && !unit.routine.steps.length) this.empty(unit.headerRange, 'handler');
        break;
      case 'subroutine': {
        routines.push(unit.routine);
        const args = new Map<string, Ident>();
        for (const a of unit.args) for (const n of a.names) this.duplicate(args, n, 'subroutine argument');
        if (!unit.routine.statements.length && !unit.routine.steps.length) this.empty(unit.headerRange, 'subroutine');
        for (const d of unit.declarations) {
          if (d.kind === 'external') this.report(d.range, 'external-in-subroutine', 'EXTERNAL is not allowed in a subroutine (HP27-610 §2.6)', Severity.Error);
        }
        break;
      }
    }

    // Step names are unique across a handler and its RESTART section.
    const steps = new Map<string, Ident>();
    const all = unit.kind === 'handler' && unit.restart ? [...routines, unit.restart.routine] : routines;
    for (const r of all) {
      if (unit.kind !== 'handler') steps.clear();
      this.inRestart = unit.kind === 'handler' && r === unit.restart?.routine;
      this.routine(r, unit, dialect, bound, steps);
    }
    this.inRestart = false;
  }

  private routine(r: Routine, unit: Unit, dialect: Dialect | undefined, bound: string | undefined, steps: Map<string, Ident>): void {
    if (dialect && dialect !== 'AM') {
      this.prefetchLimit(r.statements, bound);
      for (const st of r.steps) this.prefetchLimit(st.statements, bound);
    }
    if (r.steps.length && r.statements.length && dialect !== 'AM') {
      this.report(r.statements[0].range, 'structure', 'A routine with steps begins with a STEP heading (HP27-610 §4.1.2)', Severity.Error);
    }
    for (const st of r.steps) if (!st.statements.length && st.name) this.empty(st.name.range, 'STEP');
    const routineLabels = new Map<string, Ident>();
    this.statements(r.statements, unit, dialect, bound, routineLabels);
    if (r.statements.length > STEP_LIMIT) this.tooManyStatements(r.statements);
    for (const st of r.steps) {
      if (st.name) {
        if (dialect !== 'AM') this.nameLength(st.name, 'step');
        this.duplicate(steps, st.name, 'step');
      }
      this.statements(st.statements, unit, dialect, bound, new Map(routineLabels));
      if (st.statements.length > STEP_LIMIT) this.tooManyStatements(st.statements);
    }
  }

  private statements(list: Statement[], unit: Unit, dialect: Dialect | undefined, bound: string | undefined, labels: Map<string, Ident>): void {
    for (const s of list) {
      if (s.label) this.duplicate(labels, s.label, 'label');
      this.statement(s, unit, dialect, bound, true);
    }
    this.loops(list);
  }

  // ---------------------------------------------------------------- statements

  private statement(s: Statement, unit: Unit, dialect: Dialect | undefined, bound: string | undefined, topLevel: boolean): void {
    const e = (x: Expr | undefined) => x && this.expressions(x, unit, dialect, bound, s);
    const nested = (x: Statement) => this.statement(x, unit, dialect, bound, false);

    if (dialect === 'AM' && AM_FORBIDDEN[s.kind]) {
      this.report(s.range, 'dialect', `${AM_FORBIDDEN[s.kind]} is not available in CL/AM (AM27-610 §3.2)`, Severity.Error);
    }
    if ('onError' in s && s.onError) {
      if (dialect === 'AM') this.report(s.onError.range, 'dialect', 'WHEN ERROR is not available in CL/AM', Severity.Error);
      else if (dialect === 'PM') this.report(s.onError.range, 'dialect', 'WHEN ERROR needs CL/APM or CL/HPM (R620 and later)', Severity.Error);
    }

    if (dialect && dialect !== 'AM') this.valueNames(s, bound);

    switch (s.kind) {
      case 'set':
        s.targets.forEach(e);
        e(s.value);
        if (dialect && dialect !== 'AM') {
          for (const t of s.targets) this.readOnly(t);
        }
        if (s.onError) nested(s.onError.statement);
        break;
      case 'read':
      case 'write':
        // Remote points are allowed here: these are the statements that reach other nodes.
        s.targets.forEach((x) => this.expressions(x, unit, dialect, bound, s, true));
        s.sources.forEach((x) => this.expressions(x, unit, dialect, bound, s, true));
        if (s.onError) nested(s.onError.statement);
        break;
      case 'stateChange':
        s.targets.forEach(e);
        if (dialect && dialect !== 'AM') this.stateChange(s);
        // State change targets must be in this HPM (HP27-610 §3.2.5).
        for (const t of s.targets) if (t.kind === 'name') this.remoteAccess(t.id, unit, dialect, bound, s);
        if (s.onError) nested(s.onError.statement);
        break;
      case 'if':
        for (const b of s.branches) {
          e(b.condition);
          if (b.onError) nested(b.onError.statement);
          b.body.forEach(nested);
        }
        s.elseBody?.forEach(nested);
        break;
      case 'loop':
        if (!s.label) this.report(s.range, 'loop-label', 'A LOOP must have a label (HP27-610 §3.2.9)', Severity.Error);
        if (!topLevel) this.report(s.range, 'loop-label', 'A LOOP cannot be part of another statement', Severity.Error);
        e(s.low);
        e(s.high);
        this.loopCounter(s, dialect);
        break;
      case 'resume':
        if (!this.inRestart && dialect !== 'AM') {
          this.report(s.range, 'handler', 'RESUME is allowed only in the RESTART section of a handler (HP27-610 §3.2.17)', Severity.Error);
        }
        break;
      case 'enb': {
        const types = new Set<string>();
        for (const h of s.handlers) {
          if (types.has(h.type)) this.report(h.name.range, 'handler', `${h.type} appears twice in this ENB (HP27-610 §3.2.6)`, Severity.Error);
          types.add(h.type);
        }
        this.handlerRefs(s.handlers);
        break;
      }
      case 'initiate':
        if (!s.target && s.handlerType && s.onError) {
          this.report(s.onError.range, 'initiate', 'WHEN ERROR is not allowed on INITIATE of this program\'s own handler (HP27-610 §3.2.15.4)', Severity.Error);
        }
        if (s.target && dialect && dialect !== 'AM') {
          const p = this.env?.point(s.target.name);
          if (p && p.type !== 'PRMODNIM') {
            this.report(s.target.range, 'initiate', `The point database has ${s.target.text} as ${typeName(p.type)}: only a process module runs a sequence to INITIATE`, Severity.Warning);
          }
        }
        if (s.target && bound && s.target.name === bound && !s.handlerType && dialect !== 'AM') {
          this.report(s.target.range, 'initiate', `${s.target.text} is this program's own point: a sequence cannot INITIATE itself`, Severity.Error);
        }
        if (s.onError) nested(s.onError.statement);
        break;
      case 'call':
        s.args.forEach(e);
        if (dialect !== 'AM') this.callArguments(s, unit);
        if (dialect && dialect !== 'AM' && s.target && !BUILTIN_ARITY.has(s.target.name)) {
          for (const a of s.args) {
            for (const m of this.prefetches(a, bound)) {
              if (/^(SO|INITREQ)$/.test(m.kind === 'member' ? m.property.name : '')) continue;
              this.report(m.range, 'prefetch', `${exprText(m)} needs a prefetch, which a CALL argument cannot have (HP27-610 §3.2.13.2)`, Severity.Warning);
            }
          }
        }
        break;
      case 'wait':
        e(s.value);
        if (s.value && isAbsoluteTime(s.value)) {
          this.report(s.value.range, 'wait-absolute', 'This waits for a duration as long as the date: use WAIT Date_Time > t to wait until a moment (HP27-610 §3.2.12)', Severity.Warning);
        }
        if (s.timeout) {
          e(s.timeout.time);
          nested(s.timeout.statement);
        }
        if (s.onError) nested(s.onError.statement);
        break;
      case 'send':
        if (s.wait && dialect === 'AM') this.report(s.range, 'dialect', 'SEND (WAIT) is not available in CL/AM', Severity.Error);
        e(s.destination);
        s.items.forEach(e);
        this.sendLength(s);
        break;
    }
  }

  /** Every LOOP label should be the target of a REPEAT, and of only one; a REPEAT targets a LOOP [HP27-610 §3.2.10]. */
  private loops(list: Statement[]): void {
    const repeated = new Set<string>();
    const collect = (s: Statement) => {
      if (s.kind === 'repeat' && s.target) {
        const target = this.resolved.get(s.target);
        if (target?.kind === 'label' && target.detail !== 'LOOP') {
          this.report(s.target.range, 'repeat', `${s.target.text} does not label a LOOP (HP27-610 §3.2.10)`, Severity.Error);
        } else if (target && repeated.has(s.target.name)) {
          this.report(s.target.range, 'repeat', `Loop ${s.target.text} already has a REPEAT: a loop has only one (HP27-610 §3.2.10)`, Severity.Error);
        }
        repeated.add(s.target.name);
      }
      if (s.kind === 'if') {
        s.branches.forEach((b) => b.body.forEach(collect));
        s.elseBody?.forEach(collect);
      }
    };
    list.forEach(collect);
    for (const s of list) {
      if (s.kind === 'loop' && s.label && s.counter && !repeated.has(s.label.name)) {
        this.report(s.label.range, 'loop-never-repeated', `Loop ${s.label.text} is never repeated: no REPEAT ${s.label.text} in this step`, Severity.Warning);
      }
    }
  }

  /** A loop counter is a scalar Number LOCAL or subroutine argument [HP27-610 §3.2.9.2]. */
  private loopCounter(s: Extract<Statement, { kind: 'loop' }>, dialect: Dialect | undefined): void {
    if (s.counter) {
      const sym = this.resolved.get(s.counter);
      const d = sym?.declaration;
      const scalarNumber =
        sym?.kind === 'argument' ||
        (sym?.kind === 'local' && d?.kind === 'local' && !d.type?.array && d.type?.kind !== 'array' && d.type?.kind !== 'states' && (!d.type || d.type.name.name === 'NUMBER'));
      // Without a heading the file is a fragment, included where the counter may be declared.
      if (!sym) {
        if (dialect) this.report(s.counter.range, 'loop-counter', `Loop counter ${s.counter.text} is not declared`, Severity.Error);
      }
      else if (!scalarNumber) {
        this.report(s.counter.range, 'loop-counter', `Loop counter ${s.counter.text} must be a scalar Number LOCAL or subroutine argument (HP27-610 §3.2.9.2)`, Severity.Error);
      }
    }
    const low = s.low && constantNumber(s.low);
    const high = s.high && constantNumber(s.high);
    if (low !== undefined && high !== undefined && low > high) {
      this.report(s.high!.range, 'loop-range', `The loop counts up from ${low} and never reaches ${high}: decrementing loops are not supported (HP27-610 §3.2.9.3)`, Severity.Error);
    }
  }

  /**
   * A CALL passes what its subroutine declares [HP27-610 §3.2.13]: as many arguments, a variable
   * for OUT and IN OUT, expressions to built-in subroutines only, constant indices, and values
   * of the declared type.
   */
  private callArguments(s: Extract<Statement, { kind: 'call' }>, unit: Unit): void {
    if (!s.target) return;
    if (s.args.length > MAX_CALL_ARGS) {
      this.report(s.args[MAX_CALL_ARGS].range, 'call-args', `A CALL passes at most ${MAX_CALL_ARGS} arguments (HP27-610 §3.2.13)`, Severity.Error);
    }
    const sub = this.resolved.get(s.target)?.kind === 'subroutine' ? this.subroutines.get(s.target.name) : undefined;
    if (!sub) {
      const b = BUILTIN_ARITY.get(s.target.name);
      if (b?.kind === 'subroutine' && !this.resolved.get(s.target)) this.arity(s.target, s.args.length, b);
      return;
    }
    const formals = sub.args.flatMap((a) => a.names.map((name) => ({ name, mode: a.mode, type: a.type })));
    if (formals.length !== s.args.length) {
      this.report(
        s.target.range,
        'call-args',
        `${s.target.text} takes ${formals.length} argument${formals.length === 1 ? '' : 's'}, not ${s.args.length}: too ${s.args.length < formals.length ? 'few' : 'many'} arguments`,
        Severity.Error,
      );
    }
    s.args.forEach((actual, i) => {
      const formal = formals[i];
      const what = `Argument ${i + 1}${formal ? ` (${formal.name.text})` : ''}`;
      if (!isVariable(actual) && !isLiteral(actual)) {
        this.report(actual.range, 'call-args', `${what}: only built-in subroutines take expressions; pass a variable or a constant (HP27-610 §3.2.13.2)`, Severity.Error);
        return;
      }
      if (formal && formal.mode !== 'IN' && !isVariable(actual)) {
        this.report(actual.range, 'call-args', `${what} is ${formal.mode}: pass a variable (HP27-610 §3.2.13.2)`, Severity.Error);
        return;
      }
      if (actual.kind === 'apply' && actual.args.length === 1 && constantNumber(actual.args[0]) === undefined) {
        this.report(actual.args[0].range, 'call-args', `${what}: an array element passed to a subroutine needs a constant index (HP27-610 §3.2.13.2)`, Severity.Error);
        return;
      }
      if (unit.kind === 'subroutine' && actual.kind === 'apply' && actual.callee.kind === 'name' && this.resolved.get(actual.callee.id)?.kind === 'argument') {
        this.report(actual.range, 'call-args', `${what}: a subroutine cannot pass on one element of its array argument (HP27-610 §3.2.13.2)`, Severity.Error);
        return;
      }
      if (formal) this.argumentType(actual, formal, what);
    });
  }

  /** The type of a literal or a declared LOCAL against the type of the argument it is passed to. */
  private argumentType(actual: Expr, formal: { type?: TypeSpec }, what: string): void {
    const expected = valueType(formal.type);
    let got: { family: string; array: boolean } | undefined;
    if (actual.kind === 'number' || (actual.kind === 'unary' && actual.op === '-' && actual.operand.kind === 'number')) got = { family: 'NUMBER', array: false };
    const local = (id: Ident) => {
      const d = this.resolved.get(id)?.declaration;
      return d?.kind === 'local' && d.at ? valueType(d.type) : undefined;
    };
    if (actual.kind === 'name') got = local(actual.id);
    if (actual.kind === 'apply' && actual.callee.kind === 'name') {
      const t = local(actual.callee.id);
      if (t?.array) got = { family: t.family, array: false };
    }
    if (!got || !expected) return;
    if (got.family !== expected.family || got.array !== expected.array) {
      const word = (t: { family: string; array: boolean }) => `${t.family === 'STATES' ? 'a state list' : t.family}${t.array ? ' ARRAY' : ''}`;
      this.report(actual.range, 'call-args', `${what}: type mismatch, the subroutine takes ${word(expected)} and this is ${word(got)}`, Severity.Error);
    }
  }

  private arity(id: Ident, count: number, b: { min: number; max: number; signature: string }): void {
    if (count < b.min || count > b.max) {
      const n = b.min === b.max ? `${b.min}` : `${b.min} to ${b.max}`;
      this.report(id.range, 'call-args', `${b.signature} takes ${n} argument${b.max === 1 ? '' : 's'}, not ${count}`, Severity.Error);
    }
  }

  /**
   * IN arguments can only be read [HP27-610 §4.5.1.2]: not the target of SET, READ, a state
   * change, a LOOP, or an OUT argument of another CALL. Reading an OUT argument is wrong by the
   * manual too, but the compiler accepts it, and programs rely on it.
   */
  private argumentModes(): void {
    const targets = new Set<Ident>();
    const root = (x: Expr): Ident | undefined => (x.kind === 'name' ? x.id : x.kind === 'apply' && x.callee.kind === 'name' ? x.callee.id : undefined);
    const all = (us: Unit[]): Unit[] => us.flatMap((u) => (u.kind === 'package' ? all(u.units) : [u]));
    for (const u of all(this.file.units)) {
      if (u.kind !== 'subroutine') continue;
      eachStatement([...u.routine.statements, ...u.routine.steps.flatMap((st) => st.statements)], (s) => {
        const set = (xs: Expr[]) => xs.forEach((x) => { const id = root(x); if (id) targets.add(id); });
        if (s.kind === 'set' || s.kind === 'read' || s.kind === 'stateChange') set(s.targets);
        if (s.kind === 'loop' && s.counter) targets.add(s.counter);
        if (s.kind === 'call' && s.target) {
          const callee = this.subroutines.get(s.target.name);
          const modes = callee?.args.flatMap((a) => a.names.map(() => a.mode)) ?? [];
          s.args.forEach((x, i) => {
            if (modes[i] && modes[i] !== 'IN') set([x]);
          });
        }
      });
    }
    for (const r of this.binding.references) {
      const sym = r.symbol;
      if (r.isDefinition || sym?.kind !== 'argument' || !sym.detail || sym.detail === 'function argument') continue;
      const mode = sym.detail.startsWith('IN OUT') ? 'IN OUT' : sym.detail.startsWith('OUT') ? 'OUT' : 'IN';
      if (mode === 'IN' && targets.has(r.ident)) {
        this.report(r.ident.range, 'argument-mode', `${r.ident.text} is an IN argument: it can be read, not set (HP27-610 §4.5.1.2)`, Severity.Error);
      }
    }
  }

  /**
   * `OPEN XV1, XV2`: the only statement without a keyword, so a stray word lands here. It names
   * up to 16 points declared EXTERNAL: Digital Output, Digital Composite or Device Control
   * points [HP27-610 §3.2.5].
   */
  private stateChange(s: Extract<Statement, { kind: 'stateChange' }>): void {
    if (!s.targets.length) {
      this.report(s.state.range, 'state-change', `${s.state.text} is not a statement; a state change names its points, as in OPEN XV1`, Severity.Error);
      return;
    }
    if (s.targets.length > MAX_STATE_CHANGE_POINTS) {
      this.report(s.targets[MAX_STATE_CHANGE_POINTS].range, 'state-change', `A state change sets at most ${MAX_STATE_CHANGE_POINTS} points (HP27-610 §3.2.5)`, Severity.Error);
    }
    for (const t of s.targets) {
      if (t.kind !== 'name' || /^[!$]/.test(t.id.name)) continue;
      const sym = this.resolved.get(t.id);
      if (!sym) {
        this.report(t.id.range, 'state-change', `${t.id.text} is not declared EXTERNAL: ${s.state.text} ${t.id.text} reads as a state change of point ${t.id.text}`, Severity.Error);
      } else if (sym.kind !== 'external') {
        this.report(t.id.range, 'state-change', `${t.id.text} is a ${sym.kind === 'local' ? 'LOCAL' : sym.kind}: a state change sets the OP of a point (HP27-610 §3.2.5)`, Severity.Error);
      } else {
        const p = this.env?.point(t.id.name);
        if (p && !STATE_CHANGE_TYPES.has(p.type)) {
          this.report(t.id.range, 'state-change', `The point database has ${t.id.text} as ${typeName(p.type)}: a state change sets the OP of a Digital Output, Digital Composite or Device Control`, Severity.Warning);
        }
      }
    }
  }

  // ---------------------------------------------------------------- names in expressions

  /**
   * Names where a value is needed must be declared: in arithmetic and logic, conditions,
   * indices, and stores to declared LOCALs. A bare name compared with or stored to a point
   * parameter may be one of its states, which the database does not always list, so it is
   * left alone there; a LOCAL's own states and ON/OFF are known.
   */
  private valueNames(s: Statement, bound: string | undefined): void {
    const strict = (x: Expr | undefined) => x && this.checkExpr(x, bound);
    switch (s.kind) {
      case 'set': {
        s.targets.forEach((t) => this.checkTarget(t, bound));
        const states = this.allowedStates(s.targets);
        if (s.value.kind === 'name' && states !== 'any') this.checkName(s.value.id, bound, states);
        else if (s.value.kind === 'when') {
          for (const arm of s.value.arms) {
            strict(arm.condition);
            if (arm.value.kind === 'name') {
              if (states !== 'any') this.checkName(arm.value.id, bound, states);
            } else strict(arm.value);
          }
        } else if (s.value.kind !== 'name') strict(s.value);
        break;
      }
      case 'if':
        s.branches.forEach((b) => strict(b.condition));
        break;
      case 'wait':
        strict(s.value);
        if (s.timeout) strict(s.timeout.time);
        break;
      case 'loop':
        strict(s.low);
        strict(s.high);
        break;
      case 'call':
        // An argument may be an enumeration state; inside an expression, names are values.
        for (const a of s.args) if (a.kind !== 'name') strict(a);
        break;
    }
  }

  /** The states a bare name stored to these targets may be: 'any' when a target is a point parameter. */
  private allowedStates(targets: Expr[]): Set<string> | 'any' {
    const out = new Set<string>();
    for (const t of targets) {
      const id = t.kind === 'name' ? t.id : t.kind === 'apply' && t.callee.kind === 'name' ? t.callee.id : undefined;
      const d = id && this.resolved.get(id)?.declaration;
      if (!id || d?.kind !== 'local') return 'any';
      const type = d.type;
      if (type?.kind === 'states') type.states.forEach((st) => out.add(st.name));
      else if (type?.kind === 'named' && (type.name.name === 'LOGICAL' || type.name.name === 'FLAG')) ['ON', 'OFF'].forEach((st) => out.add(st));
      else if (type?.kind === 'named' && !['NUMBER', 'TIME', 'STRING'].includes(type.name.name)) return 'any';
    }
    return out;
  }

  private checkTarget(t: Expr, bound: string | undefined): void {
    if (t.kind === 'apply') t.args.forEach((a) => this.checkExpr(a, bound));
    if (t.kind === 'member') this.checkTarget(t.object, bound);
  }

  /** Every name in a value expression, except a bare name compared with a point parameter. */
  private checkExpr(x: Expr, bound: string | undefined): void {
    switch (x.kind) {
      case 'name':
        this.checkName(x.id, bound, new Set());
        return;
      case 'member':
        if (x.object.kind !== 'name') this.checkExpr(x.object, bound);
        return;
      case 'apply':
        if (x.callee.kind !== 'name') this.checkExpr(x.callee, bound);
        x.args.forEach((a) => this.checkExpr(a, bound));
        return;
      case 'unary':
        this.checkExpr(x.operand, bound);
        return;
      case 'paren':
        this.checkExpr(x.inner, bound);
        return;
      case 'in':
        [x.value, x.low, x.high].forEach((y) => this.checkExpr(y, bound));
        return;
      case 'time':
        x.parts.forEach((p) => this.checkExpr(p.value, bound));
        return;
      case 'when':
        x.arms.forEach((a) => {
          if (a.condition) this.checkExpr(a.condition, bound);
          this.checkExpr(a.value, bound);
        });
        return;
      case 'binary':
        if (COMPARISONS.has(x.op)) {
          for (const [side, other] of [[x.left, x.right], [x.right, x.left]] as const) {
            if (side.kind !== 'name') {
              this.checkExpr(side, bound);
              continue;
            }
            const states = this.statesBeside(other);
            if (states !== 'any') this.checkName(side.id, bound, states);
          }
          return;
        }
        this.checkExpr(x.left, bound);
        this.checkExpr(x.right, bound);
        return;
    }
  }

  /** What a bare name compared with `other` may be: its states, or 'any' beside a point parameter. */
  private statesBeside(other: Expr): Set<string> | 'any' {
    if (other.kind === 'member' || (other.kind === 'apply' && other.callee.kind === 'member')) return 'any';
    if (other.kind === 'name' || (other.kind === 'apply' && other.callee.kind === 'name')) {
      const id = other.kind === 'name' ? other.id : (other.callee as Extract<Expr, { kind: 'name' }>).id;
      const sym = this.resolved.get(id);
      if (!sym) return 'any';
      if (sym.kind === 'local' || sym.kind === 'argument') return sym.declaration?.kind === 'local' ? this.allowedStates([other]) : 'any';
      return 'any';
    }
    return new Set();
  }

  private checkName(id: Ident, bound: string | undefined, states: Set<string>): void {
    const n = id.name;
    if (this.resolved.get(id) || states.has(n) || /^[!$]/.test(n) || n === bound || BUILTIN_ARITY.has(n)) return;
    if (typeHasParameter('PRMODNIM', n)) return;
    if (this.undeclared.has(id)) return;
    this.undeclared.add(id);
    const hint = states.size ? `: not declared, and not ${[...states].join(' or ')}` : ': not a LOCAL, constant, EXTERNAL or argument';
    this.report(id.range, 'undefined', `Undefined name ${id.text}${hint}`, Severity.Error);
  }

  /** A point named in `point.param` is declared EXTERNAL, unless it is the program's own [HP27-610 §2.6.4]. */
  private pointDeclared(id: Ident, bound: string | undefined): void {
    if (/^[!$]/.test(id.name) || id.name === bound || this.resolved.get(id) || this.undeclared.has(id)) return;
    this.undeclared.add(id);
    this.report(id.range, 'undeclared-point', `${id.text} is not declared EXTERNAL`, Severity.Error);
  }

  // ---------------------------------------------------------------- point database

  /** A database point's parameter exists on its point type [HP09-641, XPM09]. */
  private parameterExists(point: Ident, param: Ident): void {
    const p = this.env?.point(point.name);
    if (!p || typeHasParameter(p.type, param.name) !== false) return;
    this.report(param.range, 'parameter', `The point database has ${point.text} as ${typeName(p.type)}, which has no parameter ${param.text}`, Severity.Warning);
  }

  /** A store to a parameter whose access lock is View. */
  private readOnly(target: Expr): void {
    const m = target.kind === 'apply' ? target.callee : target;
    if (m.kind !== 'member' || m.object.kind !== 'name') return;
    const p = this.env?.point(m.object.id.name);
    // A regulatory point's access locks depend on its algorithm, which these tables do not separate.
    if (p && !/^REG/.test(p.type) && isViewOnly(p.type, m.property.name)) {
      this.report(m.property.range, 'read-only', `${m.property.text} of ${typeName(p.type)} is view-only: a program cannot store to it`, Severity.Warning);
    }
  }

  /** EXTERNAL names points on the program's own UCN [HP27-610 §2.6.4.2]. */
  private externalNetwork(unit: Unit, bound: string | undefined): void {
    const own = bound && this.env?.boxOfProgram(bound);
    if (!own) return;
    const network = (box: string) => box.split(':')[0];
    for (const d of unit.declarations) {
      if (d.kind !== 'external') continue;
      for (const n of d.names) {
        // $NMnnNmm and !BOX name boxes relative to the program's own LCN; the database cannot place them.
        if (/^[$!]/.test(n.name)) continue;
        const p = this.env!.point(n.name);
        const box = p && this.env!.boxOfPoint(p);
        if (box && network(box) !== network(own)) {
          this.report(n.range, 'external-ucn', `The point database places ${n.text} in ${formatBox(box)}, off this program's UCN (${formatBox(own)}): EXTERNAL can name only points on the same UCN (HP27-610 §2.6.4.2)`, Severity.Warning);
        }
      }
    }
  }

  /**
   * I/O module parameters of this HPM that a read needs prefetched [HP27-610 §2.5.5]: all of AI,
   * AO, DI and DO points except the PV of a DI and the PV-related parameters of an AI.
   */
  private prefetches(root: Expr, bound: string | undefined): Extract<Expr, { kind: 'member' }>[] {
    const own = bound && this.env?.boxOfProgram(bound);
    const out: Extract<Expr, { kind: 'member' }>[] = [];
    if (!own) return out;
    walkExpr(root, (x) => {
      if (x.kind !== 'member' || x.object.kind !== 'name') return;
      const p = this.env!.point(x.object.id.name);
      if (!p || !IO_TYPES.has(p.type) || this.env!.boxOfPoint(p) !== own) return;
      const param = x.property.name;
      if (p.type === 'DIINNIM' && (param === 'PV' || param === 'PVFL')) return;
      if (p.type === 'ANINNIM' && AI_NO_PREFETCH.has(param)) return;
      out.push(x);
    });
    return out;
  }

  /** At most 12 distinct prefetches in one step [HP27-610 §2.5.5]. */
  private prefetchLimit(list: Statement[], bound: string | undefined): void {
    const seen = new Map<string, Expr>();
    eachStatement(list, (s) => {
      const reads: Expr[] = [];
      switch (s.kind) {
        case 'set':
          reads.push(s.value);
          for (const t of s.targets) if (t.kind === 'apply') reads.push(...t.args);
          break;
        case 'if':
          reads.push(...s.branches.map((b) => b.condition));
          break;
        case 'wait':
          if (s.value) reads.push(s.value);
          break;
        case 'send':
          reads.push(...s.items);
          break;
        case 'call':
          reads.push(...s.args);
          break;
        case 'loop':
          if (s.low) reads.push(s.low);
          if (s.high) reads.push(s.high);
          break;
      }
      for (const r of reads) for (const m of this.prefetches(r, bound)) if (!seen.has(exprText(m))) seen.set(exprText(m), m);
    });
    if (seen.size > PREFETCH_LIMIT) {
      const extra = [...seen.values()][PREFETCH_LIMIT];
      this.report(extra.range, 'prefetch', `This step reads ${seen.size} I/O module parameters; a step can prefetch ${PREFETCH_LIMIT} (HP27-610 §2.5.5): add a STEP heading`, Severity.Warning);
    }
  }

  /** Handlers named in an ENB statement or PHASE heading are of the type named with them. */
  private handlerRefs(refs: HandlerRef[]): void {
    for (const h of refs) {
      const actual = this.handlerTypes.get(h.name.name);
      if (actual && actual !== h.type) this.report(h.name.range, 'handler', `${h.name.text} is a ${actual} handler, not ${h.type}`, Severity.Error);
    }
  }

  /** A GOTO STEP cannot cross a handler's RESTART heading [HP27-610 §4.4]. */
  private gotoAcrossRestart(main: Routine, restart: Routine): void {
    const names = (r: Routine) => new Set(r.steps.flatMap((st) => (st.name ? [st.name.name] : [])));
    const check = (r: Routine, other: Set<string>) => {
      eachStatement([...r.statements, ...r.steps.flatMap((st) => st.statements)], (s) => {
        if (s.kind === 'goto' && s.targetKind === 'step' && s.target && other.has(s.target.name)) {
          this.report(s.target.range, 'handler', `A GOTO cannot cross the RESTART heading to step ${s.target.text} (HP27-610 §4.4)`, Severity.Error);
        }
      });
    };
    check(main, names(restart));
    check(restart, names(main));
  }

  private empty(range: Range, what: string): void {
    this.report(range, 'structure', `This ${what} has no statements: it must contain executable statements`, Severity.Error);
  }

  private sendLength(s: Extract<Statement, { kind: 'send' }>): void {
    const text = s.items.filter((i): i is Extract<Expr, { kind: 'string' }> => i.kind === 'string').map((i) => stringValue(i.value)).join('');
    if (text.length > CRT_LIMIT) {
      this.report(s.range, 'send-length', `The message text alone is ${text.length} characters; the CRT shows ${CRT_LIMIT} (the log ${CRT_LIMIT + 11}) and cuts the rest`, Severity.Warning);
    }
  }

  // ---------------------------------------------------------------- expressions

  /**
   * Checks inside one expression tree: string length, mixed AND/OR, storage ranges, and access
   * to points on other UCN nodes.
   */
  private expressions(root: Expr, unit: Unit, dialect: Dialect | undefined, bound: string | undefined, stmt?: Statement, remoteAllowed = false): void {
    walkExpr(root, (x) => {
      if (x.kind === 'string') this.stringLength(x);
      if (x.kind === 'binary' && LOGICAL_OPS.has(x.op)) {
        for (const child of [x.left, x.right]) {
          if (child.kind === 'binary' && LOGICAL_OPS.has(child.op) && child.op !== x.op) {
            this.report(child.range, 'mixed-logic', `${child.op} mixed with ${x.op} needs parentheses (HP27-610 §2.7.2.4)`, Severity.Error);
          }
        }
      }
      const slot = slotOf(x);
      if (slot) this.slotRange(slot, dialect, bound);
      if (x.kind === 'apply' && x.callee.kind === 'name' && !this.resolved.get(x.callee.id)) {
        const b = BUILTIN_ARITY.get(x.callee.id.name);
        if (b && b.kind !== 'subroutine') this.arity(x.callee.id, x.args.length, b);
      }
      if (x.kind === 'member' && x.object.kind === 'name') {
        if (dialect && dialect !== 'AM') {
          this.parameterExists(x.object.id, x.property);
          this.pointDeclared(x.object.id, bound);
        }
        this.boundPrefix(x.object.id, bound, dialect);
        if (!remoteAllowed) this.remoteAccess(x.object.id, unit, dialect, bound, stmt);
      }
    });
  }

  private stringLength(x: Extract<Expr, { kind: 'string' }>): void {
    const length = stringValue(x.value).length;
    if (length > STRING_LIMIT) {
      this.report(x.range, 'string-length', `String is ${length} characters; the compiler shortens it to ${STRING_LIMIT}`, Severity.Warning);
    }
  }

  private slotRange(slot: { point?: Ident; param: Ident; index: number; range: Range }, dialect: Dialect | undefined, bound: string | undefined): void {
    if (dialect === 'AM') return;
    const { point, param, index } = slot;
    if (index < 1) {
      this.report(slot.range, 'slot-range', `${param.text}(${index}): indices start at 1`, Severity.Error);
      return;
    }
    const isBox = point && (point.name === '!BOX' || /^\$NM\d+[NB]\d+$/.test(point.name));
    if (isBox && (param.name === 'NN' || param.name === 'FL' || param.name.startsWith('STR') || param.name === 'TIME') && index > BOX_LIMIT) {
      this.report(slot.range, 'slot-range', `CL cannot reach box ${param.name} beyond ${BOX_LIMIT}; map an Array point onto it (HP09 §15)`, Severity.Error);
    }
    const ownSlot = !point || (bound && point.name === bound) || this.env?.point(point.name)?.type === 'PRMODNIM';
    const limit = SLOT_LIMITS[param.name];
    if (ownSlot && !isBox && limit && index > limit) {
      this.report(slot.range, 'slot-range', `A Process Module has ${param.name}(1..${limit}) (HP27-610 Table 2-4)`, Severity.Error);
    }
  }

  /** The bound point's parameters are written without its name [HP27-610 §2.4]. */
  private boundPrefix(id: Ident, bound: string | undefined, dialect: Dialect | undefined): void {
    if (bound && dialect !== 'AM' && id.name === bound) {
      this.report(id.range, 'external-bound', `${id.text} is this program's own point: write its parameters without the name`, Severity.Error);
    }
  }

  /**
   * A point in another node on the same UCN can only be reached with READ, WRITE or INITIATE
   * [HP27-610 §2.5]. Needs the point database to know where each point lives.
   */
  private remoteAccess(id: Ident, _unit: Unit, dialect: Dialect | undefined, bound: string | undefined, stmt: Statement | undefined): void {
    if (!this.env || !bound || !stmt || dialect === 'AM' || dialect === undefined) return;
    if (id.name.startsWith('!') || id.name.startsWith('$')) return;
    const own = this.env.boxOfProgram(bound);
    const p = this.env.point(id.name);
    if (!own || !p || p.fields.NODETYP === undefined) return;
    const box = this.env.boxOfPoint(p);
    if (box && box !== own) {
      // A warning, not an error: it is only as current as the point database. Points move
      // between HPMs, and older listings compiled against the old placement.
      this.report(
        id.range,
        'remote-access',
        `The point database places ${id.text} in ${formatBox(box)}, not this program's ${formatBox(own)}: only READ, WRITE and INITIATE can reach another node (HP27-610 §2.5)`,
        Severity.Warning,
      );
    }
  }

  // ---------------------------------------------------------------- declarations

  private declarations(unit: Unit, dialect: Dialect | undefined, bound: string | undefined): void {
    for (const d of unit.declarations) {
      if (dialect && dialect !== 'AM' && (d.kind === 'define' || d.kind === 'parameter') && unit.kind !== 'custom' && unit.kind !== 'paramList') {
        this.report(d.range, 'dialect', `${d.kind === 'define' ? 'DEFINE' : 'PARAMETER'} is only available in CL/AM`, Severity.Error);
      }
      if (d.kind === 'external' && bound && dialect !== 'AM') {
        for (const n of d.names) {
          if (n.name === bound) this.report(n.range, 'external-bound', `${n.text} is this program's own point and may not be declared EXTERNAL (HP27-610 §2.4)`, Severity.Error);
        }
      }
      if (d.kind === 'constant') this.constantExpression(d.value);
      if (d.kind === 'local' && d.at) {
        const index = d.at.index?.kind === 'number' ? Number(d.at.index.value) : undefined;
        if (index !== undefined) this.slotRange({ point: d.at.point, param: d.at.param, index, range: d.at.range }, dialect, bound);
        if (d.at.point) this.boundPrefix(d.at.point, bound, dialect);
        this.serialIop(d);
      }
      if (d.kind === 'constant' && d.value.kind === 'string') this.stringLength(d.value);
    }
  }

  /** `/` and MOD are not allowed in constant expressions [HP27-610 §2.6.3]. */
  private constantExpression(value: Expr): void {
    walkExpr(value, (x) => {
      if (x.kind === 'binary' && (x.op === '/' || x.op === 'MOD')) {
        this.report(x.range, 'const-expr', `${x.op} is not allowed in a LOCAL constant (HP27-610 §2.6.3)`, Severity.Error);
      }
    });
  }

  /** The compiler notes LOCALs on serial-interface Array points, which are slow to access. */
  private serialIop(d: Extract<Declaration, { kind: 'local' }>): void {
    const p = d.at?.point && this.env?.point(d.at.point.name);
    if (p?.type === 'ARRAY' && /^IO_/.test(p.fields.EXTDATA ?? '')) {
      for (const n of d.names) {
        this.report(n.range, 'serial-iop', `${n.text} is mapped to a Serial Interface IOP parameter (${p.name}, ${p.fields.EXTDATA})`, Severity.Information);
      }
    }
  }

  /**
   * LOCAL ... AT rules [HP27-610 §2.6.2]: the location is NN, FL, TIME or STRn (NN or FL in
   * CL/PM) at an integer index, of the variable's type; another point's variables follow its
   * EXTERNAL; and one LOCAL names one variable.
   */
  private localStorage(unit: Unit, dialect: Dialect, bound: string | undefined): void {
    for (const d of unit.declarations) {
      if (d.kind !== 'local') continue;
      const t = d.type;
      if (t?.kind === 'states' && t.states.length !== 2) {
        this.report(t.states[0].range, 'local-type', 'A LOCAL state list has exactly two states (HP27-610 §2.6.2.1)', Severity.Error);
      }
      const bounds = t?.array?.[0];
      const range = bounds?.kind === 'binary' && bounds.op === '..' ? [constantNumber(bounds.left), constantNumber(bounds.right)] : undefined;
      if (range && range[0] !== undefined && range[1] !== undefined && range[0] >= range[1]) {
        this.report(bounds!.range, 'array-bounds', 'The lower bound must be less than the upper bound (HP27-610 §2.6.2.2)', Severity.Error);
      }
      const at = d.at;
      if (!at) continue;
      const param = at.param.name;
      const family = /^STR(8|16|32|64)$/.test(param) ? 'STR' : param;
      const allowed = dialect === 'PM' ? ['NN', 'FL'] : ['NN', 'FL', 'TIME', 'STR'];
      if (!allowed.includes(family)) {
        const list = dialect === 'PM' ? 'NN or FL' : 'NN, FL, TIME or STRn';
        this.report(at.param.range, 'local-location', `A LOCAL maps to ${list}, not ${at.param.text} (HP27-610 Table 2-4)`, Severity.Error);
        continue;
      }
      const expected = localFamily(t);
      if (expected && expected !== family) {
        this.report(at.param.range, 'local-type', `A ${typeWord(t)} LOCAL maps to ${expected === 'STR' ? 'STRn' : expected}, not ${at.param.text} (HP27-610 Table 2-4)`, Severity.Error);
      }
      const index = at.index && constantNumber(at.index);
      if (at.index && (index === undefined || !Number.isInteger(index))) {
        this.report(at.index.range, 'local-location', 'The location index must be an integer', Severity.Error);
      }
      if (at.point && at.point.name !== bound && unit.kind === 'sequence') this.externalFirst(unit, at.point, d.range);
      if (d.names.length > 1) {
        // Two LOCALs on one location are allowed (aliases); one LOCAL naming several variables is not.
        this.report(d.names[1].range, 'local-location', `Only one variable per LOCAL ... AT: ${d.names.map((n) => n.text).join(', ')} would all be ${at.param.text}${at.index ? '(...)' : ''}`, Severity.Error);
      }
    }
  }

  /** LOCALs on another point follow the EXTERNAL that names it [HP27-610 §2.6.2.2]. */
  private externalFirst(unit: Unit, point: Ident, local: Range): void {
    const decl = unit.declarations.find((x) => x.kind === 'external' && x.names.some((n) => n.name === point.name));
    if (!decl) this.report(point.range, 'external-order', `${point.text} is not declared EXTERNAL`, Severity.Error);
    else if (decl.range.start.line > local.start.line) {
      this.report(point.range, 'external-order', `The LOCAL must follow EXTERNAL ${point.text} (HP27-610 §2.6.2.2)`, Severity.Error);
    }
  }

  private declarationsBeforePhases(unit: Extract<Unit, { kind: 'sequence' }>): void {
    const first = unit.phases[0];
    if (!first) return;
    for (const d of unit.declarations) {
      if (d.kind !== 'directive' && d.range.start.line > first.range.start.line) {
        this.report(d.range, 'decl-after-phase', 'Declarations must come before the first PHASE (HP27-610 §2.6)', Severity.Error);
      }
    }
  }

  private duplicateDeclarations(decls: Declaration[]): void {
    const seen = new Map<string, Ident>();
    for (const d of decls) {
      const names = d.kind === 'local' || d.kind === 'external' || d.kind === 'parameter' ? d.names : d.kind === 'constant' || d.kind === 'define' ? [d.name] : [];
      for (const n of names) this.duplicate(seen, n, 'name');
    }
  }

  private duplicate(seen: Map<string, Ident>, id: Ident, what: string): void {
    const prev = seen.get(id.name);
    if (prev) this.report(id.range, 'duplicate', `${id.text} is already defined as a ${what} on line ${prev.range.start.line + 1}`, Severity.Error);
    else seen.set(id.name, id);
  }

  private nameLength(id: Ident, what: string): void {
    if (id.name.length > NAME_LIMIT) {
      this.report(id.range, 'name-length', `A ${what} name has at most ${NAME_LIMIT} characters (HP27-610 §2.2.5.1)`, Severity.Error);
    }
  }

  private tooManyStatements(list: Statement[]): void {
    const at = list[STEP_LIMIT];
    this.report(at.range, 'step-size', `A step holds at most ${STEP_LIMIT} statements: split it with STEP headings (HP27-610 App. B.2)`, Severity.Error);
  }

  // ---------------------------------------------------------------- whole file

  /** LOCALs and EXTERNALs that nothing refers to, as the compiler's "Defined But Not Referenced". */
  private unused(): void {
    for (const s of unusedSymbols(this.binding)) {
      this.report(s.ident.range, 'unused', `${s.ident.text} is defined but not referenced`, Severity.Warning, [UNNECESSARY]);
    }
  }

  /** Subroutines may call one level deep: main -> A -> B, but B cannot call C (runtime error 110). */
  private callDepth(): void {
    const subs = new Map<string, Extract<Unit, { kind: 'subroutine' }>>();
    const all = (us: Unit[]): Unit[] => us.flatMap((u) => (u.kind === 'package' ? all(u.units) : [u]));
    for (const u of all(this.file.units)) if (u.kind === 'subroutine' && u.name) subs.set(u.name.name, u);
    const callsIn = (r: Routine): Extract<Statement, { kind: 'call' }>[] => {
      const out: Extract<Statement, { kind: 'call' }>[] = [];
      const visit = (s: Statement) => {
        if (s.kind === 'call') out.push(s);
        if (s.kind === 'if') {
          s.branches.forEach((b) => b.body.forEach(visit));
          s.elseBody?.forEach(visit);
        }
      };
      [...r.statements, ...r.steps.flatMap((st) => st.statements)].forEach(visit);
      return out;
    };
    const calledFromSub = new Set<string>();
    for (const sub of subs.values()) for (const c of callsIn(sub.routine)) if (c.target && subs.has(c.target.name)) calledFromSub.add(c.target.name);
    for (const name of calledFromSub) {
      for (const c of callsIn(subs.get(name)!.routine)) {
        if (c.target && subs.has(c.target.name)) {
          this.report(c.target.range, 'call-depth', `${name} is itself called from a subroutine, so it cannot call ${c.target.text}: subroutines nest one level (runtime error 110)`, Severity.Warning);
        }
      }
    }
  }
}

/** Columns the compiler reads: a 131-character statement compiles, one from column 137 is dropped. */
export const COMPILER_COLUMNS = 132;

/**
 * Code past the last column the compiler reads, which it drops without a message. Comment text
 * there is harmless. `limit` may be set lower, for an editor or transfer that cuts lines sooner.
 */
export function longLines(lines: string[], limit = COMPILER_COLUMNS): LintDiagnostic[] {
  const out: LintDiagnostic[] = [];
  lines.forEach((line, i) => {
    const end = line.trimEnd().length;
    if (end <= limit) return;
    const comment = commentStart(line);
    if (comment !== undefined && comment < limit) return;
    const message =
      limit === COMPILER_COLUMNS
        ? `The compiler reads ${limit} columns and drops the rest of this line without a message: move it to a continuation line`
        : `This line is longer than ${limit} characters (amcl.lineLength)`;
    out.push({ range: { start: { line: i, character: limit }, end: { line: i, character: end } }, code: 'line-length', message, severity: Severity.Warning });
  });
  return out;
}

/** Where a `--` comment starts, outside string literals. */
function commentStart(line: string): number | undefined {
  let inString = false;
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] === '"') inString = !inString;
    else if (!inString && line[i] === '-' && line[i + 1] === '-') return i;
  }
  return undefined;
}

/** Symbols nothing refers to, as the compiler's "Defined But Not Referenced". */
export function unusedSymbols(binding: Binding): Set<ClSymbol> {
  const used = new Set<ClSymbol>();
  // The name after END repeats the heading; it is not a use.
  for (const r of binding.references) if (!r.isDefinition && r.symbol && r.kind !== 'unit') used.add(r.symbol);
  const out = new Set<ClSymbol>();
  const visit = (syms: ClSymbol[]) => {
    for (const s of syms) {
      if (UNUSED_KINDS.has(s.kind) && !used.has(s)) out.add(s);
      visit(s.children);
    }
  };
  visit(binding.symbols);
  return out;
}

const LOGICAL_OPS = new Set(['AND', 'OR', 'XOR']);

const MAX_CALL_ARGS = 32;
const PREFETCH_LIMIT = 12;
const MAX_STATE_CHANGE_POINTS = 16;
const COMPARISONS = new Set(['=', '<>', '<', '<=', '>', '>=']);
const STATE_CHANGE_TYPES = new Set(['DOUTNIM', 'DICMPNIM', 'DEVCTLNIM']);
/** Point types that live in I/O modules, whose parameters are prefetched. */
const IO_TYPES = new Set(['ANINNIM', 'ANOUTNIM', 'DIINNIM', 'DOUTNIM']);
/** AI parameters read without a prefetch [HP27-610 §2.5.5]. */
const AI_NO_PREFETCH = new Set(['PV', 'PVSTS', 'PVROCNFL', 'PVROCPFL', 'PVHIFL', 'PVLOFL', 'PVHHFL', 'PVLLFL', 'BADPVFL']);

const typeName = (type: string) => {
  const name = POINT_TYPES[type] ?? type;
  return `${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name}`;
};

/** `XV1.OP` as written. */
function exprText(x: Expr): string {
  if (x.kind === 'member') return `${exprText(x.object)}.${x.property.text}`;
  if (x.kind === 'name') return x.id.text;
  return '';
}

/** Argument counts of the built-ins, from their signatures: `Avg(x, y, ...)` takes 1 to 16. */
const BUILTIN_ARITY = new Map(
  BUILTINS.map((b) => {
    const inner = /\((.*)\)/.exec(b.signature)?.[1];
    const params = inner === undefined || inner.trim() === '' ? [] : inner.split(',');
    const variadic = params.some((p) => p.includes('...'));
    return [b.name, { kind: b.kind, signature: b.signature.replace(/^CALL /, ''), min: variadic ? 1 : params.length, max: variadic ? 16 : params.length }];
  }),
);

/** Something a CALL can store into: a name, a parameter, or an indexed element. */
function isVariable(x: Expr): boolean {
  return x.kind === 'name' || x.kind === 'member' || (x.kind === 'apply' && (x.callee.kind === 'name' || x.callee.kind === 'member'));
}

function isLiteral(x: Expr): boolean {
  return x.kind === 'number' || x.kind === 'string' || (x.kind === 'unary' && x.op === '-' && x.operand.kind === 'number');
}

/** The value type of a declared LOCAL or argument; undefined for types this does not compare. */
function valueType(t: TypeSpec | undefined): { family: string; array: boolean } | undefined {
  const array = !!t && (t.kind === 'array' || !!t.array);
  if (!t || t.kind === 'array') return { family: 'NUMBER', array };
  if (t.kind === 'states') return { family: 'STATES', array };
  const name = t.name.name === 'FLAG' ? 'LOGICAL' : t.name.name;
  return ['NUMBER', 'LOGICAL', 'TIME', 'STRING'].includes(name) ? { family: name, array } : undefined;
}

/** Symbols the compiler reports as "Defined But Not Referenced" when nothing uses them. */
const UNUSED_KINDS = new Set(['local', 'external', 'constant', 'label', 'handler', 'subroutine', 'argument']);

const AM_FORBIDDEN: Partial<Record<Statement['kind'], string>> = {
  wait: 'WAIT',
  pause: 'PAUSE',
  read: 'READ',
  write: 'WRITE',
  initiate: 'INITIATE',
  enb: 'ENB',
  fail: 'FAIL',
  resume: 'RESUME',
};

/** The characters of a string literal, with `""` read as one quote. */
function stringValue(literal: string): string {
  return literal.slice(1, literal.endsWith('"') && literal.length > 1 ? -1 : undefined).replace(/""/g, '"');
}

/** `NN(3)`, `X.FL(21)` with a constant index. */
function slotOf(x: Expr): { point?: Ident; param: Ident; index: number; range: Range } | undefined {
  if (x.kind !== 'apply' || x.args.length !== 1 || x.args[0].kind !== 'number') return undefined;
  const index = Number(x.args[0].value);
  if (!Number.isInteger(index)) return undefined;
  if (x.callee.kind === 'name' && SLOT_LIMITS[x.callee.id.name]) return { param: x.callee.id, index, range: x.range };
  if (x.callee.kind === 'member' && x.callee.object.kind === 'name' && SLOT_LIMITS[x.callee.property.name]) {
    return { point: x.callee.object.id, param: x.callee.property, index, range: x.range };
  }
  return undefined;
}

/** A time expression built on Date_Time, which waits for decades rather than until a moment. */
function isAbsoluteTime(x: Expr): boolean {
  // A condition (`Date_Time > t`, `A AND ...`, `NOT ...`, `x IN ...`) waits until it is true.
  if (x.kind === 'binary' && (['=', '<>', '<', '<=', '>', '>='].includes(x.op) || LOGICAL_OPS.has(x.op))) return false;
  if (x.kind === 'in' || (x.kind === 'unary' && x.op === 'NOT')) return false;
  let found = false;
  walkExpr(x, (y) => {
    if (y.kind === 'name' && y.id.name === 'DATE_TIME') found = true;
  });
  return found;
}

/** The value of a numeric literal, possibly negated or parenthesized. */
function constantNumber(x: Expr): number | undefined {
  if (x.kind === 'number') return Number(x.value);
  if (x.kind === 'paren') return constantNumber(x.inner);
  if (x.kind === 'unary' && x.op === '-') {
    const v = constantNumber(x.operand);
    return v === undefined ? undefined : -v;
  }
  return undefined;
}

/** The storage a LOCAL's type maps to [HP27-610 Table 2-4]. */
function localFamily(t: TypeSpec | undefined): string | undefined {
  if (!t || t.kind === 'array') return 'NN';
  if (t.kind === 'states') return 'FL';
  switch (t.name.name) {
    case 'NUMBER':
      return 'NN';
    case 'LOGICAL':
    case 'FLAG':
      return 'FL';
    case 'TIME':
      return 'TIME';
    case 'STRING':
      return 'STR';
  }
  return undefined;
}

function typeWord(t: TypeSpec | undefined): string {
  if (!t || t.kind === 'array') return 'NUMBER';
  return t.kind === 'states' ? 'state list' : t.name.text.toUpperCase();
}

/** Visit statements and the statements nested in them. */
function eachStatement(list: Statement[], f: (s: Statement) => void): void {
  for (const s of list) {
    f(s);
    if (s.kind === 'if') {
      for (const b of s.branches) {
        eachStatement(b.body, f);
        if (b.onError) eachStatement([b.onError.statement], f);
      }
      if (s.elseBody) eachStatement(s.elseBody, f);
    } else if ('onError' in s && s.onError) eachStatement([s.onError.statement], f);
    if (s.kind === 'wait' && s.timeout) eachStatement([s.timeout.statement], f);
  }
}
