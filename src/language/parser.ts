import {
  Declaration,
  ErrorClause,
  Expr,
  HandlerRef,
  Ident,
  IfBranch,
  Phase,
  Routine,
  SlotRef,
  SourceFile,
  Statement,
  StatementBody,
  Step,
  SubroutineArg,
  TypeSpec,
  Unit,
  WhenArm,
} from './ast';
import { lex, LogicalLine, Token, TokenKind, tokenRange } from './lexer';
import { Diagnostic, Range, Severity } from './types';

export interface ParseResult {
  file: SourceFile;
  diagnostics: Diagnostic[];
}

/** Reserved words [HP27-610 Table 2-2, AM27-610 Table 2-2]. They cannot be labels or state names. */
export const RESERVED = new Set(
  `ABORT ACCESS ALARM AND ARRAY AT BLD_VISIBLE BLOCK CALL CLASS CUSTOM DAYS DEFINE ELSE EMERGENCY ENB
   END ENUMERATION ERROR EU EXIT EXTERNAL FAIL FOR FROM GENERIC GOTO HANDLER HELP HOLD HOURS IF IN
   INITIATE KEEPENB LOCAL LOOP MINS MOD NOT OR OTHERS OUT PACKAGE PARALLEL PARAMETER PARAM_LIST PAUSE
   PHASE POINT RANGE READ REPEAT RESTART RESUME SECS SEND SEQUENCE SET SHUTDOWN STEP SUBROUTINE THEN
   VALUE WAIT WHEN WRITE XOR`.split(/\s+/),
);

const TIME_UNITS = new Set(['DAYS', 'HOURS', 'MINS', 'SECS']);
const RELOPS = new Set(['=', '<>', '<', '<=', '>', '>=']);
const HANDLER_TYPES = new Set(['HOLD', 'SHUTDOWN', 'EMERGENCY']);
const DECLARATION_WORDS = new Set(['LOCAL', 'EXTERNAL', 'PARAMETER', 'DEFINE']);
const ATTRIBUTE_WORDS = new Set(['ACCESS', 'EU', 'VALUE', 'BLD_VISIBLE', 'CLASS', 'HELP']);
/** Words that end an expression; never parsed as names. */
const EXPRESSION_STOP = new Set([
  'THEN', 'ELSE', 'FROM', 'AND', 'OR', 'XOR', 'MOD', 'IN', 'NOT', 'WHEN', 'OTHERS', 'ERROR', 'AT',
  'DAYS', 'HOURS', 'MINS', 'SECS',
]);

export function parse(text: string): ParseResult {
  const lexed = lex(text);
  const parser = new Parser(lexed.lines);
  const units = parser.parseUnits(undefined);
  const multiLineStatements = lexed.lines
    .filter((l) => l.endLine > l.startLine)
    .map((l) => ({ startLine: l.startLine, endLine: l.endLine }));
  return {
    file: { units, directives: parser.fileDirectives, commentLines: lexed.commentLines, multiLineStatements },
    diagnostics: [...lexed.diagnostics, ...parser.diagnostics],
  };
}

// ------------------------------------------------------------------ token stream

class Stream {
  pos = 0;
  last: Token | undefined;
  /** Only the first error on a line is reported; later ones are usually consequences of it. */
  private errored = false;

  constructor(
    readonly tokens: Token[],
    private readonly diagnostics: Diagnostic[],
  ) {}

  peek(k = 0): Token | undefined {
    return this.tokens[this.pos + k];
  }

  word(k = 0): string | undefined {
    const t = this.peek(k);
    return t && t.kind === TokenKind.Ident ? t.upper : undefined;
  }

  isPunct(text: string, k = 0): boolean {
    const t = this.peek(k);
    return !!t && t.kind === TokenKind.Punct && t.text === text;
  }

  isWord(word: string, k = 0): boolean {
    return this.word(k) === word;
  }

  get eol(): boolean {
    return this.pos >= this.tokens.length;
  }

  next(): Token {
    const t = this.tokens[this.pos++];
    this.last = t;
    return t;
  }

  acceptWord(word: string): Token | undefined {
    return this.isWord(word) ? this.next() : undefined;
  }

  acceptPunct(text: string): Token | undefined {
    return this.isPunct(text) ? this.next() : undefined;
  }

  expectPunct(text: string): Token | undefined {
    if (this.isPunct(text)) return this.next();
    this.error(`Expected '${text}'`);
    return undefined;
  }

  expectWord(word: string): Token | undefined {
    if (this.isWord(word)) return this.next();
    this.error(`Expected ${word}`);
    return undefined;
  }

  /** An identifier that is not a reserved word. */
  ident(what = 'a name'): Ident | undefined {
    const t = this.peek();
    if (t && t.kind === TokenKind.Ident && !RESERVED.has(t.upper)) {
      this.next();
      return toIdent(t);
    }
    this.error(`Expected ${what}`);
    return undefined;
  }

  /** Any identifier, reserved or not (for names after END, enumeration states, ...). */
  anyIdent(what = 'a name'): Ident | undefined {
    const t = this.peek();
    if (t && t.kind === TokenKind.Ident) {
      this.next();
      return toIdent(t);
    }
    this.error(`Expected ${what}`);
    return undefined;
  }

  error(message: string, severity = Severity.Error): void {
    const t = this.peek() ?? this.last ?? this.tokens[this.tokens.length - 1];
    if (!t || this.errored) return;
    this.errored = true;
    const range = this.peek()
      ? tokenRange(t)
      : { start: { line: t.line, character: t.end }, end: { line: t.line, character: t.end + 1 } };
    this.diagnostics.push({ range, message, severity, code: 'syntax' });
  }

  rangeFrom(first: Token): Range {
    const last = this.last && this.pos > this.tokens.indexOf(first) ? this.last : first;
    return { start: tokenRange(first).start, end: tokenRange(last).end };
  }

  rangeFromNode(start: Range): Range {
    return { start: start.start, end: this.last ? tokenRange(this.last).end : start.end };
  }

  /** Skip to the end of the line, reporting the first unparsed token. */
  finish(): void {
    if (!this.eol) {
      this.error(`Unexpected '${this.peek()!.text}'`);
      this.pos = this.tokens.length;
    }
  }

  mark(): { pos: number; last: Token | undefined; diagnostics: number; errored: boolean } {
    return { pos: this.pos, last: this.last, diagnostics: this.diagnostics.length, errored: this.errored };
  }

  reset(m: { pos: number; last: Token | undefined; diagnostics: number; errored: boolean }): void {
    this.pos = m.pos;
    this.last = m.last;
    this.diagnostics.length = m.diagnostics;
    this.errored = m.errored;
  }
}

function toIdent(t: Token): Ident {
  return { text: t.text, name: t.upper, range: tokenRange(t) };
}

// ------------------------------------------------------------------ parser

type UnitStart = 'SEQUENCE' | 'BLOCK' | 'HANDLER' | 'SUBROUTINE' | 'PACKAGE' | 'CUSTOM' | 'PARAM_LIST' | 'ENUMERATION';

class Parser {
  readonly diagnostics: Diagnostic[] = [];
  readonly fileDirectives: Declaration[] = [];
  private index = 0;

  constructor(private readonly lines: LogicalLine[]) {}

  private stream(line: LogicalLine): Stream {
    return new Stream(line.tokens, this.diagnostics);
  }

  private unitStart(line: LogicalLine): UnitStart | undefined {
    const t = line.tokens;
    const w = (k: number) => (t[k] && t[k].kind === TokenKind.Ident ? t[k].upper : undefined);
    switch (w(0)) {
      case 'SEQUENCE':
      case 'BLOCK':
      case 'SUBROUTINE':
      case 'PACKAGE':
      case 'PARAM_LIST':
      case 'ENUMERATION':
        return w(0) as UnitStart;
      case 'CUSTOM':
        return 'CUSTOM';
      case 'HOLD':
      case 'SHUTDOWN':
      case 'EMERGENCY':
        return w(1) === 'HANDLER' ? 'HANDLER' : undefined;
    }
    return undefined;
  }

  /** Parse units until the end of input, or until `END PACKAGE` when inside a package. */
  parseUnits(packageStart: Token | undefined): Unit[] {
    const units: Unit[] = [];
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      const first = line.tokens[0];
      if (!first) {
        this.index++;
        continue;
      }
      if (packageStart && first.upper === 'END' && line.tokens[1]?.upper === 'PACKAGE') return units;
      if (first.kind === TokenKind.Directive) {
        const s = this.stream(line);
        const d = this.parseDirective(s);
        if (d) this.fileDirectives.push(d);
        this.index++;
        continue;
      }
      const unit = this.parseUnit(line);
      if (unit) {
        units.push(unit);
        continue;
      }
      const w = first.kind === TokenKind.Ident ? first.upper : '';
      if (!packageStart && w !== 'END') {
        // Code without a heading (often a commented-out SEQUENCE line). Report once and parse the
        // rest as an unnamed sequence so navigation still works.
        this.error(tokenRange(first), 'Missing SEQUENCE or BLOCK heading before this line');
        const routine: Routine = { statements: [], steps: [] };
        const implicit: Unit = {
          kind: 'sequence', declarations: [], headerRange: tokenRange(first), range: tokenRange(first),
          phases: [{ keepEnb: false, handlers: [], routine, range: tokenRange(first) }],
        };
        this.parseBody(implicit, { phases: implicit.phases, routine, implicit: true });
        units.push(implicit);
        continue;
      }
      const s = this.stream(line);
      s.error(
        packageStart
          ? 'Expected BLOCK, CUSTOM, PARAM_LIST, ENUMERATION or END PACKAGE'
          : 'Expected SEQUENCE, BLOCK, handler, SUBROUTINE, PACKAGE, CUSTOM, PARAM_LIST or ENUMERATION',
      );
      this.index++;
    }
    if (packageStart) {
      this.diagnostics.push({
        range: tokenRange(packageStart),
        message: 'PACKAGE has no matching END PACKAGE',
        severity: Severity.Error,
        code: 'syntax',
      });
    }
    return units;
  }

  private parseUnit(line: LogicalLine): Unit | undefined {
    switch (this.unitStart(line)) {
      case 'SEQUENCE':
        return this.parseSequence(line);
      case 'BLOCK':
        return this.parseBlock(line);
      case 'HANDLER':
        return this.parseHandler(line);
      case 'SUBROUTINE':
        return this.parseSubroutine(line);
      case 'PACKAGE':
        return this.parsePackage(line);
      case 'CUSTOM':
        return this.parseCustom(line);
      case 'PARAM_LIST':
        return this.parseParamList(line);
      case 'ENUMERATION':
        return this.parseEnumeration(line);
    }
    return undefined;
  }

  // ---------------------------------------------------------------- unit headers

  private parseSequence(line: LogicalLine): Unit {
    const s = this.stream(line);
    const first = s.next();
    const name = s.ident('a sequence name');
    let dialect: Ident | undefined;
    let point: Ident | undefined;
    if (s.expectPunct('(')) {
      dialect = s.anyIdent('HPM, APM or PM');
      if (dialect && !['HPM', 'APM', 'PM', 'MC'].includes(dialect.name)) {
        this.diagnostics.push({ range: dialect.range, message: `Unknown program type '${dialect.text}'; expected HPM, APM or PM`, severity: Severity.Error, code: 'syntax' });
      }
      s.expectPunct(';');
      s.expectWord('POINT');
      point = s.anyIdent('a point name');
      s.expectPunct(')');
    }
    s.finish();
    this.index++;
    const unit: Unit = {
      kind: 'sequence', name, dialect, point, phases: [], declarations: [],
      headerRange: s.rangeFrom(first), range: s.rangeFrom(first),
    };
    this.parseBody(unit, { phases: unit.phases });
    return unit;
  }

  private parseBlock(line: LogicalLine): Unit {
    const s = this.stream(line);
    const first = s.next();
    const name = s.anyIdent('a block name');
    const unit: Unit = {
      kind: 'block', name, generic: false, declarations: [], routine: { statements: [], steps: [] },
      headerRange: tokenRange(first), range: tokenRange(first),
    };
    if (s.expectPunct('(')) {
      if (s.acceptWord('POINT')) unit.point = s.anyIdent('a point name');
      else if (s.acceptWord('GENERIC')) {
        unit.generic = true;
        if (!s.isPunct(';') && !s.isPunct(')')) unit.paramList = s.anyIdent('a parameter list name');
      } else s.error('Expected POINT or GENERIC');
      while (s.acceptPunct(';')) {
        if (s.acceptWord('AT')) {
          unit.insertionPoint = s.anyIdent('an insertion point');
          if (s.acceptPunct('(')) {
            const n = s.peek();
            if (n && n.kind === TokenKind.Number) unit.order = s.next().text;
            else s.error('Expected an execution order number');
            s.expectPunct(')');
          }
        } else if (s.acceptWord('WHEN')) unit.when = this.parseExpr(s);
        else if (s.acceptWord('ACCESS')) unit.access = s.anyIdent('PROGRAM or CONTIN_CTRL');
        else {
          s.error('Expected AT, WHEN or ACCESS');
          break;
        }
      }
      s.expectPunct(')');
    }
    s.finish();
    unit.headerRange = unit.range = s.rangeFrom(first);
    this.index++;
    this.parseBody(unit, { routine: unit.routine });
    return unit;
  }

  private parseHandler(line: LogicalLine): Unit {
    const s = this.stream(line);
    const first = s.next();
    s.next(); // HANDLER
    const name = s.ident('a handler name');
    const unit: Unit = {
      kind: 'handler', handlerType: first.upper as 'HOLD', name, declarations: [],
      routine: { statements: [], steps: [] }, headerRange: tokenRange(first), range: tokenRange(first),
    };
    if (s.acceptPunct('(')) {
      s.expectWord('WHEN');
      unit.when = this.parseExpr(s);
      if (s.acceptPunct(';')) unit.iolClause = s.anyIdent('FAIL_IF_ERROR, IGNORE_IF_ERROR or INVOKE_IF_ERROR');
      s.expectPunct(')');
    }
    s.finish();
    unit.headerRange = unit.range = s.rangeFrom(first);
    this.index++;
    this.parseBody(unit, { routine: unit.routine, handler: unit });
    return unit;
  }

  private parseSubroutine(line: LogicalLine): Unit {
    const s = this.stream(line);
    const first = s.next();
    const name = s.ident('a subroutine name');
    const args: SubroutineArg[] = [];
    if (s.acceptPunct('(')) {
      do {
        if (s.isWord('POINT') || s.isWord('GENERIC')) {
          // Library subroutines take a point description first [AM27-610 A.4 first_param].
          s.next();
          if (!s.isPunct(';') && !s.isPunct(')')) s.anyIdent();
          continue;
        }
        const names = this.identList(s);
        let mode: SubroutineArg['mode'] = 'IN';
        let type: TypeSpec | undefined;
        if (s.acceptPunct(':')) {
          if (s.acceptWord('IN')) mode = s.acceptWord('OUT') ? 'IN OUT' : 'IN';
          else if (s.acceptWord('OUT')) mode = 'OUT';
          if (!s.isPunct(';') && !s.isPunct(')')) type = this.parseType(s);
        }
        args.push({ names, mode, type });
      } while (s.acceptPunct(';'));
      s.expectPunct(')');
    }
    s.finish();
    this.index++;
    const unit: Unit = {
      kind: 'subroutine', name, args, declarations: [], routine: { statements: [], steps: [] },
      headerRange: s.rangeFrom(first), range: s.rangeFrom(first),
    };
    this.parseBody(unit, { routine: unit.routine });
    return unit;
  }

  private parsePackage(line: LogicalLine): Unit {
    const s = this.stream(line);
    const first = s.next();
    s.finish();
    this.index++;
    const units = this.parseUnits(first);
    const unit: Unit = { kind: 'package', units, declarations: [], headerRange: tokenRange(first), range: tokenRange(first) };
    const end = this.lines[this.index];
    if (end) {
      const es = this.stream(end);
      es.next();
      es.next();
      es.finish();
      unit.range = { start: unit.headerRange.start, end: tokenRange(end.tokens[end.tokens.length - 1]).end };
      this.index++;
    } else if (units.length) {
      unit.range = { start: unit.headerRange.start, end: units[units.length - 1].range.end };
    }
    return unit;
  }

  private parseCustom(line: LogicalLine): Unit {
    const s = this.stream(line);
    const first = s.next();
    const attributes: { name: string; value?: Ident; range: Range }[] = [];
    if (s.acceptPunct('(')) {
      do {
        const start = s.peek();
        if (!start) break;
        if (s.acceptWord('NOT')) {
          s.expectWord('BLD_VISIBLE');
          attributes.push({ name: 'NOT BLD_VISIBLE', range: s.rangeFrom(start) });
        } else if (s.acceptWord('BLD_VISIBLE')) attributes.push({ name: 'BLD_VISIBLE', range: s.rangeFrom(start) });
        else if (s.acceptWord('ACCESS') || s.acceptWord('CLASS')) {
          attributes.push({ name: start.upper, value: s.anyIdent(), range: s.rangeFrom(start) });
        } else {
          s.error('Expected ACCESS, CLASS or BLD_VISIBLE');
          break;
        }
      } while (s.acceptPunct(';'));
      s.expectPunct(')');
    }
    s.finish();
    this.index++;
    const unit: Unit = {
      kind: 'custom', attributes, declarations: [], headerRange: s.rangeFrom(first), range: s.rangeFrom(first),
    };
    this.parseBody(unit, {});
    return unit;
  }

  private parseParamList(line: LogicalLine): Unit {
    const s = this.stream(line);
    const first = s.next();
    const name = s.ident('a parameter list name');
    s.finish();
    this.index++;
    const unit: Unit = { kind: 'paramList', name, declarations: [], headerRange: s.rangeFrom(first), range: s.rangeFrom(first) };
    this.parseBody(unit, {});
    return unit;
  }

  private parseEnumeration(line: LogicalLine): Unit {
    const s = this.stream(line);
    const first = s.next();
    const name = s.ident('an enumeration name');
    const states: Ident[] = [];
    if (s.expectPunct('=')) {
      do {
        const st = s.anyIdent('a state name');
        if (st) states.push(st);
      } while (s.acceptPunct('/'));
    }
    s.finish();
    this.index++;
    const range = s.rangeFrom(first);
    return { kind: 'enumeration', name, states, declarations: [], headerRange: range, range };
  }

  // ---------------------------------------------------------------- unit bodies

  /**
   * Parse declarations, phases, steps and statements up to the unit's END line. Stops without
   * consuming at the start of another unit, which reports a missing END.
   */
  private parseBody(
    unit: Unit,
    ctx: { phases?: Phase[]; routine?: Routine; handler?: Extract<Unit, { kind: 'handler' }>; implicit?: boolean },
  ): void {
    let routine = ctx.routine;
    let step: Step | undefined;
    let phase: Phase | undefined = ctx.implicit ? ctx.phases?.[0] : undefined;
    let misplacedReported = -2;

    const closeStep = (endLine: Range) => {
      if (step) step.range = { start: step.range.start, end: endLine.end };
    };
    const closePhase = (end: Range) => {
      closeStep(end);
      if (phase) phase.range = { start: phase.range.start, end: end.end };
    };
    const lastRange = (): Range => {
      for (let i = this.index - 1; i >= 0; i--) {
        const t = this.lines[i].tokens;
        if (t.length) return tokenRange(t[t.length - 1]);
      }
      return unit.headerRange;
    };

    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      const first = line.tokens[0];
      if (!first) {
        this.index++;
        continue;
      }
      const s = this.stream(line);
      const w = first.kind === TokenKind.Ident ? first.upper : '';

      if (w === 'END' && line.tokens[1]?.upper === 'PACKAGE' && unit.kind !== 'package') break;

      if (w === 'END') {
        s.next();
        if (unit.kind === 'custom' || unit.kind === 'package') {
          if (!s.acceptWord(unit.kind === 'custom' ? 'CUSTOM' : 'PACKAGE')) s.error(`Expected END ${unit.kind.toUpperCase()}`);
        } else {
          unit.endName = s.eol ? undefined : s.anyIdent();
          if (!unit.endName) {
            this.warn(tokenRange(first), `END should name the ${unitWord(unit)}${unit.name ? ` (END ${unit.name.text})` : ''}`);
          } else if (unit.name && unit.endName.name !== unit.name.name) {
            this.error(unit.endName.range, `END ${unit.endName.text} does not match ${unitWord(unit)} ${unit.name.text}`);
          }
        }
        s.finish();
        this.index++;
        closePhase(s.rangeFrom(first));
        unit.range = { start: unit.headerRange.start, end: s.rangeFrom(first).end };
        return;
      }

      if (this.unitStart(line)) break;

      if (first.kind === TokenKind.Directive && first.upper !== '%DEBUG') {
        const d = this.parseDirective(s);
        if (d) unit.declarations.push(d);
        this.index++;
        continue;
      }

      if (DECLARATION_WORDS.has(w)) {
        const d = this.parseDeclaration(s);
        if (d) unit.declarations.push(d);
        this.index++;
        continue;
      }

      const lastDecl = unit.declarations[unit.declarations.length - 1];
      if (
        (ATTRIBUTE_WORDS.has(w) || (w === 'NOT' && line.tokens[1]?.upper === 'BLD_VISIBLE')) &&
        lastDecl?.kind === 'parameter'
      ) {
        this.parseAttribute(s, lastDecl);
        lastDecl.range = { start: lastDecl.range.start, end: s.rangeFrom(first).end };
        this.index++;
        continue;
      }

      if (w === 'PHASE' && ctx.phases) {
        closePhase(lastRange());
        phase = this.parsePhaseHeader(s);
        ctx.phases.push(phase);
        routine = phase.routine;
        step = undefined;
        this.index++;
        continue;
      }

      if (w === 'STEP' && line.tokens[1]?.kind === TokenKind.Ident) {
        if (!routine) {
          s.error(ctx.phases ? 'STEP must follow a PHASE' : `STEP is not allowed in a ${unitWord(unit)}`);
          this.index++;
          continue;
        }
        closeStep(lastRange());
        s.next();
        step = { name: s.ident('a step name'), statements: [], range: tokenRange(first) };
        s.finish();
        routine.steps.push(step);
        this.index++;
        continue;
      }

      if (w === 'RESTART' && ctx.handler) {
        closeStep(lastRange());
        s.next();
        s.finish();
        if (ctx.handler.restart) {
          // Keep the statements: they continue the first RESTART section.
          this.error(tokenRange(first), 'A handler has one RESTART section', 'heading');
          routine = ctx.handler.restart.routine;
          step = routine.steps[routine.steps.length - 1];
          this.index++;
          continue;
        }
        const restartRoutine: Routine = { statements: [], steps: [] };
        ctx.handler.restart = { routine: restartRoutine, range: tokenRange(first) };
        routine = restartRoutine;
        step = undefined;
        this.index++;
        continue;
      }

      if (!routine) {
        // Report a run of misplaced lines once.
        if (misplacedReported !== this.index - 1) s.error(
          ctx.phases
            ? 'Statements must follow a PHASE heading'
            : unit.kind === 'custom' || unit.kind === 'paramList'
              ? 'Expected PARAMETER'
              : 'Unexpected statement',
        );
        misplacedReported = this.index;
        this.index++;
        continue;
      }

      const list = step ? step.statements : routine.statements;
      if (w === 'ELSE') {
        this.parseElseLine(s, list);
        this.index++;
        continue;
      }

      const stmt = this.parseStatementLine(s, line);
      if (stmt) list.push(stmt);
      this.index++;
    }

    // Reached another unit or the end of input without END.
    const end = lastRange();
    closePhase(end);
    unit.range = { start: unit.headerRange.start, end: end.end };
    if (ctx.implicit) return;
    this.error(
      unit.headerRange,
      unit.kind === 'custom' || unit.kind === 'package'
        ? `Missing END ${unit.kind.toUpperCase()}`
        : `Missing END${unit.name ? ` ${unit.name.text}` : ''} for this ${unitWord(unit)}`,
    );
  }

  private parsePhaseHeader(s: Stream): Phase {
    const first = s.next();
    const phase: Phase = {
      name: s.ident('a phase name'), keepEnb: false, handlers: [], routine: { statements: [], steps: [] },
      range: tokenRange(first),
    };
    if (s.acceptPunct('(')) {
      // Clause rules of HP27-610 §4.1.4.2, reported here because the phase keeps one of each.
      let keepEnb: Token | undefined;
      do {
        const w = s.word();
        if (w === 'ALARM') {
          const t = s.next();
          const alarm = this.parseExpr(s);
          if (phase.alarm) this.error(tokenRange(t), 'A PHASE heading has one ALARM clause', 'heading');
          else phase.alarm = alarm;
        } else if (w === 'KEEPENB') {
          keepEnb = s.next();
          phase.keepEnb = true;
        } else if (w && HANDLER_TYPES.has(w)) {
          const t = s.next();
          const name = s.ident('a handler name');
          if (phase.handlers.some((h) => h.type === w)) this.error(tokenRange(t), `${w} appears twice in this PHASE heading (HP27-610 §4.1.4.2)`, 'heading');
          if (name) phase.handlers.push({ type: w as HandlerRef['type'], name });
        } else {
          s.error('Expected ALARM, KEEPENB, HOLD, SHUTDOWN or EMERGENCY');
          break;
        }
      } while (s.acceptPunct(';'));
      s.expectPunct(')');
      if (keepEnb && phase.handlers.length) {
        this.error(tokenRange(keepEnb), 'A PHASE heading names handlers or KEEPENB, not both (HP27-610 §4.1.4.2)', 'heading');
      }
    }
    s.finish();
    return phase;
  }

  // ---------------------------------------------------------------- declarations

  private parseDirective(s: Stream): Declaration | undefined {
    const first = s.next();
    const arg = s.peek();
    if (arg && arg.kind === TokenKind.String) s.next();
    else if (first.upper === '%DEBUG') return undefined;
    else s.finish();
    return { kind: 'directive', name: first.upper, argument: arg?.kind === TokenKind.String ? arg.text : undefined, range: s.rangeFrom(first) };
  }

  private parseDeclaration(s: Stream): Declaration | undefined {
    const first = s.next();
    switch (first.upper) {
      case 'LOCAL': {
        const names = this.identList(s);
        if (names.length === 1 && s.acceptPunct('=')) {
          const value = this.parseExpr(s);
          s.finish();
          return { kind: 'constant', name: names[0], value, range: s.rangeFrom(first) };
        }
        let type: TypeSpec | undefined;
        let at: SlotRef | undefined;
        if (s.acceptPunct(':')) type = this.parseType(s);
        if (s.acceptWord('AT')) at = this.parseSlot(s);
        s.finish();
        return { kind: 'local', names, type, at, range: s.rangeFrom(first) };
      }
      case 'EXTERNAL': {
        const names = this.identList(s, true);
        s.finish();
        return { kind: 'external', names, range: s.rangeFrom(first) };
      }
      case 'PARAMETER': {
        const names: Ident[] = [];
        do {
          let id = s.anyIdent('a parameter name');
          // `point.param` in a PARAMETER list asserts a parameter of another point.
          while (id && s.acceptPunct('.')) id = s.anyIdent('a parameter name');
          if (id) names.push(id);
        } while (s.acceptPunct(','));
        let type: TypeSpec | undefined;
        if (s.acceptPunct(':')) type = this.parseType(s);
        let description: string | undefined;
        const d = s.peek();
        if (d && d.kind === TokenKind.String) description = s.next().text;
        const decl: Declaration = { kind: 'parameter', names, type, description, attributes: [], range: s.rangeFrom(first) };
        // CDS attributes may share the PARAMETER line.
        while (!s.eol && (ATTRIBUTE_WORDS.has(s.word() ?? '') || s.isWord('NOT'))) this.parseAttribute(s, decl);
        s.finish();
        decl.range = s.rangeFrom(first);
        return decl;
      }
      case 'DEFINE': {
        const name = s.anyIdent('a function name');
        const params: Ident[] = [];
        let type: TypeSpec | undefined;
        if (s.acceptPunct(':')) type = this.parseType(s);
        if (s.acceptPunct('(')) {
          do {
            params.push(...this.identList(s));
            if (s.acceptPunct(':')) this.parseType(s);
          } while (s.acceptPunct(';') || s.acceptPunct(','));
          s.expectPunct(')');
        }
        let value: Expr | undefined;
        if (s.expectPunct('=')) value = this.parseExpr(s);
        s.finish();
        if (!name) return undefined;
        return { kind: 'define', name, params, type, value, range: s.rangeFrom(first) };
      }
    }
    return undefined;
  }

  private parseAttribute(s: Stream, decl: Extract<Declaration, { kind: 'parameter' }>): void {
    const first = s.next();
    let name = first.upper;
    let value: Expr | undefined;
    if (name === 'NOT') {
      s.expectWord('BLD_VISIBLE');
      name = 'NOT BLD_VISIBLE';
    } else if (name === 'VALUE' && s.isPunct('(') && !s.isWord('WHEN', 1)) {
      // VALUE (1, 2, 3) for arrays
      s.next();
      do this.parseExpr(s);
      while (s.acceptPunct(','));
      s.expectPunct(')');
    } else if (name !== 'BLD_VISIBLE') {
      value = this.parseExpr(s);
    }
    decl.attributes.push({ name, value, range: s.rangeFrom(first) });
  }

  private parseSlot(s: Stream): SlotRef | undefined {
    const first = s.peek();
    const a = s.anyIdent('a storage slot such as NN(1)');
    if (!a || !first) return undefined;
    let point: Ident | undefined;
    let param = a;
    if (s.acceptPunct('.')) {
      point = a;
      param = s.anyIdent('a parameter name') ?? a;
    }
    let index: Expr | undefined;
    if (s.acceptPunct('(')) {
      index = this.parseExpr(s);
      s.expectPunct(')');
    }
    return { point, param, index, range: s.rangeFrom(first) };
  }

  private parseType(s: Stream): TypeSpec | undefined {
    if (s.acceptWord('ARRAY')) return { kind: 'array', array: this.parseArrayBounds(s) };
    const name = s.anyIdent('a type');
    if (!name) return undefined;
    if (s.isPunct('/')) {
      const states = [name];
      while (s.acceptPunct('/')) {
        const st = s.anyIdent('a state name');
        if (st) states.push(st);
      }
      return { kind: 'states', states, array: s.acceptWord('ARRAY') ? this.parseArrayBounds(s) : undefined };
    }
    return { kind: 'named', name, array: s.acceptWord('ARRAY') ? this.parseArrayBounds(s) : undefined };
  }

  private parseArrayBounds(s: Stream): Expr[] {
    const bounds: Expr[] = [];
    if (!s.expectPunct('(')) return bounds;
    do {
      const low = this.parseAdditive(s);
      if (s.acceptPunct('..')) {
        const high = this.parseAdditive(s);
        bounds.push({ kind: 'binary', op: '..', left: low, right: high, range: { start: low.range.start, end: high.range.end } });
      } else bounds.push(low);
    } while (s.acceptPunct(','));
    s.expectPunct(')');
    return bounds;
  }

  private identList(s: Stream, allowSystemNames = false): Ident[] {
    const names: Ident[] = [];
    do {
      const id = allowSystemNames ? s.anyIdent('a name') : s.ident('a name');
      if (id) names.push(id);
      else break;
    } while (s.acceptPunct(','));
    return names;
  }

  // ---------------------------------------------------------------- statements

  private parseStatementLine(s: Stream, line: LogicalLine): Statement | undefined {
    if (s.peek()?.kind === TokenKind.Directive) s.next(); // %DEBUG <statement>
    let label: Ident | undefined;
    const t0 = s.peek();
    if (t0 && t0.kind === TokenKind.Ident && !RESERVED.has(t0.upper) && s.isPunct(':', 1)) {
      label = toIdent(s.next());
      s.next();
    }
    const first = s.peek();
    let stmt: Statement;
    if (!first) {
      stmt = { kind: 'empty', range: label!.range, startLine: line.startLine, endLine: line.endLine };
    } else {
      stmt = this.parseStatement(s, true);
      // The compiler accepts a stray ';' after a statement.
      if (s.isPunct(';') && s.pos === s.tokens.length - 1) s.next();
      s.finish();
    }
    stmt.label = label;
    stmt.startLine = line.startLine;
    stmt.endLine = line.endLine;
    if (label) stmt.range = { start: label.range.start, end: stmt.range.end };
    return stmt;
  }

  private parseElseLine(s: Stream, list: Statement[]): void {
    const elseTok = s.next();
    const prev = list[list.length - 1];
    if (!prev || prev.kind !== 'if' || prev.elseBody) {
      this.error(tokenRange(elseTok), 'ELSE without a matching IF');
      s.pos = s.tokens.length;
      return;
    }
    this.parseElse(s, prev, elseTok);
    if (s.isPunct(';') && s.pos === s.tokens.length - 1) s.next();
    s.finish();
    prev.endLine = elseTok.line;
    const last = s.last ? tokenRange(s.last) : tokenRange(elseTok);
    prev.endLine = last.end.line;
    prev.range = { start: prev.range.start, end: last.end };
  }

  /** After ELSE: either `IF cond THEN consequent` or a consequent. */
  private parseElse(s: Stream, stmt: Extract<Statement, { kind: 'if' }>, elseTok: Token): void {
    if (s.isWord('IF')) {
      const ifTok = s.next();
      stmt.branches.push(this.parseIfBranch(s, ifTok));
    } else {
      stmt.elseBody = this.parseConsequent(s);
      stmt.elseRange = s.rangeFrom(elseTok);
    }
  }

  private parseIfBranch(s: Stream, ifTok: Token): IfBranch {
    const condition = this.parseExpr(s);
    const onError = this.parseErrorClause(s);
    if (!s.expectWord('THEN')) {
      // Without THEN the condition ran into the consequent; checking either would only repeat the error.
      while (!s.eol) s.next();
      return { condition: { kind: 'error', range: condition.range }, onError, body: [], range: s.rangeFrom(ifTok) };
    }
    const body = this.parseConsequent(s);
    return { condition, onError, body, range: s.rangeFrom(ifTok) };
  }

  private parseConsequent(s: Stream): Statement[] {
    if (s.isPunct('(')) {
      s.next();
      const body: Statement[] = [];
      do {
        if (s.isPunct(')')) break;
        body.push(this.parseStatement(s, false));
      } while (s.acceptPunct(';'));
      s.expectPunct(')');
      return body;
    }
    return [this.parseStatement(s, false)];
  }

  private parseErrorClause(s: Stream): ErrorClause | undefined {
    if (!(s.isPunct('(') && s.isWord('WHEN', 1) && s.isWord('ERROR', 2))) return undefined;
    const first = s.next();
    s.next();
    s.next();
    const statement = this.parseStatement(s, false);
    s.expectPunct(')');
    return { statement, range: s.rangeFrom(first) };
  }

  private parseStatement(s: Stream, allowIf: boolean): Statement {
    const first = s.peek()!;
    const base = { startLine: first?.line ?? 0, endLine: first?.line ?? 0 };
    const done = (stmt: StatementBody): Statement => {
      const range = s.rangeFrom(first);
      return { ...stmt, ...base, endLine: range.end.line, range };
    };
    if (!first) {
      s.error('Expected a statement');
      return { kind: 'invalid', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, ...base };
    }
    const w = first.kind === TokenKind.Ident ? first.upper : '';

    switch (w) {
      case 'IF': {
        s.next();
        if (!allowIf) this.error(tokenRange(first), 'IF cannot be nested inside another statement (HP27-610 §3.2.8)');
        const stmt = done({ kind: 'if', branches: [this.parseIfBranch(s, first)] }) as Extract<Statement, { kind: 'if' }>;
        while (s.isWord('ELSE')) this.parseElse(s, stmt, s.next());
        stmt.range = s.rangeFrom(first);
        stmt.endLine = stmt.range.end.line;
        return stmt;
      }
      case 'SET': {
        s.next();
        const targets = this.exprList(s, true);
        s.expectPunct('=');
        const value = this.parseExpr(s);
        return done({ kind: 'set', targets, value, onError: this.parseErrorClause(s) });
      }
      case 'READ':
      case 'WRITE': {
        s.next();
        const targets = this.exprList(s, true);
        s.expectWord('FROM');
        const sources = this.exprList(s, false);
        return done({ kind: w === 'READ' ? 'read' : 'write', targets, sources, onError: this.parseErrorClause(s) });
      }
      case 'GOTO': {
        s.next();
        const targetKind = s.acceptWord('STEP') ? 'step' : s.acceptWord('PHASE') ? 'phase' : 'label';
        return done({ kind: 'goto', targetKind, target: s.anyIdent(`a ${targetKind} name`) });
      }
      case 'RESUME': {
        s.next();
        s.expectWord('PHASE');
        return done({ kind: 'resume', target: s.anyIdent('a phase name') });
      }
      case 'REPEAT':
        s.next();
        return done({ kind: 'repeat', target: s.anyIdent('a loop label') });
      case 'LOOP': {
        s.next();
        if (!s.acceptWord('FOR')) return done({ kind: 'loop' });
        const counter = s.anyIdent('a loop counter');
        s.expectWord('IN');
        const low = this.parseAdditive(s);
        s.expectPunct('..');
        const high = this.parseAdditive(s);
        return done({ kind: 'loop', counter, low, high });
      }
      case 'CALL': {
        s.next();
        const target = s.anyIdent('a subroutine name');
        const args: Expr[] = [];
        if (s.acceptPunct('(')) {
          if (!s.isPunct(')')) args.push(...this.exprList(s, false));
          s.expectPunct(')');
        }
        return done({ kind: 'call', target, args });
      }
      case 'ENB': {
        s.next();
        const handlers: HandlerRef[] = [];
        if (!s.eol && !s.isPunct(';') && !s.isPunct(')')) {
          do {
            const type = s.word();
            if (!type || !HANDLER_TYPES.has(type)) {
              s.error('Expected HOLD, SHUTDOWN or EMERGENCY');
              break;
            }
            s.next();
            const name = s.ident('a handler name');
            if (name) handlers.push({ type: type as HandlerRef['type'], name });
          } while (s.acceptPunct(','));
        }
        return done({ kind: 'enb', handlers });
      }
      case 'INITIATE': {
        s.next();
        const own = s.word();
        if (own && HANDLER_TYPES.has(own)) {
          s.next();
          return done({ kind: 'initiate', handlerType: own, onError: this.parseErrorClause(s) });
        }
        const target = s.anyIdent('a point name');
        let handlerType: string | undefined;
        if (s.acceptPunct(':')) handlerType = s.anyIdent('HOLD, SHUTDOWN or EMERGENCY')?.name;
        return done({ kind: 'initiate', target, handlerType, onError: this.parseErrorClause(s) });
      }
      case 'WAIT': {
        s.next();
        const value = this.parseExpr(s);
        let timeout: { time: Expr; statement: Statement } | undefined;
        if (s.isPunct('(') && s.isWord('WHEN', 1) && !s.isWord('ERROR', 2)) {
          s.next();
          s.next();
          const time = this.parseExpr(s);
          s.expectPunct(':');
          const statement = this.parseStatement(s, false);
          s.expectPunct(')');
          timeout = { time, statement };
        }
        return done({ kind: 'wait', value, timeout, onError: this.parseErrorClause(s) });
      }
      case 'SEND': {
        s.next();
        let wait = false;
        if (s.isPunct('(') && s.isWord('WAIT', 1)) {
          s.next();
          s.next();
          s.expectPunct(')');
          wait = true;
        }
        let destination: Expr | undefined;
        if (!s.isPunct(':')) destination = this.parsePostfix(s);
        s.expectPunct(':');
        const items = s.eol || s.isPunct(';') || s.isPunct(')') ? [] : this.exprList(s, false);
        return done({ kind: 'send', wait, destination, items });
      }
      case 'PAUSE':
      case 'FAIL':
      case 'EXIT':
      case 'ABORT':
        s.next();
        return done({ kind: w.toLowerCase() as 'pause' });
    }

    if (first.kind === TokenKind.Ident && !RESERVED.has(w)) {
      // State change: `state point, point...`, or `state` alone for the bound point (CL/AM).
      const state = toIdent(s.next());
      const targets = s.eol || s.isPunct(';') || s.isPunct(')') || s.isPunct('(') || s.isWord('ELSE') ? [] : this.exprList(s, true);
      return done({ kind: 'stateChange', state, targets, onError: this.parseErrorClause(s) });
    }

    s.error(w ? `${first.text} is not a statement` : 'Expected a statement');
    s.next();
    while (!s.eol && !s.isPunct(';') && !s.isPunct(')') && !s.isWord('ELSE')) s.next();
    return done({ kind: 'invalid' });
  }

  private exprList(s: Stream, variablesOnly: boolean): Expr[] {
    const list: Expr[] = [];
    do list.push(variablesOnly ? this.parseAdditive(s) : this.parseExpr(s));
    while (s.acceptPunct(','));
    return list;
  }

  // ---------------------------------------------------------------- expressions

  parseExpr(s: Stream): Expr {
    let left = this.parseNot(s);
    for (;;) {
      const w = s.word();
      if (w !== 'AND' && w !== 'OR' && w !== 'XOR') return left;
      s.next();
      const right = this.parseNot(s);
      left = { kind: 'binary', op: w, left, right, range: { start: left.range.start, end: right.range.end } };
    }
  }

  private parseNot(s: Stream): Expr {
    if (s.isWord('NOT')) {
      const t = s.next();
      const operand = this.parseNot(s);
      return { kind: 'unary', op: 'NOT', operand, range: { start: tokenRange(t).start, end: operand.range.end } };
    }
    return this.parseRelation(s);
  }

  private parseRelation(s: Stream): Expr {
    const left = this.parseAdditive(s);
    const t = s.peek();
    if (t && t.kind === TokenKind.Punct && RELOPS.has(t.text)) {
      s.next();
      const right = this.parseAdditive(s);
      return { kind: 'binary', op: t.text, left, right, range: { start: left.range.start, end: right.range.end } };
    }
    const negated = s.isWord('NOT') && s.isWord('IN', 1);
    if (negated || s.isWord('IN')) {
      if (negated) s.next();
      s.next();
      const low = this.parseAdditive(s);
      s.expectPunct('..');
      const high = this.parseAdditive(s);
      return { kind: 'in', negated, value: left, low, high, range: { start: left.range.start, end: high.range.end } };
    }
    return left;
  }

  parseAdditive(s: Stream): Expr {
    let left: Expr;
    if (s.isPunct('-') || s.isPunct('+')) {
      const t = s.next();
      const operand = this.parseTerm(s);
      left = { kind: 'unary', op: t.text, operand, range: { start: tokenRange(t).start, end: operand.range.end } };
    } else left = this.parseTerm(s);
    while (s.isPunct('+') || s.isPunct('-')) {
      const op = s.next().text;
      const right = this.parseTerm(s);
      left = { kind: 'binary', op, left, right, range: { start: left.range.start, end: right.range.end } };
    }
    return left;
  }

  private parseTerm(s: Stream): Expr {
    let left = this.parseFactor(s);
    while (s.isPunct('*') || s.isPunct('/') || s.isWord('MOD')) {
      const op = s.next().upper;
      const right = this.parseFactor(s);
      left = { kind: 'binary', op, left, right, range: { start: left.range.start, end: right.range.end } };
    }
    return left;
  }

  private parseFactor(s: Stream): Expr {
    const base = this.parseTime(s);
    if (!s.isPunct('**')) return base;
    s.next();
    const exponent = this.parseTime(s);
    return { kind: 'binary', op: '**', left: base, right: exponent, range: { start: base.range.start, end: exponent.range.end } };
  }

  /** `operand DAYS operand HOURS operand MINS operand SECS`, any subset in that order. */
  private parseTime(s: Stream): Expr {
    const first = this.parseOperand(s);
    const unit = s.word();
    if (!unit || !TIME_UNITS.has(unit)) return first;
    s.next();
    const parts = [{ value: first, unit }];
    for (;;) {
      const m = s.mark();
      const t = s.peek();
      if (!t || !(t.kind === TokenKind.Number || t.kind === TokenKind.Ident || s.isPunct('('))) break;
      const value = this.parseOperand(s);
      const u = s.word();
      if (!u || !TIME_UNITS.has(u)) {
        s.reset(m);
        break;
      }
      s.next();
      parts.push({ value, unit: u });
    }
    return { kind: 'time', parts, range: s.rangeFromNode(first.range) };
  }

  private parseOperand(s: Stream): Expr {
    // Unary minus inside a time literal or exponent: `-5 MINS`, `2 ** -1`.
    if (s.isPunct('-') || s.isPunct('+')) {
      const t = s.next();
      const operand = this.parseOperand(s);
      return { kind: 'unary', op: t.text, operand, range: { start: tokenRange(t).start, end: operand.range.end } };
    }
    return this.parsePostfix(s);
  }

  private parsePostfix(s: Stream): Expr {
    const t = s.peek();
    if (!t) {
      s.error('Expected an expression');
      return { kind: 'error', range: s.last ? tokenRange(s.last) : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
    }
    if (t.kind === TokenKind.Number) return { kind: 'number', value: s.next().text, range: tokenRange(t) };
    if (t.kind === TokenKind.String) return { kind: 'string', value: s.next().text, range: tokenRange(t) };
    if (s.isPunct('(')) {
      s.next();
      if (s.isWord('WHEN')) return this.parseWhenList(s, t);
      const inner = this.parseExpr(s);
      s.expectPunct(')');
      return { kind: 'paren', inner, range: s.rangeFrom(t) };
    }
    if (t.kind !== TokenKind.Ident || EXPRESSION_STOP.has(t.upper)) {
      s.error('Expected an expression');
      return { kind: 'error', range: tokenRange(t) };
    }
    s.next();
    let expr: Expr = { kind: 'name', id: toIdent(t), range: tokenRange(t) };
    for (;;) {
      if (s.isPunct('(') && !s.isWord('WHEN', 1)) {
        s.next();
        const args = s.isPunct(')') ? [] : this.exprList(s, false);
        s.expectPunct(')');
        expr = { kind: 'apply', callee: expr, args, range: s.rangeFromNode(expr.range) };
      } else if (s.isPunct('.') && s.peek(1)?.kind === TokenKind.Ident) {
        s.next();
        const property = toIdent(s.next());
        expr = { kind: 'member', object: expr, property, range: { start: expr.range.start, end: property.range.end } };
      } else return expr;
    }
  }

  private parseWhenList(s: Stream, open: Token): Expr {
    const arms: WhenArm[] = [];
    do {
      const start = s.peek();
      if (!start || !s.expectWord('WHEN')) break;
      let condition: Expr | undefined;
      if (!s.acceptWord('OTHERS')) condition = this.parseExpr(s);
      s.expectPunct(':');
      const value = this.parseExpr(s);
      arms.push({ condition, value, range: s.rangeFrom(start) });
    } while (s.acceptPunct(';'));
    s.expectPunct(')');
    return { kind: 'when', arms, range: s.rangeFrom(open) };
  }

  // ---------------------------------------------------------------- helpers

  private error(range: Range, message: string, code = 'syntax'): void {
    this.diagnostics.push({ range, message, severity: Severity.Error, code });
  }

  private warn(range: Range, message: string): void {
    this.diagnostics.push({ range, message, severity: Severity.Warning, code: 'syntax' });
  }
}

export function unitWord(unit: Unit): string {
  switch (unit.kind) {
    case 'sequence':
      return 'SEQUENCE';
    case 'block':
      return 'BLOCK';
    case 'handler':
      return `${unit.handlerType} HANDLER`;
    case 'subroutine':
      return 'SUBROUTINE';
    case 'package':
      return 'PACKAGE';
    case 'custom':
      return 'CUSTOM';
    case 'paramList':
      return 'PARAM_LIST';
    case 'enumeration':
      return 'ENUMERATION';
  }
}
