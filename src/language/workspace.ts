import { fieldNumber, ioOf, PointRecord } from './eb';
import { NetworkConfig } from './ncf';
import { FileSummary, StorageUse } from './summary';
import { Range } from './types';

export interface Location {
  uri: string;
  range: Range;
}

/** A point database record located in an .EB file. */
export interface PointLocation extends Location {
  point: PointRecord;
}

export interface StorageEntry extends Location {
  kind: 'local' | 'use' | 'point';
  /** For `local`: the local's name, its declaration, its references in that file and the stores among them. */
  local?: { name: string; decl: Range; refs: Range[]; writes?: Range[] };
  /** For `use`: the access stores. */
  written?: boolean;
  /** For `point`: the box Numeric or Flag point. */
  point?: PointRecord;
}

interface Derived {
  /** Bound point name -> programs (SEQUENCE/BLOCK headings) bound to it. */
  programs: Map<string, { uri: string; name: string; range: Range; kind: string }[]>;
  /** Point name -> every reference in the workspace. */
  pointRefs: Map<string, { uri: string; range: Range; isDeclaration: boolean }[]>;
  /** Storage key -> accesses. */
  storage: Map<string, StorageEntry[]>;
  hpm: UnionFind;
  /** Inferred HPM group root -> box, when any member of the group is in the point database. */
  groupBox: Map<string, string>;
  /** Point database type -> parameter -> number of uses in the workspace. */
  parameterUse: Map<string, Map<string, number>>;
  /** `box|!DI16S06` -> the points built on or wired to that I/O channel. */
  hardware: Map<string, HardwareUse[]>;
  /** Point database folder -> the LCN its points are on. */
  networkOfFolder: Map<string, string>;
  /** CL file -> the LCN of the points it references. */
  networkOfFile: Map<string, string>;
  /** CL file -> its place among the files, which orders the entries of each table. */
  order: Map<string, number>;
}

/** A point connected to an I/O channel. */
export interface HardwareUse {
  point: PointRecord;
  /** `channel`: the point is built on it (AI, AO, DI, DO). `input`/`output`: it is wired to it. */
  role: 'channel' | 'input' | 'output';
  /** The parameter it uses on the channel, such as PVFL or SO. */
  param?: string;
  box: string;
}

/** `!DI16S06`: an I/O channel by card and channel number. */
export const HARDWARE_NAME = /^!(AI|AO|DI|DO)(\d{2})S(\d{2})$/i;

/**
 * Cross-file knowledge: which program each point is bound to, who references a point, and who
 * reads or writes each storage location (bound-point slots, box variables, Array elements).
 *
 * Box identity: `!BOX` means the box of the HPM the program runs in. The HPM comes from the
 * point database (NTWKNUM/NODENUM of the bound point). Without one, it is inferred: a LOCAL may
 * only be mapped onto another Process Module point of the same HPM [HP27-610 §2.6.2], so such
 * mappings put two programs in the same HPM.
 */
export class WorkspaceIndex {
  private readonly files = new Map<string, FileSummary>();
  private readonly points = new Map<string, PointRecord>();
  private readonly pointUris = new Map<PointRecord, string>();
  private networks: NetworkConfig[] = [];
  private derived: Derived | undefined;
  /** Point database folder -> the UCN numbers of its points. */
  private folderUcns = new Map<string, Set<number>>();
  /** Tables of the point database alone, for one placement of its folders on LCNs. */
  private pointTables: { networks: string; hardware: Derived['hardware']; boxPoints: [string, StorageEntry][] } | undefined;

  setFile(uri: string, summary: FileSummary): void {
    const old = this.files.get(uri);
    this.files.set(uri, summary);
    // Typing rarely changes what places programs and points; then only this file's entries change.
    if (this.derived && old && this.topology(old) === this.topology(summary)) this.patch(uri, old, summary, this.derived);
    else this.derived = undefined;
  }

  deleteFile(uri: string): void {
    if (this.files.delete(uri)) this.derived = undefined;
  }

  hasFile(uri: string): boolean {
    return this.files.has(uri);
  }

  get fileCount(): number {
    return this.files.size;
  }

  get pointCount(): number {
    return this.points.size;
  }

  /** Replace the point database. `uriOf` maps an .EB path to a document URI. */
  setPoints(records: PointRecord[], uriOf: (file: string) => string): void {
    this.points.clear();
    this.pointUris.clear();
    for (const r of records) {
      // A point may be exported more than once; keep the first.
      if (this.points.has(r.name)) continue;
      this.points.set(r.name, r);
      this.pointUris.set(r, uriOf(r.file));
    }
    this.folderUcns = new Map();
    for (const p of this.points.values()) {
      const ucns = this.folderUcns.get(folderOf(p.file)) ?? this.folderUcns.set(folderOf(p.file), new Set()).get(folderOf(p.file))!;
      const ucn = fieldNumber(p, 'NTWKNUM');
      if (ucn !== undefined) ucns.add(ucn);
    }
    this.pointTables = undefined;
    this.derived = undefined;
  }

  /** LCN definitions from network configuration files, used to name LCNs. */
  setNetworks(networks: NetworkConfig[]): void {
    this.networks = networks;
    this.derived = undefined;
  }

  /**
   * The LCN a point is on: a name from the network configuration, `#1`, `#2`... without one, or
   * undefined when the workspace has a single LCN.
   */
  networkOf(p: PointRecord): string | undefined {
    return this.get().networkOfFolder.get(folderOf(p.file)) || undefined;
  }

  /** `net/ucn:node` of the HPM (or other UCN node) a point is in. */
  boxOfPoint(p: PointRecord): string | undefined {
    return this.boxKey(p, this.get());
  }

  point(name: string): PointRecord | undefined {
    return this.points.get(name.toUpperCase());
  }

  pointLocation(name: string): PointLocation | undefined {
    const p = this.point(name);
    if (!p) return undefined;
    const line = p.line;
    return { uri: this.pointUris.get(p)!, range: { start: { line, character: 3 }, end: { line, character: 3 + p.name.length } }, point: p };
  }

  // ---------------------------------------------------------------- queries

  /** Programs bound to a point, plus the point's database record. */
  pointDefinitions(name: string): Location[] {
    const d = this.get();
    const out: Location[] = (d.programs.get(name) ?? []).map(({ uri, range }) => ({ uri, range }));
    const db = this.pointLocation(name);
    if (db) out.push({ uri: db.uri, range: db.range });
    return out;
  }

  /** How often each parameter is used on points of a database type, across the workspace. */
  parameterUse(type: string): Map<string, number> {
    return this.get().parameterUse.get(type) ?? new Map();
  }

  /** Box (`ucn:node`) of the HPM a program's bound point is in, if known. */
  boxOfProgram(boundPoint: string): string | undefined {
    const box = this.boxOfBound(boundPoint.toUpperCase(), this.get());
    return box.startsWith('G') ? undefined : box;
  }

  /**
   * Points built on or wired to an I/O channel such as `!DI16S06`. Hardware names are relative to
   * an HPM; without `box`, matches in every HPM are returned.
   */
  hardwareUses(address: string, box?: string): HardwareUse[] {
    const upper = address.toUpperCase();
    const d = this.get();
    if (box) return d.hardware.get(`${box}|${upper}`) ?? [];
    return [...d.hardware].filter(([k]) => k.endsWith(`|${upper}`)).flatMap(([, v]) => v);
  }

  /** SEQUENCEs and BLOCKs bound to a point. */
  programsFor(name: string): { uri: string; name: string; range: Range; kind: string }[] {
    return this.get().programs.get(name.toUpperCase()) ?? [];
  }

  /** LOCALs mapped onto a storage key, with their names. */
  storageLocals(key: string): { uri: string; name: string; range: Range }[] {
    return (this.get().storage.get(key) ?? [])
      .filter((e) => e.kind === 'local')
      .map((e) => ({ uri: e.uri, name: e.local!.name, range: e.local!.decl }));
  }

  /** The database point (box Numeric or Flag) that names a storage key, if any. */
  storagePoint(key: string): PointRecord | undefined {
    return (this.get().storage.get(key) ?? []).find((x) => x.kind === 'point')?.point;
  }

  /** Every reference to a point in the workspace. */
  pointReferences(name: string, includeDeclaration: boolean): Location[] {
    const out = (this.get().pointRefs.get(name) ?? [])
      .filter((r) => includeDeclaration || !r.isDeclaration)
      .map(({ uri, range }) => ({ uri, range }));
    if (includeDeclaration) out.push(...this.pointDefinitions(name));
    return dedupe(out);
  }

  /** The storage key of a use in the given file, if it can be resolved. */
  storageKey(use: StorageUse, file?: FileSummary): string | undefined {
    const d = this.get();
    return this.resolve(use, d, file && this.networkOfSummary(file, d));
  }

  /** LOCALs mapped onto a storage key anywhere in the workspace, and the database point at it. */
  storageDefinitions(key: string): Location[] {
    return (this.get().storage.get(key) ?? [])
      .filter((e) => e.kind !== 'use')
      .map((e) => ({ uri: e.uri, range: e.kind === 'local' ? e.local!.decl : e.range }));
  }

  /**
   * Every access to a storage key: each LOCAL mapped onto it with all its references, direct
   * accesses such as `!BOX.FL(21)`, and the database point.
   */
  storageReferences(key: string, includeDeclaration: boolean): Location[] {
    const out: Location[] = [];
    for (const e of this.get().storage.get(key) ?? []) {
      if (e.kind === 'local') {
        const decl = e.local!.decl;
        const isDecl = (r: Range) => r.start.line === decl.start.line && r.start.character === decl.start.character;
        out.push(...e.local!.refs.filter((r) => includeDeclaration || !isDecl(r)).map((range) => ({ uri: e.uri, range })));
        if (includeDeclaration) out.push({ uri: e.uri, range: e.range });
      } else if (e.kind === 'use' || includeDeclaration) {
        out.push({ uri: e.uri, range: e.range });
      }
    }
    return dedupe(out);
  }

  /** A readable description of a storage key, e.g. `box 5:15 FL(21)`. */
  describeKey(key: string): string {
    const [kind, ...rest] = key.split(':');
    const [param, index] = rest.slice(-2);
    const owner = rest.slice(0, -2).join(':');
    const what = `${param}(${index})`;
    switch (kind) {
      case 'BOX':
        return `${formatBox(owner)} box ${what}`;
      case 'PM':
        return `${owner}.${what}`;
      case 'ARR':
        return `array ${owner}.${what}`;
      default:
        return `${owner}.${what}`;
    }
  }

  /**
   * Every SEQUENCE and BLOCK, with the box of its bound point (`net/ucn:node`, `G…` for an
   * inferred group) and the LCN of the points its file references, which places programs whose
   * bound point the database lacks, such as CL/AM blocks.
   */
  programList(): { uri: string; name: string; kind: 'sequence' | 'block'; point?: string; dialect?: string; range: Range; box?: string; fileNetwork?: string }[] {
    const d = this.get();
    const out: ReturnType<WorkspaceIndex['programList']> = [];
    for (const [uri, s] of this.files) {
      for (const p of s.programs) {
        out.push({
          uri,
          name: p.name,
          kind: p.kind,
          point: p.point,
          dialect: p.dialect,
          range: p.nameRange,
          box: p.point ? this.boxOfBound(p.point, d) : undefined,
          fileNetwork: d.networkOfFile.get(uri) || undefined,
        });
      }
    }
    return out;
  }

  /** The LCN of the points a file references, when the workspace has several LCNs. */
  networkOfFile(uri: string): string | undefined {
    return this.get().networkOfFile.get(uri) || undefined;
  }

  /** Every storage key, with each LOCAL, direct access and database point at it. */
  storageEntries(): Map<string, readonly Readonly<StorageEntry>[]> {
    return this.get().storage;
  }

  /** Number of SEQUENCEs and BLOCKs, without deriving the cross-file tables. */
  programCount(): number {
    let n = 0;
    for (const s of this.files.values()) n += s.programs.length;
    return n;
  }

  /** Every `point.PARAM` access of a point in the workspace; of one parameter when `param` is given. */
  memberUses(point: string, param?: string): (Location & { param: string; written?: boolean })[] {
    const name = point.toUpperCase();
    const out: (Location & { param: string; written?: boolean })[] = [];
    for (const [uri, s] of this.files) {
      for (const m of s.memberRefs ?? []) {
        if (m.point === name && (!param || m.param === param)) out.push({ uri, range: m.range, param: m.param, written: m.written });
      }
    }
    return out;
  }

  summaryOf(uri: string): FileSummary | undefined {
    return this.files.get(uri);
  }

  symbols(): { uri: string; summary: FileSummary }[] {
    return [...this.files].map(([uri, summary]) => ({ uri, summary }));
  }

  allPoints(): PointRecord[] {
    return [...this.points.values()];
  }

  // ---------------------------------------------------------------- derivation

  private get(): Derived {
    if (this.derived) return this.derived;
    const programs: Derived['programs'] = new Map();
    const pointRefs: Derived['pointRefs'] = new Map();
    const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
      const l = m.get(k);
      if (l) l.push(v);
      else m.set(k, [v]);
    };

    for (const [uri, s] of this.files) {
      for (const p of s.programs) if (p.point) push(programs, p.point, { uri, name: p.name, range: p.nameRange, kind: p.kind });
      for (const r of s.pointRefs) push(pointRefs, r.name, { uri, range: r.range, isDeclaration: r.isDeclaration });
    }
    const networkOfFolder = this.inferNetworks();

    const hpm = new UnionFind();
    for (const s of this.files.values()) {
      for (const u of s.storage) {
        if (u.local && u.bound && u.point && this.isProcessModule(u.point, programs)) hpm.union(u.bound, u.point);
      }
    }

    const partial = { networkOfFolder } as Derived;
    const groupBox = new Map<string, string>();
    for (const member of hpm.keys()) {
      const rec = this.points.get(member);
      const box = rec && this.boxKey(rec, partial);
      if (box && !groupBox.has(hpm.find(member))) groupBox.set(hpm.find(member), box);
    }

    const storage: Derived['storage'] = new Map();
    const parameterUse: Derived['parameterUse'] = new Map();
    for (const s of this.files.values()) this.countMembers(s, parameterUse, 1);
    const tables = this.tablesOfPoints(partial);
    const hardware = tables.hardware;
    const order = new Map([...this.files.keys()].map((uri, i) => [uri, i]));
    const derived: Derived = { programs, pointRefs, storage, hpm, groupBox, parameterUse, hardware, networkOfFolder, networkOfFile: new Map(), order };
    for (const [uri, s] of this.files) {
      const net = this.networkOfSummary(s, derived);
      if (net) derived.networkOfFile.set(uri, net);
      for (const u of s.storage) {
        const key = this.resolve(u, derived, net);
        if (key) push(storage, key, { uri, range: u.range, kind: u.local ? 'local' : 'use', local: u.local, written: u.written });
      }
    }
    for (const [key, entry] of tables.boxPoints) push(storage, key, entry);
    this.derived = derived;
    return derived;
  }

  /**
   * I/O channels and box Numeric and Flag points, which depend on the point database and on which
   * LCN each of its folders is on, not on the CL files: kept while that placement stays.
   */
  private tablesOfPoints(d: Pick<Derived, 'networkOfFolder'>): NonNullable<WorkspaceIndex['pointTables']> {
    const networks = JSON.stringify([...d.networkOfFolder]);
    if (this.pointTables?.networks === networks) return this.pointTables;
    const hardware: Derived['hardware'] = new Map();
    const push = (k: string, v: HardwareUse) => (hardware.get(k) ?? hardware.set(k, []).get(k)!).push(v);
    for (const p of this.points.values()) {
      const io = ioOf(p);
      const box = this.boxKey(p, d);
      if (!io || !box) continue;
      if (io.channel) push(`${box}|${io.channel.address}`, { point: p, role: 'channel', box });
      for (const [role, refs] of [['input', io.inputs], ['output', io.outputs]] as const) {
        for (const ref of refs) {
          const [address, param] = ref.toUpperCase().split('.');
          if (HARDWARE_NAME.test(address)) push(`${box}|${address}`, { point: p, role, param, box });
        }
      }
    }
    // Box Numeric and Flag points are named views of one box element.
    const boxPoints: [string, StorageEntry][] = [];
    for (const p of this.points.values()) {
      if (p.type !== 'NUMERNIM' && p.type !== 'FLAGNIM') continue;
      const box = this.boxKey(p, d);
      const slot = fieldNumber(p, 'SLOTNUM');
      const loc = this.pointLocation(p.name);
      if (box && slot !== undefined && loc) {
        boxPoints.push([`BOX:${box}:${p.type === 'NUMERNIM' ? 'NN' : 'FL'}:${slot}`, { uri: loc.uri, range: loc.range, kind: 'point', point: p }]);
      }
    }
    this.pointTables = { networks, hardware, boxPoints };
    return this.pointTables;
  }

  /**
   * What of a file the derived tables depend on beyond its own entries: its programs and bound
   * points, the LOCALs that put two programs in one HPM, and the database folders of the points it
   * names, which place it and them on an LCN.
   */
  private topology(s: FileSummary): string {
    const folders = new Set<string>();
    let first: string | undefined;
    for (const n of [...s.programs.flatMap((p) => (p.point ? [p.point] : [])), ...s.pointRefs.map((r) => r.name)]) {
      const rec = this.points.get(n);
      if (!rec || n.startsWith('$')) continue;
      const f = folderOf(rec.file);
      first ??= f;
      folders.add(f);
    }
    return JSON.stringify([
      s.programs.map((p) => [p.kind, p.point]),
      s.storage.filter((u) => u.local && u.bound && u.point).map((u) => [u.bound, u.point]),
      first,
      [...folders].sort(),
    ]);
  }

  /** Replace one file's entries in the tables, where a full derivation would put them. */
  private patch(uri: string, old: FileSummary, next: FileSummary, d: Derived): void {
    const at = d.order.get(uri)!;
    const replace = <V extends { uri: string }>(m: Map<string, V[]>, before: [string, V][], after: [string, V][], ours = (_: V) => true) => {
      const fresh = new Map<string, V[]>();
      for (const [k] of before) fresh.set(k, []);
      for (const [k, v] of after) (fresh.get(k) ?? fresh.set(k, []).get(k)!).push(v);
      for (const [k, added] of fresh) {
        const kept = (m.get(k) ?? []).filter((v) => !(ours(v) && v.uri === uri));
        // Entries go in file order, and entries of no file (database points) after them.
        let i = kept.findIndex((v) => !ours(v) || (d.order.get(v.uri) ?? Infinity) > at);
        if (i < 0) i = kept.length;
        kept.splice(i, 0, ...added);
        if (kept.length) m.set(k, kept);
        else m.delete(k);
      }
    };
    const programs = (s: FileSummary) =>
      s.programs.flatMap((p) => (p.point ? [[p.point, { uri, name: p.name, range: p.nameRange, kind: p.kind }] as [string, { uri: string; name: string; range: Range; kind: string }]] : []));
    replace(d.programs, programs(old), programs(next));
    const refs = (s: FileSummary) => s.pointRefs.map((r) => [r.name, { uri, range: r.range, isDeclaration: r.isDeclaration }] as [string, { uri: string; range: Range; isDeclaration: boolean }]);
    replace(d.pointRefs, refs(old), refs(next));
    const net = d.networkOfFile.get(uri);
    const storage = (s: FileSummary) =>
      s.storage.flatMap((u) => {
        const key = this.resolve(u, d, net);
        return key ? [[key, { uri, range: u.range, kind: u.local ? 'local' : 'use', local: u.local, written: u.written } as StorageEntry] as [string, StorageEntry]] : [];
      });
    replace(d.storage, storage(old), storage(next), (e) => e.kind !== 'point');
    this.countMembers(old, d.parameterUse, -1);
    this.countMembers(next, d.parameterUse, 1);
  }

  /** Add (`sign` 1) or take away (-1) a file's parameter uses. */
  private countMembers(s: FileSummary, parameterUse: Derived['parameterUse'], sign: 1 | -1): void {
    for (const m of s.members) {
      const type = this.points.get(m.point)?.type ?? (/^(!BOX|\$NM\d+[NB]\d+)$/.test(m.point) ? 'PM_BOX' : undefined);
      if (!type) continue;
      const counts = parameterUse.get(type) ?? new Map<string, number>();
      const n = (counts.get(m.param) ?? 0) + sign * m.count;
      if (n) counts.set(m.param, n);
      else counts.delete(m.param);
      if (counts.size) parameterUse.set(type, counts);
      else parameterUse.delete(type);
    }
  }

  private isProcessModule(name: string, programs: Derived['programs']): boolean {
    const rec = this.points.get(name);
    if (rec) return rec.type === 'PRMODNIM';
    return programs.get(name)?.some((p) => p.kind === 'sequence') ?? false;
  }

  /**
   * Which LCN each point database folder is on. A CL program can only name points on its own
   * LCN (other LCNs are reached as `net\tag`), so the folders of the points one file references
   * are on one LCN. Groups are named from network configuration files by their UCN numbers,
   * else numbered.
   */
  private inferNetworks(): Map<string, string> {
    const groups = new UnionFind();
    for (const f of this.folderUcns.keys()) groups.union(f, f);
    for (const s of this.files.values()) {
      let first: string | undefined;
      const names = [...s.pointRefs.map((r) => r.name), ...s.programs.flatMap((p) => (p.point ? [p.point] : []))];
      for (const n of names) {
        const rec = this.points.get(n);
        if (!rec || n.startsWith('$')) continue;
        const f = folderOf(rec.file);
        if (first === undefined) first = f;
        else groups.union(first, f);
      }
    }
    const members = new Map<string, string[]>();
    for (const f of groups.keys()) {
      const root = groups.find(f);
      members.set(root, [...(members.get(root) ?? []), f]);
    }
    const ucnsOf = new Map<string, Set<number>>();
    for (const [f, ucns] of this.folderUcns) {
      if (!ucns.size) continue;
      const root = groups.find(f);
      const all = ucnsOf.get(root) ?? ucnsOf.set(root, new Set()).get(root)!;
      for (const u of ucns) all.add(u);
    }
    const out = new Map<string, string>();
    const roots = [...members.keys()].sort();
    roots.forEach((root, i) => {
      const ucns = [...(ucnsOf.get(root) ?? [])];
      const named = this.networks.filter((n) => ucns.length && ucns.every((u) => n.ucns.has(u)));
      // With a single LCN there is nothing to tell apart, so it gets no label.
      const name = named.length === 1 ? named[0].name : roots.length === 1 ? '' : `#${i + 1}`;
      for (const f of members.get(root)!) out.set(f, name);
    });
    return out;
  }

  /** The LCN of the database points a file references, if any. */
  private networkOfSummary(s: FileSummary, d: Derived): string | undefined {
    for (const name of [...s.programs.flatMap((p) => (p.point ? [p.point] : [])), ...s.pointRefs.map((r) => r.name)]) {
      const rec = this.points.get(name);
      if (rec && !name.startsWith('$')) return d.networkOfFolder.get(folderOf(rec.file));
    }
    return undefined;
  }

  /** `net/ucn:node` from a point's NTWKNUM and NODENUM and the LCN of its database folder. */
  private boxKey(p: PointRecord, d: Pick<Derived, 'networkOfFolder'>): string | undefined {
    const ucn = fieldNumber(p, 'NTWKNUM');
    const node = fieldNumber(p, 'NODENUM');
    if (ucn === undefined || node === undefined) return undefined;
    return `${d.networkOfFolder.get(folderOf(p.file)) ?? ''}/${ucn}:${node}`;
  }

  /** Box of the HPM a bound point lives in: from the database, else from the inferred group. */
  private boxOfBound(bound: string, d: Derived): string {
    const direct = this.points.get(bound);
    const db = direct && this.boxKey(direct, d);
    if (db) return db;
    const root = d.hpm.find(bound);
    return d.groupBox.get(root) ?? `G${root}`;
  }

  /** `fileNet`: the LCN of the file the use is in, for `$NMxxNyy` when its program is unknown. */
  private resolve(u: StorageUse, d: Derived, fileNet?: string): string | undefined {
    const param = u.param;
    if (param === 'PV' || param === 'PVFL') {
      // Only box Numeric and Flag points are storage; PV of anything else is a process value.
      const rec = u.point ? this.points.get(u.point) : undefined;
      if (!rec || (rec.type !== 'NUMERNIM' && rec.type !== 'FLAGNIM')) return undefined;
      const box = this.boxKey(rec, d);
      const slot = fieldNumber(rec, 'SLOTNUM');
      return box && slot !== undefined ? `BOX:${box}:${rec.type === 'NUMERNIM' ? 'NN' : 'FL'}:${slot}` : undefined;
    }
    if (u.index === undefined) return undefined;
    const slot = `${param}:${u.index}`;
    if (!u.point) return u.bound ? `PM:${u.bound}:${slot}` : undefined;
    if (u.point === '!BOX') return u.bound ? `BOX:${this.boxOfBound(u.bound, d)}:${slot}` : undefined;
    const sys = /^\$NM(\d+)[NB](\d+)$/.exec(u.point);
    if (sys) {
      // The UCN number is only unique within an LCN: use the program's.
      const own = u.bound ? this.points.get(u.bound) : undefined;
      const net = (own && d.networkOfFolder.get(folderOf(own.file))) ?? fileNet ?? '';
      return `BOX:${net}/${Number(sys[1])}:${Number(sys[2])}:${slot}`;
    }
    if (u.point.startsWith('!') || u.point.startsWith('$')) return undefined;

    const rec = this.points.get(u.point);
    if (rec?.type === 'ARRAY') {
      // An Array point with no external data is a window onto box variables starting at xxSTIX.
      const stix = fieldNumber(rec, `${param === 'NN' ? 'NN' : param === 'FL' ? 'FL' : param === 'TIME' ? 'TIME' : 'STR'}STIX`);
      const ext = rec.fields.EXTDATA;
      const box = this.boxKey(rec, d);
      if ((!ext || ext === 'NONE') && stix && stix > 0 && box) return `BOX:${box}:${param}:${stix + u.index - 1}`;
      return `ARR:${u.point}:${slot}`;
    }
    return `PM:${u.point}:${slot}`;
  }
}

const folders = new Map<string, string>();

/** The folder of a point database file: the unit of LCN membership. */
function folderOf(file: string): string {
  let f = folders.get(file);
  if (f === undefined) folders.set(file, (f = file.replace(/[\\/][^\\/]*$/, '')));
  return f;
}

/** A box key for people: `HPM 01/09 (LCN A)`, or an inferred group. */
export function formatBox(box: string): string {
  if (box.startsWith('G')) return `HPM group ${box.slice(1)}`;
  const m = /^(.*)\/(\d+):(\d+)$/.exec(box);
  if (!m) return box;
  const two = (n: string) => n.padStart(2, '0');
  return `HPM ${two(m[2])}/${two(m[3])}${m[1] ? ` (LCN ${m[1]})` : ''}`;
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(x: string): string {
    let root = x;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression.
    while (x !== root && this.parent.has(x)) {
      const next = this.parent.get(x)!;
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    for (const x of [a, b]) if (!this.parent.has(x)) this.parent.set(x, x);
    const ra = this.find(a);
    const rb = this.find(b);
    // The smaller name becomes the root, so group names are stable.
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }

  keys(): IterableIterator<string> {
    return this.parent.keys();
  }
}

function dedupe(locs: Location[]): Location[] {
  const seen = new Set<string>();
  return locs.filter((l) => {
    const k = `${l.uri}#${l.range.start.line}:${l.range.start.character}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
