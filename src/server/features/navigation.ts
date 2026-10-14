import { DocumentHighlight, DocumentHighlightKind, Location, Position } from 'vscode-languageserver';
import { Binding, Reference, referenceAt, referencesTo } from '../../language/binder';

export function definition(binding: Binding, uri: string, pos: Position): Location | undefined {
  const ref = referenceAt(binding, pos);
  if (!ref?.symbol) return undefined;
  return Location.create(uri, ref.symbol.ident.range);
}

export function references(binding: Binding, uri: string, pos: Position, includeDeclaration: boolean): Location[] {
  return related(binding, pos)
    .filter((r) => includeDeclaration || !r.isDefinition)
    .map((r) => Location.create(uri, r.ident.range));
}

export function documentHighlights(binding: Binding, pos: Position): DocumentHighlight[] {
  return related(binding, pos).map((r) =>
    DocumentHighlight.create(r.ident.range, r.isDefinition ? DocumentHighlightKind.Write : DocumentHighlightKind.Read),
  );
}

/**
 * All occurrences of the name under the cursor. A resolved name gives every reference to its
 * symbol. An unresolved one (an enumeration state, a point's parameter) gives every unresolved
 * occurrence of the same name and kind, which is still what the user wants to see highlighted.
 */
function related(binding: Binding, pos: Position): Reference[] {
  const ref = referenceAt(binding, pos);
  if (!ref) return [];
  if (ref.symbol) return referencesTo(binding, ref.symbol);
  return binding.references.filter((r) => !r.symbol && r.kind === ref.kind && r.ident.name === ref.ident.name);
}
