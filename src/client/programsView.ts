import {
  Event,
  EventEmitter,
  MarkdownString,
  ThemeColor,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  workspace,
} from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { openEntryCommand } from './openEntry';
import {
  PROGRAM_PARTS_REQUEST,
  PROGRAM_STATUS_REQUEST,
  ProgramItem,
  ProgramPart,
  PROGRAMS_REQUEST,
  ProgramStatus,
} from '../shared/programs';

type Node =
  | { kind: 'lcn'; name: string; programs: ProgramItem[] }
  | { kind: 'hpm'; name: string; programs: ProgramItem[] }
  | { kind: 'program'; program: ProgramItem; status?: ProgramStatus }
  | { kind: 'part'; uri: string; part: ProgramPart };

export const UNKNOWN_LCN = 'LCN not known';
export const UNKNOWN_LCN_TOOLTIP =
  'Neither the bound point nor any point these files use is in the point database, so their LCN is not known. CL/AM blocks and programs of HPMs missing from the database export end up here.';

const PART_ICON: Record<ProgramPart['kind'], string> = {
  phase: 'symbol-class',
  step: 'symbol-method',
  handler: 'zap',
  subroutine: 'symbol-function',
};

/**
 * Programs grouped by where they run: LCN, then HPM (UCN and node), with each program's phases,
 * handlers and subroutines. Statuses from the listings are fetched for an HPM when it opens.
 */
export class ProgramsView implements TreeDataProvider<Node> {
  private readonly changed = new EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData: Event<Node | undefined> = this.changed.event;
  private programs: Promise<ProgramItem[]> | undefined;

  constructor(private readonly client: LanguageClient) {}

  refresh(): void {
    this.programs = undefined;
    this.changed.fire(undefined);
  }

  private all(): Promise<ProgramItem[]> {
    this.programs ??= this.client.sendRequest<ProgramItem[]>(PROGRAMS_REQUEST);
    return this.programs;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      const all = await this.all();
      const lcns = groupBy(all, (p) => p.lcn ?? '');
      // One LCN, or none known: start at the HPMs.
      if (lcns.size <= 1) return this.hpms(all);
      return [...lcns]
        .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
        .map(([name, programs]) => ({ kind: 'lcn', name: name ? `LCN ${name}` : UNKNOWN_LCN, programs }));
    }
    switch (node.kind) {
      case 'lcn':
        return this.hpms(node.programs);
      case 'hpm': {
        const programs = [...node.programs].sort((a, b) => a.name.localeCompare(b.name));
        const statuses = await this.client
          .sendRequest<ProgramStatus[]>(PROGRAM_STATUS_REQUEST, { uris: programs.map((p) => p.uri) })
          .catch(() => [] as ProgramStatus[]);
        const byUri = new Map(statuses.map((s) => [s.uri, s]));
        return programs.map((program) => ({ kind: 'program', program, status: byUri.get(program.uri) }));
      }
      case 'program': {
        const parts = await this.client.sendRequest<ProgramPart[]>(PROGRAM_PARTS_REQUEST, { uri: node.program.uri, program: node.program.name });
        return parts.map((part) => ({ kind: 'part', uri: node.program.uri, part }));
      }
      case 'part':
        return (node.part.children ?? []).map((part) => ({ kind: 'part', uri: node.uri, part }));
    }
  }

  private hpms(programs: ProgramItem[]): Node[] {
    const byHpm = groupBy(programs, (p) => `${p.hpmOrder}|${p.hpm}`);
    return [...byHpm]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, ps]) => ({ kind: 'hpm', name: key.slice(key.indexOf('|') + 1), programs: ps }));
  }

  getTreeItem(node: Node): TreeItem {
    switch (node.kind) {
      case 'lcn': {
        const item = new TreeItem(node.name, TreeItemCollapsibleState.Collapsed);
        item.iconPath = new ThemeIcon(node.name === UNKNOWN_LCN ? 'question' : 'globe');
        item.description = `${node.programs.length} programs`;
        if (node.name === UNKNOWN_LCN) item.tooltip = UNKNOWN_LCN_TOOLTIP;
        return item;
      }
      case 'hpm': {
        const item = new TreeItem(node.name, TreeItemCollapsibleState.Collapsed);
        item.iconPath = new ThemeIcon('server');
        item.description = `${node.programs.length}`;
        return item;
      }
      case 'program':
        return this.programItem(node.program, node.status);
      case 'part': {
        const p = node.part;
        const item = new TreeItem(p.name, p.children?.length ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);
        item.iconPath = new ThemeIcon(PART_ICON[p.kind]);
        item.description = p.detail ?? p.kind.toUpperCase();
        item.command = openEntryCommand({ uri: node.uri, kind: p.kind, name: p.name, line: p.line, character: p.character });
        return item;
      }
    }
  }

  private programItem(p: ProgramItem, status: ProgramStatus | undefined): TreeItem {
    const item = new TreeItem(p.name, TreeItemCollapsibleState.Collapsed);
    const notes: string[] = [];
    if (p.point && p.point !== p.name) notes.push(`POINT ${p.point}`);
    if (status?.errors) notes.push(`${status.errors} compile error${status.errors === 1 ? '' : 's'}`);
    else if (status?.changed) notes.push('changed since compile');
    item.description = notes.join(' · ');
    item.iconPath = status?.errors
      ? new ThemeIcon('error', new ThemeColor('list.errorForeground'))
      : status?.changed
        ? new ThemeIcon('symbol-module', new ThemeColor('list.warningForeground'))
        : new ThemeIcon('symbol-module');
    const file = workspace.asRelativePath(Uri.parse(p.uri));
    const lines = [`**${p.name}** · ${p.kind === 'block' ? 'BLOCK' : `SEQUENCE${p.dialect ? ` (${p.dialect})` : ''}`}`, '', `Point ${p.point ?? '—'} · ${p.hpm}${p.lcn ? ` (LCN ${p.lcn})` : ''}`, '', `\`${file}\``];
    if (status?.errors) lines.push('', `The .LE beside it lists ${status.errors} error${status.errors === 1 ? '' : 's'} from the last compile.`);
    else if (status?.changed) lines.push('', 'The source differs from its listing: changed since the last compile.');
    else if (status?.noListing) lines.push('', 'No listing beside it.');
    item.tooltip = new MarkdownString(lines.join('\n'));
    item.command = openEntryCommand({ uri: p.uri, kind: p.kind, name: p.name, line: p.line, character: p.character });
    item.contextValue = 'program';
    return item;
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
