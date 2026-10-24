/**
 * Pictures follow the job they show (owner 2026-10-23, on a real stage: "Bu pencerede anlamsız
 * iki grup kartı oluşmuş"). The super opened a child's result as two picture groups (`--group`),
 * the owner turned that design down, the super sent the child new work and showed three new
 * options; the two old groups sat on the stage, showing a design already replaced: a picture had
 * no link to its job, only the 45-minute idle clock, which every look restarts.
 *
 *  - `super open image … --for <child>` links pictures to that child's job (images only, one of
 *    the super's children);
 *  - once the job moves on after they were shown (`super send` new work, ended or handed on, or
 *    a result it finished later seen by the owner), they go to Others at the first tidy tick 90 s
 *    on (LOOK_GRACE_MS);
 *  - only the OWNER's own look keeps it (owner decisions 2026-10-23): a look his window reports
 *    after the move (a group's panel or full screen: on open, every 30 s, on close), or what he
 *    arranges, brings back from Others or sets the view to then, makes it his (unlinked on the
 *    record); the super's own moves never keep it, and the clock's tick never dates it; never
 *    moved anyway: what he placed or sized, or what the view shows.
 *
 * The replay below is the real sequence's shape and timing (times in UTC, the stage was in
 * Turkey, +3), with fictional names.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-picture-job-home-`);
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { LOOK_GRACE_MS, TIDY_IDLE_MS, _resetTidy, jobMovedOn, keepOwnerLooked, planTidy, tidyOnce } from '../../src/lib/super/tidy.js';
import { succeedChild } from '../../src/lib/super/succession.js';
import { LOOK_RENEW_MS, applyLayoutPatch } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import { LIGHT_POLL_FACTOR } from '../../dashboard/src/lib/windowActivity.js';
import { superSanitizeOpts, writeSuper, _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { DONE_SETTLE_MS, SUPER_SHOW_SECTION, emptySuperState, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import { SUPER_OWNER_HANDLERS, handleSuperLayout, handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverWindowResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { _resetChatParkForTests } from '../../src/server/chat-park.js';

const SUPER = 'sup-pictures';
const JOB = '9a7c2f10-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const OTHER = '4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b';
let dir: string;
let root: string;
let token = '';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;
const io = { read: (r: string) => readSuperState(r, superSanitizeOpts()), write: (r: string, fn: (s: SuperState) => void) => writeSuper(r, fn) };
const child = (sid: string, extra: Record<string, unknown> = {}) => ({ sessionId: sid, brief: 'job', adopted: false, startedAt: Date.parse('2026-10-22T19:00:00Z'), ...extra });

function makeVault(): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    children: { [JOB]: child(JOB, { row: 'done' }), [OTHER]: child(OTHER, { row: 'working' }) },
    containers: [],
  }));
  token = mintWindowToken({
    send: (frame) => {
      if (typeof frame.id === 'string' && frame.subtype === 'window_command') setImmediate(() => deliverWindowResult(token, frame.id as string, { ok: true, result: { delivered: 'sent' } }));
      return true;
    },
    vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super',
  }).token;
}

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
/** The clock the routes and the tidy read, set to a moment of the replay. */
const at = (iso: string): number => { const t = Date.parse(iso); vi.spyOn(Date, 'now').mockReturnValue(t); return t; };
async function verb(name: string, body: Record<string, unknown>) {
  const r = res();
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: name });
  return r;
}
async function layout(body: Record<string, unknown>) {
  const r = res();
  await handleSuperLayout(req(body), r, {}, root);
  return r;
}
/** The owner marks results seen in the agenda: each child with the finish key his window showed. */
async function seen(children: Array<{ id: string; at: number }>) {
  const r = res();
  await SUPER_OWNER_HANDLERS.seen({} as never, r, root, { children });
  return r;
}
const state = () => readSuperState(root);
/** What his window reports for a group's panel: the group and the cards it shows. */
const looks = (g: { id: string; cards: string[] }) => [g.id, ...g.cards];
/** Each picture's job link, in card order (null: not linked). */
const links = async () => (await state()).containers.filter((k) => k.kind === 'image').map((k) => k.forChild ?? null);
const groupNamed = async (name: string) => (await state()).groups.find((g) => g.name === name);
/** One tidy tick at `iso` (the server's clock runs every minute). */
const tick = async (iso: string) => tidyOnce(root, io, at(iso));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-picture-job-'));
  _resetChatRegistry(); resetSuperIndex(); _resetSuperInbox(); resetWindowControl(); _resetChatParkForTests(); _resetTidy();
  process.env.DREAMCONTEXT_DESKTOP = '1';
  makeVault();
  // The job's chat runs: a send steers it (no wake).
  registerChat({ sessionId: JOB, conversationId: null, vault: 'acme', mode: 'basic' });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  _resetChatParkForTests();
  rmSync(dir, { recursive: true, force: true });
});

const PENDING = ['1-gate', '2-bubble', '3-panel', '4-after-mark', '5-admin-chip', '6-phone-panel'].map((n) => `_dream_context/tmp/pending-show/${n}.png`);
const WINDOW_FIX = ['before-after-390', 'before-after-1440'].map((n) => `_dream_context/tmp/pending-show/${n}.png`);
const OPTIONS = ['option-A', 'option-B', 'option-C'].map((n) => `_dream_context/tmp/pending-show/${n}.png`);

/** The real sequence, 2026-10-22 23:19 → 00:16 (Turkey). `linked`: the super passes `--for`. */
async function replay(linked: boolean): Promise<void> {
  const forJob = linked ? { for: JOB } : {};
  // 23:19 — the super shows the child's result: six screenshots, one named group.
  at('2026-10-22T20:19:02Z');
  expect((await verb('open', { kind: 'image', refs: PENDING, group: 'Pending work', size: 'large', ...forJob })).status).toBe(200);
  await tick('2026-10-22T20:19:30Z');
  // ~23:53 — the owner, trying the feature, opens that group's panel: touched.
  at('2026-10-22T20:53:00Z');
  const pending = (await groupNamed('Pending work'))!;
  await layout({ touch: [pending.id] });
  // 23:54 — the child's next result: before/after, its own named group.
  at('2026-10-22T20:54:36Z');
  expect((await verb('open', { kind: 'image', refs: WINDOW_FIX, group: 'Window fix', titles: ['Phone before/after', 'Panel before/after'], ...forJob })).status).toBe(200);
  await tick('2026-10-22T20:55:00Z');
  // 00:00 the owner turns the design down; 00:01 the super sends the child new work.
  at('2026-10-22T21:01:32Z');
  const sent = await verb('send', { child: JOB, text: 'The owner wants another design: draw 2-3 options first.' });
  expect(sent.status).toBe(200);
  await tick('2026-10-22T21:02:32Z');
  // 00:09 — three options, presented; 00:12 the owner picks A; the super stacks the options.
  at('2026-10-22T21:09:10Z');
  expect((await verb('open', { kind: 'image', refs: OPTIONS, group: 'Row options', ...forJob })).status).toBe(200);
  const options = (await groupNamed('Row options'))!;
  await verb('present', { containers: options.cards });
  await tick('2026-10-22T21:10:00Z');
  at('2026-10-22T21:12:48Z');
  await verb('present', { off: true });
  await verb('stack', { container: options.id });
  // 00:16 — the moment of the owner's recording.
  await tick('2026-10-22T21:16:21Z');
}

describe('the real sequence, replayed (23:19 → 00:16)', () => {
  it('with --for: both old groups leave the stage soon after the child is sent new work, never closed', async () => {
    await replay(true);
    const s = await state();
    const place = (n: string) => s.groups.find((g) => g.name === n)?.place;
    expect(place('Pending work')).toBe('others');
    expect(place('Window fix')).toBe('others');
    expect(place('Row options')).toBe('others');
    expect(s.groups.filter((g) => g.place === 'float')).toEqual([]);
    expect([...PENDING, ...WINDOW_FIX, ...OPTIONS].every((ref) => s.containers.some((k) => k.ref === ref))).toBe(true);
    expect(s.children[JOB].sentAt).toBe(Date.parse('2026-10-22T21:01:32Z'));
  });

  it('…at the first tick once 90 s have passed since the send (00:03), before the options were shown', async () => {
    at('2026-10-22T20:19:02Z');
    await verb('open', { kind: 'image', refs: PENDING, group: 'Pending work', for: JOB });
    at('2026-10-22T20:54:36Z');
    await verb('open', { kind: 'image', refs: WINDOW_FIX, group: 'Window fix', for: JOB });
    await tick('2026-10-22T20:55:00Z');
    expect(await tick('2026-10-22T21:01:00Z')).toEqual([]);
    at('2026-10-22T21:01:32Z');
    await verb('send', { child: JOB, text: 'new design' });
    expect(await tick('2026-10-22T21:02:32Z')).toEqual([]);
    const moved = await tick('2026-10-22T21:03:32Z');
    const s = await state();
    expect(moved.sort()).toEqual(s.groups.map((g) => g.id).sort());
  });

  it('a send before the clock first ticks still moves them (the open is the touch, not that tick)', async () => {
    await tick('2026-10-22T20:54:00Z');
    at('2026-10-22T20:54:36Z');
    await verb('open', { kind: 'image', refs: WINDOW_FIX, group: 'Window fix', for: JOB });
    at('2026-10-22T20:54:46Z');
    expect((await verb('send', { child: JOB, text: 'also run the tests' })).status).toBe(200);
    expect(await tick('2026-10-22T20:56:30Z')).toEqual([(await groupNamed('Window fix'))!.id]);
  });

  it('…also for a picture a chain pulled into a group after the clock ticked', async () => {
    at('2026-10-22T20:00:00Z');
    await verb('open', { kind: 'image', ref: 'shots/d.png', for: JOB });
    await tick('2026-10-22T20:00:30Z');
    at('2026-10-22T20:01:10Z');
    expect(((await verb('open', { kind: 'image', ref: 'shots/e.png', for: JOB })).json.result as { autoGroup?: boolean }).autoGroup).toBe(true);
    at('2026-10-22T20:01:20Z');
    await verb('send', { child: JOB, text: 'next job' });
    await tick('2026-10-22T20:01:30Z');
    await tick('2026-10-22T20:03:00Z');
    expect((await state()).groups.map((g) => g.place)).toEqual(['others']);
  });

  it('…also for a group a named --group open took a picture out of', async () => {
    at('2026-10-22T20:00:00Z');
    await verb('open', { kind: 'image', refs: ['shots/a.png', 'shots/b.png', 'shots/c.png'], for: JOB });
    await tick('2026-10-22T20:00:30Z');
    at('2026-10-22T20:01:00Z');
    expect((await verb('open', { kind: 'image', refs: ['shots/a.png', 'shots/z.png'], group: 'Pick', for: JOB })).status).toBe(200);
    expect((await state()).groups.map((g) => [g.name, g.cards.length])).toEqual([['shots', 2], ['Pick', 2]]);
    at('2026-10-22T20:01:10Z');
    await verb('send', { child: JOB, text: 'build it' });
    await tick('2026-10-22T20:01:30Z');
    await tick('2026-10-22T20:02:50Z');
    expect((await state()).groups.map((g) => [g.name, g.place])).toEqual([['shots', 'others'], ['Pick', 'others']]);
  });

  it('…and after the super ends a presentation of them just before the send', async () => {
    at('2026-10-22T21:09:10Z');
    await verb('open', { kind: 'image', refs: OPTIONS, group: 'Row options', for: JOB });
    const options = (await groupNamed('Row options'))!;
    await verb('present', { containers: options.cards });
    await tick('2026-10-22T21:10:00Z');
    at('2026-10-22T21:12:48Z');
    await verb('present', { off: true });
    at('2026-10-22T21:12:58Z');
    await verb('send', { child: JOB, text: 'build A' });
    await tick('2026-10-22T21:13:00Z');
    await tick('2026-10-22T21:14:30Z');
    expect((await groupNamed('Row options'))?.place).toBe('others');
  });

  it('the owner opening the group after the job moved on makes it his: it stays, after a later send and a restart too', async () => {
    at('2026-10-22T20:54:36Z');
    await verb('open', { kind: 'image', refs: WINDOW_FIX, group: 'Window fix', for: JOB });
    at('2026-10-22T21:01:32Z');
    await verb('send', { child: JOB, text: 'new design' });
    const g = (await groupNamed('Window fix'))!;
    at('2026-10-22T21:01:40Z');
    await layout({ touch: looks(g) });
    expect(await links()).toEqual([null, null]);
    expect(await tick('2026-10-22T21:03:30Z')).toEqual([]);
    // His look long over, a later send and a restart: the idle clock is its only rule now.
    at('2026-10-22T21:20:00Z');
    await verb('send', { child: JOB, text: 'and one more thing' });
    _resetTidy();
    expect(await tick('2026-10-22T21:22:00Z')).toEqual([]);
    expect((await groupNamed('Window fix'))?.place).toBe('float');
  });

  it('a group he has open when the job moves on is never moved before his window reports again, and is his then', async () => {
    at('2026-10-22T20:54:36Z');
    await verb('open', { kind: 'image', refs: WINDOW_FIX, group: 'Window fix', for: JOB });
    const g = (await groupNamed('Window fix'))!;
    at('2026-10-22T21:00:50Z');
    await layout({ touch: looks(g) });
    at('2026-10-22T21:01:32Z');
    await verb('send', { child: JOB, text: 'new design' });
    expect(await tick('2026-10-22T21:01:40Z')).toEqual([]);
    // The 30 s report (60 s in Light mode) lands inside the grace.
    at('2026-10-22T21:02:20Z');
    await layout({ touch: looks(g) });
    expect(await links()).toEqual([null, null]);
    expect(await tick('2026-10-22T21:10:00Z')).toEqual([]);
  });

  it('a look sent along with other layout changes counts as his look too', async () => {
    at('2026-10-22T20:54:36Z');
    await verb('open', { kind: 'image', refs: WINDOW_FIX, group: 'Window fix', for: JOB });
    const g = (await groupNamed('Window fix'))!;
    at('2026-10-22T21:01:32Z');
    await verb('send', { child: JOB, text: 'new design' });
    at('2026-10-22T21:01:40Z');
    expect((await layout({ touch: looks(g), view: { mode: 'float' } })).status).toBe(200);
    expect(await links()).toEqual([null, null]);
  });

  it('a group he opened and closed just before the send goes once the grace is over', async () => {
    at('2026-10-22T20:54:36Z');
    await verb('open', { kind: 'image', refs: WINDOW_FIX, group: 'Window fix', for: JOB });
    const g = (await groupNamed('Window fix'))!;
    at('2026-10-22T20:58:00Z');
    await layout({ touch: looks(g) });
    // Closed: his window's last report.
    at('2026-10-22T21:00:50Z');
    await layout({ touch: looks(g) });
    at('2026-10-22T21:01:15Z');
    await verb('send', { child: JOB, text: 'not this one: another design' });
    expect(await tick('2026-10-22T21:01:30Z')).toEqual([]);
    expect(await tick('2026-10-22T21:02:50Z')).toEqual([g.id]);
    expect(await links()).toEqual([JOB, JOB]);
  });

  it('a group the super dissolves while he has it open stays his: the close report names the cards it showed', async () => {
    at('2026-10-22T20:54:36Z');
    await verb('open', { kind: 'image', refs: WINDOW_FIX, group: 'Window fix', for: JOB });
    const g = (await groupNamed('Window fix'))!;
    at('2026-10-22T21:00:50Z');
    await layout({ touch: looks(g) });
    at('2026-10-22T21:01:00Z');
    await verb('send', { child: JOB, text: 'new design' });
    at('2026-10-22T21:01:05Z');
    expect((await verb('ungroup', { targets: [g.id] })).status).toBe(200);
    // His panel closes on the dissolve; the window reports what it last showed.
    at('2026-10-22T21:01:06Z');
    await layout({ touch: looks(g) });
    expect(await links()).toEqual([null, null]);
    expect(await tick('2026-10-22T21:03:00Z')).toEqual([]);
  });

  it('a later result he sees long after it finished: the grace counts from his click, not the finish', async () => {
    at('2026-10-22T20:54:36Z');
    await verb('open', { kind: 'image', refs: WINDOW_FIX, group: 'Window fix', for: JOB });
    const g = (await groupNamed('Window fix'))!;
    // The child finished another result at 21:00 (its row's stamp); he was away.
    const finished = Date.parse('2026-10-22T21:00:00Z');
    await writeSuper(root, (s) => { s.children[JOB].finishedAt = finished; });
    at('2026-10-22T21:10:00Z');
    expect((await seen([{ id: JOB, at: finished }])).status).toBe(200);
    resetSuperIndex();
    expect(await tick('2026-10-22T21:11:00Z')).toEqual([]);
    expect(await tick('2026-10-22T21:11:31Z')).toEqual([g.id]);
  });

  it('a picture he drags out of the group he has open, right after the send, keeps both (the group dissolves)', async () => {
    at('2026-10-22T20:54:36Z');
    await verb('open', { kind: 'image', refs: WINDOW_FIX, group: 'Window fix', for: JOB });
    const g = (await groupNamed('Window fix'))!;
    at('2026-10-22T21:01:20Z');
    await layout({ touch: looks(g) });
    at('2026-10-22T21:01:32Z');
    await verb('send', { child: JOB, text: 'new design' });
    at('2026-10-22T21:01:35Z');
    expect((await layout({ leave: [g.cards[0]] })).status).toBe(200);
    expect((await state()).groups).toEqual([]);
    expect(await links()).toEqual([null, null]);
    _resetTidy();
    expect(await tick('2026-10-22T21:03:30Z')).toEqual([]);
  });

  it('a view he sets after the move makes what it shows his; ending the super\'s presentation is no look', async () => {
    at('2026-10-22T21:09:10Z');
    await verb('open', { kind: 'image', refs: OPTIONS, group: 'Row options', for: JOB });
    const options = (await groupNamed('Row options'))!;
    await verb('present', { containers: options.cards });
    at('2026-10-22T21:12:58Z');
    await verb('send', { child: JOB, text: 'build A' });
    at('2026-10-22T21:13:10Z');
    expect((await layout({ view: { mode: 'float' } })).status).toBe(200);
    expect(await links()).toEqual([JOB, JOB, JOB]);
    at('2026-10-22T21:13:20Z');
    expect((await layout({ view: { mode: 'half', card: options.cards[0] } })).status).toBe(200);
    expect(await links()).toEqual([null, JOB, JOB]);
  });

  it('one he brings back from Others is his, whether or not its job moved on again', async () => {
    at('2026-10-22T20:54:36Z');
    await verb('open', { kind: 'image', refs: WINDOW_FIX, group: 'Window fix', for: JOB });
    at('2026-10-22T21:01:32Z');
    await verb('send', { child: JOB, text: 'new design' });
    const g = (await groupNamed('Window fix'))!;
    expect(await tick('2026-10-22T21:03:10Z')).toEqual([g.id]);
    at('2026-10-22T21:25:00Z');
    expect((await layout({ cards: [{ id: g.id, place: 'float' }] })).status).toBe(200);
    expect(await links()).toEqual([null, null]);
    at('2026-10-22T21:30:00Z');
    await verb('send', { child: JOB, text: 'later work' });
    expect(await tick('2026-10-22T21:32:00Z')).toEqual([]);
  });

  it('without --for (what the stage did): both groups still float at 00:16', async () => {
    await replay(false);
    const s = await state();
    expect(s.groups.filter((g) => g.place === 'float').map((g) => g.name).sort()).toEqual(['Pending work', 'Window fix']);
  });
});

describe('super open image --for', () => {
  it('links each picture to the job, and re-opening shows it again for that job', async () => {
    const t0 = at('2026-10-22T20:00:00Z');
    expect((await verb('open', { kind: 'image', ref: 'shots/a.png', for: JOB })).status).toBe(200);
    let k = (await state()).containers.find((c) => c.ref === 'shots/a.png')!;
    expect([k.forChild, k.forAt]).toEqual([JOB, t0]);
    const t1 = at('2026-10-22T20:10:00Z');
    await verb('open', { kind: 'image', ref: 'shots/a.png' });
    k = (await state()).containers.find((c) => c.ref === 'shots/a.png')!;
    expect([k.forChild, k.forAt]).toEqual([JOB, t1]);
    at('2026-10-22T20:20:00Z');
    await verb('open', { kind: 'image', ref: 'shots/a.png', for: OTHER });
    expect((await state()).containers.find((c) => c.ref === 'shots/a.png')?.forChild).toBe(OTHER);
  });

  it('the 2-minute picture chain never puts two jobs\' pictures in one group', async () => {
    at('2026-10-22T20:00:00Z');
    await verb('open', { kind: 'image', ref: 'shots/a.png', for: JOB });
    at('2026-10-22T20:00:30Z');
    const other = await verb('open', { kind: 'image', ref: 'shots/b.png', for: OTHER });
    expect(other.json.result).not.toHaveProperty('group');
    at('2026-10-22T20:01:00Z');
    await verb('open', { kind: 'image', ref: 'shots/c.png' });
    expect((await state()).groups).toEqual([]);
    // The same job's next picture within the window still joins.
    at('2026-10-22T20:01:20Z');
    await verb('open', { kind: 'image', ref: 'shots/d.png', for: OTHER });
    at('2026-10-22T20:01:40Z');
    const same = await verb('open', { kind: 'image', ref: 'shots/e.png', for: OTHER });
    expect((same.json.result as { autoGroup?: boolean }).autoGroup).toBe(true);
    const g = (await state()).groups;
    const ref = (id: string) => (async () => (await state()).containers.find((k) => k.id === id)?.ref)();
    expect(g).toHaveLength(1);
    expect(await Promise.all(g[0].cards.map(ref))).toEqual(['shots/d.png', 'shots/e.png']);
  });

  it('…nor a re-opened picture still linked to a job with one that is not', async () => {
    at('2026-10-22T20:00:00Z');
    await verb('open', { kind: 'image', ref: 'shots/a.png', for: JOB });
    at('2026-10-22T20:05:00Z');
    await verb('open', { kind: 'image', ref: 'shots/b.png' });
    at('2026-10-22T20:05:30Z');
    await verb('open', { kind: 'image', ref: 'shots/a.png' });
    expect((await state()).groups).toEqual([]);
    expect(await links()).toEqual([JOB, null]);
  });

  it('…nor the same child\'s picture from before its job moved on (a design it was sent to replace)', async () => {
    at('2026-10-22T20:00:00Z');
    await verb('open', { kind: 'image', ref: 'shots/v1.png', for: JOB });
    at('2026-10-22T20:00:30Z');
    await verb('send', { child: JOB, text: 'another design' });
    at('2026-10-22T20:00:50Z');
    const v2 = await verb('open', { kind: 'image', ref: 'shots/v2.png', for: JOB });
    expect(v2.json.result).not.toHaveProperty('group');
    // Nor a group still holding a picture of the earlier job (its other picture shown again).
    at('2026-10-22T20:10:00Z');
    await verb('open', { kind: 'image', refs: ['shots/v3a.png', 'shots/v3b.png'], for: JOB });
    at('2026-10-22T20:10:20Z');
    await verb('send', { child: JOB, text: 'and again' });
    at('2026-10-22T20:10:30Z');
    await verb('open', { kind: 'image', ref: 'shots/v3b.png', for: JOB });
    at('2026-10-22T20:10:40Z');
    await verb('open', { kind: 'image', ref: 'shots/v4.png', for: JOB });
    const s = await state();
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].cards).toHaveLength(2);
  });

  it('a picture shown again for the job leaves its turned-down group for the new set (owner 2026-10-23)', async () => {
    at('2026-10-22T20:00:00Z');
    await verb('open', { kind: 'image', refs: ['shots/a.png', 'shots/b.png'], for: JOB });
    at('2026-10-22T20:00:30Z');
    await verb('send', { child: JOB, text: 'redo b' });
    // b regenerated at the same path, shown with a new one: b and c are the set, a stands apart.
    at('2026-10-22T20:05:00Z');
    await verb('open', { kind: 'image', refs: ['shots/b.png', 'shots/c.png'], for: JOB });
    const ref = (s: SuperState, id: string) => s.containers.find((k) => k.id === id)?.ref;
    let s = await state();
    expect(s.groups.map((g) => g.cards.map((id) => ref(s, id)))).toEqual([['shots/b.png', 'shots/c.png']]);
    // Named as the only group there is (the one it left dissolved).
    expect(s.groups[0].name).toBe('shots');
    expect(await links()).toEqual([JOB, JOB, JOB]);
    // The turned-down one goes on its own; the set stays.
    expect(await tick('2026-10-22T20:06:00Z')).toEqual([s.containers.find((k) => k.ref === 'shots/a.png')!.id]);
    // Named with one of this set later, new ones join it.
    at('2026-10-22T20:07:00Z');
    await verb('open', { kind: 'image', refs: ['shots/b.png', 'shots/d.png'], for: JOB });
    s = await state();
    expect(s.groups.map((g) => g.cards.map((id) => ref(s, id)))).toEqual([['shots/b.png', 'shots/c.png', 'shots/d.png']]);
  });

  it('…and one of another child\'s group shown for this job leaves it too', async () => {
    at('2026-10-22T20:00:00Z');
    await verb('open', { kind: 'image', refs: ['shots/a.png', 'shots/b.png'], for: OTHER });
    at('2026-10-22T20:05:00Z');
    await verb('open', { kind: 'image', refs: ['shots/b.png', 'shots/c.png', 'shots/d.png'], for: JOB });
    const s = await state();
    expect(s.groups.map((g) => g.cards.map((id) => s.containers.find((k) => k.id === id)?.ref))).toEqual([['shots/b.png', 'shots/c.png', 'shots/d.png']]);
    expect(s.containers.find((k) => k.ref === 'shots/a.png')?.forChild).toBe(OTHER);
  });

  it('…but a group of unlinked pictures (his, or shown for no job) is never broken up', async () => {
    at('2026-10-22T20:00:00Z');
    await verb('open', { kind: 'image', refs: ['shots/a.png', 'shots/b.png'] });
    const g = (await state()).groups[0];
    at('2026-10-22T20:05:00Z');
    await verb('open', { kind: 'image', refs: ['shots/b.png', 'shots/c.png'], for: JOB });
    const s = await state();
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({ id: g.id, cards: g.cards });
    // On purpose: shown for the job now, it carries the link where it stands.
    expect(s.containers.find((k) => k.ref === 'shots/b.png')?.forChild).toBe(JOB);
  });

  it('…nor one the owner placed (his drop position)', async () => {
    at('2026-10-22T20:00:00Z');
    await verb('open', { kind: 'image', refs: ['shots/a.png', 'shots/b.png'], for: OTHER });
    const g = (await state()).groups[0];
    await writeSuper(root, (s) => { s.groups[0].pos = { x: 0.2, y: 0.3 }; });
    at('2026-10-22T20:05:00Z');
    await verb('open', { kind: 'image', refs: ['shots/b.png', 'shots/c.png', 'shots/d.png'], for: JOB });
    const s = await state();
    expect(s.groups.find((x) => x.id === g.id)?.cards).toEqual(g.cards);
  });

  it('a pull never takes the stage past its floating limit (the group it left still stands)', async () => {
    at('2026-10-22T20:00:00Z');
    await verb('open', { kind: 'image', refs: ['shots/a.png', 'shots/b.png'], for: OTHER });
    for (let i = 0; i < 11; i++) expect((await verb('open', { kind: 'image', ref: `pad/p${i}.png`, group: false })).status).toBe(200);
    const was = await state();
    expect(was.containers.filter((k) => k.place === 'float' && !was.groups.some((g) => g.cards.includes(k.id))).length + was.groups.length).toBe(12);
    at('2026-10-22T20:05:00Z');
    const r = await verb('open', { kind: 'image', refs: ['shots/b.png', 'shots/c.png', 'shots/d.png'], for: JOB });
    expect(r.status).toBe(409);
    expect((await state()).groups).toEqual(was.groups);
  });

  it('…and a new set is only ever one job\'s pictures', async () => {
    at('2026-10-22T20:00:00Z');
    await verb('open', { kind: 'image', ref: 'shots/x.png', for: JOB });
    at('2026-10-22T20:10:00Z');
    await verb('open', { kind: 'image', refs: ['shots/x.png', 'shots/y.png'] });
    expect((await state()).groups).toEqual([]);
  });

  it('…while new pictures named with one of the same job still join its group', async () => {
    at('2026-10-22T20:00:00Z');
    await verb('open', { kind: 'image', refs: ['shots/a.png', 'shots/b.png'], for: JOB });
    at('2026-10-22T20:05:00Z');
    await verb('open', { kind: 'image', refs: ['shots/b.png', 'shots/c.png'], for: JOB });
    expect((await state()).groups.map((x) => x.cards.length)).toEqual([3]);
  });

  it('is refused for another kind and for a child that is not the super\'s', async () => {
    const r1 = await verb('open', { kind: 'task', ref: 'ship-it', for: JOB });
    expect([r1.status, r1.json.error]).toEqual([400, 'invalid_args']);
    const r2 = await verb('open', { kind: 'image', ref: 'shots/a.png', for: 'not-a-child-0000' });
    expect([r2.status, r2.json.error]).toEqual([404, 'unknown_child']);
    expect((await state()).containers).toEqual([]);
  });

  it('the briefing tells the super to pass it', () => {
    expect(SUPER_SHOW_SECTION).toMatch(/--for <child>/);
  });
});

describe('when a job has moved on (pure)', () => {
  const T = 1_800_000_000_000;
  const pic = (extra: Partial<SuperContainer> = {}): SuperContainer => ({ id: 'image-a', kind: 'image', ref: 'a.png', shape: 'square', place: 'float', forChild: JOB, forAt: T, ...extra });
  const kids = (extra: Record<string, unknown>) => ({ [JOB]: { ...child(JOB), ...extra } }) as SuperState['children'];

  it('new work, an end or a later result seen move it on; anything before it was shown does not', () => {
    expect(jobMovedOn(pic(), kids({ sentAt: T + 5 }))).toBe(T + 5);
    expect(jobMovedOn(pic(), kids({ endedAt: T + 7 }))).toBe(T + 7);
    expect(jobMovedOn(pic(), kids({ finishedAt: T + DONE_SETTLE_MS + 1, seenAt: T + 90_000 }))).toBe(T + 90_000);
    // Dated when he marked it (the server's clock), not by the finish key his window showed.
    expect(jobMovedOn(pic(), kids({ finishedAt: T + 60_000, seenAt: T + 60_000, seenMarkedAt: T + 600_000 }))).toBe(T + 600_000);
    // The result the pictures show, stamped as its row settled after they were opened: not moved on.
    expect(jobMovedOn(pic(), kids({ finishedAt: T + DONE_SETTLE_MS - 1, seenAt: T + DONE_SETTLE_MS - 1, seenMarkedAt: T + 90_000 }))).toBeUndefined();
    // Once he saw a later result, a newer finish never undoes it (the finish key he saw only rises).
    expect(jobMovedOn(pic(), kids({ finishedAt: T + 900_000, seenAt: T + 60_000, seenMarkedAt: T + 120_000 }))).toBe(T + 120_000);
    expect(jobMovedOn(pic(), kids({ sentAt: T + 5, endedAt: T + 2 }))).toBe(T + 2);
    // The result the pictures show (finished and seen before they were opened): not moved on.
    expect(jobMovedOn(pic(), kids({ sentAt: T - 1, endedAt: T - 1, finishedAt: T - 5, seenAt: T + 9 }))).toBeUndefined();
    // A newer result not seen yet: not moved on.
    expect(jobMovedOn(pic(), kids({ finishedAt: T + 3 }))).toBeUndefined();
    expect(jobMovedOn(pic(), kids({ succeededBy: OTHER, succeededAt: T + 4 }))).toBe(T + 4);
    expect(jobMovedOn(pic({ forChild: undefined }), kids({ sentAt: T + 5 }))).toBeUndefined();
    expect(jobMovedOn(pic(), {})).toBeUndefined();
  });

  const stage = (cards: SuperContainer[], extra: Partial<SuperState> = {}): SuperState =>
    ({ ...emptySuperState(), session: SUPER, enabled: true, containers: cards, children: kids({ sentAt: T + 60_000 }), ...extra });

  it('a picture whose job moved on goes once the grace is over; placement, size or view keep it', () => {
    const now = T + 60_000 + LOOK_GRACE_MS;
    expect(planTidy(stage([pic()]), () => T, now)).toEqual(['image-a']);
    // Inside the grace it holds its place: a look his window reports comes first.
    expect(planTidy(stage([pic()]), () => T, now - 1)).toEqual([]);
    // A change the super (or the clock's tick) dated after the move does not keep it.
    expect(planTidy(stage([pic()]), () => T + 90_000, now)).toEqual(['image-a']);
    expect(planTidy(stage([pic({ pos: { x: 0.1, y: 0.8 } })]), () => T, now)).toEqual([]);
    expect(planTidy(stage([pic({ sizeBy: 'owner' })]), () => T, now)).toEqual([]);
    expect(planTidy(stage([pic()], { view: { mode: 'half', card: 'image-a' } }), () => T, now)).toEqual([]);
    // Not linked: only the idle clock.
    expect(planTidy(stage([pic({ forChild: undefined, forAt: undefined })]), () => T, now)).toEqual([]);
    expect(planTidy(stage([pic({ forChild: undefined, forAt: undefined })]), () => T, T + TIDY_IDLE_MS)).toEqual(['image-a']);
  });

  it('a group goes when all its pictures may; a placed group stays', () => {
    const now = T + 60_000 + LOOK_GRACE_MS;
    const cards = [pic(), pic({ id: 'image-b', ref: 'b.png' })];
    const g = { id: 'grp-pics', name: 'Shots', cards: ['image-a', 'image-b'], place: 'float' as const };
    expect(planTidy(stage(cards, { groups: [g] }), () => T, now)).toEqual(['grp-pics']);
    expect(planTidy(stage(cards, { groups: [g] }), (id) => (id === 'grp-pics' ? T + 90_000 : T), now)).toEqual(['grp-pics']);
    expect(planTidy(stage(cards, { groups: [{ ...g, pos: { x: 0.1, y: 0.8 } }] }), () => T, now)).toEqual([]);
    // One picture linked to a job still current: the group waits for the idle clock.
    const mixed = [pic(), pic({ id: 'image-b', ref: 'b.png', forChild: undefined, forAt: undefined })];
    expect(planTidy(stage(mixed, { groups: [g] }), () => T, now)).toEqual([]);
  });

  it('what he looked at after the move is his: only those pictures, a group naming its cards', () => {
    const cards = [pic(), pic({ id: 'image-b', ref: 'b.png' }), pic({ id: 'image-c', ref: 'c.png' }), pic({ id: 'image-d', ref: 'd.png', forAt: T + 90_000 })];
    const s = stage(cards, { groups: [{ id: 'grp-pics', name: 'Shots', cards: ['image-a', 'image-b'], place: 'float' }] });
    // image-c he did not look at; image-d was shown after the move: still the job's.
    expect(keepOwnerLooked(s, ['grp-pics', 'image-d', 'task-x'])).toEqual(['image-a', 'image-b']);
    expect(s.containers.map((k) => k.forChild ?? null)).toEqual([null, null, JOB, JOB]);
  });

  it('handing the job on moves it on, even while the old child still runs', () => {
    const s = { ...emptySuperState(), children: { [JOB]: child(JOB), [OTHER]: child(OTHER) } } as SuperState;
    succeedChild(s, JOB, OTHER, { now: T + 4 });
    expect([s.children[JOB].succeededBy, s.children[JOB].succeededAt, s.children[JOB].endedAt]).toEqual([OTHER, T + 4, undefined]);
    expect(jobMovedOn(pic(), s.children)).toBe(T + 4);
  });

  it('a look sent from the window changes nothing on its stage (not even the server\'s auto mark)', () => {
    const st = { containers: [pic()], groups: [], view: { mode: 'half' as const, card: 'image-a', auto: true as const } };
    expect(applyLayoutPatch(st, { touch: ['image-a'] })).toBe(st);
  });

  it('the window reports the cards it last showed when a look closes, and never repaints from a look (source)', () => {
    const surface = readFileSync(join(__dirname, '../../dashboard/src/components/sleepy/super/SuperSurface.tsx'), 'utf8');
    expect(surface).toMatch(/return \(\) => \{ clearInterval\(timer\); if \(last\.length\) layoutRef\.current\(\{ touch: last \}\); \};/);
    expect(surface).toMatch(/setInterval\(look, Math\.min\(pollMs\(LOOK_RENEW_MS\), LOOK_RENEW_MS \* LIGHT_POLL_FACTOR\)\)/);
    // A panel left open in a hidden window is no look.
    expect(surface).toMatch(/const look = \(\) => \{\s*\/\/[^\n]*\n\s*if \(document\.hidden\) return;/);
    const agent = readFileSync(join(__dirname, '../../dashboard/src/components/sleepy/AgentSurface.tsx'), 'utf8');
    expect(agent).toMatch(/settle\(\); if \(!lookOnly\) setSuperState\(withPendingEdits\(st\)\);/);
  });

  it('the window reports a look well inside the server\'s grace (drift)', () => {
    // Its slowest cadence (capped at Light mode's, unfocused or not), with a third to spare.
    expect(LOOK_RENEW_MS * LIGHT_POLL_FACTOR * 1.5).toBeLessThanOrEqual(LOOK_GRACE_MS);
  });

  it('the record keeps the link only on a picture, and only to a child it holds', async () => {
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
      ...emptySuperState(), session: SUPER, enabled: true,
      children: { [JOB]: child(JOB, { sentAt: T, succeededAt: T }), [OTHER]: child(OTHER, { succeededBy: JOB, succeededAt: T }) },
      containers: [
        { id: 'image-a', kind: 'image', ref: 'a.png', shape: 'square', place: 'float', forChild: JOB, forAt: T },
        { id: 'image-b', kind: 'image', ref: 'b.png', shape: 'square', place: 'float', forChild: 'gone-child-0000', forAt: T },
        { id: 'task-c', kind: 'task', ref: 'ship-it', shape: 'square', place: 'float', forChild: JOB, forAt: T },
      ],
    }));
    resetSuperIndex();
    const s = await state();
    expect(s.children[JOB].sentAt).toBe(T);
    // A hand-over time only beside the hand-over itself.
    expect([s.children[JOB].succeededAt, s.children[OTHER].succeededAt]).toEqual([undefined, T]);
    expect(s.containers.map((k) => [k.id, k.forChild ?? null])).toEqual([['image-a', JOB], ['image-b', null], ['task-c', null]]);
  });
});
