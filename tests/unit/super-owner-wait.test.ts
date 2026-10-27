/**
 * A child waiting on the OWNER is never "done", and a child whose background job still runs is
 * never "done" either (task a-super-child-waiting-on-the-owner-or-still-running-is-never-shown-done;
 * Tilki field 2026-10-22: a `gcloud auth login` run card sat under a DONE row with "Waiting on you
 * 0" while a 10-minute exploration script had already flipped the row to done).
 *
 *  - owner-wait.ts reads the owner-only cards (run, secret, checklist) from the child's own text
 *    (cards only: the owner's call, 2026-10-22; prose is not guessed at), and recognises his answer
 *    in the chat's REAL receipt formats (the builders are imported, so a format change breaks
 *    this file, not the field); his own words answer too, the Super's steers never do;
 *  - the registry holds the waits from the frame they arrive in, and its own channel says so;
 *  - the inbox writes an `owner` item at once (no turn end, no sweep), the row rests `waiting`
 *    (no settle window, no `done` item, ever), the Super hears `event=owner` with the line that
 *    tells it to tell him, the item stays his after that turn, and his answer clears it;
 *  - background work: a job on the roster holds the row past the 10-minute quiet bar, a dev
 *    server does not, and a job left running holds it no longer than BACKGROUND_JOB_MAX_MS.
 *
 * Through the REAL registry and inbox, on a fake clock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-owner-wait-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetChatRegistry, dropOwnerWait, getChat, onOwnerWaitChange, persistentBackground, registerChat, type ChatHandle,
} from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState } from '../../src/lib/super/store.js';
import { DONE_SETTLE_MS, STALE_SWEEP_MS, emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import {
  BACKGROUND_JOB_MAX_MS, BACKGROUND_QUIET_MS, OWNER_WAIT_LINE, _resetSuperInbox, _superInboxDrained, attachSuperInbox,
  startSuperInbox, superQueueHead, superTurnEnded, syncOwnerDraft, type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { _resetSuperSends, answeredBy, noteSuperSend, ownerCardsIn } from '../../src/lib/super/owner-wait.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { superBriefing } from '../../src/server/chat-modes.js';
import { buildRunReport } from '../../dashboard/src/components/sleepy/chat/runReport.js';
import { buildSubmitMarkdown } from '../../dashboard/src/lib/checklistMarkdown.js';
import { secretReceipt } from '../../src/lib/env-secrets.js';
import { needsOwner, ownerQueueCount, queueHead, superNotepad } from '../../dashboard/src/components/sleepy/super/superHandover.js';

const SUPER = 'sup-1';
let dir: string;
let root: string;

const fence = (o: Record<string, unknown>) => `\`\`\`dream-view\n${JSON.stringify(o)}\n\`\`\``;
const RUN = { type: 'run', id: 'gcloud-login', command: 'gcloud auth login owner@example.com', why: 'it opens a browser and waits for your Google sign-in' };
const SECRET = { type: 'secret', id: 'or-key', title: 'Project AI key', file: '.env', fields: [{ key: 'API_KEY', label: 'Key' }] };
const CHECKLIST = { type: 'checklist', id: 'asc', title: 'App Store Connect key', items: [{ id: '1', text: 'Open Users and Access' }] };
const say = (h: ChatHandle, text: string) => h.observe({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const reg = (sid: string, mode = 'basic'): ChatHandle => registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode });
const roster = (h: ChatHandle, tasks: Array<{ type?: string; desc: string }>) => h.observe({
  type: 'system', subtype: 'background_tasks_changed',
  tasks: tasks.map((t, i) => ({ task_id: `bg${i}`, task_type: t.type ?? 'local_bash', description: t.desc })),
});
const runReport = (command = RUN.command) => buildRunReport(command, { code: 0, tail: 'You are now logged in.', seconds: 21 }, { includeOutput: true });

async function drain(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await _superInboxDrained();
  }
}
async function advance(ms: number, step = 5_000): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, left));
    await drain();
  }
}

async function boot(children: string[]) {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  const kids = Object.fromEntries(children.map((sid) => [sid, { sessionId: sid, brief: `brief of ${sid}`, adopted: false, startedAt: 1, row: 'working' }]));
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, children: kids }));
  const sup = reg(SUPER, 'super');
  sup.userSent('');
  sup.observe({ type: 'result' });
  const hs = children.map((sid) => { const h = reg(sid); h.userSent('go'); return h; });
  await startSuperInbox([root]);
  const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
  const inbox: SuperInbox = {
    id: `inbox-${Math.random()}`, sessionId: SUPER, attached: () => true, idle: () => true,
    deliver: async (text, event) => { delivered.push({ text, event }); return true; },
  };
  attachSuperInbox(inbox);
  await drain();
  return { sup, hs, delivered };
}

const state = () => readSuperState(root);
const ofKind = async (kind: string, sid?: string) => (await state()).queue.filter((q) => q.kind === kind && (!sid || q.sessionId === sid));

// ─── Pure reading ────────────────────────────────────────────────────────────────

describe('owner-wait: what a child leaves for the owner, and his answer', () => {
  it('reads run, secret and checklist cards from a reply (whole fences only, malformed ones skipped)', () => {
    const text = `PR merged.\n\n${fence(RUN)}\n\n${fence(SECRET)}\n${fence(CHECKLIST)}\n${fence({ type: 'pin', id: 'dev', facts: [] })}`;
    expect(ownerCardsIn(text)).toEqual([
      { kind: 'run', id: 'gcloud-login', line: RUN.why, key: RUN.command },
      { kind: 'secret', id: 'or-key', line: 'Project AI key', key: 'Project AI key' },
      { kind: 'checklist', id: 'asc', line: 'App Store Connect key', key: 'App Store Connect key' },
    ]);
    expect(ownerCardsIn('```dream-view\n{"type":"run","id":"x","command":"ls"')).toEqual([]); // still streaming
    expect(ownerCardsIn(fence({ type: 'run', id: 'bad id!', command: 'ls' }))).toEqual([]);
    expect(ownerCardsIn(fence({ type: 'run', id: 'two', command: 'a\nb' }))).toEqual([]);
    expect(ownerCardsIn(fence({ type: 'secret', id: 'nt' }))).toEqual([]);
    // A run card with no `why` says what it runs.
    expect(ownerCardsIn(fence({ type: 'run', id: 'r', command: 'firebase login' }))[0].line).toBe('run firebase login');
  });

  it('recognises his answer in the chat\'s REAL receipt formats; his own words answer every wait', () => {
    const run = ownerCardsIn(fence(RUN));
    const secret = ownerCardsIn(fence(SECRET));
    const checklist = ownerCardsIn(fence(CHECKLIST));
    expect(answeredBy(runReport(), run)).toEqual(run);
    expect(answeredBy(secretReceipt({ file: '.env', written: [{ key: 'API_KEY', action: 'added', chars: 40, fingerprint: 'abcd1234' }] } as never, 'Project AI key'), secret)).toEqual(secret);
    const spec = { type: 'checklist' as const, id: 'asc', title: 'App Store Connect key', items: [{ id: '1', text: 'Open Users and Access' }] };
    expect(answeredBy(buildSubmitMarkdown(spec, { checked: { 1: true }, notes: {}, files: {} } as never, {}), checklist)).toEqual(checklist);
    // His own words to the child answer every wait (he did it his own way). The Super's steers
    // never reach here: the registry drops the server's noted sends first (registry tests below).
    expect(answeredBy('I signed in from my terminal, go on.', [...run, ...secret])).toEqual([...run, ...secret]);
    // Two run cards open: only the one whose command ran clears.
    const two = ownerCardsIn(`${fence(RUN)}\n${fence({ type: 'run', id: 'fb', command: 'firebase login' })}`);
    expect(answeredBy(runReport('firebase login'), two).map((w) => w.id)).toEqual(['fb']);
  });

  it('a background roster entry: a dev server or a watch is persistent, a script or an agent is a job', () => {
    expect(persistentBackground({ task_type: 'local_bash', description: 'Start the dev server' })).toBe(true);
    expect(persistentBackground({ task_type: 'local_bash', description: 'npm run dev on port 5173' })).toBe(true);
    expect(persistentBackground({ task_type: 'monitor', description: 'deploy log' })).toBe(true);
    expect(persistentBackground({ task_type: 'local_bash', description: 'Run live exploration script' })).toBe(false);
    expect(persistentBackground({ task_type: 'local_agent', description: 'Review the diff' })).toBe(false);
  });

  it('an mcp card is an owner wait; its own report clears only it, never a run or secret wait (task mcp-management)', async () => {
    const { mcpReport } = await import('../../dashboard/src/components/sleepy/chat/mcpRows.js');
    const MCP = { type: 'mcp', id: 'report-sources', why: 'PostHog numbers for the weekly report', servers: ['posthog', 'claude.ai Gmail'] };
    const cards = ownerCardsIn(`${fence(MCP)}\n${fence(RUN)}\n${fence(SECRET)}\n${fence({ type: 'mcp', id: 'other', servers: ['linear'] })}`);
    expect(cards[0]).toEqual({ kind: 'mcp', id: 'report-sources', line: MCP.why, key: 'posthog, claude.ai Gmail' });
    expect(cards[3]).toEqual({ kind: 'mcp', id: 'other', line: 'Connect: linear', key: 'linear' });
    // The card's REAL report formats (mcpRows.ts), connected and skipped.
    expect(answeredBy(mcpReport('connected', MCP.servers), cards).map((w) => w.id)).toEqual(['report-sources']);
    expect(answeredBy(mcpReport('skipped', ['linear'], []), cards).map((w) => w.id)).toEqual(['other']);
    // Malformed: no servers, or more than 8.
    expect(ownerCardsIn(fence({ type: 'mcp', id: 'x', servers: [] }))).toEqual([]);
    expect(ownerCardsIn(fence({ type: 'mcp', id: 'x', servers: Array.from({ length: 9 }, (_, i) => `s${i}`) }))).toEqual([]);
  });

  it('the record keeps an owner item only with a well-formed wait', () => {
    const s = sanitizeSuperState({
      ...emptySuperState(), session: SUPER, enabled: true,
      children: { c1: { sessionId: 'c1', brief: '', adopted: false, startedAt: 1, row: 'waiting' } },
      queue: [
        { id: 'q-ok', sessionId: 'c1', kind: 'owner', state: 'pending', createdAt: 1, wait: { kind: 'run', id: 'gcloud-login' }, ownerText: 'sign in' },
        { id: 'q-nowait', sessionId: 'c1', kind: 'owner', state: 'pending', createdAt: 1 },
        { id: 'q-badkind', sessionId: 'c1', kind: 'owner', state: 'pending', createdAt: 1, wait: { kind: 'shell', id: 'x' } },
        { id: 'q-mcp', sessionId: 'c1', kind: 'owner', state: 'pending', createdAt: 1, wait: { kind: 'mcp', id: 'report-sources', key: 'posthog' }, ownerText: 'connect' },
      ],
    });
    expect(s.queue.map((q) => q.id)).toEqual(['q-ok', 'q-mcp']);
    expect(s.queue[0].wait).toEqual({ kind: 'run', id: 'gcloud-login' });
    expect(s.children.c1.row).toBe('waiting');
  });
});

// ─── The registry ────────────────────────────────────────────────────────────────

describe('the registry holds the waits from the frame they arrive in', () => {
  beforeEach(() => { _resetChatRegistry(); _resetSuperSends(); });

  it('a run card mid-turn is a wait at once, on its own channel; his run report clears it', () => {
    const seen: number[] = [];
    onOwnerWaitChange((e) => seen.push(e.ownerWaits?.length ?? 0));
    const h = reg('c1');
    h.userSent('go');
    say(h, `PR merged. Reading the rollout needs your sign-in.\n\n${fence(RUN)}`);
    expect(getChat('c1')?.ownerWaits).toEqual([{ kind: 'run', id: 'gcloud-login', line: RUN.why, key: RUN.command }]);
    expect(seen).toEqual([1]);
    expect(getChat('c1')?.status).toBe('working');
    h.observe({ type: 'result' });
    // The Super steers the child (the server notes its send): the card stays open.
    noteSuperSend('c1', 'Wait for the owner.');
    h.userSent('Wait for the owner.');
    expect(getChat('c1')?.ownerWaits).toHaveLength(1);
    h.observe({ type: 'result' });
    h.userSent(runReport());
    expect(getChat('c1')?.ownerWaits).toBeUndefined();
    expect(seen).toEqual([1, 0]);
  });

  it('he did it his own way: any message HE writes to the child answers its card', () => {
    const h = reg('c3');
    h.userSent('go');
    say(h, fence(RUN));
    h.observe({ type: 'result' });
    h.userSent('I signed in from my own terminal, go on.');
    expect(getChat('c3')?.ownerWaits).toBeUndefined();
    expect(getChat('c3')?.ownerAnswered).toEqual(['run:gcloud-login']);
    // The same card posted again is a new ask.
    say(h, fence(RUN));
    expect(getChat('c3')?.ownerWaits).toHaveLength(1);
    expect(getChat('c3')?.ownerAnswered).toEqual([]);
  });

  it('counts the roster\'s jobs apart from its servers', () => {
    const h = reg('c4');
    h.userSent('go');
    roster(h, [{ desc: 'Start dev server' }, { desc: 'Run live exploration script' }]);
    expect(getChat('c4')?.backgroundTasks).toBe(2);
    expect(getChat('c4')?.backgroundJobs).toBe(1);
    roster(h, [{ desc: 'Start dev server' }]);
    expect(getChat('c4')?.backgroundJobs).toBeUndefined();
  });

  it('after a restart the record\'s open wait is held again, never closed by its absence; his receipt still clears it', () => {
    const h = reg('c5');
    // The Super resumed it (its own send): nothing of his yet.
    noteSuperSend('c5', 'go on');
    h.userSent('go on');
    h.observe({ type: 'result' });
    const s: SuperState = {
      ...emptySuperState(), session: SUPER, enabled: true,
      children: { c5: { sessionId: 'c5', brief: '', adopted: false, startedAt: 1, row: 'waiting' } },
      queue: [{ id: 'q-1', sessionId: 'c5', kind: 'owner', state: 'escalated', createdAt: 1, wait: { kind: 'run', id: 'gcloud-login', key: RUN.command }, ownerText: RUN.why }],
    };
    // The fresh process holds no wait: the item stays open and the registry adopts it.
    syncOwnerDraft(s, 'c5', getChat('c5'), Date.now());
    expect(s.queue[0].state).toBe('escalated');
    expect(s.children.c5.row).toBe('waiting');
    expect(getChat('c5')?.ownerWaits).toEqual([{ kind: 'run', id: 'gcloud-login', line: RUN.why, key: RUN.command }]);
    h.userSent(runReport());
    syncOwnerDraft(s, 'c5', getChat('c5'), Date.now());
    expect(s.queue[0].state).toBe('done');
  });

  it('after a respawn his run report can come FIRST, before the record is read: the item closes, it is not re-held', () => {
    const h = reg('c7');
    h.userSent(runReport());
    h.observe({ type: 'result' });
    const s: SuperState = {
      ...emptySuperState(), session: SUPER, enabled: true,
      children: { c7: { sessionId: 'c7', brief: '', adopted: false, startedAt: 1, row: 'waiting' } },
      queue: [{ id: 'q-7', sessionId: 'c7', kind: 'owner', state: 'escalated', createdAt: 1, wait: { kind: 'run', id: 'gcloud-login', key: RUN.command }, ownerText: RUN.why }],
    };
    syncOwnerDraft(s, 'c7', getChat('c7'), Date.now());
    expect(s.queue[0].state).toBe('done');
    expect(getChat('c7')?.ownerWaits).toBeUndefined();
  });

  it('after a respawn with two run cards open, his report answers only the one whose command ran (review round 3)', () => {
    const h = reg('c9');
    const ADC = 'gcloud auth application-default login';
    h.userSent(runReport());
    h.observe({ type: 'result' });
    const s: SuperState = {
      ...emptySuperState(), session: SUPER, enabled: true,
      children: { c9: { sessionId: 'c9', brief: '', adopted: false, startedAt: 1, row: 'waiting' } },
      queue: [
        { id: 'q-a', sessionId: 'c9', kind: 'owner', state: 'escalated', createdAt: 1, wait: { kind: 'run', id: 'gcloud-login', key: RUN.command }, ownerText: RUN.why },
        { id: 'q-b', sessionId: 'c9', kind: 'owner', state: 'escalated', createdAt: 1, wait: { kind: 'run', id: 'adc-login', key: ADC }, ownerText: 'application default login' },
      ],
    };
    syncOwnerDraft(s, 'c9', getChat('c9'), Date.now());
    expect(s.queue.map((q) => `${q.id}:${q.state}`)).toEqual(['q-a:done', 'q-b:escalated']);
    expect(getChat('c9')?.ownerWaits?.map((w) => w.id)).toEqual(['adc-login']);
    expect(s.children.c9.row).toBe('waiting');
  });

  it('his words from before a wait was asked do not answer it', () => {
    const h = reg('c10');
    h.userSent('hi, go ahead');
    h.observe({ type: 'result' });
    const s: SuperState = {
      ...emptySuperState(), session: SUPER, enabled: true,
      children: { c10: { sessionId: 'c10', brief: '', adopted: false, startedAt: 1, row: 'waiting' } },
      queue: [{ id: 'q-10', sessionId: 'c10', kind: 'owner', state: 'escalated', createdAt: Date.now() + 60_000, wait: { kind: 'run', id: 'gcloud-login', key: RUN.command }, ownerText: RUN.why }],
    };
    syncOwnerDraft(s, 'c10', getChat('c10'), Date.now());
    expect(s.queue[0].state).toBe('escalated');
  });

  it('the Super closing an owner item (he did it another way) answers its wait: it never comes back', () => {
    const h = reg('c6');
    h.userSent('go');
    say(h, fence(RUN));
    h.observe({ type: 'result' });
    const s: SuperState = {
      ...emptySuperState(), session: SUPER, enabled: true,
      children: { c6: { sessionId: 'c6', brief: '', adopted: false, startedAt: 1, row: 'working' } },
      queue: [],
    };
    syncOwnerDraft(s, 'c6', getChat('c6'), Date.now());
    expect(s.queue.filter((q) => q.kind === 'owner')).toHaveLength(1);
    // `super queue done <item>`: the route drops the wait, then marks the item done.
    dropOwnerWait('c6', 'run', 'gcloud-login');
    s.queue[0].state = 'done';
    syncOwnerDraft(s, 'c6', getChat('c6'), Date.now());
    expect(s.queue.filter((q) => q.kind === 'owner' && q.state !== 'done')).toHaveLength(0);
    expect(getChat('c6')?.ownerWaits).toBeUndefined();
  });
});

// ─── The inbox: queue, row, event, clear ─────────────────────────────────────────

describe('a child waiting on the owner is never done', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
    dir = mkdtempSync(join(tmpdir(), 'super-owner-wait-'));
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
  });
  afterEach(async () => {
    await drain().catch(() => undefined);
    vi.useRealTimers();
    _resetSuperInbox();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the card enters the owner queue the moment it streams, the Super hears event=owner, the row rests waiting; his run clears it and the job finishes normally', async () => {
    const { hs, delivered } = await boot(['c1']);
    const h = hs[0];
    say(h, `PR merged. Reading the rollout needs your Google sign-in.\n\n${fence(RUN)}`);
    await drain();
    // At once: mid-turn, before any turn end or sweep.
    const [item] = await ofKind('owner', 'c1');
    expect(item).toMatchObject({ kind: 'owner', wait: { kind: 'run', id: 'gcloud-login' }, ownerText: RUN.why });
    let s = await state();
    expect(superQueueHead(s)?.id).toBe(item.id);
    // The window's one queue (agenda Waiting on you, the bar, the header dot) holds it.
    expect(needsOwner(item)).toBe(true);
    expect(queueHead(s)?.id).toBe(item.id);
    expect(ownerQueueCount(s)).toBe(1);
    const look = { live: () => 'ready', titleFor: (sid: string) => `job ${sid}`, superTitle: 'Claude' };
    const agenda = superNotepad(s, look);
    expect(agenda.waiting).toEqual([expect.objectContaining({ sid: 'c1', chip: 'needsYou', line: RUN.why })]);
    expect(agenda.done).toEqual([]);
    expect(agenda.now).toEqual([]);
    // The Super's event says it waits on the owner, and tells it to tell him.
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toMatch(/child=c1 event=owner wait=run/);
    expect(delivered[0].text).toContain(OWNER_WAIT_LINE);
    expect(delivered[0].text).not.toMatch(/event=done/);
    // What he must do is told, not folded: that turn renders in full in his chat.
    expect((await state()).ownerBatches).toContain(delivered[0].event.batch);
    // That event turn ends: the item stays his.
    superTurnEnded(SUPER);
    await drain();
    expect((await ofKind('owner', 'c1'))[0].state).toBe('escalated');
    // The child's turn ends: waiting at once, no settle window, and never a done, however long.
    h.observe({ type: 'result' });
    await drain();
    s = await state();
    expect(s.children.c1.row).toBe('waiting');
    expect(s.children.c1.settling).toBeUndefined();
    await advance(DONE_SETTLE_MS + 3 * STALE_SWEEP_MS, 10_000);
    expect(await ofKind('done', 'c1')).toHaveLength(0);
    expect((await state()).children.c1.row).toBe('waiting');
    expect(delivered).toHaveLength(1);
    // He presses Run: the card posts its report into the child; the item clears by itself and the child goes on.
    h.userSent(runReport());
    await drain();
    expect((await ofKind('owner', 'c1'))[0].state).toBe('done');
    expect((await state()).children.c1.row).toBe('working');
    expect(ownerQueueCount(await state())).toBe(0);
    say(h, 'Rollout at 100 %.');
    h.observe({ type: 'result' });
    await advance(DONE_SETTLE_MS + 5_000);
    expect(await ofKind('done', 'c1')).toHaveLength(1);
    expect((await state()).children.c1.row).toBe('done');
  });

  it('a secret card and a checklist each wait until their own receipt', async () => {
    const { hs } = await boot(['c1']);
    const h = hs[0];
    say(h, `Two things only you can do.\n\n${fence(SECRET)}\n${fence(CHECKLIST)}`);
    h.observe({ type: 'result' });
    await drain();
    expect((await ofKind('owner', 'c1')).map((q) => q.wait?.kind)).toEqual(['secret', 'checklist']);
    h.userSent(secretReceipt({ file: '.env', written: [{ key: 'API_KEY', action: 'added', chars: 40, fingerprint: 'abcd1234' }] } as never, 'Project AI key'));
    await drain();
    expect((await ofKind('owner', 'c1')).filter((q) => q.state !== 'done').map((q) => q.wait?.kind)).toEqual(['checklist']);
  });

  it('a child that goes away closes its owner items', async () => {
    const { hs } = await boot(['c1']);
    say(hs[0], fence(RUN));
    hs[0].observe({ type: 'result' });
    await drain();
    hs[0].exited();
    await advance(60_000);
    expect((await ofKind('owner', 'c1')).every((q) => q.state === 'done')).toBe(true);
  });

  it('the Super\'s briefing tells it to surface an owner wait at once', () => {
    const b = superBriefing();
    expect(b).toContain('`event=owner`');
    expect(b).toContain('Tell him\n  at once');
  });
});

describe('a background JOB holds the row for as long as the CLI runs it', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
    dir = mkdtempSync(join(tmpdir(), 'super-owner-wait-'));
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
  });
  afterEach(async () => {
    await drain().catch(() => undefined);
    vi.useRealTimers();
    _resetSuperInbox();
    rmSync(dir, { recursive: true, force: true });
  });

  it('an exploration script past 10 minutes is still working (the field case), and done 30 s after it ends', async () => {
    const { hs, delivered } = await boot(['c1']);
    roster(hs[0], [{ desc: 'Run live exploration script' }]);
    say(hs[0], 'Keşif betiği 10 dakikayı aştı, arka planda sürüyor; ara çıktısına bakıyorum.');
    hs[0].observe({ type: 'result' });
    await advance(BACKGROUND_QUIET_MS + 10 * 60_000, 30_000);
    expect(await ofKind('done', 'c1')).toHaveLength(0);
    expect((await state()).children.c1.row).toBe('working');
    expect(delivered).toHaveLength(0);
    roster(hs[0], []);
    await advance(STALE_SWEEP_MS + DONE_SETTLE_MS + 5_000);
    expect(await ofKind('done', 'c1')).toHaveLength(1);
  });

  it('a dev server does not hold the row past the quiet bar, whatever the reply says (review round 1)', async () => {
    const { hs } = await boot(['c1']);
    roster(hs[0], [{ desc: 'npm run dev on port 5173' }]);
    say(hs[0], 'Started the dev server in the background on :5173; I will check it later.');
    hs[0].observe({ type: 'result' });
    await advance(BACKGROUND_QUIET_MS + STALE_SWEEP_MS + DONE_SETTLE_MS + 5_000, 30_000);
    expect(await ofKind('done', 'c1')).toHaveLength(1);
  });

  it('a job left running holds the row no longer than BACKGROUND_JOB_MAX_MS', async () => {
    const { hs } = await boot(['c1']);
    roster(hs[0], [{ desc: 'Run the load test' }]);
    hs[0].observe({ type: 'result' });
    await advance(BACKGROUND_JOB_MAX_MS - 5 * 60_000, 60_000);
    expect(await ofKind('done', 'c1')).toHaveLength(0);
    await advance(5 * 60_000 + STALE_SWEEP_MS + DONE_SETTLE_MS + 5_000, 30_000);
    expect(await ofKind('done', 'c1')).toHaveLength(1);
  });
});
