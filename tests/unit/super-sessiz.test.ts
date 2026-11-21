/**
 * The Super does not go quiet (task super-sessiz-kalmaz): a job the owner waits on that runs on
 * with nothing told becomes ONE `progress` event (criteria 1-5), `super state` reads a child held
 * by its background work as `background` (6), `super read <team-job>` gives the facts of a running
 * job (7), the K6 nudge waits only for a child that still runs (9), a refused Telegram text names
 * its refs (10) and the briefing's time rule is the measured one (11).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-sessiz-home-`);
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetChatRegistry, registerChat, type ChatEntry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperChild, type SuperOwed, type SuperQueueItem, type SuperState, type SuperTeamJob, type TeamJobStatus } from '../../src/lib/super/types.js';
import {
  OWNER_VOICE, PROGRESS_DUE_MS, PROGRESS_LINE, _resetSuperInbox, _superInboxDrained, attachSuperInbox, notStalledReason, ownerPresent, progressDraft, progressDue,
  pruneProgressDraft, pumpSuper, setRow, stampToldDraft, startSuperInbox, superBatchText, writeSuper, type SuperInbox, type SuperEventFrame,
} from '../../src/lib/super/inbox.js';
import { setRequestSource, setTeamLiveSource, teamJobStatusNow, teamProgressRead } from '../../src/lib/super/team.js';
import { owedRef, owedClock, openDebts } from '../../src/lib/super/owed.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import { undeliveredNote } from '../../src/lib/super/undelivered.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { liveChildStatus } from '../../src/server/routes/super.js';
import { SUPER_BRIEF_TEXT } from '../../src/server/chat-modes.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 21, 9, 0, 0);
const SUPER = 'sup-sessiz-1';
const ORIGIN = 'abc123';
const at = (m: number) => T0 + m * MIN;

const awaitedChild = (sid: string, over: Partial<SuperChild> = {}): SuperChild => ({
  sessionId: sid, brief: `brief of ${sid}`, adopted: false, startedAt: at(0), row: 'working', rowAt: at(0), workingSince: at(0), awaited: true, origin: ORIGIN, ...over,
});
const msgDebt = (id: string, ref: string, m: number, closed = true): SuperOwed => ({
  id, kind: 'msg', ref, seq: Number(id.slice(1)), at: at(m), gist: 'his words', nudges: 0, ...(closed ? { closed: { at: at(m), by: 'mark' as const } } : {}),
});
const state = (over: Partial<SuperState> = {}): SuperState => ({ ...emptySuperState(), enabled: true, session: SUPER, ...over });
const NO_TEAMS = new Map<string, TeamJobStatus>();
const progressItems = (s: SuperState) => s.queue.filter((q) => q.kind === 'progress');

describe('criterion 1: the clock', () => {
  const base = () => state({ children: { c1: awaitedChild('c1') }, owed: [msgDebt('o1', 'msg005', 5)] });

  it('an awaited working child, his message answered at minute 5: exactly one progress item at minute 15', () => {
    const s = base();
    expect(progressDraft(s, at(14.9), NO_TEAMS).added).toBe(false);
    expect(progressItems(s)).toHaveLength(0);
    expect(progressDraft(s, at(15), NO_TEAMS).added).toBe(true);
    expect(progressItems(s)).toHaveLength(1);
    expect(progressItems(s)[0]).toMatchObject({ state: 'pending', sessionId: SUPER, progress: { jobs: [{ child: 'c1', ref: ORIGIN }] } });
    // The next sweep adds nothing: the job is already on the pending item.
    expect(progressDraft(s, at(16), NO_TEAMS).added).toBe(false);
    expect(progressItems(s)).toHaveLength(1);
  });

  it('a Super text under re:<origin> at minute 10, no debt open: none before minute 25', () => {
    const s = base();
    expect(openDebts(s)).toHaveLength(0);
    expect(stampToldDraft(s, [ORIGIN], at(10))).toBe(true);
    progressDraft(s, at(24.9), NO_TEAMS);
    expect(progressItems(s)).toHaveLength(0);
    progressDraft(s, at(25), NO_TEAMS);
    expect(progressItems(s)).toHaveLength(1);
  });

  it('his message at minute 14 answered under its own ref: none before minute 29', () => {
    const s = base();
    s.owed!.push(msgDebt('o2', 'msg014', 14, false));
    expect(stampToldDraft(s, ['msg014'], at(14))).toBe(true);
    progressDraft(s, at(28.9), NO_TEAMS);
    expect(progressItems(s)).toHaveLength(0);
    progressDraft(s, at(29), NO_TEAMS);
    expect(progressItems(s)).toHaveLength(1);
  });

  it('another job\'s result under ITS old origin restarts only that job, never his other waits (review r1, told-stamp-scope)', () => {
    const s = state({
      children: { a: awaitedChild('a', { origin: 'msgaaa' }), b: awaitedChild('b', { origin: 'msgbbb' }) },
      owed: [msgDebt('o1', 'msgaaa', 0), msgDebt('o2', 'msgbbb', 1), msgDebt('o3', 'msg005', 5)],
    });
    expect(stampToldDraft(s, ['msgaaa'], at(14))).toBe(true);
    expect(s.children.a.toldAt).toBe(at(14));
    expect(s.children.b.toldAt).toBeUndefined();
    progressDraft(s, at(15), NO_TEAMS);
    expect(progressItems(s)[0].progress?.jobs).toEqual([{ child: 'b', ref: 'msgbbb' }]);
  });

  it('a delivered progress the Super did not answer: none before 15 min after the delivery', () => {
    const s = base();
    s.children.c1.progressAt = at(15);
    expect(progressDue(s, { child: 'c1' }, at(29.9), NO_TEAMS)).toBe(false);
    expect(progressDue(s, { child: 'c1' }, at(30), NO_TEAMS)).toBe(true);
  });

  it('his newest message 61 minutes old: none (he is away; the done event tells him later)', () => {
    const s = state({ children: { c1: awaitedChild('c1') }, owed: [msgDebt('o1', 'msg000', 0)] });
    expect(ownerPresent(s, at(60))).toBe(true);
    expect(ownerPresent(s, at(61))).toBe(false);
    progressDraft(s, at(61), NO_TEAMS);
    expect(progressItems(s)).toHaveLength(0);
    expect(PROGRESS_DUE_MS).toBe(15 * MIN);
  });
});

describe('criterion 2: the domain', () => {
  const present = (m: number) => [msgDebt('o9', 'msg999', m)];

  for (const row of ['asking', 'waiting', 'stuck', 'done'] as const) {
    it(`an awaited child in ${row}: no item`, () => {
      const s = state({ children: { c1: awaitedChild('c1', { row }) }, owed: present(10) });
      progressDraft(s, at(30), NO_TEAMS);
      expect(progressItems(s)).toHaveLength(0);
    });
  }

  it('an ended child, and one nobody waits on: no item', () => {
    const s = state({ children: { c1: awaitedChild('c1', { endedAt: at(1) }), c2: awaitedChild('c2', { awaited: undefined }) }, owed: present(10) });
    progressDraft(s, at(30), NO_TEAMS);
    expect(progressItems(s)).toHaveLength(0);
  });

  it('re-sent to work at minute 120 after a told stamp at 105: due 15 min after it moved into working', () => {
    const ch = awaitedChild('c1', { row: 'done', workingSince: at(0), toldAt: at(105) });
    expect(setRow(ch, 'working', undefined, at(120))).toBe(true);
    expect(ch.workingSince).toBe(at(120));
    const s = state({ children: { c1: ch }, owed: present(120) });
    expect(progressDue(s, { child: 'c1' }, at(134.9), NO_TEAMS)).toBe(false);
    expect(progressDue(s, { child: 'c1' }, at(135), NO_TEAMS)).toBe(true);
  });

  it('an asking -> working flap keeps the start; waiting -> working restarts it', () => {
    const ch = awaitedChild('c1');
    setRow(ch, 'asking', undefined, at(5));
    setRow(ch, 'working', undefined, at(6));
    expect(ch.workingSince).toBe(at(0));
    setRow(ch, 'waiting', undefined, at(7));
    setRow(ch, 'working', undefined, at(8));
    expect(ch.workingSince).toBe(at(8));
  });

  it('a member Super record never gets an item, and never stamps its told clock', () => {
    const s = state({ member: 'rota', children: { c1: awaitedChild('c1') }, owed: present(10) });
    progressDraft(s, at(30), NO_TEAMS);
    expect(progressItems(s)).toHaveLength(0);
    expect(stampToldDraft(s, [ORIGIN], at(20))).toBe(false);
  });

  it('an awaited working child of an older record with no start gets one on the first sweep (no burst after a deploy)', () => {
    const s = state({ children: { c1: awaitedChild('c1', { workingSince: undefined, startedAt: at(-500) }) }, owed: present(10) });
    expect(progressDraft(s, at(30), NO_TEAMS)).toEqual({ changed: true, added: false });
    expect(s.children.c1.workingSince).toBe(at(30));
  });
});

describe('criterion 3: one item, re-checked at delivery', () => {
  const two = () => state({
    children: { c1: awaitedChild('c1'), c2: awaitedChild('c2', { origin: undefined }) },
    owed: [msgDebt('o1', 'msg005', 5)],
  });

  it('two due jobs: ONE item listing both; a job with no origin answers under the item\'s own ref', () => {
    const s = two();
    progressDraft(s, at(15), NO_TEAMS);
    const items = progressItems(s);
    expect(items).toHaveLength(1);
    expect(items[0].progress?.jobs).toEqual([{ child: 'c1', ref: ORIGIN }, { child: 'c2', ref: owedRef(items[0].id) }]);
  });

  it('a sweep restart (the same record, read again) adds none', () => {
    const s = two();
    progressDraft(s, at(15), NO_TEAMS);
    const again = sanitizeSuperState(JSON.parse(JSON.stringify(s)));
    progressDraft(again, at(16), NO_TEAMS);
    expect(progressItems(again)).toHaveLength(1);
    expect(progressItems(again)[0].progress?.jobs).toHaveLength(2);
  });

  it('at delivery a job that finished, or whose clock a Super answer restarted, is dropped; an empty item is closed', () => {
    const s = two();
    progressDraft(s, at(15), NO_TEAMS);
    const item = progressItems(s)[0];
    setRow(s.children.c1, 'done', undefined, at(16));
    stampToldDraft(s, [owedRef(item.id)], at(16));
    expect(s.children.c2.toldAt).toBe(at(16));
    expect(pruneProgressDraft(s, at(16), NO_TEAMS)).toBe(true);
    expect(item.state).toBe('done');
    expect(item.progress).toBeUndefined();
  });

  it('the record keeps a progress item only with well-formed jobs (malformed dropped, never thrown)', () => {
    const raw = {
      ...state(),
      queue: [
        { id: 'q-p1', sessionId: SUPER, kind: 'progress', state: 'pending', createdAt: 1, progress: { jobs: [{ child: 'c1', ref: ORIGIN }, { child: 'c1', team: 'team-x', ref: ORIGIN }, { team: 'team-ok', ref: 'NOPE!' }, 7] } },
        { id: 'q-p2', sessionId: SUPER, kind: 'progress', state: 'pending', createdAt: 1, progress: { jobs: [] } },
        { id: 'q-p3', sessionId: 'someone-else', kind: 'progress', state: 'pending', createdAt: 1, progress: { jobs: [{ child: 'c1', ref: ORIGIN }] } },
      ],
      children: { c1: { ...awaitedChild('c1'), workingSince: 'soon', toldAt: -4, progressAt: at(3) } },
    };
    const s = sanitizeSuperState(raw);
    expect(s.queue.map((q) => q.id)).toEqual(['q-p1']);
    expect(s.queue[0].progress).toEqual({ jobs: [{ child: 'c1', ref: ORIGIN }] });
    expect(s.children.c1.workingSince).toBeUndefined();
    expect(s.children.c1.toldAt).toBeUndefined();
    expect(s.children.c1.progressAt).toBe(at(3));
  });
});

describe('criterion 4: team jobs', () => {
  const job = (over: Partial<SuperTeamJob> = {}): SuperTeamJob => ({
    id: 'team-rota-1', member: 'rota', runId: '2026-11-21T09:00:00.000Z', jobKind: 'run', queued: false, brief: 'the report', startedAt: at(0), awaited: true, open: true, origin: ORIGIN, ...over,
  });
  const teams = (status: TeamJobStatus) => new Map<string, TeamJobStatus>([['team-rota-1', status]]);
  const rec = (j: SuperTeamJob) => state({ team: [j], owed: [msgDebt('o1', 'msg005', 5)] });

  it('a run job is due 15 min after it first reads running', () => {
    const s = rec(job());
    progressDraft(s, at(2), teams('running'));
    expect(s.team[0].liveSince).toBe(at(2));
    progressDraft(s, at(16.9), teams('running'));
    expect(progressItems(s)).toHaveLength(0);
    progressDraft(s, at(17), teams('running'));
    expect(progressItems(s)[0].progress?.jobs).toEqual([{ team: 'team-rota-1', ref: ORIGIN }]);
  });

  it('a reply given the member\'s lock at minute 30 is due at minute 45; a pending request never, an accepted one 15 min after', () => {
    const reply = rec(job({ jobKind: 'reply' }));
    progressDraft(reply, at(10), teams('queued'));
    expect(reply.team[0].liveSince).toBeUndefined();
    progressDraft(reply, at(30), teams('running'));
    progressDraft(reply, at(44.9), teams('running'));
    expect(progressItems(reply)).toHaveLength(0);
    progressDraft(reply, at(45), teams('running'));
    expect(progressItems(reply)).toHaveLength(1);

    const request = rec(job({ request: 'q-req-1' }));
    for (const m of [5, 15, 19]) progressDraft(request, at(m), teams('queued'));
    expect(progressItems(request)).toHaveLength(0);
    progressDraft(request, at(20), teams('running'));
    progressDraft(request, at(34.9), teams('running'));
    expect(progressItems(request)).toHaveLength(0);
    progressDraft(request, at(35), teams('running'));
    expect(progressItems(request)).toHaveLength(1);
  });

  it('running -> asking -> running keeps its start; done clears it', () => {
    const s = rec(job());
    progressDraft(s, at(1), teams('running'));
    progressDraft(s, at(5), teams('asking'));
    expect(s.team[0].liveSince).toBe(at(1));
    progressDraft(s, at(9), teams('running'));
    expect(s.team[0].liveSince).toBe(at(1));
    progressDraft(s, at(10), teams('done'));
    expect(s.team[0].liveSince).toBeUndefined();
  });
});

describe('the real sweep timer and the pump (criteria 3, 4, 5)', () => {
  let dir: string;
  let root: string;
  const envKeys = ['DREAMCONTEXT_SUPER_PROGRESS_MS', 'DREAMCONTEXT_SUPER_SWEEP_MS'] as const;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-sessiz-')));
    root = join(dir, 'acme', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
  });
  afterEach(async () => {
    for (const k of envKeys) delete process.env[k];
    setTeamLiveSource(null);
    let cap: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([_superInboxDrained(), new Promise((r) => { cap = setTimeout(r, 8_000); })]);
    clearTimeout(cap);
    _resetSuperInbox();
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (s: Partial<SuperState>) => writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...s }));
  const fakeInbox = (ok: () => boolean) => {
    const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
    const inbox: SuperInbox = { id: `inbox-${Math.random()}`, sessionId: SUPER, attached: () => true, idle: () => true, deliver: async (text, event) => { if (!ok()) return false; delivered.push({ text, event }); return true; } };
    return { inbox, delivered };
  };

  it('a main record whose only awaited work is a team job queues an item through the real sweep timer', async () => {
    process.env.DREAMCONTEXT_SUPER_PROGRESS_MS = '150';
    process.env.DREAMCONTEXT_SUPER_SWEEP_MS = '60';
    setTeamLiveSource(() => ({ kind: 'run', status: 'running' }));
    const now = Date.now();
    write({
      team: [{ id: 'team-rota-1', member: 'rota', runId: new Date(now).toISOString(), jobKind: 'run', queued: false, brief: 'the report', startedAt: now, awaited: true, open: true, origin: ORIGIN }],
      owed: [{ id: 'o1', kind: 'msg', ref: 'msg005', seq: 1, at: now, gist: 'x', nudges: 0, closed: { at: now, by: 'mark' } }],
    });
    expect(teamJobStatusNow(root, (await readSuperState(root)).team[0])).toBe('running');
    await startSuperInbox([root]);
    await vi.waitFor(async () => {
      const s = await readSuperState(root);
      expect(s.queue.find((q) => q.kind === 'progress')?.progress?.jobs).toEqual([{ team: 'team-rota-1', ref: ORIGIN }]);
    }, { timeout: 8_000, interval: 50 });
  });

  it('a delivery not written leaves the item pending and every clock unchanged; the next pump delivers it, opens no debt and moves no sent list', async () => {
    const now = Date.now();
    write({
      children: { c1: { sessionId: 'c1', brief: 'tests', adopted: false, startedAt: now - 20 * MIN, row: 'working', rowAt: now - 20 * MIN, workingSince: now - 20 * MIN, awaited: true, origin: ORIGIN, sent: ['git push'] } },
      owed: [{ id: 'o1', kind: 'msg', ref: 'msg005', seq: 1, at: now - MIN, gist: 'x', nudges: 0, closed: { at: now - MIN, by: 'mark' } }],
      owedSince: 0,
    });
    const sup = registerChat({ sessionId: SUPER, conversationId: null, vault: 'acme', mode: 'super' });
    sup.userSent('');
    sup.observe({ type: 'result' });
    registerChat({ sessionId: 'c1', conversationId: null, vault: 'acme', mode: 'basic' }).userSent('');
    await startSuperInbox([root]);
    expect((await readSuperState(root)).children.c1.row).toBe('working');
    let ok = false;
    const { inbox, delivered } = fakeInbox(() => ok);
    await writeSuper(root, (s) => { progressDraft(s, Date.now(), new Map()); });
    attachSuperInbox(inbox);
    await _superInboxDrained();
    let s = await readSuperState(root);
    const item = s.queue.find((q) => q.kind === 'progress') as SuperQueueItem;
    expect(item.state).toBe('pending');
    expect(s.children.c1.progressAt).toBeUndefined();
    expect(delivered).toHaveLength(0);
    ok = true;
    const second = { delivered };
    await pumpSuper(root);
    await vi.waitFor(async () => { expect((await readSuperState(root)).queue.find((q) => q.id === item.id)?.state).toBe('delivered'); }, { timeout: 8_000, interval: 50 });
    s = await readSuperState(root);
    const text = second.delivered[0].text;
    expect(text).toContain(`event=progress job=c1 ref=${ORIGIN}`);
    expect(text).toContain(PROGRESS_LINE);
    // An owner batch (rendered in full, sent to Telegram), no result debt, the child's sends kept.
    expect(s.ownerBatches).toContain(second.delivered[0].event.batch);
    expect(openDebts(s)).toHaveLength(0);
    expect(s.children.c1.sent).toEqual(['git push']);
    expect(s.children.c1.progressAt).toBeGreaterThan(0);
    // The window draws no child chip for it: the frame does not name the Super's own session.
    expect(second.delivered[0].event.items ?? []).toEqual([]);
  });
});

describe('criterion 5: the batch text', () => {
  it('carries one line per job, PROGRESS_LINE (an exception to the no-text rule) and fences the brief', () => {
    const s = state({ children: { c1: awaitedChild('c1') }, owed: [msgDebt('o1', 'msg005', 5)] });
    progressDraft(s, at(15), NO_TEAMS);
    const text = superBatchText('/tmp/acme/_dream_context', s, progressItems(s), 'b-1', at(15));
    expect(text).toMatch(new RegExp(`- item=q-[^ ]+ event=progress job=c1 ref=${ORIGIN} elapsed=15m`));
    expect(text).toContain(PROGRESS_LINE);
    expect(PROGRESS_LINE).toContain('exception to the no-text rule');
    expect(text).toContain('untrusted-project-output');
    expect(text).not.toMatch(/^- item=.*awaited=owner/m);
  });
});

describe('criterion 6: super state reads background', () => {
  it('idle by its turn but held by background work reads background; with nothing in the background, idle', () => {
    expect(liveChildStatus({}, 'idle', false, true)).toBe('background');
    expect(liveChildStatus({}, 'idle', false, false)).toBe('idle');
    expect(liveChildStatus({}, 'working', false, true)).toBe('working');
  });
});

describe('criterion 7: super read <team-job> while it runs', () => {
  let dir: string;
  let root: string;
  beforeEach(() => {
    resetSuperIndex();
    _resetSuperInbox();
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-sessiz-read-')));
    root = join(dir, 'acme', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
  });
  afterEach(async () => {
    setTeamLiveSource(null);
    setRequestSource(null);
    await _superInboxDrained();
    rmSync(dir, { recursive: true, force: true });
  });
  const runId = '2026-11-21T09:00:00.000Z';
  /** The member's own Super is on (a request's status reads it). */
  const memberOn = () => writeSuper(root, 'm:rota', (s) => { s.enabled = true; s.session = 'sess-m'; s.member = 'rota'; });
  const job = (over: Partial<SuperTeamJob> = {}): SuperTeamJob => ({ id: 'team-rota-1', member: 'rota', runId, jobKind: 'run', queued: false, brief: 'b', startedAt: Date.now() - 5 * MIN, awaited: true, open: true, ...over });

  it('a running run job: since, last activity, its last 1-2 own lines after its start', () => {
    const ask = appendThreadEntry(root, 'rota', { runId, kind: 'user', text: 'Build the report.' });
    appendThreadEntry(root, 'rota', { runId, kind: 'agent', text: 'Reading the numbers.', via: 'runner' });
    appendThreadEntry(root, 'rota', { runId, kind: 'agent', text: 'Drafting section 2.', via: 'runner' });
    appendThreadEntry(root, 'rota', { runId, kind: 'agent', text: 'Charts are next.', via: 'runner' });
    setTeamLiveSource(() => ({ kind: 'run', status: 'running' }));
    const j = job({ entryId: ask.id });
    const text = teamProgressRead(root, j) as string;
    expect(text).toContain(`Running since ${owedClock(j.startedAt)}, last activity `);
    expect(text).toContain('- Drafting section 2.');
    expect(text).toContain('- Charts are next.');
    expect(text).not.toContain('Reading the numbers.');
  });

  it('a running reply: only lines after the live deliveredAt', async () => {
    const ask = appendThreadEntry(root, 'rota', { runId, kind: 'user', text: 'And the totals?' });
    appendThreadEntry(root, 'rota', { runId, kind: 'agent', text: 'Older turn line.', via: 'runner' });
    await new Promise((r) => setTimeout(r, 5));
    const deliveredAt = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    appendThreadEntry(root, 'rota', { runId, kind: 'agent', text: 'Totals: adding up.', via: 'runner' });
    setTeamLiveSource(() => ({ kind: 'reply', status: 'running', phase: 'delivering', deliveredAt }));
    const text = teamProgressRead(root, job({ jobKind: 'reply', entryId: ask.id })) as string;
    expect(text).toContain(`Running since ${owedClock(deliveredAt)}`);
    expect(text).toContain('- Totals: adding up.');
    expect(text).not.toContain('Older turn line.');
  });

  it('a reply waiting for the member, and a pending request: queued behind its current work since HH:MM', async () => {
    setTeamLiveSource(() => ({ kind: 'reply', status: 'running', phase: 'waiting' }));
    const j = job({ jobKind: 'reply' });
    expect(teamProgressRead(root, j)).toBe(`Queued behind the member's current work since ${owedClock(j.startedAt)}.`);
    setRequestSource(() => ({ id: 'q-req-1', sessionId: 'sess-m', kind: 'request', state: 'pending', createdAt: 1, text: 'job' }));
    await memberOn();
    const r = job({ request: 'q-req-1' });
    expect(teamProgressRead(root, r)).toBe(`Queued behind the member's current work since ${owedClock(r.startedAt)}.`);
  });

  it('a running request: the member record\'s main:<req> children; a done job: null (its answer is the read)', async () => {
    await memberOn();
    setRequestSource(() => ({ id: 'q-req-1', sessionId: 'sess-m', kind: 'request', state: 'delivered', createdAt: 1, acceptedAt: 2, text: 'job' }));
    const since = Date.now() - 3 * MIN;
    const text = teamProgressRead(root, job({ request: 'q-req-1' }), Date.now(), [{ sid: 'kid-1', row: 'working', since, last: 'Tests are running.' }]) as string;
    expect(text).toContain(`- child=kid-1 row=working since=${owedClock(since)} last: Tests are running.`);
    setTeamLiveSource(() => ({ kind: 'run', status: 'success' }));
    expect(teamProgressRead(root, job())).toBeNull();
  });
});

describe('criterion 9: K6 waits only for a child that still runs', () => {
  const base = (child: Partial<SuperChild>, queue: SuperQueueItem[] = []): SuperState => ({
    ...emptySuperState(), enabled: true, session: 'sess-m', member: 'rota',
    children: { k1: { sessionId: 'k1', brief: 'deploy', adopted: false, startedAt: 1, workOrigin: 'main:q-req-1', ...child } },
    queue: [{ id: 'q-req-1', sessionId: 'sess-m', kind: 'request', state: 'delivered', createdAt: 1, acceptedAt: 2, text: 'job' }, ...queue],
  });
  const idle = (over: Partial<ChatEntry> = {}): ChatEntry => ({
    sessionId: 'sess-m', conversationId: null, vault: 'acme', mode: 'super', title: '', status: 'idle', lastAssistantText: ['done.'], pendingQuestion: null,
    updatedAt: new Date().toISOString(), lastFrameAt: new Date().toISOString(), toolsInFlight: 0,
    lastTurn: { endedAt: new Date().toISOString(), interrupted: false, resultSeq: 1 }, ...over,
  });
  beforeEach(() => { _resetChatRegistry(); });

  it('a done child with its chat open and its done item delivered: the stop is a stall (nudged at this turn end)', () => {
    registerChat({ sessionId: 'k1', conversationId: null, vault: 'acme', mode: 'basic' });
    const s = base({ row: 'done' }, [{ id: 'q-d1', sessionId: 'k1', kind: 'done', state: 'delivered', createdAt: 3 }]);
    // Past every child check: only the turn's origin is left (main's work in the real turn).
    expect(notStalledReason(s, idle())).toBe('a reply to the owner');
  });

  it('a working child, or a stale-stuck one whose entry still works: no nudge', () => {
    const h = registerChat({ sessionId: 'k1', conversationId: null, vault: 'acme', mode: 'basic' });
    expect(notStalledReason(base({ row: 'working' }), idle())).toBe('a child still runs');
    h.userSent('go');
    expect(notStalledReason(base({ row: 'stuck', stuckReason: 'stale' }), idle())).toBe('a child still runs');
    expect(notStalledReason(base({ row: 'stuck', stuckReason: 'error' }), idle())).toBe('a reply to the owner');
  });

  it('a main: child\'s done item still pending: no nudge yet', () => {
    const s = base({ row: 'done' }, [{ id: 'q-d1', sessionId: 'k1', kind: 'done', state: 'pending', createdAt: 3 }]);
    expect(notStalledReason(s, idle())).toBe("a child's result is still on its way");
  });
});

describe('criterion 10: a refused text names its refs', () => {
  it('the note tells the Super to re-send under the first ref', () => {
    const note = undeliveredNote(['One of your answers did not reach his phone: Telegram refused the message. It is on the Mac only. refs=abc123,def456']) as string;
    expect(note).toContain('refs=abc123,def456');
    expect(note).toContain('`<!-- re:<the first ref> -->`');
  });
});

describe('criterion 11: the briefing\'s time rule', () => {
  it('no "never with a time"; a time only from a real measurement; plan summaries keep no time; the deploy watch and background are said', () => {
    expect(OWNER_VOICE).not.toContain('never with a time');
    expect(OWNER_VOICE).toContain('only when a real measurement gives it');
    expect(SUPER_BRIEF_TEXT).not.toContain('never with a time');
    expect(SUPER_BRIEF_TEXT).toContain('ONLY from a real\nmeasurement');
    expect(SUPER_BRIEF_TEXT).toContain('no measurement means no time');
    expect(SUPER_BRIEF_TEXT).toContain('cost or risk in money, never time');
    expect(SUPER_BRIEF_TEXT).toContain('something watches that deploy');
    expect(SUPER_BRIEF_TEXT).toContain('`background`');
  });
});
