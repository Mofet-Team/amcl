import { Binding } from './binder';
import { BUILTINS } from './builtins';
import { Diagnostic, Severity } from './types';

/** Subroutines provided by the system, which a CALL may name without a definition. */
export const BUILTIN_SUBROUTINES = new Set(BUILTINS.filter((b) => b.kind === 'subroutine').map((b) => b.name));

const WHAT: Record<string, string> = {
  label: 'label',
  step: 'step',
  phase: 'phase',
  handler: 'handler',
  subroutine: 'subroutine',
};

/** Control-flow names that do not resolve. Values are not checked: they may be parameters or states. */
export function checkReferences(binding: Binding): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const r of binding.references) {
    if (r.isDefinition || r.symbol || !WHAT[r.kind]) continue;
    // Runtime extension routines are written set$ROUTINE and come from %INCLUDE_SET.
    if (r.kind === 'subroutine' && (BUILTIN_SUBROUTINES.has(r.ident.name) || r.ident.name.includes('$'))) continue;
    out.push({
      range: r.ident.range,
      message: `Undefined ${WHAT[r.kind]} '${r.ident.text}'`,
      severity: Severity.Error,
      code: 'undefined',
    });
  }
  return out;
}
