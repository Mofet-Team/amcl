import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'url';
import { fixture, pos } from './helpers';

// End-to-end: run the bundled server over stdio and speak LSP to it.
const serverPath = path.join(__dirname, '..', 'dist', 'server.js');

class Client {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly waiting = new Map<number, (result: unknown) => void>();
  readonly notifications: { method: string; params: any }[] = [];

  constructor(private readonly proc: ChildProcess) {
    proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const header = this.buffer.indexOf('\r\n\r\n');
        if (header < 0) return;
        const length = Number(/Content-Length: (\d+)/.exec(this.buffer.subarray(0, header).toString())![1]);
        if (this.buffer.length < header + 4 + length) return;
        const msg = JSON.parse(this.buffer.subarray(header + 4, header + 4 + length).toString());
        this.buffer = this.buffer.subarray(header + 4 + length);
        if (msg.id !== undefined && this.waiting.has(msg.id)) {
          this.waiting.get(msg.id)!(msg.result);
          this.waiting.delete(msg.id);
        } else if (msg.method) this.notifications.push(msg);
      }
    });
  }

  private send(msg: object) {
    const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
    this.proc.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params: object): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: object) {
    this.send({ method, params });
  }

  async waitFor(method: string): Promise<any> {
    for (let i = 0; i < 100; i++) {
      const n = this.notifications.find((x) => x.method === method);
      if (n) return n.params;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no ${method}`);
  }
}

describe.skipIf(!fs.existsSync(serverPath))('language server over stdio', () => {
  let proc: ChildProcess;
  let client: Client;
  const uri = 'file:///REACT1.CL';

  beforeAll(async () => {
    proc = spawn(process.execPath, [serverPath, '--stdio']);
    client = new Client(proc);
    const init = await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
    expect(init.capabilities).toMatchObject({ definitionProvider: true, documentSymbolProvider: expect.anything() });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'cl', version: 1, text: fixture('reactor.cl').replace('    END REACT1', '    GOTO NOWHERE\n    END REACT1') },
    });
  });

  afterAll(() => proc?.kill());

  it('publishes diagnostics', async () => {
    const d = await client.waitFor('textDocument/publishDiagnostics');
    expect(d.diagnostics.map((x: any) => x.message)).toContain("Undefined label 'NOWHERE'");
    expect(d.diagnostics.find((x: any) => x.message === 'STATES is defined but not referenced')).toMatchObject({ code: 'unused', tags: [1], severity: 2 });
  });

  it('answers documentSymbol, definition and foldingRange', async () => {
    const symbols = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
    expect(symbols.map((s: any) => s.name)).toEqual(['REACT1', 'HLD1', 'SHDN1', 'CHECK']);
    // Line 23 is `      CALL CHECK (NBATCH, FAGIT)`; character 12 is inside CHECK. The inserted
    // GOTO line moves the subroutine heading from line 48 to 49.
    const def = await client.request('textDocument/definition', { textDocument: { uri }, position: { line: 23, character: 12 } });
    expect(def.range.start.line).toBe(49);
    const folds = await client.request('textDocument/foldingRange', { textDocument: { uri } });
    expect(folds.length).toBeGreaterThan(5);
  });
});

describe.skipIf(!fs.existsSync(serverPath))('language server: workspace index', () => {
  const ws = path.join(__dirname, 'fixtures', 'ws');
  const mixerUri = pathToFileURL(path.join(ws, 'MIXER.CL')).toString();
  const mixer = fs.readFileSync(path.join(ws, 'MIXER.CL'), 'utf8');
  let proc: ChildProcess;
  let client: Client;

  beforeAll(async () => {
    proc = spawn(process.execPath, [serverPath, '--stdio']);
    client = new Client(proc);
    await client.request('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(ws).toString(), name: 'ws' }],
      initializationOptions: { encoding: 'utf8', pointDatabase: [] },
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', { textDocument: { uri: mixerUri, languageId: 'cl', version: 1, text: mixer } });
  });

  afterAll(() => proc?.kill());

  /** Ask until the background indexing has caught up. */
  async function until<T>(f: () => Promise<T>, ok: (x: T) => boolean): Promise<T> {
    for (let i = 0; i < 100; i++) {
      const x = await f();
      if (ok(x)) return x;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timed out waiting for the index');
  }

  it('goes to LOCALs on the same box flag in other files and to the database point', async () => {
    const position = pos(mixer, 'AGITATE', 1);
    const defs = await until(
      () => client.request('textDocument/definition', { textDocument: { uri: mixerUri }, position }),
      (d: any[]) => Array.isArray(d) && d.length === 3,
    );
    expect(defs.map((d: any) => path.basename(new URL(d.uri).pathname)).sort()).toEqual(['DOSER.CL', 'HPM09.EB', 'MIXER.CL']);
  });

  it('finds references across files', async () => {
    const refs = await client.request('textDocument/references', {
      textDocument: { uri: mixerUri },
      position: pos(mixer, 'DOSE_QTY', 1),
      context: { includeDeclaration: false },
    });
    expect(refs.map((d: any) => path.basename(new URL(d.uri).pathname)).sort()).toEqual(['AMBLK.CL', 'DOSER.CL', 'DOSER.CL', 'MIXER.CL']);
  });

  it('answers workspace symbol queries', async () => {
    const syms = await client.request('workspace/symbol', { query: 'TANK' });
    expect(syms.map((s: any) => s.name)).toEqual(['TANK_LVL']);
  });
});

describe.skipIf(!fs.existsSync(serverPath))('language server: compiler listings', () => {
  const ws = path.join(__dirname, 'fixtures', 'listing');
  const uriOf = (name: string) => pathToFileURL(path.join(ws, name)).toString();
  let proc: ChildProcess;
  let client: Client;

  beforeAll(async () => {
    proc = spawn(process.execPath, [serverPath, '--stdio']);
    client = new Client(proc);
    await client.request('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(ws).toString(), name: 'listing' }],
      initializationOptions: { encoding: 'utf8', pointDatabase: [] },
    });
    client.notify('initialized', {});
  });

  afterAll(() => proc?.kill());

  const diagnosticsFor = async (uri: string) => {
    for (let i = 0; i < 100; i++) {
      const n = client.notifications.filter((x) => x.method === 'textDocument/publishDiagnostics' && x.params.uri === uri).pop();
      if (n) return n.params.diagnostics;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no diagnostics for ${uri}`);
  };

  it('reports the errors of a failed compile on its source without opening it', async () => {
    const d = await diagnosticsFor(uriOf('VALVE.CL'));
    expect(d.map((x: any) => [x.message, x.code, x.range.start.line, x.range.start.character])).toEqual([
      ['Error in SET statement', 'compiler-error', 3, 16],
      ['XV3 not found', 'compiler-error', 4, 9],
    ]);
    expect(d[1].relatedInformation[0].location.uri).toBe(uriOf('VALVE.LE'));
  });

  it('serves an open error listing: diagnostics, outline, hover, and the way to the source', async () => {
    const uri = uriOf('VALVE.LE');
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'cl-listing', version: 1, text: fixture('listing/VALVE.LE') } });
    const d = await diagnosticsFor(uri);
    expect(d.map((x: any) => x.range.start.line)).toEqual([2, 6]);
    const symbols = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
    expect(symbols.map((s: any) => s.name)).toEqual(['Errors (2)']);
    const def = await client.request('textDocument/definition', { textDocument: { uri }, position: { line: 8, character: 4 } });
    expect(def).toMatchObject({ uri: uriOf('VALVE.CL'), range: { start: { line: 4, character: 9 }, end: { line: 4, character: 12 } } });
    const hover = await client.request('textDocument/hover', { textDocument: { uri }, position: { line: 8, character: 4 } });
    expect(hover.contents.value).toMatch(/pass 2/);
  });

  it('adds listing messages to an open source, without repeating its own warnings', async () => {
    const uri = uriOf('HEATER.CL');
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'cl', version: 1, text: fixture('listing/HEATER.CL') } });
    const d = await diagnosticsFor(uri);
    expect(d.filter((x: any) => x.source === 'CL compiler').map((x: any) => x.code)).toEqual(['compiler-note']);
    expect(d.filter((x: any) => x.code === 'unused')).toHaveLength(1);
  });
});
