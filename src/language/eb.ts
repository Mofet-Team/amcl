// Reader for Exception Build (.EB) files: the text form of the TPS point database that DEB
// exports and imports. Each entity looks like:
//
//   {IDF NET>AREA1>PM15SEQ.DB, ENTITY REACT1( )                 }
//   &T PRMODNIM
//   &N REACT1
//   NODETYP  = HPM
//   PTDESC   ="REACTOR 1 SEQUENCE      "
//   NTWKNUM  = 05
//   NODENUM  = 15
//   NN(001)=3.000000  NN(002)=1.678830
//
// Only the fields the language server uses are kept.

import { hasHebrew, hebrewOrienter } from './hebrew';

export interface PointRecord {
  /** Upper-cased tag name. */
  name: string;
  /** Entity type from `&T`, e.g. PRMODNIM (Process Module), NUMERNIM, FLAGNIM, DICMPNIM, ARRAY. */
  type: string;
  /** Path of the .EB file and zero-based line of the `&N` line, for navigation. */
  file: string;
  line: number;
  fields: Record<string, string>;
}

/** Fields worth keeping. STATETXT(n) is kept too, see below. */
const KEEP = new Set([
  'NODETYP', 'PNTFORM', 'PTDESC', 'EUDESC', 'KEYWORD', 'UNIT', 'ASSOCDSP', 'NTWKNUM', 'NODENUM', 'MODNUM',
  'SLOTNUM', 'EXTDATA', 'NNSTIX', 'NNUMERIC', 'FLSTIX', 'NFLAG', 'STRSTIX', 'NSTRING', 'STRLEN',
  'TIMESTIX', 'NTIME', 'NOSTATES', 'PVALGID', 'CTLALGID', 'PVEUHI', 'PVEULO', 'NMODE', 'NMODATTR',
  'HWYNUM', 'BOXNUM', 'PNTBOXIN', 'PNTMODTY',
]);
/** Wiring of composite and regulatory points: indexed source and destination parameters. */
const WIRING = /^(DISRC|DODSTN|CISRC|CODSTN|PISRC)\((\d+)\)$/;

export function parseEb(text: string, file: string): PointRecord[] {
  const out: PointRecord[] = [];
  let current: PointRecord | undefined;
  let type = '';
  const lines = text.split(/\r?\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('{IDF')) {
      current = undefined;
      type = '';
      continue;
    }
    if (line.startsWith('&T ')) {
      type = line.slice(3).trim().toUpperCase();
      continue;
    }
    if (line.startsWith('&N ')) {
      current = { name: line.slice(3).trim().toUpperCase(), type, file, line: i, fields: {} };
      out.push(current);
      continue;
    }
    if (!current) continue;
    // Several `KEY = value` pairs may share a line; quoted values may contain spaces.
    const pair = /([$A-Z0-9_]+(?:\(\d+\))?)\s*=\s*("(?:[^"]|"")*"|\S+)/gi;
    let m: RegExpExecArray | null;
    while ((m = pair.exec(line))) {
      const key = m[1].toUpperCase();
      if (!KEEP.has(key) && !key.startsWith('STATETXT(') && !WIRING.test(key)) continue;
      let value = m[2];
      if (value.startsWith('"')) value = value.slice(1, -1).replace(/""/g, '"').trimEnd();
      current.fields[key] = value;
    }
  }
  return out;
}

/** Descriptor fields shown to the user; Hebrew in them is converted from visual order. */
const TEXT_FIELDS = ['PTDESC', 'EUDESC', 'KEYWORD'];

/** Convert Hebrew descriptors of all records to logical order, in place. */
export function orientDescriptors(records: PointRecord[]): void {
  const texts = records.flatMap((r) => TEXT_FIELDS.map((f) => r.fields[f]).filter((v): v is string => !!v));
  const toLogical = hebrewOrienter(texts);
  for (const r of records) {
    for (const f of TEXT_FIELDS) {
      const v = r.fields[f];
      if (v && hasHebrew(v)) r.fields[f] = toLogical(v);
    }
  }
}

export function fieldNumber(p: PointRecord, key: string): number | undefined {
  const v = p.fields[key];
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** State names of a DigComp, DigIn or Flag point, in STATETXT order. */
export function pointStates(p: PointRecord): string[] {
  return Object.entries(p.fields)
    .map(([k, v]) => [/^STATETXT\((\d+)\)$/.exec(k)?.[1], v.trim()] as const)
    .filter((e): e is readonly [string, string] => e[0] !== undefined && !!e[1])
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, v]) => v.toUpperCase());
}

/** Hardware name prefixes of IOP-resident point types: `!AI01S01` is card 1, channel 1. */
const IO_PREFIX: Record<string, string> = { ANINNIM: 'AI', ANOUTNIM: 'AO', DIINNIM: 'DI', DOUTNIM: 'DO' };

export interface IoInfo {
  /** For AI, AO, DI and DO points: the channel on its I/O card, and the card type. */
  channel?: { address: string; card?: string };
  /** For composite and regulatory points: what feeds them and what they drive. */
  inputs: string[];
  outputs: string[];
}

/** Where a point connects to the process, if it does. */
export function ioOf(p: PointRecord): IoInfo | undefined {
  const prefix = IO_PREFIX[p.type];
  const card = fieldNumber(p, 'MODNUM');
  const channel = fieldNumber(p, 'SLOTNUM');
  if (prefix && card !== undefined && channel !== undefined) {
    const two = (n: number) => String(n).padStart(2, '0');
    return { channel: { address: `!${prefix}${two(card)}S${two(channel)}`, card: p.fields.PNTMODTY }, inputs: [], outputs: [] };
  }
  const inputs: [number, string][] = [];
  const outputs: [number, string][] = [];
  for (const [key, value] of Object.entries(p.fields)) {
    const m = WIRING.exec(key);
    // Unconnected entries are exported as dashes.
    if (!m || /^-*$/.test(value.trim())) continue;
    (m[1] === 'DODSTN' || m[1] === 'CODSTN' ? outputs : inputs).push([Number(m[2]), value.trim()]);
  }
  if (!inputs.length && !outputs.length) return undefined;
  const ordered = (xs: [number, string][]) => xs.sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return { inputs: ordered(inputs), outputs: ordered(outputs) };
}

/** `NTWKNUM`/`NODENUM` as the UCN box key, e.g. `05:15`. */
export function boxOf(p: PointRecord): string | undefined {
  const ucn = fieldNumber(p, 'NTWKNUM');
  const node = fieldNumber(p, 'NODENUM');
  return ucn !== undefined && node !== undefined ? `${ucn}:${node}` : undefined;
}
