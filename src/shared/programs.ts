// Messages between the language server and the CL Programs view.

/** A SEQUENCE or BLOCK, with where it runs. */
export interface ProgramItem {
  uri: string;
  name: string;
  kind: 'sequence' | 'block';
  point?: string;
  dialect?: string;
  line: number;
  character: number;
  /** LCN name, when the workspace has several. */
  lcn?: string;
  /** Set when the LCN is that of most other programs in the same folder, nothing else giving one. */
  lcnByFolder?: string;
  /** `HPM 01/09`, or a group for programs the point database does not place. */
  hpm: string;
  /** Sorts HPMs by UCN and node. */
  hpmOrder: string;
}

/** A phase, step, handler or subroutine of a program's file. */
export interface ProgramPart {
  name: string;
  kind: 'phase' | 'step' | 'handler' | 'subroutine';
  detail?: string;
  line: number;
  character: number;
  children?: ProgramPart[];
}

/** What the listings next to a program's source say about its last compile. */
export interface ProgramStatus {
  uri: string;
  /** Errors in a current .LE. */
  errors: number;
  /** The listing's source differs from the current file: changed since the compile. */
  changed: boolean;
  /** No .LS or .LE beside the source. */
  noListing: boolean;
}

export const PROGRAMS_CHANGED = 'amcl/programsChanged';
export const PROGRAMS_REQUEST = 'amcl/programs';
export const PROGRAM_PARTS_REQUEST = 'amcl/programParts';
export const PROGRAM_STATUS_REQUEST = 'amcl/programStatus';

/**
 * A storage element used by programs bound to two points or more (copies of one program count
 * once), or used by one and named by a box Numeric or Flag point, which displays and other
 * systems read and write it through.
 */
export interface StorageSlot {
  key: string;
  lcn?: string;
  hpm: string;
  hpmOrder: string;
  /** The box, the process module (sequence slot) or the array point the element is in. */
  ownerKind: 'box' | 'module' | 'array';
  owner: string;
  param: string;
  index: number;
  /** LOCAL names it goes by, and the box Numeric or Flag point that names it. */
  names: string[];
  /** Sequence slots (bound points) whose programs use it. */
  programs: number;
  /** Sequence slots whose programs store to it. */
  writers: number;
  /** The box Numeric or Flag point (tag) at the element, and its descriptor. */
  tag?: string;
  tagDescriptor?: string;
}

/** One program file's accesses to a storage element. */
export interface StorageAccess {
  /** The file name without extension. */
  program: string;
  uri: string;
  /** The LOCAL it is accessed through; undefined for direct access such as `!BOX.FL(21)`. */
  name?: string;
  line: number;
  character: number;
  writes: number;
  reads: number;
  /** The row is the box Numeric or Flag point at the element, not a program. */
  tag?: boolean;
  /** For a tag: its descriptor. */
  descriptor?: string;
}

export const SHARED_STORAGE_REQUEST = 'amcl/sharedStorage';
export const STORAGE_ACCESSES_REQUEST = 'amcl/storageAccesses';

/** The source a listing shows, which is what was compiled. */
export interface CompiledSource {
  listing: string;
  kind: 'LS' | 'LE';
  compiled?: string;
  /** An error listing holds only the lines with errors; then `lines` is empty. */
  whole: boolean;
  lines: string[];
}

export const COMPILED_SOURCE_REQUEST = 'amcl/compiledSource';

/** Where a program, part or LOCAL is now, by name: the views' lines may predate edits. */
export interface LocateParams {
  uri: string;
  kind: 'sequence' | 'block' | ProgramPart['kind'] | 'local';
  name: string;
}

export const LOCATE_REQUEST = 'amcl/locate';
