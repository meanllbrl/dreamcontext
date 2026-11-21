// Live links, the lifecycle (plan C5, D9, D10, D12, D13; criteria K6, K10, K11): every state can
// be closed, every close is complete, no caller waits on the grace, a stronger close cancels it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  allShares, closeAllShares, closeShare, closeSharesFor, getShare, listShares, openShare, sharedLive, liveShare, sharesRoot, sweepShareDirs, type Share,
} from '../../src/server/shares/registry.js';
import { fakeKind, fakeWorld, openAndWait, sessionCookie, upgradeViaTunnel, viaTunnel, waitFor, type FakeWorld, type KindSpy } from './share-fixture.js';

let world: FakeWorld;
let kind: KindSpy;
const HTML = { accept: 'text/html' };

beforeEach(() => {
  world = fakeWorld();
  kind = fakeKind('app');
});
afterEach(async () => { await closeAllShares('shutdown'); });

let n = 0;
const start = (slug = `a${n++}`, extra: { ai?: boolean } = {}): Share => openShare({ kind: 'app', vault: 'demo', slug, ...extra }).share;
const gone = (s: Share): boolean => getShare(s.id) === null;

async function guestOf(s: Share): Promise<string> {
  return sessionCookie(await viaTunnel(s, 'GET', `/k/${s.token}`, HTML));
}

describe('start', () => {
  it('hands out a link only once the probe passed; the awake hold starts at open', async () => {
    world.hangIn.probe = true;
    const s = start();
    await waitFor(() => s.stage === 'probe');
    expect(s.state).toBe('starting');
    expect(listShares()[0]).toMatchObject({ state: 'starting', stage: 'probe', password: false, ai: false });
    // The probe path answers its nonce; nothing else does yet, not even the right token.
    const p = await viaTunnel(s, 'GET', '/__share/probe');
    expect(p.status).toBe(204);
    expect(p.headers['x-dreamcontext-share-probe']).toBe(s.nonce);
    expect((await viaTunnel(s, 'GET', `/k/${s.token}`, HTML)).status).toBe(401);
    expect(world.caffeinates).toHaveLength(0);
    world.hangIn.probe = false;
    await closeShare(s.id, 'owner');
    await waitFor(() => gone(s));
    const t = await openAndWait(() => start());
    expect(t.state).toBe('open');
    expect(world.caffeinates).toHaveLength(1);
    expect(world.awake.held).toBe(1);
  });

  it('two concurrent opens of one target give one share (D9); a broken one does not count', async () => {
    const a = openShare({ kind: 'app', vault: 'demo', slug: 'same' });
    const b = openShare({ kind: 'app', vault: 'demo', slug: 'same' });
    expect(a.existing).toBe(false);
    expect(b.existing).toBe(true);
    expect(b.share).toBe(a.share);
    await waitFor(() => a.share.state === 'open');
    world.children[world.children.length - 1].die(1);
    await waitFor(() => a.share.state === 'broken');
    const c = openShare({ kind: 'app', vault: 'demo', slug: 'same' });
    expect(c.existing).toBe(false);
    expect(c.share.id).not.toBe(a.share.id);
  });

  it('a failed probe is broken, torn down, never open', async () => {
    world.probeOk = false;
    const s = start();
    await waitFor(() => s.state === 'broken');
    expect(s.error).toBe('probe_failed');
    await waitFor(() => !world.children[0].alive);
    await waitFor(() => !existsSync(s.dir));
    expect(world.caffeinates).toHaveLength(0);
    // The row stays ("Bağlantı koptu"); an owner close dismisses it.
    expect(listShares().map((x) => x.state)).toEqual(['broken']);
    await closeShare(s.id, 'owner');
    expect(gone(s)).toBe(true);
  });
});

describe('close during each start stage', () => {
  for (const stage of ['download', 'tunnel', 'probe'] as const) {
    it(`closes from ${stage}: no child left, listener closed, dir and lease gone`, async () => {
      world.hangIn[stage] = true;
      const s = start();
      await waitFor(() => s.stage === stage && (stage === 'download' ? s.listener !== null : true));
      const port = s.port;
      const t0 = Date.now();
      await closeShare(s.id, 'owner');
      expect(Date.now() - t0).toBeLessThan(1000);
      await waitFor(() => gone(s), 2000, 'gone');
      for (const c of world.children) expect(c.alive).toBe(false);
      expect(existsSync(s.dir)).toBe(false);
      expect(kind.released).toBe(kind.holds);
      expect(world.caffeinates).toHaveLength(0);
      if (port) await expect(viaTunnel({ ...s, port } as Share, 'GET', '/')).rejects.toThrow();
    });
  }
});

describe('owner close of an open share (K6)', () => {
  it('answers only the closed page at once, cuts sessions and an open WebSocket, then tears down after the grace', async () => {
    const s = await openAndWait(() => start());
    const cookie = await guestOf(s);
    const ws = await upgradeViaTunnel(s, '/live', { cookie });
    expect(ws.status).toBe(101);
    const wsClosed = new Promise<number>((r) => { const t0 = Date.now(); ws.sock.once('close', () => r(Date.now() - t0)); });
    const t0 = Date.now();
    await closeShare(s.id, 'owner');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.state).toBe('closing');
    expect(await wsClosed).toBeLessThan(1000);
    for (const path of ['/', '/api/board', `/k/${s.token}`, '/__share/login', '/anything/else']) {
      const r = await viaTunnel(s, 'GET', path, { ...HTML, cookie });
      expect(r.status).toBe(410);
      expect(r.body).toContain('Bu paylaşım kapandı');
    }
    const j = await viaTunnel(s, 'POST', '/api/x', { cookie }, '{}');
    expect(j.status).toBe(410);
    expect(JSON.parse(j.body)).toEqual({ error: 'share_closed' });
    // Every upgrade is refused during the grace.
    expect((await upgradeViaTunnel(s, '/live', { cookie })).status).toBe(0);
    // The lease is released at step 2, the awake hold at teardown.
    expect(kind.released).toBe(kind.holds);
    expect(world.children[0].alive).toBe(true);
    // AI gate ends at closing (C10): not live any more.
    expect(sharedLive(s.key)).toBe(false);
    expect(liveShare(s.key)).toBeNull();
    await waitFor(() => gone(s), 2000, 'grace teardown');
    expect(world.children[0].alive).toBe(false);
    expect(existsSync(s.dir)).toBe(false);
    expect(world.awake.held).toBe(0);
    expect(world.caffeinates[0].alive).toBe(false);
  });

  it('a second close during the grace ends it at once', async () => {
    world = fakeWorld({ graceMs: 60_000 });
    kind = fakeKind('app');
    const s = await openAndWait(() => start());
    await closeShare(s.id, 'owner');
    expect(s.state).toBe('closing');
    await closeShare(s.id, 'owner');
    await waitFor(() => gone(s), 1000);
    expect(world.children[0].alive).toBe(false);
  });

  it('a stronger close (app removed) during the grace tears down at once', async () => {
    world = fakeWorld({ graceMs: 60_000 });
    kind = fakeKind('app');
    const s = await openAndWait(() => start('removed-one'));
    await closeShare(s.id, 'owner');
    const t0 = Date.now();
    await closeSharesFor(s.key, 'removed');
    expect(Date.now() - t0).toBeLessThan(1000);
    await waitFor(() => gone(s), 1000);
    expect(world.children[0].alive).toBe(false);
  });

  it('cloudflared dying during the grace just ends it (not broken)', async () => {
    world = fakeWorld({ graceMs: 60_000 });
    kind = fakeKind('app');
    const s = await openAndWait(() => start());
    await closeShare(s.id, 'cli');
    world.children[0].die(0);
    await waitFor(() => gone(s), 1000);
    expect(s.state).toBe('closing');
  });

  it('a starting share gets no grace', async () => {
    world.hangIn.probe = true;
    const s = start();
    await waitFor(() => s.stage === 'probe');
    await closeShare(s.id, 'owner');
    await waitFor(() => gone(s), 1000);
  });
});

describe('cloudflared dies (D10)', () => {
  it('an open share turns broken with its row kept, and is torn down', async () => {
    const s = await openAndWait(() => start());
    const cookie = await guestOf(s);
    world.children[0].die(1);
    await waitFor(() => s.state === 'broken');
    expect(s.error).toBe('tunnel_exited');
    await waitFor(() => s.teardown !== null);
    await s.teardown;
    expect(existsSync(s.dir)).toBe(false);
    expect(world.awake.held).toBe(0);
    expect(listShares()).toEqual([expect.objectContaining({ id: s.id, state: 'broken', error: 'tunnel_exited' })]);
    await expect(viaTunnel(s, 'GET', '/', { cookie })).rejects.toThrow();
    // No restart: one child only.
    expect(world.children).toHaveLength(1);
  });
});

describe('shutdown (K10)', () => {
  it('closeAllShares kills every share\'s cloudflared, open, starting and in its grace, within the 5 s exit', async () => {
    world = fakeWorld({ graceMs: 60_000 });
    kind = fakeKind('app');
    world.stubborn = true; // ignores SIGTERM: the 3 s SIGKILL (150 ms here) ends it
    const open1 = await openAndWait(() => start('one'));
    const grace = await openAndWait(() => start('two'));
    await closeShare(grace.id, 'owner');
    world.hangIn.probe = true;
    const starting = start('three');
    await waitFor(() => starting.stage === 'probe');
    const t0 = Date.now();
    await closeAllShares('shutdown');
    expect(Date.now() - t0).toBeLessThan(5000);
    for (const c of world.children) {
      expect(c.alive).toBe(false);
      expect(c.signals).toContain('SIGKILL');
    }
    expect(allShares()).toEqual([]);
    for (const s of [open1, grace, starting]) expect(existsSync(s.dir)).toBe(false);
    expect(world.awake.held).toBe(0);
  });
});

describe('the boot sweep', () => {
  it('removes share dirs whose recorded cloudflared is dead and keeps a live one', () => {
    const root = sharesRoot(world.home);
    mkdirSync(join(root, 'deadshare1'), { recursive: true });
    writeFileSync(join(root, 'deadshare1', 'pid'), '999999');
    mkdirSync(join(root, 'liveshare1'), { recursive: true });
    writeFileSync(join(root, 'liveshare1', 'pid'), String(process.pid));
    mkdirSync(join(root, 'nopidshare'), { recursive: true });
    sweepShareDirs(world.home);
    expect(existsSync(join(root, 'deadshare1'))).toBe(false);
    expect(existsSync(join(root, 'nopidshare'))).toBe(false);
    expect(existsSync(join(root, 'liveshare1'))).toBe(true);
  });
});
