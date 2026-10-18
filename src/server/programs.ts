import { placeMessages } from '../language/listing';
import { FileSummary } from '../language/summary';
import { WorkspaceIndex } from '../language/workspace';
import { ProgramItem, ProgramPart, ProgramStatus } from '../shared/programs';
import { ListingFile } from './listings';

/** Every program, with the LCN and HPM it runs in, for the CL Programs view. */
export function programItems(index: WorkspaceIndex): ProgramItem[] {
  return index.programList().map((p) => {
    const m = p.box && /^(.*)\/(\d+):(\d+)$/.exec(p.box);
    const two = (n: string) => n.padStart(2, '0');
    let lcn: string | undefined;
    let hpm: string;
    let hpmOrder: string;
    if (p.kind === 'block') {
      // CL/AM blocks run in an Application Module, not in an HPM.
      hpm = 'CL/AM';
      hpmOrder = '2';
    } else if (m) {
      lcn = m[1] || undefined;
      hpm = `HPM ${two(m[2])}/${two(m[3])}`;
      hpmOrder = `0 ${m[2].padStart(4, '0')} ${m[3].padStart(4, '0')}`;
    } else if (p.box?.startsWith('G')) {
      // Placed together by shared storage, but not in the point database.
      hpm = 'HPM not in the point database';
      hpmOrder = '1';
    } else {
      hpm = 'No bound point';
      hpmOrder = '3';
    }
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
  // Handlers and subroutines belong to the program before them; a file normally holds one.
  const others = summary.symbols.filter((s) => s.kind === 'handler' || s.kind === 'subroutine').map(part);
  return [...phases, ...others];
}

/** The last compile as the listings beside a source tell it. */
export function programStatus(uri: string, files: ListingFile[], lines: string[] | undefined): ProgramStatus {
  const le = files.find((f) => f.kind === 'LE');
  const errors = le ? (le.listing.errorCount ?? le.listing.messages.filter((m) => m.severity === 1).length) : 0;
  const changed = !!lines && files.some((f) => placeMessages(f.listing, lines).stale);
  return { uri, errors, changed, noListing: files.length === 0 };
}
