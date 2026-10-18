import { commands, ExtensionContext, QuickPickItem, QuickPickItemKind, Range, Selection, TextEditorRevealType, Uri, window } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { STORE_USES_REQUEST, StoreUse, StoreUses } from '../shared/programs';

interface Item extends QuickPickItem {
  use?: StoreUse;
}

const count = (uses: StoreUse[]) => {
  const programs = new Set(uses.map((u) => u.uri)).size;
  return `${uses.length} in ${programs} program${programs === 1 ? '' : 's'}`;
};

function items(found: StoreUses): Item[] {
  const row = (u: StoreUse, icon: string): Item => ({
    label: `$(${icon}) ${u.program}`,
    description: [u.name, `line ${u.line + 1}`].filter(Boolean).join(' · '),
    detail: u.text,
    use: u,
  });
  const out: Item[] = [];
  if (found.tag) {
    out.push({ label: 'Tag', kind: QuickPickItemKind.Separator });
    out.push({
      label: `$(tag) ${found.tag.name}`,
      description: 'box point: displays and other systems can store to it',
      detail: found.tag.descriptor,
      use: found.tag,
    });
  }
  out.push({ label: found.stores.length ? `Stores: ${count(found.stores)}` : 'Stores', kind: QuickPickItemKind.Separator });
  if (found.stores.length) out.push(...found.stores.map((u) => row(u, 'edit')));
  else out.push({ label: '$(info) No program in the workspace stores to it' });
  out.push({ label: found.reads.length ? `Reads: ${count(found.reads)}` : 'Reads', kind: QuickPickItemKind.Separator });
  if (found.reads.length) out.push(...found.reads.map((u) => row(u, 'eye')));
  else out.push({ label: '$(info) No program in the workspace reads it' });
  return out;
}

async function show(u: StoreUse, preview: boolean): Promise<void> {
  const range = new Range(u.line, u.character, u.line, u.end);
  const editor = await window.showTextDocument(Uri.parse(u.uri), { preview, preserveFocus: preview, selection: new Selection(range.start, range.end) });
  editor.revealRange(range, TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Who Stores to This: the programs that store to what is under the cursor, then those that read it. */
export function registerWhoStores(context: ExtensionContext, client: LanguageClient): void {
  context.subscriptions.push(
    commands.registerCommand('amcl.whoStores', async () => {
      const editor = window.activeTextEditor;
      if (!editor) return;
      const found = await client.sendRequest<StoreUses | null>(STORE_USES_REQUEST, {
        uri: editor.document.uri.toString(),
        position: editor.selection.active,
      });
      if (!found) {
        void window.showInformationMessage(
          'Put the cursor on a LOCAL mapped onto storage, a storage element such as NN(3) or !BOX.FL(21), a point, or a point parameter such as REACT2.SP.',
        );
        return;
      }
      const pick = window.createQuickPick<Item>();
      pick.title = `Who stores to ${found.title}`;
      pick.placeholder = 'Filter by program, LOCAL or line';
      pick.matchOnDescription = true;
      pick.matchOnDetail = true;
      pick.items = items(found);
      // Moving through the list shows each place; Escape goes back to where the cursor was.
      const back = { document: editor.document, selection: editor.selection, column: editor.viewColumn };
      let accepted = false;
      pick.onDidChangeActive(([item]) => {
        if (item?.use) void show(item.use, true);
      });
      pick.onDidAccept(() => {
        const use = pick.selectedItems[0]?.use;
        if (!use) return;
        accepted = true;
        pick.hide();
        void show(use, false);
      });
      pick.onDidHide(() => {
        pick.dispose();
        if (!accepted) void window.showTextDocument(back.document, { viewColumn: back.column, selection: back.selection });
      });
      pick.show();
    }),
  );
}
