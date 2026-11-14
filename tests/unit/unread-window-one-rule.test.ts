/**
 * The unread window is ONE rule (`runInUnreadWindow`, lib/automations/feed.ts), anchored on a run's
 * LAST activity: the feed (chips, bars, sidebar badge, the inbox Telegram and the notch read) and an
 * agent's history pane count the same run the same. Fictional project and agents only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAgent } from '../../src/lib/agents/store.js';
import { listAgentHistory } from '../../src/lib/agents/history.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { buildFeed, runInUnreadWindow } from '../../src/lib/automations/feed.js';
import { createQuestion } from '../../src/lib/automations/hitl.js';
import { appendThreadEntry, markThreadRead, readThread } from '../../src/lib/automations/threads.js';
import type { ThreadEntry } from '../../src/lib/automations/types.js';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const OLD_RUN = '2026-10-25T09:00:00.000Z'; // 20 days before NOW, outside the 14-day window
const TODAY = '2026-11-14T10:00:00.000Z';
let projectRoot: string;
let contextRoot: string;
let home: string;
let realHome: string | undefined;

beforeEach(() => {
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-unread-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-unread-home-')));
  realHome = process.env.HOME;
  process.env.HOME = home;
  createAgent(contextRoot, { slug: 'herodot', title: 'Herodot', prompt: 'herodot watches the fictional Acme line.', learning: false }, { approve: { now: NOW, home } });
  createAutomation(contextRoot, { slug: 'line-watch', title: 'Line watch', agent: 'herodot', days: 'daily', at: '09:00', timeoutMinutes: 5 }, { approve: { now: NOW, home } });
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const put = (kind: ThreadEntry['kind'], at: string, extra: Partial<{ event: ThreadEntry['event']; text: string }> = {}) =>
  appendThreadEntry(contextRoot, 'line-watch', {
    runId: OLD_RUN, kind, text: extra.text ?? `${kind} at ${at}`, via: kind === 'user' ? 'dashboard' : kind === 'agent' ? 'cli' : 'runner',
    now: new Date(at), ...(extra.event ? { event: extra.event } : {}),
  });

const counts = () => {
  const feed = buildFeed(contextRoot, { home, now: NOW });
  const pane = listAgentHistory(contextRoot, 'herodot', { audience: 'owner', home, now: NOW });
  return {
    feed: feed.unreadBySlug['line-watch'] ?? 0,
    pane: pane.unreadCount,
    feedMessage: feed.messages.find((m) => m.slug === 'line-watch' && m.runId === OLD_RUN) ?? null,
    paneSession: pane.sessions.find((s) => s.kind === 'run') ?? null,
  };
};

describe('one unread window for the feed and the history pane', () => {
  it('a run started 20 days ago and answered today counts the same, and whole, in both', () => {
    put('system', OLD_RUN, { event: 'started', text: 'Run started.' });
    put('agent', '2026-10-25T09:01:00.000Z', { text: 'Acme line is down.' });
    put('system', '2026-10-25T09:02:00.000Z', { event: 'ok', text: 'Finished.' });
    put('user', TODAY, { text: 'Is it back?' });
    put('agent', '2026-11-14T10:01:00.000Z', { text: 'Back since 08:00.' });

    const c = counts();
    // Both posts are unread: the old one was never seen, and the run is alive again.
    expect(c.feed).toBe(2);
    expect(c.pane).toBe(2);
    expect(c.feedMessage?.unread).toBe(true);
    expect(c.paneSession?.unread).toBe(true);
    expect(c.feedMessage?.newestId).toBe(c.paneSession?.newestId);

    // Read up to the newest: nothing left anywhere.
    markThreadRead(contextRoot, 'line-watch', readThread(contextRoot, 'line-watch').at(-1)!.id, home);
    const after = counts();
    expect(after.feed).toBe(0);
    expect(after.pane).toBe(0);
  });

  it('a run 20 days old that nobody touched since counts in neither', () => {
    put('system', OLD_RUN, { event: 'started', text: 'Run started.' });
    put('agent', '2026-10-25T09:01:00.000Z', { text: 'Acme line is down.' });
    const c = counts();
    expect(c.feed).toBe(0);
    expect(c.pane).toBe(0);
    expect(c.feedMessage).toBeNull();
  });

  it('a run 20 days old stopped on an open question counts in both', () => {
    put('system', OLD_RUN, { event: 'started', text: 'Run started.' });
    put('system', '2026-10-25T09:01:00.000Z', { event: 'asked', text: 'Asked the owner.' });
    createQuestion(contextRoot, { slug: 'line-watch', runFiredAt: OLD_RUN, kind: 'flow-hitl', question: 'Restart Acme?', choices: [], sessionId: null, channel: 'chat' });
    const c = counts();
    expect(c.feed).toBe(1);
    expect(c.pane).toBe(c.feed);
  });

  it('the rule itself: last activity inside, or held by an open question', () => {
    const e = (at: string): ThreadEntry => ({ id: at, runId: OLD_RUN, kind: 'agent', at, text: '', via: 'cli' });
    expect(runInUnreadWindow([e(OLD_RUN)], '2026-10-31')).toBe(false);
    expect(runInUnreadWindow([e(OLD_RUN), e(TODAY)], '2026-10-31')).toBe(true);
    expect(runInUnreadWindow([e(OLD_RUN)], '2026-10-31', true)).toBe(true);
  });
});
