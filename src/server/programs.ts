import { placeMessages } from '../language/listing';
import { FileSummary } from '../language/summary';
import { WorkspaceIndex } from '../language/workspace';
import { ProgramItem, ProgramPart, ProgramStatus, StorageAccess, StorageSlot } from '../shared/programs';
import { compiledSource, ListingFile } from './listings';

/**
 * The LCN and HPM label of a box key (`net/ucn:node`, or `G…` for a group the database does not
 * place). `network` is the LCN of the program's file, for boxes the database does not place.
 */
export function placeBox(box: string | undefined, network?: string): { lcn?: string; hpm: string; hpmOrder: string } {
  const m = box && /^(.*)\/(\d+):(\d+)$/.exec(box);
  const two = (n: string) => n.padStart(2, '0');
  if (m) return { lcn: m[1] || network, hpm: `HPM ${two(m[2])}/${two(m[3])}`, hpmOrder: `0 ${m[2].padStart(4, '0')} ${m[3].padStart(4, '0')}` };
  // Placed together by shared storage, but not in the point database.
  if (box?.startsWith('G')) return { lcn: network, hpm: 'HPM not in the point database', hpmOrder: '1' };
  return { lcn: network, hpm: 'No bound point', hpmOrder: '3' };
}

const folderOf = (uri: string) => decodeURIComponent(uri.replace(/\/[^/]*$/, ''));

/**
 * The LCN of most programs placed in each folder, where one LCN leads: plant units keep their
 * programs in a folder of their own, and a unit is on one LCN.
 */
function folderNetworks(items: { uri: string; lcn?: string }[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const p of items) {
    if (!p.lcn) continue;
    const c = counts.get(folderOf(p.uri)) ?? new Map<string, number>();
    c.set(p.lcn, (c.get(p.lcn) ?? 0) + 1);
    counts.set(folderOf(p.uri), c);
  }
  const out = new Map<string, string>();
  for (const [folder, c] of counts) {
    const [first, second] = [...c].sort((a, b) => b[1] - a[1]);
    if (!second || first[1] > second[1]) out.set(folder, first[0]);
  }
  return out;
}

/** Every program, with the LCN and HPM it runs in, for the CL Programs view. */
export function programItems(index: WorkspaceIndex): ProgramItem[] {
  const items = placedPrograms(index);
  const byFolder = folderNetworks(items);
  for (const p of items) {
    if (p.lcn) continue;
    const lcn = byFolder.get(folderOf(p.uri));
    if (lcn) {
      p.lcn = lcn;
      p.lcnByFolder = folderOf(p.uri).replace(/^.*\//, '');
    }
  }
  return items;
}

function placedPrograms(index: WorkspaceIndex): ProgramItem[] {
  return index.programList().map((p) => {
    // CL/AM blocks run in an Application Module, on the LCN of the points they use, not in an HPM.
    const { lcn, hpm, hpmOrder } = p.kind === 'block' ? { lcn: p.fileNetwork, hpm: 'CL/AM', hpmOrder: '2' } : placeBox(p.box, p.fileNetwork);
    return {
      uri: p.uri,
      name: p.name,
      kind: p.kind,
      point: p.point,
      dialect: p.dialect,
      line: p.range.start.line,
      character: p.range.start.character,
      lcn,
      hpm,
      hpmOrder,
    };
  });
}

/** Phases with their steps, then handlers and subroutines, of the file a program is in. */
export function programParts(summary: FileSummary | undefined, program: string): ProgramPart[] {
  if (!summary) return [];
  const upper = program.toUpperCase();
  const part = (s: FileSummary['symbols'][number]): ProgramPart => ({
    name: s.name,
    kind: s.kind as ProgramPart['kind'],
    detail: s.detail,
    line: s.range.start.line,
    character: s.range.start.character,
  });
  const phases = summary.symbols
    .filter((s) => s.kind === 'phase' && s.container?.toUpperCase() === upper)
    .map((ph) => ({
      ...part(ph),
      children: summary.symbols.filter((s) => s.kind === 'step' && s.container?.toUpperCase() === `${upper} › ${ph.name.toUpperCase()}`).map(part),
    }));
  // Handlers and subroutines belong to the program before them; a CL/AM package can hold several.
  const ownerOf = (line: number) => [...summary.programs].reverse().find((p) => p.nameRange.start.line <= line)?.name.toUpperCase();
  const others = summary.symbols
    .filter((s) => (s.kind === 'handler' || s.kind === 'subroutine') && (summary.programs.length <= 1 || ownerOf(s.range.start.line) === upper))
    .map(part);
  return [...phases, ...others];
}

/** The last compile as the listings beside a source tell it. */
export function programStatus(uri: string, files: ListingFile[], lines: string[] | undefined): ProgramStatus {
  const le = files.find((f) => f.kind === 'LE');
  const errors = le ? (le.listing.errorCount ?? le.listing.messages.filter((m) => m.severity === 1).length) : 0;
  // As Compare with Last Compile sees it: the whole .LS against the file, else the lines an .LE shows.
  const compiled = lines && compiledSource(files, lines);
  const trimmed = (ls: string[]) => {
    const out = ls.map((l) => l.trimEnd());
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  };
  const changed = !!lines && !!compiled && (compiled.whole ? trimmed(compiled.lines) !== trimmed(lines) : files.some((f) => placeMessages(f.listing, lines).stale));
  return { uri, errors, changed, noListing: files.length === 0 };
}

/**
 * Storage elements two programs or more use: box variables, slots of a process module used by
 * other programs, and array point elements. Grouped like programs, by the HPM they are in.
 */
export function sharedStorage(index: WorkspaceIndex): StorageSlot[] {
  // Files placed by their folder, for storage the database does not place.
  const lcnOfFile = new Map(programItems(index).flatMap((p) => (p.lcn ? [[p.uri, p.lcn] as const] : [])));
  const boxOfModule = new Map<string, string | undefined>();
  for (const p of index.programList()) if (p.point && !boxOfModule.has(p.point)) boxOfModule.set(p.point, p.box);
  const pointBox = (name: string) => {
    const rec = index.point(name);
    return (rec && index.boxOfPoint(rec)) ?? boxOfModule.get(name);
  };
  // Copies of a program bound to the same point are one sequence slot, loaded one at a time.
  const slotOf = (uri: string) => index.summaryOf(uri)?.programs[0]?.point ?? uri;
  const out: StorageSlot[] = [];
  for (const [key, entries] of index.storageEntries()) {
    const accesses = entries.filter((e) => e.kind !== 'point');
    const slots = new Set(accesses.map((e) => slotOf(e.uri)));
    const tag = entries.find((e) => e.point)?.point;
    // Shared between sequences, or with whatever reads and writes the tag.
    if (slots.size < (tag ? 1 : 2)) continue;
    const parts = key.split(':');
    const kind = parts[0];
    const index_ = Number(parts[parts.length - 1]);
    const param = parts[parts.length - 2];
    const owner = parts.slice(1, -2).join(':');
    const box = kind === 'BOX' ? owner : pointBox(owner);
    // A box the database does not place: the LCN of the files that use it.
    const network = accesses.map((e) => index.networkOfFile(e.uri)).find(Boolean) ?? accesses.map((e) => lcnOfFile.get(e.uri)).find(Boolean);
    const writers = new Set(accesses.filter((e) => e.written || (e.local?.writes?.length ?? 0) > 0).map((e) => slotOf(e.uri)));
    const names = [...new Set([...accesses.flatMap((e) => (e.local ? [e.local.name] : [])), ...entries.flatMap((e) => (e.point ? [e.point.name] : []))])];
    out.push({
      key,
      ...placeBox(box, network),
      ownerKind: kind === 'BOX' ? 'box' : kind === 'ARR' ? 'array' : 'module',
      owner: kind === 'BOX' ? 'Box' : owner,
      param,
      index: index_,
      names,
      programs: slots.size,
      writers: writers.size,
      tag: tag?.name,
      tagDescriptor: tag?.fields.PTDESC?.trim() || undefined,
    });
  }
  return out;
}

/** Each program's accesses to one storage element: through which LOCAL, how often it stores and reads. */
export function storageAccesses(index: WorkspaceIndex, key: string): StorageAccess[] {
  const out = new Map<string, StorageAccess>();
  const tags: StorageAccess[] = [];
  for (const e of index.storageEntries().get(key) ?? []) {
    if (e.kind === 'point') {
      if (e.point) {
        tags.push({ program: e.point.name, uri: e.uri, line: e.range.start.line, character: e.range.start.character, writes: 0, reads: 0, tag: true, descriptor: e.point.fields.PTDESC?.trim() || undefined });
      }
      continue;
    }
    // The file name: copies of one program differ only in it.
    const program = decodeURIComponent(e.uri.replace(/^.*\//, '')).replace(/\.cl$/i, '');
    const name = e.local?.name;
    const id = `${e.uri}|${name ?? ''}`;
    const at = e.local ? e.local.decl.start : e.range.start;
    const writes = e.local ? (e.local.writes?.length ?? 0) : e.written ? 1 : 0;
    // A LOCAL's references include its declaration.
    const reads = e.local ? Math.max(0, e.local.refs.length - 1 - writes) : e.written ? 0 : 1;
    const a = out.get(id);
    if (a) {
      a.writes += writes;
      a.reads += reads;
    } else out.set(id, { program, uri: e.uri, name, line: at.line, character: at.character, writes, reads });
  }
  return [...tags, ...[...out.values()].sort((a, b) => b.writes - a.writes || a.program.localeCompare(b.program))];
}
