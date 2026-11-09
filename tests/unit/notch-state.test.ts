/**
 * A notice the notch shows does not ALSO go out as a macOS banner while the notch is on screen
 * (owner, 2026-11-09: "notch açıksa ve bildirim notch'ta gözüken bir bildirimse normalden
 * bildirim gitmemeli"). The shell writes the panel's real state to `~/.dreamcontext/
 * notch-state.json` (desktop/src-tauri/src/assistant.rs); every banner path reads it here.
 * Every case runs against an injected temp home: none reaches the developer's real one.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NOTCH_STATE_TTL_MS,
  notchCovers,
  notchCoversBanner,
  notchListsAgent,
  notchMutedPath,
  notchStatePath,
  readNotchState,
} from '../../src/lib/notch-state.js';
import { notifierAppPath, notifyQueueDir, notifyViaBundle } from '../../src/lib/automations/notifier.js';
import { readNotifications } from '../../src/lib/notification-log.js';
import { notifyFromApp } from '../../src/lib/apps/app-notify.js';
import { createNotificationRoutes } from '../../src/server/routes/notifications.js';

const dirs: string[] = [];
const tmp = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'dc-notch-state-'))); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); delete process.env.DREAMCONTEXT_DESKTOP; });

const NOW = 1_800_000_000_000;

function writeState(home: string, body: unknown): void {
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(notchStatePath(home), typeof body === 'string' ? body : JSON.stringify(body));
}

describe('readNotchState: the shell report, believed only while fresh', () => {
  it('a fresh visible report is open, a fresh hidden one is closed', () => {
    const home = tmp();
    writeState(home, { visible: true, at: NOW - 1_000 });
    expect(readNotchState(home, NOW)).toBe('open');
    writeState(home, { visible: false, at: NOW - 1_000 });
    expect(readNotchState(home, NOW)).toBe('closed');
  });

  it('no report, junk, a stale beat or a time from the future is unknown', () => {
    const home = tmp();
    expect(readNotchState(home, NOW)).toBe('unknown');
    for (const junk of ['not json', '[]', 'null', { visible: 'yes', at: NOW }, { visible: true }, { visible: true, at: 'now' }]) {
      writeState(home, junk);
      expect(readNotchState(home, NOW)).toBe('unknown');
    }
    // The app quit or crashed: nobody refreshes the file, so it stops being believed.
    writeState(home, { visible: true, at: NOW - NOTCH_STATE_TTL_MS - 1 });
    expect(readNotchState(home, NOW)).toBe('unknown');
    writeState(home, { visible: true, at: NOW + 60_000 });
    expect(readNotchState(home, NOW)).toBe('unknown');
  });
});

describe('THE RULE: notchCoversBanner', () => {
  it('notch open + a notice the notch shows = no system banner', () => {
    expect(notchCoversBanner(true, 'open')).toBe(true);
  });
  it('notch closed or hidden = the banner goes', () => {
    expect(notchCoversBanner(true, 'closed')).toBe(false);
  });
  it('notch open + a notice the notch does not show = the banner goes', () => {
    expect(notchCoversBanner(false, 'open')).toBe(false);
    expect(notchCoversBanner(undefined, 'open')).toBe(false);
  });
  it('state unknown = the banner goes (better twice than never)', () => {
    expect(notchCoversBanner(true, 'unknown')).toBe(false);
  });
  it('notchCovers reads the live file the same way', () => {
    const home = tmp();
    expect(notchCovers(true, home, NOW)).toBe(false);
    writeState(home, { visible: true, at: NOW });
    expect(notchCovers(true, home, NOW)).toBe(true);
    expect(notchCovers(false, home, NOW)).toBe(false);
  });
});

describe('notchListsAgent: only a notice the notch really lists is held back', () => {
  const project = (home: string): string => {
    const root = join(home, 'proj');
    mkdirSync(join(root, '_dream_context'), { recursive: true });
    return root;
  };
  const register = (home: string, root: string): void => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: root }] }));
  };

  it('a registered project agent that is not muted: listed', () => {
    const home = tmp();
    const root = project(home);
    register(home, root);
    expect(notchListsAgent(join(root, '_dream_context'), 'digest', home)).toBe(true);
  });
  it('a muted agent: not listed, so its banner goes', () => {
    const home = tmp();
    const root = project(home);
    register(home, root);
    writeFileSync(notchMutedPath(home), JSON.stringify({ [root]: ['digest'] }));
    expect(notchListsAgent(join(root, '_dream_context'), 'digest', home)).toBe(false);
    expect(notchListsAgent(join(root, '_dream_context'), 'other', home)).toBe(true);
  });
  it('an unregistered project: not listed', () => {
    const home = tmp();
    expect(notchListsAgent(join(project(home), '_dream_context'), 'digest', home)).toBe(false);
  });
});

describe.skipIf(process.platform !== 'darwin')('notifyViaBundle honours the open notch', () => {
  const noOpen = vi.fn();

  it('notch open + notchShows: no banner queued or launched, a history row, and true (no fallback)', () => {
    const home = tmp();
    mkdirSync(notifierAppPath(home), { recursive: true });
    writeState(home, { visible: true, at: Date.now() });
    noOpen.mockClear();
    expect(notifyViaBundle('Digest', 'All good.', home, { openImpl: noOpen, link: 'dreamcontext://inbox', notchShows: true })).toBe(true);
    expect(noOpen).not.toHaveBeenCalled();
    expect(existsSync(notifyQueueDir(home))).toBe(false);
    expect(readNotifications(10, home).map((n) => n.title)).toEqual(['Digest']);
  });

  it('notch open + a notice it does not show: the banner goes', () => {
    const home = tmp();
    mkdirSync(notifierAppPath(home), { recursive: true });
    writeState(home, { visible: true, at: Date.now() });
    noOpen.mockClear();
    expect(notifyViaBundle('Sleep', 'Done.', home, { openImpl: noOpen })).toBe(true);
    expect(noOpen).toHaveBeenCalledTimes(1);
    expect(readdirSync(notifyQueueDir(home))).toHaveLength(1);
  });

  it('notch hidden, or no report at all: the banner goes', () => {
    for (const state of [{ visible: false, at: Date.now() }, null]) {
      const home = tmp();
      mkdirSync(notifierAppPath(home), { recursive: true });
      if (state) writeState(home, state);
      noOpen.mockClear();
      expect(notifyViaBundle('Digest', 'All good.', home, { openImpl: noOpen, notchShows: true })).toBe(true);
      expect(noOpen).toHaveBeenCalledTimes(1);
    }
  });
});

describe('an app notice (dc.notify) the notch shows', () => {
  const rec = { vault: 'acme', slug: 'hello', hash: 'abcdef0123456789' };

  it('notch open: neither the app bundle nor the fallback posts; it is answered "notch" and kept in history', async () => {
    const home = tmp();
    const post = vi.fn(async () => true);
    const fallback = vi.fn(() => true);
    const via = await notifyFromApp(
      { title: 'Hello', body: 'hi', rec, home, notchShows: true },
      { platform: 'darwin', canNotify: () => true, post, fallback, notchCovers: () => true },
    );
    expect(via).toBe('notch');
    expect(post).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(readNotifications(10, home).map((n) => n.title)).toEqual(['Hello']);
  });

  it('notch closed (or the notch got no row): the app posts as before', async () => {
    const home = tmp();
    const post = vi.fn(async () => true);
    const via = await notifyFromApp(
      { title: 'Hello', body: 'hi', rec, home, notchShows: true },
      { platform: 'darwin', canNotify: () => true, post, notchCovers: (shows) => shows === true && false },
    );
    expect(via).toBe('app');
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/notify carries the notch flag', () => {
  function fakeReq(body: unknown): IncomingMessage {
    return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: '/api/notify', headers: {} }) as unknown as IncomingMessage;
  }
  function fakeRes(): { res: ServerResponse; captured: { status: number; body: any } } {
    const captured = { status: 0, body: null as any };
    const res = {
      writeHead(status: number) { captured.status = status; return this; },
      setHeader() { return this; },
      end(payload?: string) { captured.body = payload ? JSON.parse(payload) : null; },
    } as unknown as ServerResponse;
    return { res, captured };
  }

  it('notch: true reaches the poster as notchShows; absent stays absent; a non-boolean is a 400', async () => {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    const post = vi.fn(() => true);
    const routes = createNotificationRoutes({ home: tmp(), post });
    const a = fakeRes();
    await routes.handleNotifyPost(fakeReq({ title: 'Claude is asking', body: 'Allow Bash?', notch: true }), a.res);
    expect(a.captured.body).toEqual({ posted: true });
    expect(post.mock.calls[0][3]).toEqual(expect.objectContaining({ notchShows: true }));
    const b = fakeRes();
    await routes.handleNotifyPost(fakeReq({ title: 'Claude is asking', body: 'Allow Bash?' }), b.res);
    expect(post.mock.calls[1][3]).not.toHaveProperty('notchShows');
    const c = fakeRes();
    await routes.handleNotifyPost(fakeReq({ title: 't', body: 'b', notch: 'yes' }), c.res);
    expect(c.captured.status).toBe(400);
    expect(post).toHaveBeenCalledTimes(2);
  });
});
