import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-open-missing-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
const SUPER = 'sup-missing';
const JOB = 'child-job-1';
let token = '';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;


function makeVault(withChild: string | null): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    children: { [JOB]: { sessionId: JOB, brief: 'the logo job', adopted: false, startedAt: 1, ...(withChild ? { worktree: withChild, branch: 'super/logo' } : {}) } },
  }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-open-missing-'));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(dir, { recursive: true, force: true });
});

function req(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function open(body: Record<string, unknown>) {
  const r = res();
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: 'open' });
  return r;
}
const put = (at: string) => { mkdirSync(dirname(at), { recursive: true }); writeFileSync(at, 'x'); };

describe('super open image|pdf|video: a file that is not there makes no card', () => {
  it.each([
    ['image', 'tmp/a/one.png'],
    ['pdf', 'tmp/a/one.pdf'],
    ['video', 'tmp/a/one.mp4'],
  ])('%s: refused with the missing path, no card, nothing presented', async (kind, ref) => {
    makeVault(null);
    const r = await open({ kind, refs: [ref], present: true });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.json)).toContain(ref);
    expect((await readSuperState(root)).containers).toEqual([]);
    expect((await readSuperState(root)).view.mode).not.toBe('present');
  });

  it('four pictures, one of them missing: all or nothing', async () => {
    makeVault(null);
    for (const n of ['a', 'b', 'c']) put(join(dir, 'acme', 'tmp', `${n}.png`));
    const r = await open({ kind: 'image', refs: ['tmp/a.png', 'tmp/b.png', 'tmp/c.png', 'tmp/d.png'], present: true });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.json)).toContain('tmp/d.png');
    expect((await readSuperState(root)).containers).toEqual([]);
  });

  it('says where a live child\'s worktree holds the same relative path', async () => {
    const wt = join(process.env.HOME as string, '.claude-worktrees', 'wt-logo');
    put(join(wt, '_dream_context/tmp/x/shot.png'));
    makeVault(wt);
    const r = await open({ kind: 'image', refs: ['_dream_context/tmp/x/shot.png'], present: true });
    expect(r.status).toBe(404);
    const msg = JSON.stringify(r.json);
    expect(msg).toContain(JOB);
    expect(msg).toContain("worktree");
    expect(msg).toContain('_dream_context/tmp/');
    expect((await readSuperState(root)).containers).toEqual([]);
  });

  it('a real file opens; a directory and a symlink out of the project do not', async () => {
    makeVault(null);
    put(join(dir, 'acme', 'tmp', 'ok.png'));
    mkdirSync(join(dir, 'acme', 'tmp', 'folder.png'), { recursive: true });
    put(join(dir, 'outside.png'));
    symlinkSync(join(dir, 'outside.png'), join(dir, 'acme', 'tmp', 'link.png'));
    expect((await open({ kind: 'image', refs: ['tmp/ok.png'] })).status).toBe(200);
    expect((await open({ kind: 'image', refs: ['tmp/folder.png'] })).status).toBe(404);
    const l = await open({ kind: 'image', refs: ['tmp/link.png'] });
    expect(l.status).toBe(404);
    expect(JSON.stringify(l.json)).toContain('outside this project');
  });
});
