/**
 * Owner, 2026-11-13: "notch'ta sadece önemli bildirimler gözükmeli ... anlamsız önemsiz
 * bildirimler mac bildirimine dönsün". The ONE classifier (src/lib/notch-importance.ts): every
 * kind it knows, and an unknown one going to macOS.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { accountSwitchBanner, agentRunNews, bannerLang, notchShowsNews, ownerAskedRun, type NotchNews } from '../../src/lib/notch-importance.js';
import { postNews } from '../../src/server/assistant-inbox.js';

describe('what the notch shows (notchShowsNews)', () => {
  it('shows what waits on him or what he waits for', () => {
    for (const kind of ['ask', 'approval', 'super-reply', 'chat-finished', 'handoff-finished', 'assistant-progress'] as const) {
      expect(notchShowsNews({ kind }), kind).toBe(true);
    }
  });

  it('an agent post: only an answer to his message, a question or verdict for him, or a failure', () => {
    const post = (o: Partial<{ asked: boolean; needsYou: boolean; failed: boolean }>): NotchNews =>
      ({ kind: 'agent-post', asked: false, needsYou: false, failed: false, ...o });
    expect(notchShowsNews(post({}))).toBe(false);                 // a routine that ran fine
    expect(notchShowsNews(post({ asked: true }))).toBe(true);
    expect(notchShowsNews(post({ needsYou: true }))).toBe(true);
    expect(notchShowsNews(post({ failed: true }))).toBe(true);
  });

  it('an account: a stop needs him, a move the work went on through is info', () => {
    expect(notchShowsNews({ kind: 'account', switched: true, exhausted: false })).toBe(false);
    expect(notchShowsNews({ kind: 'account', switched: false, exhausted: true })).toBe(true);
    expect(notchShowsNews({ kind: 'account', switched: false, exhausted: false })).toBe(true);
  });

  it('task rows that wait on him show; any other row does not', () => {
    for (const row of ['task-plan', 'task-question', 'task-review', 'task-stuck', 'task-stalled', 'task-stopped', 'task-blocked', 'task-orphaned', 'task-start-missed']) {
      expect(notchShowsNews({ kind: 'task-row', row }), row).toBe(true);
    }
    expect(notchShowsNews({ kind: 'task-row', row: 'task-step' })).toBe(false);
    expect(notchShowsNews({ kind: 'task-row', row: 'secret-held' })).toBe(false);
  });

  it('a run starting, an app notice, and anything unknown go to macOS', () => {
    expect(notchShowsNews({ kind: 'run-started' })).toBe(false);
    expect(notchShowsNews({ kind: 'app' })).toBe(false);
    expect(notchShowsNews({ kind: 'other' })).toBe(false);
    expect(notchShowsNews({ kind: 'something-new' } as unknown as NotchNews)).toBe(false);
  });
});

describe('one run, read the same way by the runner and the feed (agentRunNews, postNews)', () => {
  it('the owner asked only when the run opens with HIS user entry, never an App\'s', () => {
    expect(ownerAskedRun({ kind: 'user', via: 'dashboard' })).toBe(true);
    expect(ownerAskedRun({ kind: 'user', via: 'telegram' })).toBe(true);
    expect(ownerAskedRun({ kind: 'user', via: 'app' })).toBe(false);   // an App ask, with or without its name
    expect(ownerAskedRun({ kind: 'system', via: 'runner' })).toBe(false);
    expect(ownerAskedRun(null)).toBe(false);
  });

  it('a run that POSTED and then failed is a failure for both (the reviewer\'s case)', () => {
    const runner = agentRunNews({ firstEntry: { kind: 'system', via: 'runner' }, status: 'failed', needsYou: false });
    const feed = postNews({ ownerAsked: false, needsYou: false, status: 'failed' });
    expect(runner).toEqual(feed);
    expect(notchShowsNews(runner)).toBe(true);
    expect(notchShowsNews(agentRunNews({ firstEntry: null, status: 'timeout', needsYou: false }))).toBe(true);
  });

  it('a routine that ran fine is macOS for both; an asked one is notch for both', () => {
    expect(notchShowsNews(postNews({ ownerAsked: false, needsYou: false, status: 'done' }))).toBe(false);
    expect(notchShowsNews(agentRunNews({ firstEntry: { kind: 'system' }, status: 'ok', needsYou: false }))).toBe(false);
    expect(notchShowsNews(postNews({ ownerAsked: true, needsYou: false, status: 'done' }))).toBe(true);
    expect(notchShowsNews(agentRunNews({ firstEntry: { kind: 'user', via: 'dashboard' }, status: 'ok', needsYou: false }))).toBe(true);
    expect(notchShowsNews(postNews({ ownerAsked: false, needsYou: true, status: 'needs-you' }))).toBe(true);
  });
});

describe('the macOS copy for an account move (EN + TR)', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('reads the Mac locale; Turkish for tr, English otherwise', () => {
    expect(bannerLang('tr-TR')).toBe('tr');
    expect(bannerLang('en-US')).toBe('en');
    expect(bannerLang(undefined)).toBe('en');
  });
  it('names both accounts and the project, with no em dash', () => {
    const en = accountSwitchBanner('a@x.com', 'b@y.com', 'acme', 'en');
    expect(en).toEqual({ title: 'Account switched · acme', body: 'a@x.com hit its limit. Work goes on with b@y.com.' });
    const tr = accountSwitchBanner('a@x.com', 'b@y.com', null, 'tr');
    expect(tr).toEqual({ title: 'Hesap değişti', body: 'a@x.com limitine ulaştı. İş b@y.com ile devam ediyor.' });
    expect(`${en.title}${en.body}${tr.title}${tr.body}`).not.toContain('—');
  });
});
