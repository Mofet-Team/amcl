import * as path from 'path';
import { commands, EventEmitter, ExtensionContext, TextDocumentContentProvider, Uri, window, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { COMPILED_SOURCE_REQUEST, CompiledSource } from '../shared/programs';

const SCHEME = 'amcl-compiled';

/** Read-only documents holding the source of a last compile, for the left side of the diff. */
class CompiledContent implements TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly changed = new EventEmitter<Uri>();
  readonly onDidChange = this.changed.event;

  set(uri: Uri, text: string): void {
    this.contents.set(uri.toString(), text);
    this.changed.fire(uri);
  }

  provideTextDocumentContent(uri: Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }
}

/** The CL file a command was run on: from the explorer or editor title, a CL Programs entry, or the active editor. */
function targetOf(arg: unknown): Uri | undefined {
  if (arg instanceof Uri) return arg;
  const program = (arg as { program?: { uri?: string } } | undefined)?.program;
  if (program?.uri) return Uri.parse(program.uri);
  const doc = window.activeTextEditor?.document;
  return doc?.languageId === 'cl' ? doc.uri : undefined;
}

const trimmed = (lines: string[]) => {
  const out = lines.map((l) => l.trimEnd());
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
};

/** Compare with Last Compile: the source in the listing beside a file against the file now. */
export function registerCompare(context: ExtensionContext, client: LanguageClient): void {
  const content = new CompiledContent();
  context.subscriptions.push(
    workspace.registerTextDocumentContentProvider(SCHEME, content),
    commands.registerCommand('amcl.compareWithCompile', async (arg?: unknown) => {
      const target = targetOf(arg);
      if (!target) {
        void window.showInformationMessage('Open a CL file to compare it with its last compile.');
        return;
      }
      const name = path.basename(target.fsPath);
      const compiled = await client.sendRequest<CompiledSource | null>(COMPILED_SOURCE_REQUEST, { uri: target.toString() });
      if (!compiled) {
        void window.showInformationMessage(`${name} has no listing (.LS) beside it, so there is no compile to compare with.`);
        return;
      }
      const when = compiled.compiled ? `, ${compiled.compiled}` : '';
      if (!compiled.whole) {
        void window.showInformationMessage(
          `Only the error listing ${compiled.listing} is beside ${name}. It holds just the lines with errors, so the compiled source cannot be shown.`,
        );
        return;
      }
      const current = (await workspace.openTextDocument(target)).getText().split(/\r?\n|\r/);
      const before = trimmed(compiled.lines);
      if (before.join('\n') === trimmed(current).join('\n')) {
        void window.showInformationMessage(`${name}: no changes since the last compile (${compiled.listing}${when}).`);
        return;
      }
      // The file name keeps CL highlighting; the query keeps documents of different files apart.
      const left = Uri.from({ scheme: SCHEME, path: `/${name}`, query: target.toString() });
      content.set(left, compiled.lines.join('\n') + '\n');
      await commands.executeCommand('vscode.diff', left, target, `${name}: last compile (${compiled.listing}${when}) ↔ now`);
    }),
  );
}
