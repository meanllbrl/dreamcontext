/**
 * Routines that wait on the owner, queue side (uye-bildirim K7, criterion 9).
 *
 *  - `syncRoutineNeeds` is the ONLY writer of `routine` items: born pending in MAIN's queue from
 *    the facts on disk, closed when the fact leaves the disk, its marker dying with the fact;
 *  - one ring per fact (banner, Telegram), also across a restart (`shown`);
 *  - a write elsewhere (a member's record, main's own) leaves a routine item open and silent;
 *  - a routine with no member is drawn by its own title;
 *  - the runner's forward names an approval fact once per manifest (`approvalFactOf`).
 *
 * The facts reader is swapped for a table (needs.ts derives; its own test covers the disk).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/dc-super-rutin-`);
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { MAX_QUEUE, emptySuperState } from '../../src/lib/super/types.js';
import {
  ROUTINE_LINE, _resetSuperInbox, _superInboxDrained, nextBatch, ownerItems, routineItemId, setRoutineFactsForTest, superBatchText, syncRoutineNeeds, wireSuperInbox, writeSuper,
} from '../../src/lib/super/inbox.js';
import { _resetOwnerQuestions, setOwnerQuestionSinks } from '../../src/lib/super/owner-question.js';
import { answerOwnerItem } from '../../src/lib/super/answer.js';
import type { RoutineFacts } from '../../src/lib/automations/needs.js';
import { approvalFactOf } from '../../src/lib/automations/runner.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';

let dir: string;
let root: string;
const MAIN = 'sess-main-rutin-1';

const facts = (over: Partial<RoutineFacts> = {}): RoutineFacts => ({
  questions: [],
  routines: [
    {
      slug: 'nightly-digest', title: 'Nightly digest', hash: 'h1', post: null, newestLight: null,
      newest: { status: 'blocked', firedAt: '2026-11-10T01:00:00.000Z', startedAt: '2026-11-10T01:00:00.000Z', error: 'not approved (never approved on this Mac)', permissionDenials: 0 },
    },
    {
      slug: 'scout-sweep', title: 'Scout sweep', member: 'scout', hash: 'h2', post: null, newest: null,
      newestLight: {
        status: 'ok', firedAt: '2026-11-10T02:00:00.000Z', startedAt: '2026-11-10T02:00:01.000Z', error: null, permissionDenials: 2, light: true,
        deniedCalls: [{ tool: 'Bash', input: 'node scripts/fetch.mjs' }, { tool: 'WebFetch', input: '{"url":"https://example.test"}' }],
      },
    },
  ],
  ...over,
});

const main = () => readSuperState(root);
const routineItems = async () => (await main()).queue.filter((q) => q.kind === 'routine');

let banners: string[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'dc-super-rutin-proj-')));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  resetSuperIndex();
  _resetSuperInbox();
  _resetChatRegistry();
  _resetOwnerQuestions();
  banners = [];
  setOwnerQuestionSinks({ banner: (title, body) => { banners.push(`${title} | ${body}`); return true; } });
  wireSuperInbox();
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: MAIN, enabled: true }));
  setRoutineFactsForTest(() => facts());
});
afterEach(async () => {
  await _superInboxDrained();
  setRoutineFactsForTest(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('syncRoutineNeeds: one item per fact, in main\'s queue', () => {
  it('births an item per fact, drawn by the routine\'s own title, with its member only when it has one', async () => {
    await syncRoutineNeeds(root);
    const items = await routineItems();
    expect(items.map((q) => q.routine).sort()).toEqual(['nightly-digest', 'scout-sweep']);
    const night = items.find((q) => q.routine === 'nightly-digest');
    expect(night).toMatchObject({ id: routineItemId('nightly-digest', 'not-approved:h1'), fact: 'not-approved:h1', sessionId: MAIN, shown: true });
    expect(night?.member).toBeUndefined();
    expect(night?.ownerText?.startsWith('Nightly digest: ')).toBe(true);
    expect(items.find((q) => q.routine === 'scout-sweep')).toMatchObject({ member: 'scout', fact: 'denials:2026-11-10T02:00:01.000Z' });
    expect(ownerItems(await main()).filter((q) => q.kind === 'routine')).toHaveLength(2);
  });

  it('the Super hears it in a batch, with its own line', async () => {
    await syncRoutineNeeds(root);
    const s = await main();
    const { items } = nextBatch(s);
    expect(items.filter((q) => q.kind === 'routine')).toHaveLength(2);
    const text = superBatchText(root, s, items, 'b-test');
    expect(text).toContain('event=routine routine=nightly-digest');
    expect(text).toContain(ROUTINE_LINE);
  });

  it('rings once per fact: a later pass, another write, or a restart rings nothing', async () => {
    await syncRoutineNeeds(root);
    const first = banners.length;
    expect(first).toBeGreaterThanOrEqual(1);
    await syncRoutineNeeds(root);
    await writeSuper(root, (s) => { s.pool = [...s.pool]; });
    await _superInboxDrained();
    expect(banners.length).toBe(first);
    // A restart: every in-memory mark is gone; the item's own `shown` keeps it quiet.
    _resetOwnerQuestions();
    _resetSuperInbox();
    banners = [];
    setOwnerQuestionSinks({ banner: (title, body) => { banners.push(`${title} | ${body}`); return true; } });
    setRoutineFactsForTest(() => facts());
    wireSuperInbox();
    await syncRoutineNeeds(root);
    await writeSuper(root, (s) => { s.pool = [...s.pool]; });
    expect(banners).toEqual([]);
  });

  it('closes when its fact leaves the disk, and a closed fact is never opened again', async () => {
    await syncRoutineNeeds(root);
    const id = routineItemId('nightly-digest', 'not-approved:h1');
    // Approved: the blocked row is gone from the facts.
    setRoutineFactsForTest(() => facts({ routines: facts().routines.slice(1) }));
    await syncRoutineNeeds(root);
    expect((await main()).queue.find((q) => q.id === id)?.state).toBe('done');
    // The next pass drops its closed marker with the fact; a new fact is a new item.
    await syncRoutineNeeds(root);
    expect((await main()).queue.some((q) => q.id === id)).toBe(false);
  });

  it('Not needed sets it aside: closed while its fact lasts, gone with it, and it no longer holds the head', async () => {
    await syncRoutineNeeds(root);
    const id = routineItemId('nightly-digest', 'not-approved:h1');
    const r = await answerOwnerItem(root, { record: 'main', item: id, via: 'bar', answer: { kind: 'dismiss' } });
    expect(r).toEqual({ ok: true, outcome: 'dismissed' });
    // The fact is still on disk: a later pass never opens it again.
    await syncRoutineNeeds(root);
    expect((await main()).queue.find((q) => q.id === id)?.state).toBe('done');
    expect(ownerItems(await main()).some((q) => q.id === id)).toBe(false);
    // Anything but a dismiss is still not answered here (Review on the Mac).
    const other = routineItemId('scout-sweep', 'denials:2026-11-10T02:00:01.000Z');
    expect(await answerOwnerItem(root, { record: 'main', item: other, via: 'bar', answer: { kind: 'ask', text: 'go' } })).toMatchObject({ ok: false, error: 'not_offered' });
    // The fact leaves the disk: the closed marker goes with it.
    setRoutineFactsForTest(() => facts({ routines: facts().routines.slice(1) }));
    await syncRoutineNeeds(root);
    expect((await main()).queue.some((q) => q.id === id)).toBe(false);
  });

  it('a full queue never prunes a set-aside routine item: it does not come back and ring again', async () => {
    await syncRoutineNeeds(root);
    const id = routineItemId('nightly-digest', 'not-approved:h1');
    await answerOwnerItem(root, { record: 'main', item: id, via: 'bar', answer: { kind: 'dismiss' } });
    // Main's record passes the cap with finished items newer AND older than the dismissal.
    await writeSuper(root, (s) => {
      for (let i = 0; i < MAX_QUEUE + 20; i++) {
        s.queue.push({ id: `done-${i}`, sessionId: MAIN, kind: 'done', state: 'done', createdAt: i } as (typeof s.queue)[number]);
      }
    });
    const q = (await main()).queue;
    expect(q.length).toBeLessThanOrEqual(MAX_QUEUE);
    expect(q.find((x) => x.id === id)?.state).toBe('done');
    banners = [];
    await syncRoutineNeeds(root);
    expect((await main()).queue.find((x) => x.id === id)?.state).toBe('done');
    expect(banners.filter((b) => b.includes('Nightly digest'))).toEqual([]);
  });

  it('nothing is written while main is not handed over (no bar to put it on)', async () => {
    await writeSuper(root, (s) => { s.enabled = false; });
    await syncRoutineNeeds(root);
    expect(await routineItems()).toEqual([]);
  });
});

describe('approvalFactOf: one fact per manifest for the runner\'s forward', () => {
  const m = {
    slug: 'nightly-digest', title: 'Nightly digest', prompt: 'Write the digest.', outputInstructions: '', model: null, effort: null,
    timeoutMinutes: 10, outputDir: null, schedule: { cron: '0 1 * * *' },
  } as unknown as AutomationManifest;
  it('names awaiting-approval and not-approved, nothing else', () => {
    expect(approvalFactOf('awaiting-approval', null, m)).toMatch(/^awaiting-approval:/);
    expect(approvalFactOf('blocked', 'not approved (never approved on this Mac)', m)).toMatch(/^not-approved:/);
    expect(approvalFactOf('blocked', 'runs on another Mac', m)).toBeNull();
    expect(approvalFactOf('failed', 'boom', m)).toBeNull();
    // The same manifest is the same fact, tick after tick.
    expect(approvalFactOf('awaiting-approval', null, m)).toBe(approvalFactOf('awaiting-approval', null, m));
  });
});
