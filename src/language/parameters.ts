// Point types and the parameters CL code touches most, summarised from the HPM Parameters Pocket
// Guide (HP09-641) and HPM Control Theory (HP09). Parameters not listed here are still offered
// when the workspace uses them on a point of that type.

export type PointClass =
  | 'ProcMod' | 'DigComp' | 'DigIn' | 'DigOut' | 'AnalgIn' | 'AnalgOut' | 'RegPV' | 'RegCtl'
  | 'Logic' | 'Array' | 'Flag' | 'Numeric' | 'Timer' | 'Box';

/** Point database entity types (`&T`) to point classes. */
export const CLASS_OF_TYPE: Record<string, PointClass> = {
  PRMODNIM: 'ProcMod',
  DICMPNIM: 'DigComp',
  DEVCTLNIM: 'DigComp',
  DIINNIM: 'DigIn',
  DOUTNIM: 'DigOut',
  ANINNIM: 'AnalgIn',
  ANOUTNIM: 'AnalgOut',
  REGPVNIM: 'RegPV',
  REGCLNIM: 'RegCtl',
  LOGICNIM: 'Logic',
  ARRAY: 'Array',
  FLAGNIM: 'Flag',
  NUMERNIM: 'Numeric',
  TIMERNIM: 'Timer',
  PM_BOX: 'Box',
  BOX: 'Box',
};

/** Display names of point database entity types. */
export const POINT_TYPES: Record<string, string> = {
  PRMODNIM: 'Process Module (sequence slot)',
  NUMERNIM: 'Numeric (box variable)',
  FLAGNIM: 'Flag (box variable)',
  TIMERNIM: 'Timer',
  ARRAY: 'Array',
  DICMPNIM: 'Digital Composite',
  DEVCTLNIM: 'Device Control',
  DIINNIM: 'Digital Input',
  DOUTNIM: 'Digital Output',
  ANINNIM: 'Analog Input',
  ANOUTNIM: 'Analog Output',
  REGPVNIM: 'Regulatory PV',
  REGCLNIM: 'Regulatory Control',
  LOGICNIM: 'Logic',
  PM_BOX: 'HPM box',
  BOX: 'Box',
  NODE: 'Node',
};

/** Display names of parameter type codes. */
export const TYPE_NAMES: Record<string, string> = {
  R: 'Number', I: 'Number (integer)', L: 'Logical', S: 'String', T: 'Time', E: 'Enumeration', SDE: 'State',
};

export interface ParameterInfo {
  name: string;
  /** R real, I integer, L logical, S string, T time, E enumeration, SDE self-defined enumeration. */
  type: 'R' | 'I' | 'L' | 'S' | 'T' | 'E' | 'SDE';
  description: string;
  /** Fixed enumeration states. SDE states come from the point's STATETXT instead. */
  states?: string[];
  /** Takes an index: `NN(i)`. */
  indexed?: boolean;
  classes: PointClass[];
}

const ALL: PointClass[] = ['ProcMod', 'DigComp', 'DigIn', 'DigOut', 'AnalgIn', 'AnalgOut', 'RegPV', 'RegCtl', 'Logic', 'Array', 'Flag', 'Numeric', 'Timer'];
const MODAL: PointClass[] = ['DigComp', 'AnalgOut', 'RegCtl'];
const ANALOG: PointClass[] = ['AnalgIn', 'RegPV', 'RegCtl'];

export const STATES = {
  MODE: ['MAN', 'AUTO', 'CAS', 'BCAS', 'NORMAL'],
  MODATTR: ['OPERATOR', 'PROGRAM', 'NORMAL', 'NONE'],
  PVSTS: ['NORMAL', 'UNCERTN', 'BAD'],
  PVSOURCE: ['AUTO', 'MAN', 'SUB', 'TRACK'],
  PTEXECST: ['INACTIVE', 'ACTIVE'],
  ALENBST: ['ENABLE', 'DISABLE', 'INHIBIT'],
  PROCMOD: ['OFF', 'NORM', 'HOLD', 'SHDN', 'EMSD', 'STRT', 'STOP'],
  SEQEXEC: ['NL', 'DLL', 'LOADED', 'RUN', 'PAUSE', 'ERROR', 'FAIL', 'END'],
  SEQMODE: ['AUTO', 'SEMIAUTO', 'SNGLSTEP'],
  TMCMD: ['NONE', 'START', 'STOP', 'RESET', 'RESTSTRT'],
  TMST: ['STOPPED', 'RUNNING'],
  ONOFF: ['ON', 'OFF'],
  FUNCSTATE: ['BASIC', 'FULL'],
};

const P = (
  name: string,
  type: ParameterInfo['type'],
  classes: PointClass[],
  description: string,
  extra: Partial<ParameterInfo> = {},
): ParameterInfo => ({ name, type, classes, description, ...extra });

export const PARAMETERS: ParameterInfo[] = [
  // Common
  P('PTEXECST', 'E', ALL, 'Point execution state.', { states: STATES.PTEXECST }),
  P('ALENBST', 'E', ALL, 'Alarm enable state.', { states: STATES.ALENBST }),
  P('PNTSTATE', 'E', ALL, 'Point state: OK, Failed, Idle or Uncertn. View only.'),
  P('PTINAL', 'L', ALL, 'The point is in alarm. View only.'),
  P('NODENUM', 'I', ALL, 'UCN node number of the point.'),
  P('SLOTNUM', 'I', ALL, 'Slot number of the point.'),

  // Mode
  P('MODE', 'E', MODAL, 'Mode. RegCtl: Man, Auto, Cas, Bcas, Normal. AnalgOut: Man, Cas, Normal. DigComp: Man, Normal.', { states: STATES.MODE }),
  P('MODATTR', 'E', MODAL, 'Mode attribute: who may command SP, OP and MODE. Set PROGRAM before commanding the point from CL; with OPERATOR a store fails with 173.', { states: STATES.MODATTR }),
  P('NMODE', 'E', MODAL, 'Normal mode, applied when the operator presses NORM.', { states: STATES.MODE }),
  P('NMODATTR', 'E', MODAL, 'Normal mode attribute, applied when the operator presses NORM.', { states: STATES.MODATTR }),
  P('REDTAG', 'E', MODAL, 'Red tag: the point is locked out.', { states: STATES.ONOFF }),
  P('MANMODFL', 'L', MODAL, 'ON when MODE is Man. View only.'),
  P('AUTMODFL', 'L', MODAL, 'ON when MODE is Auto. View only.'),
  P('CASMODFL', 'L', MODAL, 'ON when MODE is Cas. View only.'),
  P('PRGATRFL', 'L', MODAL, 'ON when MODATTR is Program. View only.'),
  P('OPRATRFL', 'L', MODAL, 'ON when MODATTR is Operator. View only.'),

  // Analog and regulatory PV
  P('PV', 'R', [...ANALOG, 'Numeric'], 'Process variable in engineering units.'),
  P('PVSTS', 'E', ANALOG, 'PV status. Cannot be written.', { states: STATES.PVSTS }),
  P('PVSOURCE', 'E', [...ANALOG, 'DigIn'], 'PV source. With SUB a program supplies the PV.', { states: STATES.PVSOURCE }),
  P('PVAUTO', 'R', ANALOG, 'PV computed by the point, before PVSOURCE. View only.'),
  P('PVEUHI', 'R', ANALOG, 'PV range high, in EU.'),
  P('PVEULO', 'R', ANALOG, 'PV range low, in EU.'),
  P('PVHITP', 'R', ANALOG, 'PV high alarm trip point. NaN disables it.'),
  P('PVLOTP', 'R', ANALOG, 'PV low alarm trip point. NaN disables it.'),
  P('PVHHTP', 'R', ANALOG, 'PV high-high alarm trip point.'),
  P('PVLLTP', 'R', ANALOG, 'PV low-low alarm trip point.'),
  P('PVHIFL', 'L', ANALOG, 'PV high alarm is active.'),
  P('PVLOFL', 'L', ANALOG, 'PV low alarm is active.'),
  P('PVHHFL', 'L', ANALOG, 'PV high-high alarm is active.'),
  P('PVLLFL', 'L', ANALOG, 'PV low-low alarm is active.'),
  P('PVROCPFL', 'L', ANALOG, 'Positive rate-of-change alarm is active.'),
  P('PVROCNFL', 'L', ANALOG, 'Negative rate-of-change alarm is active.'),
  P('BADPVFL', 'L', ANALOG, 'PV is bad.'),
  P('PVTV', 'R', ANALOG, 'PV target value (totalizers and similar algorithms).'),
  P('PVP', 'R', ANALOG, 'PV in percent of range.'),

  // Regulatory control
  P('SP', 'R', ['RegCtl'], 'Setpoint, limited by SPHILM and SPLOLM.'),
  P('SPHILM', 'R', ['RegCtl'], 'Setpoint high limit.'),
  P('SPLOLM', 'R', ['RegCtl'], 'Setpoint low limit.'),
  P('SPTV', 'R', ['RegCtl'], 'Setpoint target value for ramping.'),
  P('OP', 'R', ['RegCtl', 'AnalgOut'], 'Output in percent, -6.9 to 106.9, limited by OPHILM and OPLOLM.'),
  P('OPHILM', 'R', ['RegCtl', 'AnalgOut'], 'Output high limit.'),
  P('OPLOLM', 'R', ['RegCtl', 'AnalgOut'], 'Output low limit.'),
  P('OPEU', 'R', ['RegCtl'], 'Output in engineering units. View only.'),
  P('K', 'R', ['RegCtl'], 'PID gain.'),
  P('T1', 'R', ['RegCtl'], 'PID integral time, minutes.'),
  P('T2', 'R', ['RegCtl'], 'PID derivative time, minutes.'),
  P('INITMAN', 'L', ['RegCtl', 'AnalgOut'], 'The point is initializing. View only.'),

  // Digital composite
  P('OP', 'SDE', ['DigComp'], "Commanded state, one of the point's STATETXT names. A state change `OPEN XV1` writes it."),
  P('PV', 'SDE', ['DigComp'], "Feedback state: the point's states plus MOVING and BAD."),
  P('PVFL', 'L', ['DigComp'], 'Per-state PV flags.', { indexed: true }),
  P('OPFINAL', 'SDE', ['DigComp'], 'Final output after interlocks. View only.'),
  P('CMDDISFL', 'L', ['DigComp'], 'Command disagree: the feedback did not follow the command in time.'),
  P('CMDFALFL', 'L', ['DigComp'], 'Command failed.'),
  P('BYPASS', 'L', ['DigComp'], 'Interlock bypass.'),
  P('SI0', 'L', ['DigComp'], 'Safety interlock.'),
  P('P0', 'L', ['DigComp'], 'Permissive interlock for state 0.'),
  P('P1', 'L', ['DigComp'], 'Permissive interlock for state 1.'),
  P('I0', 'L', ['DigComp'], 'Override interlock to state 0.'),
  P('I1', 'L', ['DigComp'], 'Override interlock to state 1.'),

  // Digital input and output
  P('PV', 'SDE', ['DigIn'], "State: one of the point's two STATETXT names."),
  P('PVFL', 'L', ['DigIn', 'Flag'], 'Logical PV. With PVSOURCE Auto, a store from CL fails with F171.'),
  P('PVRAW', 'L', ['DigIn'], 'Raw contact state. View only.'),
  P('SO', 'L', ['DigOut', 'Logic', 'Timer'], 'Status output.', { indexed: false }),
  P('ONPULSE', 'R', ['DigOut'], 'On pulse command, 0 to 60 seconds.'),
  P('OFFPULSE', 'R', ['DigOut'], 'Off pulse command, 0 to 60 seconds.'),

  // Box variable points
  P('PV', 'SDE', ['Flag'], "State of the box flag, one of the point's STATETXT names."),

  // Timer point
  P('SP', 'I', ['Timer'], 'Timer preset, 0 to 32000.'),
  P('PV', 'I', ['Timer'], 'Elapsed time.'),
  P('COMMAND', 'E', ['Timer'], 'Timer command.', { states: STATES.TMCMD }),

  // Process Module
  P('PROCMOD', 'E', ['ProcMod'], 'Process module command: start (NORM), stop, or trigger a handler (HOLD, SHDN, EMSD).', { states: STATES.PROCMOD }),
  P('SEQEXEC', 'E', ['ProcMod'], 'Sequence execution state. View only.', { states: STATES.SEQEXEC }),
  P('SEQMODE', 'E', ['ProcMod'], 'Sequence mode.', { states: STATES.SEQMODE }),
  P('SEQERR', 'I', ['ProcMod'], 'Last sequence error code.'),
  P('PHASE', 'S', ['ProcMod'], 'Current phase name.'),
  P('STEP', 'S', ['ProcMod'], 'Current step name.'),
  P('NN', 'R', ['ProcMod', 'Array', 'Logic', 'Box'], 'Numeric storage.', { indexed: true }),
  P('FL', 'L', ['ProcMod', 'Array', 'Logic', 'Box'], 'Flag storage.', { indexed: true }),
  P('TIME', 'T', ['ProcMod', 'Array', 'Box'], 'Time storage.', { indexed: true }),
  P('STR8', 'S', ['ProcMod', 'Array', 'Box'], 'String storage, 8 characters.', { indexed: true }),
  P('STR16', 'S', ['ProcMod', 'Array'], 'String storage, 16 characters. Overlays STR8.', { indexed: true }),
  P('STR32', 'S', ['ProcMod', 'Array'], 'String storage, 32 characters. Overlays STR8.', { indexed: true }),
  P('STR64', 'S', ['ProcMod', 'Array'], 'String storage, 64 characters. Overlays STR8.', { indexed: true }),

  // Box
  P('TMSP', 'I', ['Box'], 'Box timer setpoint, 0 to 32000 (higher fails with F172).', { indexed: true }),
  P('TMPV', 'I', ['Box'], 'Box timer elapsed time. View only.', { indexed: true }),
  P('TMRV', 'I', ['Box'], 'Box timer remaining time. View only.', { indexed: true }),
  P('TMCMD', 'E', ['Box'], 'Box timer command.', { indexed: true, states: STATES.TMCMD }),
  P('TMST', 'E', ['Box'], 'Box timer state. View only.', { indexed: true, states: STATES.TMST }),
  P('TMSO', 'L', ['Box'], 'Box timer done. View only.', { indexed: true }),
];

/** Parameters documented for a point class. */
export function parametersFor(cls: PointClass | undefined): ParameterInfo[] {
  return cls ? PARAMETERS.filter((p) => p.classes.includes(cls)) : [];
}

export function parameterInfo(cls: PointClass | undefined, name: string): ParameterInfo | undefined {
  const upper = name.toUpperCase();
  return parametersFor(cls).find((p) => p.name === upper) ?? PARAMETERS.find((p) => p.name === upper);
}
