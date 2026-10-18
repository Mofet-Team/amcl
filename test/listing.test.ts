import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseListing, placeMessages } from '../src/language/listing';
import { lookupMessage, MESSAGE_COUNT } from '../src/language/messages';
import { Severity } from '../src/language/types';
import { listedLineAt, listingDiagnostics, listingHover, listingSymbols } from '../src/server/features/listing';
import { compilerDiagnostics, ListingStore } from '../src/server/listings';
import { fixture } from './helpers';

const heaterLs = parseListing(fixture('listing/HEATER.LS'));
const valveLe = parseListing(fixture('listing/VALVE.LE'));
const heater = fixture('listing/HEATER.CL').split('\n');
const valve = fixture('listing/VALVE.CL').split('\n');

describe('message catalogue', () => {
  it('holds the messages of the compiler, linker and data access commands', () => {
    expect(MESSAGE_COUNT).toBeGreaterThan(350);
  });

  it('finds messages whatever their letter case, and fills placeholders', () => {
    expect(lookupMessage('Defined But Not Referenced')).toMatchObject({ source: 'P2', severity: 'Warning' });
    expect(lookupMessage('FOO cannot be redeclared')).toMatchObject({ text: '<name> cannot be redeclared', source: 'P2' });
    expect(lookupMessage('String exceeded maximum allowable length and was shortened to 64 characters')).toMatchObject({ source: 'P3CDS' });
    expect(lookupMessage('Syntax Error')).toMatchObject({ source: 'P1', severity: 'Severe' });
    expect(lookupMessage('no such message')).toBeUndefined();
  });

  it('prefers a literal entry to a placeholder one', () => {
    expect(lookupMessage('Data Point Identifier expected')?.text).toBe('Data Point Identifier expected');
  });
});

describe('parseListing', () => {
  it('reads source lines, messages with their caret, and the summary', () => {
    expect(heaterLs.source.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(heaterLs.source[2].text.trimEnd()).toBe('    LOCAL SPARE: LOGICAL AT FL(1)');
    expect(heaterLs.messages).toMatchObject([
      { kind: 'WARNING', text: 'Defined But Not Referenced', severity: Severity.Warning, context: { number: 3 }, caret: 24 },
      { kind: 'NOTE', severity: Severity.Information, context: { number: 5 }, catalog: { source: 'P2' } },
    ]);
    expect(heaterLs.errorCount).toBe(0);
    expect(heaterLs.mainSource).toBe('HEATER.CL');
  });

  it('reads an error listing that holds only the lines with errors', () => {
    expect(valveLe.errorCount).toBe(2);
    expect(valveLe.source.map((s) => s.number)).toEqual([4, 5]);
    expect(valveLe.messages.map((m) => [m.kind, m.severity, m.context?.number])).toEqual([
      ['ERROR', Severity.Error, 4],
      ['ERROR', Severity.Error, 5],
    ]);
    expect(valveLe.messages[1].catalog?.text).toBe('<name> not found');
    expect(placeMessages(valveLe, valve).placed.map((p) => [p.line, p.start, p.end])).toEqual([
      [3, 16, 16],
      [4, 9, 12],
    ]);
  });

  it('pairs several carets on one line with the messages after it, in order', () => {
    const l = parseListing(
      ['     1            SET A = B', '                      ^   ^', '  **ERROR   **  first', '  **ERROR   **  second'].join('\n'),
    );
    expect(l.messages.map((m) => m.caret)).toEqual([22, 26]);
  });

  it('reads listings without line numbers, skipping page headers', () => {
    const l = parseListing(
      ['  CL V14.2   INTREFLX        14 10 85 14:02   Page    2', '           IF init THEN EXIT', '           ESLE EXIT', '           ^', '  **ERROR   **  Syntax Error', '   ********  Number of errors detected:   1'].join('\n'),
    );
    expect(l.source).toEqual([]);
    expect(l.messages[0]).toMatchObject({ text: 'Syntax Error', context: { text: '           ESLE EXIT' }, caret: 11 });
    expect(l.errorCount).toBe(1);
    expect(placeMessages(l, ['SEQUENCE S', '  IF init THEN EXIT', '  ESLE EXIT']).placed[0]).toMatchObject({ line: 2, start: 2, end: 6 });
  });
});

describe('placeMessages', () => {
  it('places messages at their line and caret', () => {
    const { placed, lost, stale } = placeMessages(heaterLs, heater);
    expect(stale).toBe(false);
    expect(lost).toEqual([]);
    expect(placed[0]).toMatchObject({ line: 2, start: 10, end: 15 });
  });

  it('follows lines moved and re-indented since the compile', () => {
    const edited = ['-- new header', '-- more', ...heater.map((l) => l.replace(/^ {4}/, '  '))];
    const { placed, stale } = placeMessages(heaterLs, edited);
    expect(stale).toBe(true);
    expect(placed.map((p) => [p.line, p.start])).toEqual([
      [4, 8],
      [6, 2],
    ]);
  });

  it('reports messages whose line has changed', () => {
    const edited = heater.map((l) => (l.includes('SPARE') ? '    LOCAL SPARE2: LOGICAL AT FL(1)' : l));
    const { placed, lost } = placeMessages(heaterLs, edited);
    expect(lost.map((m) => m.text)).toEqual(['Defined But Not Referenced']);
    expect(placed).toHaveLength(1);
  });

  it('places a message without a caret on the whole line', () => {
    const l = parseListing(['     2            EXIT', '  **ERROR   **  Missing END'].join('\n'));
    expect(placeMessages(l, ['SUBROUTINE S', '    EXIT']).placed[0]).toMatchObject({ line: 1, start: 4, end: 8 });
  });
});

describe('compilerDiagnostics', () => {
  const file = (listing: typeof heaterLs, kind: 'LS' | 'LE') => ({ path: `/x/HEATER.${kind}`, kind, mtime: 0, listing });
  const uri = (p: string) => `file://${p}`;

  it('turns messages into diagnostics that link back to the listing', () => {
    const d = compilerDiagnostics([file(heaterLs, 'LS')], heater, [], new Set(), uri);
    expect(d.map((x) => [x.code, x.severity, x.range.start.line])).toEqual([
      ['compiler-warning', 2, 2],
      ['compiler-note', 4, 4],
    ]);
    expect(d[0]).toMatchObject({ source: 'CL compiler', relatedInformation: [{ location: { uri: 'file:///x/HEATER.LS', range: { start: { line: 7 } } } }] });
  });

  it('leaves out warnings the extension reports itself, and duplicates across listings', () => {
    const ours = [{ code: 'unused', range: { start: { line: 2, character: 10 }, end: { line: 2, character: 15 } }, message: '', severity: 2 as Severity }];
    const d = compilerDiagnostics([file(heaterLs, 'LS'), file(heaterLs, 'LE')], heater, ours, new Set(), uri);
    expect(d.map((x) => x.code)).toEqual(['compiler-note']);
  });

  it('reports messages on changed lines once per listing, and honours disabled codes', () => {
    const edited = heater.map((l) => (l.includes('SPARE') ? '    LOCAL SPARE2: LOGICAL AT FL(1)' : l));
    const d = compilerDiagnostics([file(heaterLs, 'LS')], edited, [], new Set(['compiler-note']), uri);
    expect(d).toMatchObject([{ code: 'compiler-stale', source: 'CL compiler', range: { start: { line: 0 } } }]);
    expect(d[0].message).toMatch(/^1 compiler message is on lines changed/);
  });
});

describe('listing documents', () => {
  it('reports messages at their caret in the listing', () => {
    const d = listingDiagnostics(valveLe, new Set());
    expect(d.map((x) => [x.range.start.line, x.range.start.character, x.range.end.character])).toEqual([
      [2, 30, 31],
      [6, 23, 26],
    ]);
  });

  it('outlines messages by severity', () => {
    expect(listingSymbols(heaterLs).map((s) => [s.name, s.children?.map((c) => c.detail)])).toEqual([
      ['Warnings (1)', ['line 3']],
      ['Notes (1)', ['line 5']],
    ]);
  });

  it('finds the source line of a listing line or message line', () => {
    expect(listedLineAt(valveLe, 8)?.listed.number).toBe(5);
    expect(listedLineAt(valveLe, 8)?.caret).toBe(23);
    expect(listedLineAt(heaterLs, 3)?.listed.number).toBe(1);
    expect(listedLineAt(heaterLs, 0)).toBeUndefined();
  });

  it('explains a message on hover', () => {
    const h = listingHover(valveLe, { line: 8, character: 4 });
    expect((h?.contents as { value: string }).value).toMatch(/Error, reported by pass 2 \(type checking\)/);
  });
});

describe('ListingStore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcl-listing-'));
  const write = (name: string, text: string, mtime: number) => {
    fs.writeFileSync(path.join(dir, name), text);
    fs.utimesSync(path.join(dir, name), mtime, mtime);
  };
  const store = new ListingStore((b) => b.toString('latin1'));

  it('finds listings in any letter case, and drops an error listing a clean compile superseded', () => {
    write('PUMP.CL', 'x', 100);
    write('pump.le', fixture('listing/VALVE.LE'), 100);
    expect(store.companions(path.join(dir, 'PUMP.CL')).map((f) => f.kind)).toEqual(['LE']);
    write('Pump.Ls', fixture('listing/HEATER.LS'), 200);
    expect(store.companions(path.join(dir, 'PUMP.CL')).map((f) => f.kind)).toEqual(['LS']);
    expect(store.sourceOf(path.join(dir, 'pump.le'))).toBe(path.join(dir, 'PUMP.CL'));
  });
});

describe('listing layouts', () => {
  it('reads empty source lines printed as their number alone', () => {
    const l = parseListing(['Line   Loc  Text', '1        -- header', '2', '3        SEQUENCE S (HPM; POINT S)'].join('\r\n'));
    expect(l.source.map((s) => [s.number, s.text])).toEqual([
      [1, '-- header'],
      [2, ''],
      [3, 'SEQUENCE S (HPM; POINT S)'],
    ]);
  });

  it('reads the fixed columns of old CL/AM listings', () => {
    const l = parseListing(
      ['  Line     Loc  Text', '     1      18  BLOCK B (POINT P; AT GENERAL)', '     2          %INCLUDE_SET FILE', '     3  .60     %PAGE----', '    10    1014    SET X = 1'].join('\n'),
    );
    expect(l.source.map((s) => [s.number, s.text])).toEqual([
      [1, 'BLOCK B (POINT P; AT GENERAL)'],
      [2, '%INCLUDE_SET FILE'],
      [3, '%PAGE----'],
      [10, '  SET X = 1'],
    ]);
  });
});

describe('listing views', () => {
  it('maps positions between a whole listing and its source column', async () => {
    const { wholeView } = await import('../src/server/listingView');
    const { analyze } = await import('../src/language/analyze');
    const v = wholeView('file:///x.LS', heaterLs, analyze);
    expect(v.toSource({ line: 14, character: 22 })).toEqual({ line: 5, character: 8 });
    expect(v.toListing({ start: { line: 3, character: 10 }, end: { line: 3, character: 14 } })).toEqual({
      start: { line: 9, character: 24 },
      end: { line: 9, character: 28 },
    });
  });

  it('takes a line the listing cut at its page width from the source file', async () => {
    const { wholeView } = await import('../src/server/listingView');
    const { analyze } = await import('../src/language/analyze');
    const cut = parseListing(['     1            SEQUENCE S (HPM; POINT S)', '     2            PHASE P', '     3            SET NN(1) = 1 +', '     4            END S'].join('\n'));
    const v = wholeView('file:///x.LS', cut, analyze, ['    SEQUENCE S (HPM; POINT S)', '    PHASE P', '    SET NN(1) = 1 + 2', '    END S']);
    expect(v.lines[2]).toBe('    SET NN(1) = 1 + 2');
    expect(v.analysis.diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });
});

describe('compiled source', () => {
  it('reads the compile date from the page header, as printed', () => {
    expect(heaterLs.compiled).toBe('14/10/26 09:12');
    expect(parseListing('  CL V68.101    64_V1                         06/13/23 09:15:13:7361     Page      1').compiled).toBe('06/13/23 09:15');
  });

  it('gives the source of a whole listing, and restores lines cut at the page width', async () => {
    const { compiledSource } = await import('../src/server/listings');
    const file = (listing: ReturnType<typeof parseListing>, kind: 'LS' | 'LE') => ({ path: `/x/A.${kind}`, kind, mtime: 0, listing });
    const ls = compiledSource([file(heaterLs, 'LS')], heater);
    expect(ls).toMatchObject({ listing: 'A.LS', kind: 'LS', compiled: '14/10/26 09:12', whole: true });
    expect(ls!.lines).toEqual(heater.slice(0, 7));

    const cut = parseListing(['     1            SET A = 1', '     2            SET B = 22222 +'].join('\n'));
    // Line 2 is at the listing's widest, so it was cut; a short line that grew is a change.
    expect(compiledSource([file(cut, 'LS')], ['    SET A = 1 + 1', '    SET B = 22222 + 3'])!.lines).toEqual(['    SET A = 1', '    SET B = 22222 + 3']);

    expect(compiledSource([file(valveLe, 'LE')], valve)).toMatchObject({ kind: 'LE', whole: false, lines: [] });
    expect(compiledSource([], valve)).toBeUndefined();
  });
});
