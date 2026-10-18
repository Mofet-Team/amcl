import { Event, EventEmitter, MarkdownString, Position, Range, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { SHARED_STORAGE_REQUEST, STORAGE_ACCESSES_REQUEST, StorageAccess, StorageSlot } from '../shared/programs';

type Node =
  | { kind: 'lcn'; name: string; slots: StorageSlot[] }
  | { kind: 'hpm'; name: string; slots: StorageSlot[] }
  | { kind: 'owner'; name: string; slots: StorageSlot[] }
  | { kind: 'slot'; slot: StorageSlot }
  | { kind: 'access'; access: StorageAccess };

const PARAM_WORD: Record<string, string> = { NN: 'numerics', FL: 'flags', TIME: 'times' };

/**
 * Storage two sequences or more use, by HPM and owner: box variables, a sequence's slots used by
 * others, array elements. Each element lists the programs that store to it and read it.
 */
export class StorageView implements TreeDataProvider<Node> {
  private readonly changed = new EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData: Event<Node | undefined> = this.changed.event;
  private slots: Promise<StorageSlot[]> | undefined;

  constructor(private readonly client: LanguageClient) {}

  refresh(): void {
    this.slots = undefined;
    this.changed.fire(undefined);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      this.slots ??= this.client.sendRequest<StorageSlot[]>(SHARED_STORAGE_REQUEST);
      const all = await this.slots;
      const lcns = groupBy(all, (s) => s.lcn ?? '');
      if (lcns.size <= 1) return this.hpms(all);
      return [...lcns]
        .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
        .map(([name, slots]) => ({ kind: 'lcn', name: name ? `LCN ${name}` : 'Other', slots }));
    }
    switch (node.kind) {
      case 'lcn':
        return this.hpms(node.slots);
      case 'hpm': {
        // Box variables by type first, then each sequence's slots, then arrays.
        const order = (s: StorageSlot) => (s.ownerKind === 'box' ? `0 ${s.param}` : s.ownerKind === 'module' ? `1 ${s.owner}` : `2 ${s.owner}`);
        const label = (s: StorageSlot) =>
          s.ownerKind === 'box'
            ? `Box ${PARAM_WORD[s.param] ?? (s.param.startsWith('STR') ? 'strings' : s.param)}`
            : s.ownerKind === 'module'
              ? `${s.owner} slots`
              : `Array ${s.owner}`;
        const groups = groupBy(node.slots, (s) => `${order(s)}|${label(s)}`);
        return [...groups]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, slots]) => ({ kind: 'owner', name: k.slice(k.indexOf('|') + 1), slots }));
      }
      case 'owner':
        return [...node.slots].sort((a, b) => a.param.localeCompare(b.param) || a.index - b.index).map((slot) => ({ kind: 'slot', slot }));
      case 'slot': {
        const accesses = await this.client.sendRequest<StorageAccess[]>(STORAGE_ACCESSES_REQUEST, { key: node.slot.key });
        return accesses.map((access) => ({ kind: 'access', access }));
      }
      case 'access':
        return [];
    }
  }

  private hpms(slots: StorageSlot[]): Node[] {
    const byHpm = groupBy(slots, (s) => `${s.hpmOrder}|${s.hpm}`);
    return [...byHpm].sort(([a], [b]) => a.localeCompare(b)).map(([k, ss]) => ({ kind: 'hpm', name: k.slice(k.indexOf('|') + 1), slots: ss }));
  }

  getTreeItem(node: Node): TreeItem {
    switch (node.kind) {
      case 'lcn':
      case 'hpm':
      case 'owner': {
        const item = new TreeItem(node.name, TreeItemCollapsibleState.Collapsed);
        item.iconPath = new ThemeIcon(node.kind === 'lcn' ? 'globe' : node.kind === 'hpm' ? 'server' : node.name.startsWith('Box') ? 'database' : 'symbol-module');
        item.description = `${node.slots.length}`;
        return item;
      }
      case 'slot': {
        const s = node.slot;
        const item = new TreeItem(`${s.param}(${s.index})`, TreeItemCollapsibleState.Collapsed);
        item.iconPath = new ThemeIcon('symbol-field');
        const who = `${s.programs} sequences${s.writers ? `, ${s.writers} storing` : ', none storing'}`;
        item.description = [s.names.slice(0, 3).join(', ') + (s.names.length > 3 ? '…' : ''), who].filter(Boolean).join(' · ');
        item.tooltip = new MarkdownString(
          [`**${s.owner === 'Box' ? `${s.hpm} box` : s.owner} ${s.param}(${s.index})**`, '', `Used by ${who}.`, '', s.names.length ? `Names: ${s.names.join(', ')}` : 'Accessed directly only.'].join('\n'),
        );
        return item;
      }
      case 'access': {
        const a = node.access;
        const item = new TreeItem(a.program, TreeItemCollapsibleState.None);
        item.iconPath = new ThemeIcon(a.writes ? 'edit' : 'eye');
        const counts = [a.writes && `stores ${a.writes}`, a.reads && `reads ${a.reads}`].filter(Boolean).join(', ');
        item.description = `${a.name ?? 'direct'}${counts ? ` · ${counts}` : ''}`;
        const at = new Position(a.line, a.character);
        item.command = { command: 'vscode.open', title: 'Open', arguments: [Uri.parse(a.uri), { selection: new Range(at, at) }] };
        return item;
      }
    }
  }
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    const list = out.get(k);
    if (list) list.push(i);
    else out.set(k, [i]);
  }
  return out;
}
