import { commands, ExtensionContext, Position, Range, Uri, window } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { LOCATE_REQUEST, LocateParams } from '../shared/programs';

export interface OpenEntryArgs extends Partial<LocateParams> {
  uri: string;
  line: number;
  character: number;
}

/** The command a view entry runs: open its file where the entry is now, found by name. */
export function openEntryCommand(args: OpenEntryArgs) {
  return { command: 'amcl.openEntry', title: 'Open', arguments: [args] };
}

export function registerOpenEntry(context: ExtensionContext, client: LanguageClient): void {
  context.subscriptions.push(
    commands.registerCommand('amcl.openEntry', async (args: OpenEntryArgs) => {
      let at = new Position(args.line, args.character);
      if (args.kind && args.name) {
        // The view's line may predate edits; the server knows where the entry is now.
        const now = await client
          .sendRequest<{ line: number; character: number } | null>(LOCATE_REQUEST, { uri: args.uri, kind: args.kind, name: args.name })
          .catch(() => null);
        if (now) at = new Position(now.line, now.character);
      }
      await window.showTextDocument(Uri.parse(args.uri), { selection: new Range(at, at) });
    }),
  );
}
