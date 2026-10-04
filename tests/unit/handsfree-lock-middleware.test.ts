// The ONE lock middleware (D3/AC6): every mutating /api/* request whose resolved vault sits
// inside a locked root gets 423 handsfree_away; reads pass; /api/handsfree/* is exempt; an
// unreadable state file locks everything (fail closed) and names the file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerResponse, IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { bodySelectedVaultLock, handsfreeLockRefusal, isBodySelectorRoute, screenBodySelectedVault, sendHandsfreeAway } from '../../src/server/routes/handsfree.js';
import { parseJsonBody } from '../../src/server/middleware.js';
import { beginGoing, setPhase, statePath, lastGoodPath } from '../../src/lib/handsfree/trip-state.js';
import { rootIdFor } from '../../src/lib/handsfree/manifest.js';

let home: string;
let vault: string;
let other: string;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'hf-lock-')));
  vault = join(home, 'projects', 'app');
  other = join(home, 'projects', 'other');
  mkdirSync(join(vault, '_dream_context'), { recursive: true });
  mkdirSync(join(other, '_dream_context'), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('handsfreeLockRefusal', () => {
  it('is a no-op while home', () => {
    expect(handsfreeLockRefusal('POST', '/api/tasks', join(vault, '_dream_context'), home)).toBeNull();
  });

  it('refuses mutating requests scoped to a locked vault from the first step of go; reads and other vaults pass', async () => {
    await beginGoing('t-1', [{ rootId: rootIdFor(vault), path: vault }], home);
    const ctx = join(vault, '_dream_context');
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(handsfreeLockRefusal(m, '/api/tasks/x', ctx, home)).toMatchObject({ tripId: 't-1', phase: 'going', rootId: rootIdFor(vault) });
    }
    // The lab cache sync and whiteboard nav are mutating routes like any other.
    expect(handsfreeLockRefusal('POST', '/api/lab/sync', ctx, home)).not.toBeNull();
    expect(handsfreeLockRefusal('PUT', '/api/whiteboards/main', ctx, home)).not.toBeNull();
    expect(handsfreeLockRefusal('GET', '/api/tasks', ctx, home)).toBeNull();
    expect(handsfreeLockRefusal('POST', '/api/tasks', join(other, '_dream_context'), home)).toBeNull();
    expect(handsfreeLockRefusal('POST', '/api/tasks', null, home)).toBeNull();
    await setPhase('away', 't-1', home);
    expect(handsfreeLockRefusal('PUT', '/api/agent/sessions', ctx, home)).toMatchObject({ phase: 'away' });
  });

  it('exempts /api/handsfree/* (go, return, the cloud transfer routes)', async () => {
    await beginGoing('t-1', [{ rootId: rootIdFor(vault), path: vault }], home);
    const ctx = join(vault, '_dream_context');
    expect(handsfreeLockRefusal('POST', '/api/handsfree/return', ctx, home)).toBeNull();
    expect(handsfreeLockRefusal('POST', '/api/handsfree/cloud/seal', ctx, home)).toBeNull();
    expect(handsfreeLockRefusal('POST', '/api/handsfreeX', ctx, home)).not.toBeNull();
  });

  it('an unreadable state file locks every vault and names the file', () => {
    mkdirSync(join(home, '.dreamcontext', 'handsfree'), { recursive: true });
    writeFileSync(statePath(home), '{not json');
    writeFileSync(lastGoodPath(home), 'also broken');
    const lock = handsfreeLockRefusal('POST', '/api/tasks', join(other, '_dream_context'), home);
    expect(lock?.error).toContain(statePath(home));
  });

  it('answers 423 handsfree_away', async () => {
    await beginGoing('t-9', [{ rootId: rootIdFor(vault), path: vault }], home);
    const lock = handsfreeLockRefusal('POST', '/api/tasks', join(vault, '_dream_context'), home)!;
    const res = new ServerResponse(new IncomingMessage(new Socket())) as ServerResponse & { code?: number; body?: string };
    res.writeHead = ((c: number) => { res.code = c; return res; }) as typeof res.writeHead;
    res.end = ((b?: unknown) => { res.body = String(b); return res; }) as typeof res.end;
    sendHandsfreeAway(res, lock);
    expect(res.code).toBe(423);
    expect(JSON.parse(res.body!)).toMatchObject({ error: 'handsfree_away', tripId: 't-9', phase: 'going' });
  });
});

describe('vault named in the body or query of a vault-agnostic route (round 2)', () => {
  it('only mutating /api/launcher, /api/assistant and /api/agent/accounts routes are screened', () => {
    expect(isBodySelectorRoute('POST', '/api/launcher/connection')).toBe(true);
    expect(isBodySelectorRoute('POST', '/api/assistant/proposals/x')).toBe(true);
    expect(isBodySelectorRoute('POST', '/api/agent/accounts/preferred')).toBe(true);
    expect(isBodySelectorRoute('GET', '/api/launcher/status')).toBe(false);
    expect(isBodySelectorRoute('POST', '/api/tasks')).toBe(false);
  });

  it('a registered vault NAME, an absolute path inside, a ~/ path or a ?vault= query hits the lock; others pass', async () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'app', path: vault }, { name: 'other', path: other }] }));
    await beginGoing('t-7', [{ rootId: rootIdFor(vault), path: vault }], home);
    const q = new URLSearchParams();
    expect(bodySelectedVaultLock({ from: 'app', to: 'other' }, q, home)).toMatchObject({ tripId: 't-7' });
    expect(bodySelectedVaultLock({ url: 'https://x/y.git', parentDir: join(vault, 'sub') }, q, home)).toMatchObject({ tripId: 't-7' });
    expect(bodySelectedVaultLock({ nested: { list: ['~/projects/app/_dream_context'] } }, q, home)).toMatchObject({ tripId: 't-7' });
    expect(bodySelectedVaultLock(null, new URLSearchParams('vault=app'), home)).toMatchObject({ tripId: 't-7' });
    expect(bodySelectedVaultLock({ from: 'other', parentDir: join(home, 'elsewhere') }, q, home)).toBeNull();
  });

  it('screenBodySelectedVault refuses a locked target and replays the exact body to the handler otherwise', async () => {
    await beginGoing('t-8', [{ rootId: rootIdFor(vault), path: vault }], home);
    const mk = (body: string) => {
      const r = new IncomingMessage(new Socket());
      r.method = 'POST';
      r.url = '/api/launcher/clone';
      r.headers = { 'content-type': 'application/json' };
      setImmediate(() => { r.push(body); r.push(null); });
      return r;
    };
    const url = new URL('http://localhost/api/launcher/clone');
    const refused = await screenBodySelectedVault(mk(JSON.stringify({ url: 'https://x/y.git', parentDir: vault })), url, home);
    expect('lock' in refused && refused.lock.tripId).toBe('t-8');
    const ok = await screenBodySelectedVault(mk(JSON.stringify({ url: 'https://x/y.git', parentDir: other })), url, home);
    expect('req' in ok).toBe(true);
    if ('req' in ok) expect(await parseJsonBody(ok.req)).toEqual({ url: 'https://x/y.git', parentDir: other });
  });
});
