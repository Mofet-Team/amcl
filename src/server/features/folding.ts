import { FoldingRange, FoldingRangeKind } from 'vscode-languageserver';
import { Routine, SourceFile, Statement, Unit } from '../../language/ast';

export function foldingRanges(file: SourceFile): FoldingRange[] {
  const out: FoldingRange[] = [];
  const add = (startLine: number, endLine: number, kind?: FoldingRangeKind) => {
    if (endLine > startLine) out.push({ startLine, endLine, kind });
  };

  const routine = (r: Routine) => {
    r.statements.forEach(statement);
    for (const st of r.steps) {
      add(st.range.start.line, st.range.end.line);
      st.statements.forEach(statement);
    }
  };
  const statement = (s: Statement) => {
    if (s.kind === 'if' || s.kind === 'set' || s.kind === 'wait') add(s.startLine, s.endLine);
  };
  const unit = (u: Unit) => {
    add(u.range.start.line, u.range.end.line);
    const decls = u.declarations.filter((d) => d.kind !== 'directive');
    if (decls.length > 1) add(decls[0].range.start.line, decls[decls.length - 1].range.end.line, FoldingRangeKind.Imports);
    switch (u.kind) {
      case 'sequence':
        for (const p of u.phases) {
          add(p.range.start.line, p.range.end.line);
          routine(p.routine);
        }
        break;
      case 'block':
      case 'subroutine':
        routine(u.routine);
        break;
      case 'handler':
        routine(u.routine);
        if (u.restart) {
          add(u.restart.range.start.line, u.range.end.line - 1);
          routine(u.restart.routine);
        }
        break;
      case 'package':
        u.units.forEach(unit);
        break;
    }
  };
  file.units.forEach(unit);

  for (const m of file.multiLineStatements) add(m.startLine, m.endLine);

  // Runs of two or more comment lines, such as the header banners every program starts with.
  const comments = file.commentLines;
  for (let i = 0; i < comments.length; ) {
    let j = i;
    while (j + 1 < comments.length && comments[j + 1] === comments[j] + 1) j++;
    add(comments[i], comments[j], FoldingRangeKind.Comment);
    i = j + 1;
  }

  // One range per start line: editors keep the first, so keep the largest.
  const byStart = new Map<number, FoldingRange>();
  for (const r of out) {
    const prev = byStart.get(r.startLine);
    if (!prev || r.endLine > prev.endLine) byStart.set(r.startLine, r);
  }
  return [...byStart.values()].sort((a, b) => a.startLine - b.startLine);
}
