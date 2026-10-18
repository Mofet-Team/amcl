import * as path from 'path';
import * as fs from 'fs';
import { commands, ExtensionContext, Uri, window, workspace } from 'vscode';
import { ProgramsView } from './programsView';
import { StorageView } from './storageView';
import { PROGRAMS_CHANGED } from '../shared/programs';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

/** The server reads closed files itself, so it needs the encoding VS Code uses for CL. */
function settings() {
  return {
    encoding: workspace.getConfiguration('files', { languageId: 'cl' }).get<string>('encoding'),
    pointDatabase: workspace.getConfiguration('amcl').get<string[]>('pointDatabase') ?? [],
    hebrewDescriptors: workspace.getConfiguration('amcl').get<string>('hebrewDescriptors') ?? 'auto',
    disabledDiagnostics: workspace.getConfiguration('amcl').get<string[]>('diagnostics.disabled') ?? [],
    networkConfig: workspace.getConfiguration('amcl').get<string[]>('networkConfig') ?? [],
    lineLength: workspace.getConfiguration('amcl').get<number>('lineLength') ?? 132,
  };
}

export async function activate(context: ExtensionContext): Promise<void> {
  const module = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'cl' }, { language: 'cl-listing' }],
    initializationOptions: settings(),
  };
  client = new LanguageClient('amcl', 'CL Language Server', serverOptions, clientOptions);
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('amcl') || e.affectsConfiguration('files.encoding')) {
        void client?.sendNotification('amcl/settings', settings());
      }
    }),
  );
  context.subscriptions.push(commands.registerCommand('amcl.createFormatRules', createFormatRules));

  const programs = new ProgramsView(client);
  const storage = new StorageView(client);
  context.subscriptions.push(
    window.registerTreeDataProvider('amclPrograms', programs),
    window.registerTreeDataProvider('amclStorage', storage),
    commands.registerCommand('amcl.refreshPrograms', () => {
      programs.refresh();
      storage.refresh();
    }),
  );
  await client.start();
  // The view shows in workspaces with CL programs, and refreshes when the server's index changes.
  client.onNotification(PROGRAMS_CHANGED, ({ count }: { count: number }) => {
    void commands.executeCommand('setContext', 'amcl.hasPrograms', count > 0);
    programs.refresh();
    storage.refresh();
  });
}

/** Write a .clformat.json beside the active CL file, with the columns that file uses. */
async function createFormatRules(): Promise<void> {
  const editor = window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'cl' || !client) {
    void window.showInformationMessage('Open a CL file to take its formatting rules from.');
    return;
  }
  if (editor.document.uri.scheme !== 'file') {
    void window.showInformationMessage('Save the file first: the rules are written to its folder.');
    return;
  }
  const target = Uri.joinPath(Uri.file(path.dirname(editor.document.uri.fsPath)), '.clformat.json');
  if (fs.existsSync(target.fsPath)) {
    const answer = await window.showWarningMessage(`${target.fsPath} exists. Replace it?`, { modal: true }, 'Replace');
    if (answer !== 'Replace') return;
  }
  const columns = await client.sendRequest('amcl/learnFormat', { uri: editor.document.uri.toString() });
  const rules = { columns, trimTrailingSpaces: true, uppercaseKeywords: true, maxLineLength: 132 };
  fs.writeFileSync(target.fsPath, JSON.stringify(rules, null, 2) + '\n');
  await window.showTextDocument(target);
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
