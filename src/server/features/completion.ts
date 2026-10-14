import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  InsertTextFormat,
  MarkupKind,
  Position,
  Range,
} from 'vscode-languageserver';
import { Analysis } from '../../language/analyze';
import { ClSymbol } from '../../language/binder';
import { BUILTINS } from '../../language/builtins';
import { pointStates, PointRecord } from '../../language/eb';
import { parameterInfo, parametersFor, POINT_TYPES, STATES, TYPE_NAMES } from '../../language/parameters';
import { RESERVED } from '../../language/parser';
import { WorkspaceIndex } from '../../language/workspace';
import { classifyPoint, programAt, splitComment } from './shared';

export interface CompletionContext {
  analysis: Analysis;
  index: WorkspaceIndex;
  lines: string[];
}

/** Points offered from other HPMs on an EXTERNAL line, once a prefix is typed. */
const MAX_OTHER_POINTS = 300;

const STATEMENT_KEYWORDS = [
  'SET', 'IF', 'THEN', 'ELSE', 'GOTO', 'WAIT', 'SEND', 'CALL', 'LOOP', 'REPEAT', 'PAUSE', 'FAIL', 'EXIT',
  'ABORT', 'ENB', 'INITIATE', 'READ', 'WRITE', 'FROM', 'RESUME', 'WHEN', 'OTHERS', 'ERROR', 'AND', 'OR',
  'NOT', 'IN', 'MOD', 'ON', 'OFF', 'DAYS', 'HOURS', 'MINS', 'SECS', 'LOCAL', 'EXTERNAL', 'PHASE', 'STEP',
  'END', 'LOGICAL', 'NUMBER', 'TIME', 'STRING', 'ARRAY', 'AT',
];

export function complete(ctx: CompletionContext, pos: Position): CompletionList {
  const line = ctx.lines[pos.line] ?? '';
  const prefix = line.slice(0, pos.character);
  if (inStringOrComment(prefix)) return list([]);
  const word = /[\w$!'֐-׿]*$/.exec(prefix)![0];
  const range: Range = { start: { line: pos.line, character: pos.character - word.length }, end: pos };
  const items = (xs: CompletionItem[], incomplete = false) => list(xs.map((x) => ({ ...x, textEdit: x.textEdit ?? { range, newText: x.insertText ?? x.label } })), incomplete);

  let m: RegExpExecArray | null;

  // point.PARAM = |  ->  that parameter's states. With several targets (`SET A.MODATTR,
  // B.FL(2) = `), the one before `=` decides.
  if ((m = /([!$\w\\]+)\.(\w+)(?:\(\s*\d+\s*\))?\s*(=|<>)\s*[\w֐-׿]*$/.exec(prefix))) {
    const states = stateItems(ctx, m[1], m[2]);
    if (states.length) return items(states);
  }
  // point.|  ->  parameters
  if ((m = /([!$\w\\]+)\.(\w*)$/.exec(prefix))) return items(parameterItems(ctx, m[1]));

  const symbols = flatten(ctx.analysis.binding.symbols);
  const ofKind = (k: ClSymbol['kind']) => symbols.filter((s) => s.kind === k);

  if (/\bGOTO\s+STEP\s+\w*$/i.test(prefix)) return items(symbolItems(ofKind('step'), CompletionItemKind.Method));
  if (/\b(GOTO|RESUME)\s+PHASE\s+\w*$/i.test(prefix)) return items(symbolItems(ofKind('phase'), CompletionItemKind.Class));
  if (/\bGOTO\s+\w*$/i.test(prefix)) {
    return items([...symbolItems(ofKind('label'), CompletionItemKind.Reference), keyword('STEP'), keyword('PHASE')]);
  }
  if (/\bREPEAT\s+\w*$/i.test(prefix)) return items(symbolItems(ofKind('label').filter((l) => l.detail === 'LOOP'), CompletionItemKind.Reference));
  if (/\bCALL\s+\w*$/i.test(prefix)) {
    const subs = BUILTINS.filter((b) => b.kind === 'subroutine').map((b) => ({ label: b.signature.replace(/^CALL /, '').replace(/\(.*/, ''), kind: CompletionItemKind.Function, detail: b.signature, documentation: b.description }));
    return items([...symbolItems(ofKind('subroutine'), CompletionItemKind.Function), ...subs]);
  }
  if ((m = /\b(HOLD|SHUTDOWN|EMERGENCY)\s+\w*$/i.exec(prefix)) && /\b(ENB|PHASE)\b/i.test(prefix)) {
    const type = m[1].toUpperCase();
    return items(symbolItems(ofKind('handler').filter((h) => h.detail === `${type} HANDLER`), CompletionItemKind.Event));
  }
  if (inExternalList(ctx.lines, pos.line, prefix)) return items(...databaseItems(ctx, pos, word));

  // state point, point  ->  points that have that state first
  if ((m = /(?:^\s*(?:\w+:\s*)?|\b(?:THEN|ELSE)\s+|[(;]\s*)([A-Za-z֐-׿][\w֐-׿]*)\s+(?:[!$\w]+\s*,\s*)*[!$\w]*$/i.exec(prefix)) && !RESERVED.has(m[1].toUpperCase())) {
    const state = m[1].toUpperCase();
    return items(ofKind('external').map((e) => {
      const p = ctx.index.point(e.name);
      const has = p ? pointStates(p).includes(state) : false;
      return { ...pointItem(e.ident.text, p), sortText: `${has ? 0 : 1}${e.name}` };
    }));
  }

  return items(identifierItems(ctx, symbols));
}

// ------------------------------------------------------------------ item builders

function identifierItems(ctx: CompletionContext, symbols: ClSymbol[]): CompletionItem[] {
  const out: CompletionItem[] = [];
  const seen = new Set<string>();
  for (const s of symbols) {
    if (seen.has(s.name)) continue;
    switch (s.kind) {
      case 'local':
      case 'constant':
      case 'argument':
        out.push(localItem(ctx, s));
        break;
      case 'external':
        out.push(pointItem(s.ident.text, ctx.index.point(s.name)));
        break;
      case 'function':
      case 'parameter':
      case 'enumState':
        out.push({ label: s.ident.text, kind: s.kind === 'function' ? CompletionItemKind.Function : s.kind === 'parameter' ? CompletionItemKind.Property : CompletionItemKind.EnumMember, detail: s.detail });
        break;
      default:
        continue;
    }
    seen.add(s.name);
  }
  for (const b of BUILTINS) {
    if (b.kind === 'subroutine') continue;
    out.push({ label: b.signature.replace(/\(.*/, ''), kind: CompletionItemKind.Function, detail: b.signature, documentation: b.description, sortText: `2${b.name}` });
  }
  for (const k of STATEMENT_KEYWORDS) out.push({ ...keyword(k), sortText: `3${k}` });
  return out;
}

/** A LOCAL with its mapping as detail (`LOGICAL AT FL(32)`) and its comment as documentation. */
function localItem(ctx: CompletionContext, s: ClSymbol): CompletionItem {
  const comment = splitComment(ctx.lines[s.range.start.line] ?? '').comment;
  return {
    label: s.ident.text,
    kind: s.kind === 'constant' ? CompletionItemKind.Constant : CompletionItemKind.Variable,
    detail: s.kind === 'constant' ? `constant ${s.detail ?? ''}` : s.detail,
    documentation: comment,
    sortText: `0${s.name}`,
  };
}

function pointItem(label: string, p: PointRecord | undefined): CompletionItem {
  const type = p ? POINT_TYPES[p.type] ?? p.type : 'external point';
  const desc = p?.fields.PTDESC;
  return {
    label,
    kind: CompletionItemKind.Reference,
    detail: desc ? `${desc} · ${type}` : type,
    labelDetails: desc ? { description: desc } : undefined,
    sortText: `1${label.toUpperCase()}`,
  };
}

function parameterItems(ctx: CompletionContext, pointName: string): CompletionItem[] {
  const { type, cls } = classifyPoint(ctx.index, pointName);
  const usage = type ? ctx.index.parameterUse(type) : new Map<string, number>();
  const documented = cls ? parametersFor(cls) : [];
  const names = new Set([...documented.map((p) => p.name), ...usage.keys()]);
  const rank = [...names].sort((a, b) => (usage.get(b) ?? 0) - (usage.get(a) ?? 0) || a.localeCompare(b));
  return rank.map((name, i) => {
    const info = parameterInfo(cls, name);
    const uses = usage.get(name);
    return {
      label: name,
      kind: CompletionItemKind.Property,
      detail: [info && typeName(info.type), uses ? `used ${uses}×` : undefined].filter(Boolean).join(' · ') || undefined,
      documentation: info ? { kind: MarkupKind.Markdown, value: info.description + (info.states ? `\n\nStates: ${info.states.join(', ')}` : '') } : undefined,
      insertText: info?.indexed ? `${name}($1)` : name,
      insertTextFormat: info?.indexed ? InsertTextFormat.Snippet : undefined,
      sortText: String(i).padStart(4, '0'),
    };
  });
}

function stateItems(ctx: CompletionContext, pointName: string, param: string): CompletionItem[] {
  const { cls } = classifyPoint(ctx.index, pointName);
  const p = ctx.index.point(pointName);
  const info = parameterInfo(cls, param);
  const upper = param.toUpperCase();
  let states: string[] = [];
  if (info?.type === 'SDE' && p) {
    states = pointStates(p);
    if (upper === 'PV' && cls === 'DigComp') states = [...states, 'MOVING', 'BAD'];
  } else if (info?.states) states = info.states;
  else if (info?.type === 'L' || upper === 'FL' || upper === 'PVFL') states = STATES.ONOFF;
  return states.map((s, i) => ({ label: s, kind: CompletionItemKind.EnumMember, detail: `${pointName.toUpperCase()}.${upper}`, sortText: String(i).padStart(3, '0') }));
}

/** Database points for an EXTERNAL list: those in the program's own HPM, then by prefix. */
function databaseItems(ctx: CompletionContext, pos: Position, word: string): [CompletionItem[], boolean] {
  const declared = new Set(flatten(ctx.analysis.binding.symbols).filter((s) => s.kind === 'external').map((s) => s.name));
  const bound = programAt(ctx.analysis.file.units, pos);
  const box = bound && ctx.index.boxOfProgram(bound);
  const prefix = word.toUpperCase();
  const out: CompletionItem[] = [];
  let others = 0;
  for (const p of ctx.index.allPoints()) {
    if (declared.has(p.name) || p.type.startsWith('$') || p.type === 'NODE' || p.type === 'HM_HIST') continue;
    const local = box !== undefined && ctx.index.boxOfPoint(p) === box;
    if (!local) {
      if (prefix.length < 2 || !p.name.startsWith(prefix) || others >= MAX_OTHER_POINTS) continue;
      others++;
    }
    out.push({ ...pointItem(p.name, p), sortText: `${local ? 0 : 1}${p.name}` });
  }
  return [out, true];
}

// ------------------------------------------------------------------ helpers




function symbolItems(syms: ClSymbol[], kind: CompletionItemKind): CompletionItem[] {
  const seen = new Set<string>();
  return syms.filter((s) => !seen.has(s.name) && seen.add(s.name)).map((s) => ({ label: s.ident.text, kind, detail: s.detail }));
}

function keyword(k: string): CompletionItem {
  return { label: k, kind: CompletionItemKind.Keyword };
}

function flatten(syms: ClSymbol[]): ClSymbol[] {
  return syms.flatMap((s) => [s, ...flatten(s.children)]);
}

function list(items: CompletionItem[], isIncomplete = false): CompletionList {
  return { isIncomplete, items };
}

function inStringOrComment(prefix: string): boolean {
  let inString = false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] === '"') inString = !inString;
    else if (!inString && prefix[i] === '-' && prefix[i + 1] === '-') return true;
  }
  return inString;
}

/** The cursor is in an EXTERNAL list: on its line or on one of its `&` continuation lines. */
function inExternalList(lines: string[], line: number, prefix: string): boolean {
  if (/^\s*EXTERNAL\b/i.test(prefix)) return true;
  if (!prefix.startsWith('&')) return false;
  for (let i = line - 1; i >= 0; i--) {
    if (/^\s*EXTERNAL\b/i.test(lines[i])) return true;
    if (!lines[i].startsWith('&')) return false;
  }
  return false;
}


function typeName(t: string): string {
  return TYPE_NAMES[t] ?? t;
}