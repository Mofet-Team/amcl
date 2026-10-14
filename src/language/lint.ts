// Semantic checks beyond syntax. Each has a stable code so users can tell them apart. Rules that
// the compiler enforces are errors; rules the compiler warns about, or that fail at run time,
// are warnings. Section tags cite HP27-610 (CL/HPM) and AM27-610 (CL/AM).

import { Declaration, Expr, HandlerRef, Ident, Routine, SourceFile, Statement, TypeSpec, Unit } from './ast';
import { Binding, ClSymbol } from './binder';
import { PointRecord } from './eb';
import { Diagnostic, Range, Severity } from './types';
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

  constructor(
    private readonly file: SourceFile,
    private readonly binding: Binding,
    private readonly env: LintEnvironment | undefined,
  ) {
    for (const r of binding.references) this.resolved.set(r.ident, r.symbol);
    const all = (us: Unit[]): Unit[] => us.flatMap((u) => (u.kind === 'package' ? all(u.units) : [u]));
    for (const u of all(file.units)) if (u.kind === 'handler' && u.name) this.handlerTypes.set(u.name.name, u.handlerType);
  }

  run(): LintDiagnostic[] {
    this.units(this.file.units, undefined);
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

    const routines: Routine[] = [];
    switch (unit.kind) {
      case 'sequence': {
        const phases = new Map<string, Ident>();
        for (const p of unit.phases) {
          if (!p.name) continue;
          if (dialect !== 'AM') this.nameLength(p.name, 'phase');
          this.duplicate(phases, p.name, 'phase');
          if (p.alarm) this.expressions(p.alarm, unit, dialect, bound);
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
      case 'subroutine':
        routines.push(unit.routine);
        if (!unit.routine.statements.length && !unit.routine.steps.length) this.empty(unit.headerRange, 'subroutine');
        for (const d of unit.declarations) {
          if (d.kind === 'external') this.report(d.range, 'external-in-subroutine', 'EXTERNAL is not allowed in a subroutine (HP27-610 §2.6)', Severity.Error);
        }
        break;
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

    switch (s.kind) {
      case 'set':
        s.targets.forEach(e);
        e(s.value);
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
        if (s.target && bound && s.target.name === bound && !s.handlerType && dialect !== 'AM') {
          this.report(s.target.range, 'initiate', `${s.target.text} is this program's own point: a sequence cannot INITIATE itself`, Severity.Error);
        }
        if (s.onError) nested(s.onError.statement);
        break;
      case 'call':
        s.args.forEach(e);
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
      if (x.kind === 'member' && x.object.kind === 'name') {
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
