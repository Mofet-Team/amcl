// Quick fixes for diagnostics: each returns the edits of one fix, in the file's own layout.

import { Declaration, Expr, Ident, Statement, Unit } from './ast';
import { Analysis } from './analyze';
import { lex, TokenKind } from './lexer';
import { COMPILER_COLUMNS } from './lint';
import { comparePositions, Diagnostic, Range } from './types';

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface QuickFix {
  title: string;
  edits: TextEdit[];
  /** The fix to apply with one keystroke when several are offered. */
  preferred?: boolean;
}

const at = (line: number, character: number) => ({ line, character });
const sameStart = (a: Range, b: Range) => comparePositions(a.start, b.start) === 0;
const indentOf = (s: string) => s.length - s.trimStart().length;
const wholeLines = (from: number, to: number) => ({ start: at(from, 0), end: at(to + 1, 0) });

/** Whether another program uses a slot of a sequence's own point, e.g. `taken('64_V165', 'FL', 5)`. */
export type SlotTaken = (point: string, param: string, index: number) => boolean;

/** The fixes for one diagnostic. */
export function quickFixes(lines: string[], analysis: Analysis, d: Diagnostic, taken: SlotTaken = () => false): QuickFix[] {
  switch (d.code) {
    case 'undeclared-point':
    case 'state-change':
    case 'external-order':
      return /not declared EXTERNAL/.test(d.message) ? addExternal(lines, analysis, d.range) : [];
    case 'unused':
      return removeUnused(lines, analysis, d.range);
    case 'line-length':
      return breakLine(lines, d.range.start.line);
    case 'syntax':
      return spaceBeforeKeyword(lines, d.range);
    case 'undefined':
      return /^Undefined name /.test(d.message) ? [...similarNames(lines, analysis, d.range), ...declareLocal(lines, analysis, d.range, taken)] : [];
  }
  return [];
}

// ---------------------------------------------------------------- EXTERNAL

/** Units of the file, with packages opened. */
function allUnits(units: Unit[]): Unit[] {
  return units.flatMap((u) => (u.kind === 'package' ? allUnits(u.units) : [u]));
}

/** The SEQUENCE a position is in, or that the handler or subroutine it is in belongs to. */
function mainSequence(analysis: Analysis, line: number): Extract<Unit, { kind: 'sequence' }> | undefined {
  let main: Extract<Unit, { kind: 'sequence' }> | undefined;
  for (const u of allUnits(analysis.file.units)) {
    if (u.kind === 'sequence') main = u;
    if (u.range.start.line <= line && line <= u.range.end.line) return main;
  }
  return main;
}

/** Add a point to the program's EXTERNAL list, or a new EXTERNAL line after the heading. */
function addExternal(lines: string[], analysis: Analysis, range: Range): QuickFix[] {
  const name = lines[range.start.line]?.slice(range.start.character, range.end.character);
  const seq = mainSequence(analysis, range.start.line);
  if (!name || !seq) return [];
  const title = `Add ${name} to EXTERNAL`;
  const externals = seq.declarations.filter((d): d is Extract<Declaration, { kind: 'external' }> => d.kind === 'external' && d.names.length > 0);
  // A LOCAL on the point needs the EXTERNAL above it: among the declarations, use only lists before the line.
  const firstPhase = seq.phases[0]?.range.start.line ?? Number.MAX_SAFE_INTEGER;
  const usable = range.start.line < firstPhase ? externals.filter((e) => e.range.end.line < range.start.line) : externals;
  const last = usable[usable.length - 1];
  if (last) {
    const tail = last.names[last.names.length - 1];
    const line = lines[tail.range.end.line];
    const appended = line.slice(0, tail.range.end.character) + `, ${name}` + line.slice(tail.range.end.character);
    if (appended.trimEnd().length <= COMPILER_COLUMNS) {
      return [{ title, preferred: true, edits: [{ range: { start: tail.range.end, end: tail.range.end }, newText: `, ${name}` }] }];
    }
    // No room: a continuation line, its name under the first name of the line above.
    const firstOnLine = last.names.find((n) => n.range.start.line === tail.range.end.line) ?? tail;
    const column = Math.max(2, firstOnLine.range.start.character);
    return [
      {
        title,
        preferred: true,
        edits: [
          { range: { start: tail.range.end, end: tail.range.end }, newText: ',' },
          { range: { start: at(tail.range.end.line + 1, 0), end: at(tail.range.end.line + 1, 0) }, newText: `&${' '.repeat(column - 1)}${name}\n` },
        ],
      },
    ];
  }
  // No EXTERNAL yet: a line after the heading, where the other declarations start.
  const headerEnd = seq.headerRange.end.line;
  const firstDecl = seq.declarations.find((d) => d.kind !== 'directive');
  const indent = firstDecl ? indentOf(lines[firstDecl.range.start.line]) : indentOf(lines[seq.headerRange.start.line]);
  return [{ title, preferred: true, edits: [{ range: { start: at(headerEnd + 1, 0), end: at(headerEnd + 1, 0) }, newText: `${' '.repeat(indent)}EXTERNAL ${name}\n` }] }];
}

// ---------------------------------------------------------------- unused names

/** Remove an unused LOCAL, constant, EXTERNAL point or label. */
function removeUnused(lines: string[], analysis: Analysis, range: Range): QuickFix[] {
  const ref = analysis.binding.references.find((r) => r.isDefinition && sameStart(r.ident.range, range));
  const sym = ref?.symbol;
  if (!sym) return [];
  const name = sym.ident.text;
  if (sym.kind === 'label') {
    // A LOOP needs its label even when nothing repeats it.
    if (sym.detail === 'LOOP') return [];
    // Spaces in place of `L:`, so the statement keeps its column.
    const line = lines[range.start.line];
    const colon = line.indexOf(':', range.end.character);
    if (colon < 0) return [];
    return [{ title: `Remove unused label ${name}`, preferred: true, edits: [{ range: { start: range.start, end: at(range.start.line, colon + 1) }, newText: ' '.repeat(colon + 1 - range.start.character) }] }];
  }
  const decl = sym.declaration;
  if (!decl || (decl.kind !== 'local' && decl.kind !== 'constant' && decl.kind !== 'external')) return [];
  const names = decl.kind === 'constant' ? [decl.name] : decl.names;
  const what = decl.kind === 'external' ? 'EXTERNAL point' : decl.kind === 'constant' ? 'constant' : 'LOCAL';
  const title = `Remove unused ${what} ${name}`;
  if (names.length === 1) return [{ title, preferred: true, edits: [{ range: wholeLines(decl.range.start.line, decl.range.end.line), newText: '' }] }];
  const i = names.findIndex((n) => sameStart(n.range, range));
  if (i < 0) return [];
  return [{ title, preferred: true, edits: removeFromList(lines, names, i) }];
}

/** Remove the i-th name of a comma list, with its comma; an `&` line left empty goes too. */
function removeFromList(lines: string[], names: Ident[], i: number): TextEdit[] {
  const n = names[i];
  if (i === names.length - 1) {
    const prev = names[i - 1];
    // The last name on the line of the one before: from the end of that one.
    if (prev.range.end.line === n.range.start.line) return [{ range: { start: prev.range.end, end: n.range.end }, newText: '' }];
    // On a line of its own: the comma after the one before, and the name, so comments stay.
    const prevLine = lines[prev.range.end.line];
    const comma = /^\s*,/.exec(prevLine.slice(prev.range.end.character));
    const edits: TextEdit[] = comma ? [{ range: { start: prev.range.end, end: at(prev.range.end.line, prev.range.end.character + comma[0].length) }, newText: '' }] : [];
    const line = lines[n.range.start.line];
    const rest = line.slice(0, n.range.start.character) + line.slice(n.range.end.character);
    edits.push(
      line.startsWith('&') && rest.slice(1).trim() === ''
        ? { range: wholeLines(n.range.start.line, n.range.start.line), newText: '' }
        : { range: n.range, newText: '' },
    );
    return edits;
  }
  const line = lines[n.range.start.line];
  const after = /^\s*,\s*/.exec(line.slice(n.range.end.character));
  const end = n.range.end.character + (after ? after[0].length : 0);
  const rest = line.slice(0, n.range.start.character) + line.slice(end);
  if (line.startsWith('&') && rest.slice(1).trim() === '') return [{ range: wholeLines(n.range.start.line, n.range.start.line), newText: '' }];
  return [{ range: { start: n.range.start, end: at(n.range.start.line, end) }, newText: '' }];
}

// ---------------------------------------------------------------- undefined names

/** Slots of a Process Module point per sequence [HP27-610 Table 2-4]. */
const SLOT_LIMIT: Record<string, number> = { FL: 127, NN: 80 };

const sameRange = (a: Range, b: Range) => sameStart(a, b) && comparePositions(a.end, b.end) === 0;

/**
 * Whether the name at `range` is used as a logical value: a condition, an operand of AND, OR, XOR
 * or NOT, compared with ON or OFF, or stored to a LOGICAL LOCAL. Otherwise it is taken as a number.
 */
function usedAsLogical(analysis: Analysis, range: Range): boolean {
  const isOnOff = (x: Expr) => x.kind === 'name' && (x.id.name === 'ON' || x.id.name === 'OFF');
  const find = (x: Expr | undefined, logical: boolean): boolean | undefined => {
    if (!x) return undefined;
    switch (x.kind) {
      case 'name':
        return sameRange(x.id.range, range) ? logical : undefined;
      case 'paren':
        return find(x.inner, logical);
      case 'unary':
        return find(x.operand, x.op === 'NOT');
      case 'binary':
        if (['AND', 'OR', 'XOR'].includes(x.op)) return find(x.left, true) ?? find(x.right, true);
        if (['=', '<>'].includes(x.op)) return find(x.left, isOnOff(x.right)) ?? find(x.right, isOnOff(x.left));
        return find(x.left, false) ?? find(x.right, false);
      case 'when':
        for (const a of x.arms) {
          const r = find(a.condition, true) ?? find(a.value, logical);
          if (r !== undefined) return r;
        }
        return undefined;
      case 'apply':
        return find(x.callee, false) ?? x.args.map((y) => find(y, false)).find((r) => r !== undefined);
      case 'member':
        return find(x.object, false);
      case 'in':
        return find(x.value, false) ?? find(x.low, false) ?? find(x.high, false);
      case 'time':
        return x.parts.map((p) => find(p.value, false)).find((r) => r !== undefined);
    }
    return undefined;
  };
  const logicalLocal = (t: Expr) => {
    const id = t.kind === 'name' ? t.id : t.kind === 'apply' && t.callee.kind === 'name' ? t.callee.id : undefined;
    const d = id && analysis.binding.references.find((r) => r.ident === id)?.symbol?.declaration;
    return d?.kind === 'local' && (d.type?.kind === 'named' ? d.type.name.name === 'LOGICAL' || d.type.name.name === 'FLAG' : d.type?.kind === 'states');
  };
  /** `t` is the name at `range`, alone or indexed. */
  const targetIs = (t: Expr) => {
    const id = t.kind === 'name' ? t.id : t.kind === 'apply' && t.callee.kind === 'name' ? t.callee.id : undefined;
    return !!id && sameRange(id.range, range);
  };
  /** Whether a value is logical: ON, OFF, a condition, NOT, or a LOGICAL LOCAL. */
  const logicalValue = (x: Expr): boolean => {
    if (x.kind === 'paren') return logicalValue(x.inner);
    if (x.kind === 'unary') return x.op === 'NOT';
    if (x.kind === 'binary') return ['AND', 'OR', 'XOR', '=', '<>', '<', '<=', '>', '>='].includes(x.op);
    if (x.kind === 'in') return true;
    if (x.kind === 'name') return isOnOff(x) || logicalLocal(x);
    return false;
  };
  let result: boolean | undefined;
  const visit = (s: Statement) => {
    if (result !== undefined) return;
    switch (s.kind) {
      case 'if':
        for (const b of s.branches) {
          result ??= find(b.condition, true);
          b.body.forEach(visit);
        }
        s.elseBody?.forEach(visit);
        break;
      case 'wait':
        result ??= find(s.value, true);
        break;
      case 'set':
        // The target itself: logical when the value stored is (ON, OFF, a condition, a LOGICAL).
        if (s.targets.some((t) => targetIs(t))) result ??= logicalValue(s.value);
        result ??= find(s.value, s.targets.some(logicalLocal)) ?? s.targets.map((t) => find(t, false)).find((r) => r !== undefined);
        break;
      case 'read':
      case 'write':
        for (const x of [...s.targets, ...s.sources]) result ??= find(x, false);
        break;
      case 'call':
        for (const x of s.args) result ??= find(x, false);
        break;
      case 'loop':
        result ??= find(s.low, false) ?? find(s.high, false);
        break;
      case 'send':
        for (const x of s.items) result ??= find(x, false);
        break;
    }
    if ('onError' in s && s.onError) visit(s.onError.statement);
  };
  for (const u of allUnits(analysis.file.units)) {
    const routines = u.kind === 'sequence' ? u.phases.map((p) => p.routine) : 'routine' in u ? [u.routine] : [];
    if (u.kind === 'handler' && u.restart) routines.push(u.restart.routine);
    for (const r of routines) [...r.statements, ...r.steps.flatMap((st) => st.statements)].forEach(visit);
  }
  return result ?? false;
}

/** Declare an undefined name as a LOCAL on the first free slot of the sequence's own point. */
function declareLocal(lines: string[], analysis: Analysis, range: Range, taken: SlotTaken): QuickFix[] {
  const name = lines[range.start.line]?.slice(range.start.character, range.end.character).toUpperCase();
  const seq = mainSequence(analysis, range.start.line);
  if (!name || !seq?.point || seq.dialect?.name === 'AM') return [];
  const bound = seq.point.name;
  const logical = usedAsLogical(analysis, range);
  const param = logical ? 'FL' : 'NN';
  const locals = seq.declarations.filter((d): d is Extract<Declaration, { kind: 'local' }> => d.kind === 'local');
  // Slots of the own point this file already maps, arrays included.
  const used = new Set<number>();
  for (const d of locals) {
    if (!d.at || d.at.param.name !== param || (d.at.point && d.at.point.name !== bound) || d.at.index?.kind !== 'number') continue;
    const first = Number(d.at.index.value);
    const bounds = d.type?.array?.[0];
    const size = bounds?.kind === 'binary' && bounds.left.kind === 'number' && bounds.right.kind === 'number' ? Number(bounds.right.value) - Number(bounds.left.value) + 1 : 1;
    for (let i = 0; i < size; i++) used.add(first + i);
  }
  let slot = 0;
  for (let i = 1; i <= SLOT_LIMIT[param]; i++) {
    if (!used.has(i) && !taken(bound, param, i)) {
      slot = i;
      break;
    }
  }
  if (!slot) return [];
  const type = logical ? ': LOGICAL' : '';
  const title = `Declare ${name} as LOCAL${type} AT ${param}(${slot})`;

  // Into the section of LOCALs of the same kind on the own point, in slot order.
  const indexOf = (d: Extract<Declaration, { kind: 'local' }>) => (d.at?.index?.kind === 'number' ? Number(d.at.index.value) : 0);
  const section = locals.filter((d) => d.at?.param.name === param && (!d.at.point || d.at.point.name === bound) && d.at.index?.kind === 'number');
  const below = section.filter((d) => indexOf(d) < slot).sort((a, b) => indexOf(b) - indexOf(a))[0];
  const template = below ?? section[0];
  const insertAt = below ? below.range.end.line + 1 : section.length ? section[0].range.start.line : undefined;
  if (template && insertAt !== undefined) {
    const line = like(lines, template, name, param, slot, logical);
    if (line !== undefined) return [{ title, preferred: true, edits: [{ range: { start: at(insertAt, 0), end: at(insertAt, 0) }, newText: `${line}\n` }] }];
  }
  // No such section: after the last LOCAL, in its indentation; else after the last declaration, or the heading.
  const anchor = locals[locals.length - 1] ?? seq.declarations.filter((d) => d.kind !== 'directive').pop();
  const after = anchor ? anchor.range.end.line : seq.headerRange.end.line;
  const indent = anchor ? indentOf(lines[anchor.range.start.line]) : indentOf(lines[seq.headerRange.start.line]);
  const text = `${' '.repeat(indent)}LOCAL ${name}${type} AT ${param}(${slot})`;
  return [{ title, preferred: true, edits: [{ range: { start: at(after + 1, 0), end: at(after + 1, 0) }, newText: `${text}\n` }] }];
}

/**
 * A declaration laid out like `template`, a one-line LOCAL of the same kind: the name padded to
 * the same width, the rest in the same columns, its comment left out. Undefined when the template
 * declares another type or an array.
 */
function like(lines: string[], template: Extract<Declaration, { kind: 'local' }>, name: string, param: string, slot: number, logical: boolean): string | undefined {
  if (template.range.start.line !== template.range.end.line || template.names.length !== 1 || template.type?.array || template.type?.kind === 'array') return undefined;
  const typeName = template.type?.kind === 'named' ? template.type.name.name : template.type ? 'STATES' : 'NUMBER';
  if (logical ? typeName !== 'LOGICAL' && typeName !== 'FLAG' : typeName !== 'NUMBER') return undefined;
  const line = lines[template.range.start.line];
  const id = template.names[0].range;
  let rest = line.slice(id.end.character);
  const comment = rest.indexOf('--');
  if (comment >= 0 && !rest.slice(0, comment).includes('"')) rest = rest.slice(0, comment);
  const replaced = rest.trimEnd().replace(new RegExp(`(\\b${param}\\s*\\(\\s*)\\d+(\\s*\\))`, 'i'), `$1${slot}$2`);
  if (replaced === rest.trimEnd()) return undefined;
  const width = id.end.character - id.start.character;
  const colon = /^(\s*):(\s*)(.*)$/.exec(replaced);
  let head: string;
  if (!colon) {
    // No type (`N1        AT NN(1)`): keep AT's column.
    const gap = replaced.length - replaced.trimStart().length;
    head = name + ' '.repeat(Math.max(1, width + gap - name.length)) + replaced.trimStart();
  } else if (colon[1]) {
    // Colons aligned in a column (`FMSG1  :LOGICAL`): keep the colon's column.
    head = name.padEnd(width + colon[1].length) + ':' + colon[2] + colon[3];
  } else {
    // The colon after the name (`FREADY: LOGICAL`): keep the type's column.
    head = name + ':' + ' '.repeat(Math.max(1, width + colon[2].length - name.length)) + colon[3];
  }
  return line.slice(0, id.start.character) + head;
}

/** A declared name a letter or two away from an undefined one: a likely typo. */
function similarNames(lines: string[], analysis: Analysis, range: Range): QuickFix[] {
  const name = lines[range.start.line]?.slice(range.start.character, range.end.character);
  if (!name || name.length < 3) return [];
  const upper = name.toUpperCase();
  const candidates = new Set<string>();
  const visit = (syms: Analysis['binding']['symbols']) => {
    for (const s of syms) {
      if (['local', 'constant', 'external', 'argument'].includes(s.kind) && s.name !== upper && distance(s.name, upper) <= Math.min(2, upper.length - 2)) {
        candidates.add(s.ident.text);
      }
      visit(s.children);
    }
  };
  visit(analysis.binding.symbols);
  return [...candidates].slice(0, 3).map((c) => ({ title: `Change to ${c}`, edits: [{ range, newText: c }] }));
}

/** Edit distance between two names. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

// ---------------------------------------------------------------- long lines

/** Continue a line past the column the compiler reads on an `&` line, between two tokens. */
function breakLine(lines: string[], lineNo: number): QuickFix[] {
  const line = lines[lineNo];
  if (!line || line.startsWith('%')) return [];
  const tokens = lex(line).lines.flatMap((l) => l.tokens).filter((t) => t.line === 0);
  // The last gap between tokens where the first part fits.
  let cut = -1;
  // Only at a space or after a comma: `X.PV` and `NN(1)` stay whole.
  for (let k = 1; k < tokens.length; k++) {
    const prev = tokens[k - 1];
    const open = tokens[k].start > prev.end || (prev.kind === TokenKind.Punct && prev.text === ',');
    if (prev.end <= COMPILER_COLUMNS && open) cut = k;
  }
  if (cut < 1) return reindent(lines, lineNo);
  const head = line.slice(0, tokens[cut - 1].end).trimEnd();
  const statementIndent = line.startsWith('&') ? indentOf(line.slice(1)) + 1 : indentOf(line);
  const tail = '&' + ' '.repeat(Math.max(1, statementIndent + 3)) + line.slice(tokens[cut].start);
  return [
    {
      title: 'Continue on the next line (the compiler reads 132 columns)',
      preferred: true,
      edits: [{ range: { start: at(lineNo, 0), end: at(lineNo, line.length) }, newText: `${head}\n${tail}` }],
    },
  ];
}

/** Code indented past the limit: move it to the indentation of the statement before it. */
function reindent(lines: string[], lineNo: number): QuickFix[] {
  const line = lines[lineNo];
  if (line.startsWith('&')) return [];
  let prev = lineNo - 1;
  while (prev >= 0 && (!lines[prev].trim() || /^\s*--/.test(lines[prev]) || lines[prev].startsWith('&'))) prev--;
  const indent = prev >= 0 ? indentOf(lines[prev]) : 0;
  const moved = ' '.repeat(indent) + line.trimStart();
  if (moved.trimEnd().length > COMPILER_COLUMNS || indent >= indentOf(line)) return [];
  return [
    {
      title: 'Move to the indentation of the statement before (the compiler reads 132 columns)',
      preferred: true,
      edits: [{ range: { start: at(lineNo, 0), end: at(lineNo, line.length) }, newText: moved }],
    },
  ];
}

// ---------------------------------------------------------------- Hebrew against a keyword

const STUCK = /([\u0590-\u05FF])(THEN|AND|OR)\b/gi;

/** Whether a column is code: not in a string and not after `--`. */
function inCode(line: string, column: number): boolean {
  let inString = false;
  for (let i = 0; i < column; i++) {
    if (line[i] === '"') inString = !inString;
    else if (!inString && line[i] === '-' && line[i + 1] === '-') return false;
  }
  return !inString;
}

/** A Hebrew state written against THEN, AND or OR (`=<state>THEN`) reads as one name. */
function spaceBeforeKeyword(lines: string[], range: Range): QuickFix[] {
  const edits: TextEdit[] = [];
  // The statement may continue on `&` lines; look from its first line to the error.
  let first = range.start.line;
  while (first > 0 && lines[first].startsWith('&')) first--;
  for (let l = first; l <= range.end.line; l++) {
    const text = lines[l] ?? '';
    for (const m of text.matchAll(STUCK)) {
      if (!inCode(text, m.index!)) continue;
      edits.push({ range: { start: at(l, m.index! + 1), end: at(l, m.index! + 1) }, newText: ' ' });
    }
  }
  return edits.length ? [{ title: `Insert a space before ${edits.length === 1 ? 'the keyword' : 'the keywords'}`, preferred: true, edits }] : [];
}
