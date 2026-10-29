/**
 * POST /api/agent/pick-paths — the composer's picker in a separate process (owner 2026-10-29:
 * "file picking mostly does not work", and the desktop app aborted inside wry's open panel). The
 * osascript runner is a seam here: no dialog ever opens in a test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PICK_SCRIPT, handleAgentPickPaths, parsePickedPaths, pickPathsInSeparateProcess, resetPickForTests, type OsascriptRunner,
} from '../../src/server/routes/agent-pick.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';
import { routePolicyFor } from '../../src/lib/handsfree/mac/route-policy.js';

class FakeReq extends EventEmitter {
  socket: { remoteAddress: string } = { remoteAddress: '127.0.0.1' };
  headers: Record<string, string> = { host: '127.0.0.1:4173' };
  constructor(body: string, opts: { phone?: boolean; from?: string; headers?: Record<string, string> } = {}) {
    super();
    this.socket.remoteAddress = opts.from ?? '127.0.0.1';
    if (opts.phone) markPhoneSocket(this.socket);
    Object.assign(this.headers, opts.headers ?? {});
    setTimeout(() => { this.emit('data', Buffer.from(body)); this.emit('end'); }, 0);
  }
}

function res() {
  let code = 0;
  let body: Record<string, unknown> = {};
  const em = new EventEmitter();
  const r = Object.assign(em, {
    headersSent: false,
    writableEnded: false,
    writeHead(c: number) { code = c; return r; },
    setHeader() {},
    end(d?: string) { if (typeof d === 'string') body = JSON.parse(d); r.writableEnded = true; },
  }) as unknown as ServerResponse & { writableEnded: boolean };
  return { r, status: () => code, body: () => body };
}

const ran: Array<{ script: string; args: string[] }> = [];
const answer = (code: number | null, stdout: string, stderr = ''): OsascriptRunner => async (script, args) => {
  ran.push({ script, args });
  return { code, stdout, stderr };
};

async function call(body: unknown, run: OsascriptRunner, opts: ConstructorParameters<typeof FakeReq>[1] = {}) {
  const x = res();
  await handleAgentPickPaths(new FakeReq(JSON.stringify(body), opts) as unknown as IncomingMessage, x.r, {}, '/nowhere', run, 'darwin');
  return x;
}

let desktopBefore: string | undefined;
beforeEach(() => {
  ran.length = 0;
  resetPickForTests();
  desktopBefore = process.env.DREAMCONTEXT_DESKTOP;
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  if (desktopBefore === undefined) delete process.env.DREAMCONTEXT_DESKTOP;
  else process.env.DREAMCONTEXT_DESKTOP = desktopBefore;
});

describe('parsePickedPaths', () => {
  it('one absolute path per line; a folder loses its trailing slash; blanks and noise are skipped', () => {
    expect(parsePickedPaths('/Users/x/a b.png\n/Users/x/Proje/\n\nnot a path\r\n/\n')).toEqual(['/Users/x/a b.png', '/Users/x/Proje', '/']);
  });
});

describe('pickPathsInSeparateProcess', () => {
  it('files, many: the script gets "files many" and the paths come back', async () => {
    expect(await pickPathsInSeparateProcess(false, true, answer(0, '/a/1.png\n/a/2.pdf\n'), undefined, 'darwin')).toEqual(['/a/1.png', '/a/2.pdf']);
    expect(ran[0]).toEqual({ script: PICK_SCRIPT, args: ['files', 'many'] });
  });

  it('folders, one: "folders one"', async () => {
    expect(await pickPathsInSeparateProcess(true, false, answer(0, '/a/dir/\n'), undefined, 'darwin')).toEqual(['/a/dir']);
    expect(ran[0].args).toEqual(['folders', 'one']);
  });

  it('a cancel (-128) is an empty pick, not a failure', async () => {
    expect(await pickPathsInSeparateProcess(false, true, answer(1, '', 'execution error: User canceled. (-128)'), undefined, 'darwin')).toEqual([]);
  });

  it('any other failure throws with osascript\'s words', async () => {
    await expect(pickPathsInSeparateProcess(false, true, answer(1, '', 'execution error: boom (-1700)'), undefined, 'darwin')).rejects.toThrow(/boom/);
  });

  it('off macOS it refuses without running anything', async () => {
    await expect(pickPathsInSeparateProcess(false, true, answer(0, '/a'), undefined, 'linux')).rejects.toThrow(/macOS-only/);
    expect(ran).toHaveLength(0);
  });

  it('the script asks for a picker and prints POSIX paths, one per line', () => {
    expect(PICK_SCRIPT).toMatch(/choose file/);
    expect(PICK_SCRIPT).toMatch(/choose folder/);
    expect(PICK_SCRIPT).toMatch(/POSIX path of p & linefeed/);
    expect(PICK_SCRIPT).toMatch(/\n\s*activate\n/);
  });
});

describe('POST /api/agent/pick-paths', () => {
  it('answers the picked paths from the owner window', async () => {
    const x = await call({ directory: false, multiple: true }, answer(0, '/Users/x/shot.png\n'), { headers: { origin: 'http://127.0.0.1:4173', 'sec-fetch-site': 'same-origin' } });
    expect(x.status()).toBe(200);
    expect(x.body()).toEqual({ paths: ['/Users/x/shot.png'] });
    expect(ran[0].args).toEqual(['files', 'many']);
  });

  it('a cancel is 200 with no paths', async () => {
    const x = await call({ directory: true, multiple: true }, answer(1, '', 'User canceled. (-128)'));
    expect(x.status()).toBe(200);
    expect(x.body()).toEqual({ paths: [] });
  });

  it('a picker that cannot open is a 500 with a reason the composer can show', async () => {
    const x = await call({}, answer(null, '', 'spawn ENOENT'));
    expect(x.status()).toBe(500);
    expect(String(x.body().message)).toMatch(/ENOENT/);
  });

  it('refuses the phone, another origin, a non-loopback peer and a non-desktop server — and never opens a dialog for them', async () => {
    expect((await call({}, answer(0, '/a'), { phone: true })).status()).toBe(403);
    expect((await call({}, answer(0, '/a'), { headers: { origin: 'http://127.0.0.1:5173' } })).status()).toBe(403);
    expect((await call({}, answer(0, '/a'), { headers: { 'sec-fetch-site': 'cross-site' } })).status()).toBe(403);
    expect((await call({}, answer(0, '/a'), { from: '192.168.1.20' })).status()).toBe(403);
    expect((await call({}, answer(0, '/a'), { headers: { host: 'evil.test:4173' } })).status()).toBe(403);
    process.env.DREAMCONTEXT_DESKTOP = '0';
    expect((await call({}, answer(0, '/a'))).status()).toBe(403);
    expect(ran).toHaveLength(0);
  });

  it('one dialog at a time: a second ask while one is open is 409', async () => {
    let release!: () => void;
    const slow: OsascriptRunner = () => new Promise((resolve) => { release = () => resolve({ code: 0, stdout: '/a/1\n', stderr: '' }); });
    const first = call({}, slow);
    await new Promise((r) => setTimeout(r, 5));
    const second = await call({}, answer(0, '/b'));
    expect(second.status()).toBe(409);
    release();
    expect((await first).body()).toEqual({ paths: ['/a/1'] });
    // Closed again: the next ask opens.
    expect((await call({}, answer(0, '/c\n'))).body()).toEqual({ paths: ['/c'] });
  });

  it('a malformed body is a 400', async () => {
    const x = res();
    await handleAgentPickPaths(new FakeReq('{nope') as unknown as IncomingMessage, x.r, {}, '/nowhere', answer(0, '/a'), 'darwin');
    expect(x.status()).toBe(400);
  });

  it('the phone listener denies the route outright', () => {
    expect(routePolicyFor('POST', '/api/agent/pick-paths')?.allow).toBe(false);
  });
});
