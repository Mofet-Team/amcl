import { Declaration, Expr, Routine, SourceFile, Statement, Unit } from './ast';

export interface Visitor {
  /** Called for each unit; `main` is the SEQUENCE or BLOCK whose handlers and subroutines follow it. */
  unit?(unit: Unit, main: Unit | undefined): void;
  declaration?(decl: Declaration, unit: Unit, main: Unit | undefined): void;
  statement?(stmt: Statement, unit: Unit, main: Unit | undefined): void;
  expr?(expr: Expr, unit: Unit, main: Unit | undefined): void;
}

/** Visit every unit, declaration, statement and expression of a file in source order. */
export function walk(file: SourceFile, v: Visitor): void {
  walkUnits(file.units, v);
}

function walkUnits(units: Unit[], v: Visitor): void {
  let main: Unit | undefined;
  for (const unit of units) {
    if (unit.kind === 'sequence' || unit.kind === 'block') main = unit;
    if (unit.kind === 'package') {
      v.unit?.(unit, undefined);
      walkUnits(unit.units, v);
      continue;
    }
    const m = unit.kind === 'handler' || unit.kind === 'subroutine' || unit === main ? main : undefined;
    v.unit?.(unit, m);
    const e = (x: Expr | undefined) => x && walkExpr(x, (y) => v.expr?.(y, unit, m));
    for (const d of unit.declarations) {
      v.declaration?.(d, unit, m);
      if (d.kind === 'local') e(d.at?.index);
      else if (d.kind === 'constant') e(d.value);
      else if (d.kind === 'define') e(d.value);
      else if (d.kind === 'parameter') d.attributes.forEach((a) => e(a.value));
    }
    const s = (st: Statement) => walkStatement(st, (x) => v.statement?.(x, unit, m), e);
    const r = (rt: Routine) => {
      rt.statements.forEach(s);
      rt.steps.forEach((st) => st.statements.forEach(s));
    };
    switch (unit.kind) {
      case 'sequence':
        for (const p of unit.phases) {
          e(p.alarm);
          r(p.routine);
        }
        break;
      case 'block':
        e(unit.when);
        r(unit.routine);
        break;
      case 'handler':
        e(unit.when);
        r(unit.routine);
        if (unit.restart) r(unit.restart.routine);
        break;
      case 'subroutine':
        r(unit.routine);
        break;
    }
  }
}

function walkStatement(st: Statement, onStatement: (s: Statement) => void, e: (x: Expr | undefined) => void): void {
  onStatement(st);
  const s = (x: Statement) => walkStatement(x, onStatement, e);
  switch (st.kind) {
    case 'set':
      st.targets.forEach(e);
      e(st.value);
      if (st.onError) s(st.onError.statement);
      break;
    case 'read':
    case 'write':
      st.targets.forEach(e);
      st.sources.forEach(e);
      if (st.onError) s(st.onError.statement);
      break;
    case 'stateChange':
      st.targets.forEach(e);
      if (st.onError) s(st.onError.statement);
      break;
    case 'if':
      for (const b of st.branches) {
        e(b.condition);
        if (b.onError) s(b.onError.statement);
        b.body.forEach(s);
      }
      st.elseBody?.forEach(s);
      break;
    case 'loop':
      e(st.low);
      e(st.high);
      break;
    case 'call':
      st.args.forEach(e);
      break;
    case 'initiate':
      if (st.onError) s(st.onError.statement);
      break;
    case 'wait':
      e(st.value);
      if (st.timeout) {
        e(st.timeout.time);
        s(st.timeout.statement);
      }
      if (st.onError) s(st.onError.statement);
      break;
    case 'send':
      e(st.destination);
      st.items.forEach(e);
      break;
  }
}

/** Pre-order walk of an expression tree. */
export function walkExpr(x: Expr, f: (e: Expr) => void): void {
  f(x);
  const w = (y: Expr) => walkExpr(y, f);
  switch (x.kind) {
    case 'member':
      w(x.object);
      break;
    case 'apply':
      w(x.callee);
      x.args.forEach(w);
      break;
    case 'unary':
      w(x.operand);
      break;
    case 'binary':
      w(x.left);
      w(x.right);
      break;
    case 'in':
      w(x.value);
      w(x.low);
      w(x.high);
      break;
    case 'time':
      x.parts.forEach((p) => w(p.value));
      break;
    case 'when':
      x.arms.forEach((a) => {
        if (a.condition) w(a.condition);
        w(a.value);
      });
      break;
    case 'paren':
      w(x.inner);
      break;
  }
}

/** The value of a number literal, in parentheses or negated; undefined for anything else. */
export function constantNumber(x: Expr): number | undefined {
  if (x.kind === 'number') return Number(x.value);
  if (x.kind === 'paren') return constantNumber(x.inner);
  if (x.kind === 'unary' && x.op === '-') {
    const v = constantNumber(x.operand);
    return v === undefined ? undefined : -v;
  }
  return undefined;
}

/** A number from literals, named constants among `declarations`, parentheses and `+ - *`. */
export function constantValue(x: Expr, declarations: Declaration[], depth = 0): number | undefined {
  if (depth > 8) return undefined;
  if (x.kind === 'paren') return constantValue(x.inner, declarations, depth + 1);
  if (x.kind === 'binary' && (x.op === '+' || x.op === '-' || x.op === '*')) {
    const [l, r] = [constantValue(x.left, declarations, depth + 1), constantValue(x.right, declarations, depth + 1)];
    return l === undefined || r === undefined ? undefined : x.op === '+' ? l + r : x.op === '-' ? l - r : l * r;
  }
  if (x.kind !== 'name') return constantNumber(x);
  const c = declarations.find((c) => c.kind === 'constant' && c.name.name === x.id.name);
  return c?.kind === 'constant' ? constantValue(c.value, declarations, depth + 1) : undefined;
}
