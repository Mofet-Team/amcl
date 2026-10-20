import { Range } from './types';

export interface Ident {
  /** Name as written. */
  text: string;
  /** Upper-cased name used for lookups; CL is case-insensitive. */
  name: string;
  range: Range;
}

// ---------------------------------------------------------------- expressions

export type Expr =
  | { kind: 'number'; value: string; range: Range }
  | { kind: 'string'; value: string; range: Range }
  | { kind: 'name'; id: Ident; range: Range }
  | { kind: 'member'; object: Expr; property: Ident; range: Range }
  | { kind: 'apply'; callee: Expr; args: Expr[]; range: Range }
  | { kind: 'unary'; op: string; operand: Expr; range: Range }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; range: Range }
  | { kind: 'in'; negated: boolean; value: Expr; low: Expr; high: Expr; range: Range }
  | { kind: 'time'; parts: { value: Expr; unit: string }[]; range: Range }
  | { kind: 'when'; arms: WhenArm[]; range: Range }
  | { kind: 'paren'; inner: Expr; range: Range }
  | { kind: 'error'; range: Range };

export interface WhenArm {
  /** Undefined for `WHEN OTHERS`. */
  condition?: Expr;
  value: Expr;
  range: Range;
}

// ---------------------------------------------------------------- statements

/** `(WHEN ERROR stmt)` on SET, READ, WRITE, IF, WAIT, state change and INITIATE. */
export interface ErrorClause {
  statement: Statement;
  range: Range;
}

interface StatementBase {
  label?: Ident;
  range: Range;
  /** Line range covered by the statement, including continuation lines. */
  startLine: number;
  endLine: number;
}

export type Statement = StatementBase &
  (
    | { kind: 'set'; targets: Expr[]; value: Expr; onError?: ErrorClause }
    | { kind: 'read' | 'write'; targets: Expr[]; sources: Expr[]; onError?: ErrorClause }
    | { kind: 'stateChange'; state: Ident; targets: Expr[]; onError?: ErrorClause }
    | { kind: 'goto'; target?: Ident; targetKind: 'label' | 'step' | 'phase' }
    | { kind: 'resume'; target?: Ident }
    | { kind: 'repeat'; target?: Ident }
    | { kind: 'if'; branches: IfBranch[]; elseBody?: Statement[]; elseRange?: Range }
    | { kind: 'loop'; counter?: Ident; low?: Expr; high?: Expr }
    | { kind: 'call'; target?: Ident; args: Expr[] }
    | { kind: 'enb'; handlers: HandlerRef[] }
    | { kind: 'initiate'; target?: Ident; handlerType?: string; onError?: ErrorClause }
    | { kind: 'wait'; value?: Expr; timeout?: { time: Expr; statement: Statement }; onError?: ErrorClause }
    | { kind: 'send'; wait: boolean; destination?: Expr; items: Expr[] }
    | { kind: 'pause' | 'fail' | 'exit' | 'abort' }
    | { kind: 'empty' }
    | { kind: 'invalid' }
  );

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A statement without its position fields, as built by the parser before they are known. */
export type StatementBody = DistributiveOmit<Statement, 'range' | 'startLine' | 'endLine' | 'label'>;

export interface IfBranch {
  condition: Expr;
  onError?: ErrorClause;
  body: Statement[];
  range: Range;
}

export interface HandlerRef {
  type: 'HOLD' | 'SHUTDOWN' | 'EMERGENCY';
  name: Ident;
}

// ---------------------------------------------------------------- declarations

export type TypeSpec =
  | { kind: 'named'; name: Ident; array?: Expr[] }
  | { kind: 'states'; states: Ident[]; array?: Expr[] }
  | { kind: 'array'; array: Expr[] };

export interface SlotRef {
  point?: Ident;
  param: Ident;
  index?: Expr;
  range: Range;
}

export type Declaration =
  | {
      kind: 'local';
      names: Ident[];
      type?: TypeSpec;
      /** `LOCAL x AT NN(3)`: HPM storage mapping. */
      at?: SlotRef;
      range: Range;
    }
  | { kind: 'constant'; name: Ident; value: Expr; range: Range }
  | { kind: 'external'; names: Ident[]; range: Range }
  | {
      kind: 'parameter';
      names: Ident[];
      type?: TypeSpec;
      description?: string;
      attributes: { name: string; value?: Expr; range: Range }[];
      range: Range;
    }
  | { kind: 'define'; name: Ident; params: Ident[]; type?: TypeSpec; value?: Expr; range: Range }
  | { kind: 'directive'; name: string; argument?: string; range: Range };

// ---------------------------------------------------------------- structure

export interface Step {
  name?: Ident;
  statements: Statement[];
  range: Range;
}

/** Statements of a phase, handler, subroutine or block, optionally split into steps. */
export interface Routine {
  statements: Statement[];
  steps: Step[];
}

export interface Phase {
  name?: Ident;
  /** Stands in for the missing heading of code without one; no PHASE line. */
  implicit?: boolean;
  alarm?: Expr;
  keepEnb: boolean;
  handlers: HandlerRef[];
  routine: Routine;
  range: Range;
}

export interface SubroutineArg {
  names: Ident[];
  mode: 'IN' | 'OUT' | 'IN OUT';
  type?: TypeSpec;
}

interface UnitBase {
  name?: Ident;
  /** The name after END, if present. */
  endName?: Ident;
  range: Range;
  headerRange: Range;
  declarations: Declaration[];
}

export type Unit = UnitBase &
  (
    | { kind: 'sequence'; dialect?: Ident; point?: Ident; phases: Phase[] }
    | {
        kind: 'block';
        point?: Ident;
        generic: boolean;
        paramList?: Ident;
        insertionPoint?: Ident;
        order?: string;
        when?: Expr;
        access?: Ident;
        routine: Routine;
      }
    | {
        kind: 'handler';
        handlerType: 'HOLD' | 'SHUTDOWN' | 'EMERGENCY';
        when?: Expr;
        iolClause?: Ident;
        routine: Routine;
        restart?: { routine: Routine; range: Range };
      }
    | { kind: 'subroutine'; args: SubroutineArg[]; routine: Routine }
    | { kind: 'package'; units: Unit[] }
    | { kind: 'custom'; attributes: { name: string; value?: Ident; range: Range }[] }
    | { kind: 'paramList' }
    | { kind: 'enumeration'; states: Ident[] }
  );

export type UnitKind = Unit['kind'];

export interface SourceFile {
  units: Unit[];
  /** File-level directives such as `%INCLUDE_SOURCE`. */
  directives: Declaration[];
  /** Zero-based line numbers of comment-only lines. */
  commentLines: number[];
  /** Statement spans that cover several physical lines, for folding. */
  multiLineStatements: { startLine: number; endLine: number }[];
}
