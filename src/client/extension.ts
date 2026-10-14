import * as path from 'path';
import { ExtensionContext, workspace } from 'vscode';
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
  };
}

export async function activate(context: ExtensionContext): Promise<void> {
  const module = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'cl' }],
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
  await client.start();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
