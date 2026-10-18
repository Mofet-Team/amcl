import { TextDocumentEdit, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { Analysis } from '../../language/analyze';
import { Ident, Unit } from '../../language/ast';
import { ClSymbol, referenceAt, referencesTo } from '../../language/binder';
import { builtin } from '../../language/builtins';
import { lint } from '../../language/lint';
import { RESERVED } from '../../language/parser';
import { FileSummary, SLOT_PARAMS } from '../../language/summary';
import { Position, Range, rangeContains } from '../../language/types';
import { WorkspaceIndex } from '../../language/workspace';
import { programOf } from './stores';

/** Names a rename can change: those declared in the file and known only inside it. */
const RENAMABLE = new Set<ClSymbol['kind']>(['local', 'constant', 'label', 'step', 'phase', 'handler', 'subroutine', 'argument']);
/** The 8-character limit of the US [HP27-610 §2.2.5.1]; CL/AM compiles longer names. */
const NAME_LIMIT = 8;
const LIMITED = new Set<ClSymbol['kind']>(['step', 'phase', 'handler', 'subroutine']);

const WHY_NOT: Partial<Record<ClSymbol['kind'], string>> = {
  external: 'is a point: its name is in the point database, not in this file',
  sequence: 'is the program name, which the system knows the program by',
  block: 'is the program name, which the system knows the program by',
  package: 'is the package name, which the system knows it by',
  parameter: 'is a parameter other programs and displays reach by name',
  enumeration: 'is a type other programs may use',
  enumState: 'is a state of a type other programs may use',
  custom: 'is a type other programs may use',
  paramList: 'is a parameter list other programs may use',
  function: 'is a function other programs may use',
};

export type Rename<T> = T | { error: string };

/** The name a rename at `pos` would change, or why it cannot. */
export function prepareRename(a: Analysis, index: WorkspaceIndex, pos: Position): Rename<{ range: Range; placeholder: string }> | undefined {
  const ref = referenceAt(a.binding, pos);
  if (!ref) return undefined;
  const sym = ref.symbol;
  if (!sym) {
    const what = index.point(ref.ident.name) ? 'is a point in the point database' : 'is not declared in this file';
    return { error: `${ref.ident.text} ${what}, so it cannot be renamed here.` };
  }
  if (!RENAMABLE.has(sym.kind)) return { error: `${ref.ident.text} ${WHY_NOT[sym.kind] ?? 'cannot be renamed'}.` };
  // Declared twice in one scope, uses go to the first: which one the user means is not known.
  const twice = lint(a.file, a.binding).filter((d) => d.code === 'duplicate' && referenceAt(a.binding, d.range.start)?.ident.name === sym.name);
  if (twice.length) {
    const lines = [sym.ident.range.start.line, ...twice.map((d) => d.range.start.line)].map((l) => l + 1);
    return { error: `${bare(ref.ident)} is declared more than once (lines ${[...new Set(lines)].join(', ')}): remove the extra declaration first.` };
  }
  return { range: ref.ident.range, placeholder: bare(ref.ident) };
}

/**
 * The edits of renaming the name at `pos`, in its file only: other files are often other
 * engineers', or older copies of the program. `elsewhere` names the programs that give a LOCAL
 * of the same name the same storage, which keep the old name.
 */
export function rename(
  ctx: { uri: string; version: number; analysis: Analysis; summary: FileSummary; index: WorkspaceIndex },
  pos: Position,
  newName: string,
): Rename<{ edit: WorkspaceEdit; oldName: string; elsewhere: string[] }> | undefined {
  const at = prepareRename(ctx.analysis, ctx.index, pos);
  if (!at || 'error' in at) return at;
  const sym = referenceAt(ctx.analysis.binding, pos)!.symbol!;
  const name = newName.trim();
  const upper = name.toUpperCase();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return { error: `${name || 'An empty name'} is not a CL name: a letter, then letters, digits or _.` };
  if (RESERVED.has(upper)) return { error: `${name} is a reserved word.` };
  if (builtin(upper)) return { error: `${name} is a built-in function.` };
  if (SLOT_PARAMS.has(upper)) return { error: `${name} is a parameter of the bound point.` };
  if (ctx.index.point(upper)) return { error: `${name} is a point in the point database.` };
  if (LIMITED.has(sym.kind) && upper.length > NAME_LIMIT && !isAm(ctx.analysis.file.units, sym.ident.range)) {
    return { error: `A ${sym.kind} name has at most ${NAME_LIMIT} characters (HP27-610 §2.2.5.1).` };
  }
  if (upper !== sym.name) {
    const clash = ctx.analysis.binding.references.find((r) => r.ident.name === upper && r.symbol !== sym)?.ident;
    if (clash) return { error: `${name} is already used in this file, on line ${clash.range.start.line + 1}.` };
  }
  const edits = referencesTo(ctx.analysis.binding, sym).map((r) => TextEdit.replace(r.ident.range, r.ident.text.startsWith("'") ? `'${name}` : name));
  const elsewhere = sym.kind === 'local' ? [...new Set(sameLocalElsewhere(ctx, sym).map(programOf))].sort() : [];
  return { edit: { documentChanges: [TextDocumentEdit.create({ uri: ctx.uri, version: ctx.version }, edits)] }, oldName: at.placeholder, elsewhere };
}

/** Other files' LOCALs of the same name on the same storage element. */
function sameLocalElsewhere(ctx: { uri: string; summary: FileSummary; index: WorkspaceIndex }, sym: ClSymbol): string[] {
  const at = sym.ident.range.start;
  const own = ctx.summary.storage.find((u) => u.local && u.local.decl.start.line === at.line && u.local.decl.start.character === at.character);
  const key = own && ctx.index.storageKey(own, ctx.summary);
  if (!key) return [];
  return (ctx.index.storageEntries().get(key) ?? []).flatMap((e) =>
    e.kind === 'local' && e.local && e.uri !== ctx.uri && e.local.name === sym.name ? [e.uri] : [],
  );
}

/** The name is in a CL/AM block, or a handler or subroutine of one. */
function isAm(units: Unit[], range: Range): boolean {
  let main: Unit | undefined;
  for (const u of units) {
    if (u.kind === 'package') {
      if (rangeContains(u.range, range.start)) return isAm(u.units, range);
      continue;
    }
    if (u.kind === 'sequence' || u.kind === 'block') main = u;
    if (rangeContains(u.range, range.start)) return (u.kind === 'handler' || u.kind === 'subroutine' ? main : u)?.kind === 'block';
  }
  return false;
}

const bare = (id: Ident) => id.text.replace(/^'/, '');
