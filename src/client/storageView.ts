import { Event, EventEmitter, MarkdownString, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { SHARED_STORAGE_REQUEST, STORAGE_ACCESSES_REQUEST, StorageAccess, StorageSlot } from '../shared/programs';
import { openEntryCommand } from './openEntry';

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
        const who = `${s.programs} sequence${s.programs === 1 ? '' : 's'}${s.writers ? `, ${s.writers} storing` : ', none storing'}`;
        // The tag first: it is how displays and other systems know the element.
        const locals = s.names.filter((n) => n !== s.tag);
        const names = locals.slice(0, 3).join(', ') + (locals.length > 3 ? '…' : '');
        item.description = [s.tag && `🏷 ${s.tag}`, names, who].filter(Boolean).join(' · ');
        if (s.tag) item.iconPath = new ThemeIcon('tag');
        item.tooltip = new MarkdownString(
          [
            `**${s.owner === 'Box' ? `${s.hpm} box` : s.owner} ${s.param}(${s.index})**`,
            s.tag && `Tag **${s.tag}**${s.tagDescriptor ? `: ${s.tagDescriptor}` : ''}, a box ${s.param === 'FL' ? 'Flag' : 'Numeric'} point: displays and other systems can read and write it.`,
            `Used by ${who}.`,
            locals.length ? `LOCAL names: ${locals.join(', ')}` : 'Accessed directly only.',
          ]
            .filter(Boolean)
            .join('\n\n'),
        );
        return item;
      }
      case 'access': {
        const a = node.access;
        const item = new TreeItem(a.program, TreeItemCollapsibleState.None);
        if (a.tag) {
          item.iconPath = new ThemeIcon('tag');
          item.description = ['tag', a.descriptor].filter(Boolean).join(' · ');
        } else {
          item.iconPath = new ThemeIcon(a.writes ? 'edit' : 'eye');
          const counts = [a.writes && `stores ${a.writes}`, a.reads && `reads ${a.reads}`].filter(Boolean).join(', ');
          item.description = `${a.name ?? 'direct'}${counts ? ` · ${counts}` : ''}`;
        }
        // A LOCAL is found by name when clicked; a tag or a direct access opens where it was listed.
        item.command = openEntryCommand({ uri: a.uri, line: a.line, character: a.character, ...(a.name && !a.tag ? { kind: 'local' as const, name: a.name } : {}) });
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
