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
