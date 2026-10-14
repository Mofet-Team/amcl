import { SourceFile } from './ast';
import { bind, Binding } from './binder';
import { checkReferences } from './checks';
import { parse } from './parser';
import { Diagnostic } from './types';

export interface Analysis {
  file: SourceFile;
  binding: Binding;
  diagnostics: Diagnostic[];
}

export function analyze(text: string): Analysis {
  const { file, diagnostics } = parse(text);
  const binding = bind(file);
  return { file, binding, diagnostics: [...diagnostics, ...checkReferences(binding)] };
}
