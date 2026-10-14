import { ParameterInformation, Position, SignatureHelp, SignatureInformation } from 'vscode-languageserver';
import { Analysis } from '../../language/analyze';
import { Unit } from '../../language/ast';
import { exprText, typeText } from '../../language/binder';
import { builtin } from '../../language/builtins';
import { SLOT_PARAMS } from '../../language/summary';
import { splitComment } from './shared';

/**
 * Signature help inside `CALL name (...)` and `function(...)`. The statement may span `&`
 * continuation lines, so the text is read back to the start of the statement.
 */
export function signatureHelp(analysis: Analysis, lines: string[], pos: Position): SignatureHelp | null {
  const text = statementBefore(lines, pos);
  const call = openCall(text);
  if (!call) return null;
  const sig = signatureOf(analysis, call.name);
  if (!sig) return null;
  return { signatures: [sig], activeSignature: 0, activeParameter: Math.min(call.argument, (sig.parameters?.length ?? 1) - 1) };
}

function signatureOf(analysis: Analysis, name: string): SignatureInformation | undefined {
  const upper = name.toUpperCase();
  if (SLOT_PARAMS.has(upper)) return undefined;

  const sub = findUnit(analysis.file.units, upper);
  if (sub?.kind === 'subroutine') {
    const params = sub.args.flatMap((a) =>
      a.names.map((n) => `${n.text}: ${a.mode} ${typeText(a.type) ?? 'NUMBER'}`),
    );
    return SignatureInformation.create(`${sub.name!.text} (${params.join('; ')})`, undefined, ...params.map((p) => ParameterInformation.create(p)));
  }

  for (const u of allUnits(analysis.file.units)) {
    for (const d of u.declarations) {
      if (d.kind === 'define' && d.name.name === upper) {
        const params = d.params.map((p) => p.text);
        const value = d.value ? ` = ${exprText(d.value)}` : '';
        return SignatureInformation.create(`${d.name.text}(${params.join(', ')})${value}`, undefined, ...params.map((p) => ParameterInformation.create(p)));
      }
    }
  }

  const b = builtin(upper);
  if (b) {
    const label = b.signature.replace(/^CALL /, '');
    const params = /\((.*)\)/.exec(label)?.[1].split(',').map((p) => p.trim()) ?? [];
    return SignatureInformation.create(label, b.description, ...params.map((p) => ParameterInformation.create(p)));
  }
  return undefined;
}

/** The innermost unclosed `name(` before the end of `text`, and which argument the end is in. */
export function openCall(text: string): { name: string; argument: number } | undefined {
  let depth = 0;
  let commas = 0;
  let inString = false;
  // Walk backwards; strings are skipped by tracking quotes (a `""` pair toggles twice).
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '"') inString = !inString;
    if (inString) continue;
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth === 0) {
        const m = /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(0, i));
        if (!m) return undefined;
        return { name: m[1], argument: commas };
      }
      depth--;
    } else if ((c === ',' || c === ';') && depth === 0) commas++;
  }
  return undefined;
}

/** Text of the statement from its first line to the cursor, with comments removed. */
function statementBefore(lines: string[], pos: Position): string {
  let first = pos.line;
  while (first > 0 && lines[first]?.startsWith('&')) first--;
  const parts: string[] = [];
  for (let i = first; i <= pos.line; i++) {
    let l = i === pos.line ? lines[i].slice(0, pos.character) : lines[i];
    if (l.startsWith('&')) l = ' ' + l.slice(1);
    parts.push(splitComment(l).code);
  }
  return parts.join(' ');
}

function allUnits(units: Unit[]): Unit[] {
  return units.flatMap((u) => (u.kind === 'package' ? [u, ...allUnits(u.units)] : [u]));
}

function findUnit(units: Unit[], name: string): Unit | undefined {
  return allUnits(units).find((u) => u.kind === 'subroutine' && u.name?.name === name);
}
