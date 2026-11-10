/**
 * The owner-reach scenario suite (uye-bildirim criterion 13): every row of
 * `owner-reach-scenarios.data.ts` runs against the REAL modules (registry, inbox, answer, grants,
 * owner-question) with stand-in processes (no real `claude`), and must land on its `plan` column:
 * the surfaces that carry it to the owner, whether the Super Agent was told, the steps to unblock
 * it, and how many times he was asked; or, for an adversary row, that nothing is allowed. A row
 * with no verdict is red.
 *
 * Modeled, not driven (stated where they are read): a member's own bot (row s20: the member bot's
 * rule lives outside these modules), the steps of a routine (Review / Open on the Mac), and the
 * enforcers (rows s18, a1-a5 call W4's `match` and `whoAmI`, the same functions the hook gate and
 * the bridge call; the lead reruns this suite with both W5 lanes landed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/owner-answer-home-`);
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, bridgeRefusalFrame, registerChat, registerCrewHandle, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem, type SuperState } from '../../src/lib/super/types.js';
import {
  _resetSuperInbox, _superInboxDrained, grantCtx, nextBatch, ownerItems, projectOfRoot, setGrantEnvForTest, setMemberGateForTest, setMemberTitleSource,
  setRoutineFactsForTest, superTurnEnded, syncRoutineNeeds, wireSuperInbox, writeSuper,
} from '../../src/lib/super/inbox.js';
import { _resetOwnerAnswers, answerOwnerItem } from '../../src/lib/super/answer.js';
import { _resetOwnerQuestions, setOwnerQuestionSinks } from '../../src/lib/super/owner-question.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { handleSuperVerb, setTeamAskRouteForTest } from '../../src/server/routes/super.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { _resetDelegating } from '../../src/lib/super/delegating.js';
import { listGrants, newGrantId, writeGrant } from '../../src/lib/grants/store.js';
import { match } from '../../src/lib/grants/match.js';
import { whoAmI, type ProcSys } from '../../src/lib/grants/binding.js';
import type { Resolver } from '../../src/lib/grants/eligible.js';
import type { RoutineFacts } from '../../src/lib/automations/needs.js';
import { allowRows, shownWhole } from '../../src/server/telegram/asks.js';
import { needsOwner } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { SCENARIOS, type AdversaryVerdict, type ReachVerdict, type ScenarioRow, type Surface } from './owner-reach-scenarios.data.js';

let dir: string;
let root: string;
const MAIN = 'sess-main-walk-1';
let shaVersion = 'v1';
const RESOLVER: Resolver = {
  which: (n) => (['node', 'python3', 'bash', 'sh', 'tsx'].includes(n) ? `/opt/fakebin/${n}` : null),
  realpath: (p) => p,
  isRegularFile: () => true,
  sha256: () => (shaVersion === 'v1' ? 'a' : 'b').repeat(64),
};

function req(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(body === undefined ? '' : JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
const tokenFor = (sessionId: string, superId?: 'main' | `m:${string}`) =>
  mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId, mode: 'super', ...(superId ? { superId } : {}) }).token;
async function verb(token: string, name: string, body: Record<string, unknown> = {}) {
  const r = res();
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: name });
  return r;
}
const main = () => readSuperState(root);
const member = (slug: string) => readSuperState(root, `m:${slug}`);

// ─── Stand-ins: the sinks, the processes ──────────────────────────────────────────

let banners: string[] = [];
let telegram: string[] = [];
function sinks(away: boolean): void {
  setOwnerQuestionSinks({
    presence: () => ({ vault: null, session: null }),
    banner: (title) => { banners.push(title); return true; },
    telegram: ({ item }) => { if (!away) return 'at_mac'; telegram.push(item.id); return true; },
  });
}

async function memberSession(slug = 'rota'): Promise<{ session: string; request: string }> {
  const r = await verb(tokenFor(MAIN), 'team-ask', { member: slug, text: 'Build the funnel report.', brief: 'report' });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const s = await member(slug);
  return { session: s.session as string, request: s.queue.find((q) => q.kind === 'request')?.id as string };
}
function crew(sessionId: string, mode = 'auto'): ChatHandle {
  const h = registerChat({ sessionId, conversationId: null, vault: 'acme', mode: 'super', crew: true, permissionMode: mode });
  h.userSent('go');
  return h;
}
function child(sessionId: string): ChatHandle {
  const h = registerChat({ sessionId, conversationId: null, vault: 'acme', mode: 'basic', crew: true, permissionMode: 'auto' });
  h.userSent('go');
  return h;
}
async function adoptChild(slug: string, sid: string, origin?: string): Promise<void> {
  await writeSuper(root, `m:${slug}`, (s) => {
    s.children[sid] = { sessionId: sid, brief: 'a job', adopted: false, startedAt: Date.now(), row: 'working', ...(origin ? { workOrigin: origin as SuperState['children'][string]['workOrigin'] } : {}) } as SuperState['children'][string];
  });
}
function refuse(h: ChatHandle, command: string, opts: { id?: string; source?: string; reasonType?: string } = {}): void {
  const id = opts.id ?? `toolu_${Math.random().toString(36).slice(2, 8)}`;
  h.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  h.observe({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'refused' }] },
    tool_result_meta: [{ id, permission_decision: { decision: 'reject', source: opts.source ?? 'classifier', reason_type: opts.reasonType ?? 'classifier' } }],
  });
  h.observe({ type: 'result', subtype: 'success', is_error: false });
}
function permission(h: ChatHandle, requestId: string, tool: string, input: Record<string, unknown>): void {
  h.observe({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: `toolu_${requestId}` } });
}

// ─── Measuring what reached him ────────────────────────────────────────────────

/** The surfaces that carry a main-queue item (and its member's own item) to him right now. */
async function reach(mainItem: SuperQueueItem | undefined, slug: string | null, opts: { banner?: boolean; ownBot?: boolean } = {}): Promise<{ sees: Surface[]; superTold: boolean }> {
  const m = await main();
  const sees: Surface[] = [];
  // The rule his bar and the Super chat card actually read (the dashboard's `needsOwner` over
  // main's queue): a member's mirror, a routine, a session's own item are his from birth.
  const onBar = !!mainItem && m.queue.some((q) => q.id === mainItem.id && needsOwner(q as unknown as Parameters<typeof needsOwner>[0]));
  if (onBar) sees.push('bar', 'Super chat');
  // A routine with a member counts on that member's badge (its item names the member).
  const badge = (slug ? ownerItems(await member(slug)).some((q) => q.state !== 'done') : false) || (mainItem?.kind === 'routine' && !!mainItem.member);
  if (badge) sees.push('member badge');
  if (mainItem && telegram.includes(mainItem.id)) sees.push('Telegram');
  if (opts.banner && banners.length) sees.push('banner');
  if (opts.ownBot) sees.push("member's own bot");
  const now = m.queue.find((q) => q.id === mainItem?.id);
  const superTold = !!now && now.state !== 'escalated' && (nextBatch(m).items.some((q) => q.id === now.id) || now.state === 'delivered' || now.state === 'pending');
  return { sees, superTold };
}

/** One in-place answer: a step when the answer function took it (a window that a test has no
 *  stand-in for, `no_window`, is the same step on the Mac). */
async function step(record: string, item: string, answer: Parameters<typeof answerOwnerItem>[1]['answer'], via: Parameters<typeof answerOwnerItem>[1]['via'] = 'bar'): Promise<number> {
  const r = await answerOwnerItem(root, { record, item, answer, via });
  return r.ok || r.error === 'no_window' ? 1 : 0;
}

const mirrorOf = async (memberItem: string | undefined) => (await main()).queue.find((q) => q.kind === 'member' && q.answers === memberItem);
const ownItem = async (slug: string, pred: (q: SuperQueueItem) => boolean) => (await member(slug)).queue.find((q) => q.own === true && pred(q));

// ─── Drivers: one per kind of situation ─────────────────────────────────────────

type Outcome = ReachVerdict | AdversaryVerdict;

async function memberAsk(via: 'bar' | 'phone'): Promise<Outcome> {
  const { session } = await memberSession();
  const r = await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'May I send the DM?', options: ['Send it', 'Do not send'], for: 'owner' });
  await _superInboxDrained();
  const ask = (r.json.result as { item: string }).item;
  const mirror = await mirrorOf(ask);
  const seen = await reach(mirror, 'rota');
  const steps = await step('main', mirror!.id, { kind: 'question', answers: { 'May I send the DM?': 'Send it' } }, via);
  return { ...seen, steps, asked: 1 };
}

async function memberRefusal(command: string, via: 'bar' | 'telegram', size: 'once' | 'job' = 'once'): Promise<Outcome & { session: string }> {
  const { session } = await memberSession();
  refuse(crew(session), command);
  await _superInboxDrained();
  const own = await ownItem('rota', (q) => q.wait?.kind === 'refusal');
  const mirror = await mirrorOf(own?.id);
  const seen = await reach(mirror, 'rota');
  registerCrewHandle(session, { sendServerTurn: () => true });
  const steps = await step('main', mirror!.id, { kind: 'refusal', action: 'allow', size }, via);
  return { ...seen, steps, asked: 1, session };
}

async function childPermission(origin: 'owner' | 'main', tool: string, input: Record<string, unknown>): Promise<Outcome> {
  const { request } = await memberSession();
  const sid = 'sess-rota-child-1';
  await adoptChild('rota', sid, origin === 'main' ? `main:${request}` : undefined);
  permission(child(sid), 'req-child-1', tool, input);
  await _superInboxDrained();
  const item = (await member('rota')).queue.find((q) => q.kind === 'permission' && q.sessionId === sid);
  const mirror = await mirrorOf(item?.id);
  // The mirror carries the job's call: a Bash command whole, a file tool's path never whole.
  expect(mirror?.call?.tool).toBe(tool);
  expect(mirror?.call?.whole).toBe(tool === 'Bash');
  if (tool === 'Bash') expect(mirror?.call?.input).toBe(String(input.command));
  const seen = await reach(mirror, 'rota');
  const steps = await step('main', mirror!.id, { kind: 'permission', behavior: 'allow' });
  return { ...seen, steps, asked: 1 };
}

async function routine(kind: 'awaiting-approval' | 'denials' | 'owner-card' | 'question'): Promise<Outcome> {
  const base: RoutineFacts['routines'][number] = { slug: 'scout-sweep', title: 'Scout sweep', member: 'rota', hash: 'h1', post: null, newest: null, newestLight: null };
  const f: RoutineFacts = { questions: [], routines: [base] };
  if (kind === 'awaiting-approval') f.questions.push({ id: 'hq-1', slug: 'scout-sweep', kind: 'approval', question: 'Its instructions changed. Approve?' } as unknown as RoutineFacts['questions'][number]);
  if (kind === 'question') f.questions.push({ id: 'hq-2', slug: 'scout-sweep', kind: 'chat', question: 'Which market first?' } as unknown as RoutineFacts['questions'][number]);
  if (kind === 'denials') base.newestLight = { status: 'ok', firedAt: '2026-11-10T02:00:00.000Z', startedAt: '2026-11-10T02:00:01.000Z', error: null, permissionDenials: 3, light: true, deniedCalls: [{ tool: 'Bash', input: 'node a.mjs' }, { tool: 'Bash', input: 'node b.mjs' }, { tool: 'Bash', input: 'node c.mjs' }] };
  if (kind === 'owner-card') base.post = { id: 'e-1', answered: false, text: '```dream-view\n{"type":"run","id":"gh-login","command":"gh auth login","why":"sign in to GitHub"}\n```' };
  setRoutineFactsForTest(() => f);
  await syncRoutineNeeds(root);
  await _superInboxDrained();
  const item = (await main()).queue.find((q) => q.kind === 'routine');
  const seen = await reach(item, null);
  // No answer in place (approval needs the change in view; a card runs in his terminal): modeled
  // steps on the Mac, after the answer function said it is not its to take.
  const inPlace = await answerOwnerItem(root, { record: 'main', item: item!.id, via: 'bar', answer: { kind: 'dismiss' } });
  expect(inPlace).toMatchObject({ ok: false, error: 'not_offered' });
  const steps = kind === 'awaiting-approval' || kind === 'owner-card' ? 2 : 1;
  return { ...seen, steps, asked: 1 };
}

const DRIVERS: Record<string, (row: ScenarioRow) => Promise<Outcome>> = {
  'member-ask': () => memberAsk('bar'),
  'member-ask-phone': () => memberAsk('phone'),
  'member-refusal': () => memberRefusal('node scripts/report.mjs', 'bar'),
  'member-refusal-telegram': () => memberRefusal('node scripts/report.mjs', 'telegram'),
  'child-permission': () => childPermission('owner', 'Bash', { command: 'node scripts/report.mjs' }),
  'child-permission-main-work': () => childPermission('main', 'Bash', { command: 'node scripts/report.mjs' }),
  'child-permission-edit': () => childPermission('owner', 'Edit', { file_path: join(dir, 'acme', 'src', 'app.ts'), old_string: 'a', new_string: 'b' }),
  'child-question-main-work': async () => {
    const { request } = await memberSession();
    const sid = 'sess-rota-child-q';
    await adoptChild('rota', sid, `main:${request}`);
    child(sid).observe({ type: 'control_request', request_id: 'req-q', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q', input: { questions: [{ question: 'Weekly or monthly?', options: [{ label: 'Weekly' }, { label: 'Monthly' }] }] } } });
    await _superInboxDrained();
    const item = (await member('rota')).queue.find((q) => q.kind === 'question' && q.sessionId === sid);
    expect(item?.direct).toBeUndefined();
    const seen = await reach(await mirrorOf(item?.id), null);
    return { ...seen, steps: 0, asked: 0 };
  },
  'member-ask-super-answers': async () => {
    registerChat({ sessionId: MAIN, conversationId: null, vault: 'acme', mode: 'super' });
    const { session } = await memberSession();
    const r = await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'Which depot first?', options: ['North', 'South'], for: 'owner' });
    await _superInboxDrained();
    const mirror = await mirrorOf((r.json.result as { item: string }).item);
    const onBar = (await main()).queue.some((q) => q.id === mirror?.id && needsOwner(q as unknown as Parameters<typeof needsOwner>[0]));
    const told = mirror?.state === 'pending';
    await verb(tokenFor(MAIN), 'team-answer', { item: mirror!.id, text: 'North, he said so on Monday.' });
    await _superInboxDrained();
    const sees: Surface[] = [...(onBar ? ['bar' as const] : []), ...(telegram.includes(mirror!.id) ? ['Telegram' as const] : [])];
    return { sees, superTold: told, steps: 0, asked: 0 };
  },
  'member-own-permission': async () => {
    const { session } = await memberSession();
    permission(crew(session, 'default'), 'req-own-1', 'Bash', { command: 'node scripts/report.mjs' });
    await _superInboxDrained();
    const own = await ownItem('rota', (q) => q.kind === 'permission');
    const mirror = await mirrorOf(own?.id);
    const seen = await reach(mirror, 'rota');
    return { ...seen, steps: await step('main', mirror!.id, { kind: 'permission', behavior: 'allow' }), asked: 1 };
  },
  'member-stall': async () => {
    const { session, request } = await memberSession();
    await writeSuper(root, 'm:rota', (s) => { const q = s.queue.find((x) => x.id === request); if (q) { q.state = 'delivered'; q.acceptedAt = Date.now(); } });
    const h = registerChat({ sessionId: session, conversationId: null, vault: 'acme', mode: 'super', crew: true, permissionMode: 'auto' });
    const silent = async () => {
      h.userSent('go on');
      h.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'The owner must decide which funnel goes first.' }] } });
      h.observe({ type: 'result', subtype: 'success', is_error: false });
      superTurnEnded(session);
      await new Promise((r) => setTimeout(r, 5));
      await _superInboxDrained();
    };
    await silent();
    await writeSuper(root, 'm:rota', (d) => { const q = d.queue.find((x) => x.kind === 'nudge'); if (q) q.state = 'delivered'; });
    await silent();
    const own = await ownItem('rota', (q) => q.wait?.kind === 'stalled');
    const mirror = await mirrorOf(own?.id);
    const seen = await reach(mirror, 'rota');
    return { ...seen, steps: await step('main', mirror!.id, { kind: 'dismiss' }), asked: 1 };
  },
  'main-refusal': async () => {
    await writeSuper(root, (s) => { s.enabled = true; });
    refuse(crew(MAIN), 'node scripts/deploy-check.mjs');
    await _superInboxDrained();
    const own = (await main()).queue.find((q) => q.own && q.wait?.kind === 'refusal');
    const seen = await reach(own, null);
    registerCrewHandle(MAIN, { sendServerTurn: () => true });
    return { ...seen, steps: await step('main', own!.id, { kind: 'refusal', action: 'allow' }), asked: 1 };
  },
  'bridge-refusal': async () => {
    await memberSession();
    const sid = 'sess-rota-codex';
    await adoptChild('rota', sid);
    const h = child(sid);
    h.observe(bridgeRefusalFrame('exec_command', { command: ['npm', 'test'] }, 'denied unattended', 'call-1') as unknown as Record<string, unknown>);
    h.observe({ type: 'result', subtype: 'success', is_error: false });
    await _superInboxDrained();
    const item = (await member('rota')).queue.find((q) => q.kind === 'owner' && q.wait?.kind === 'refusal' && q.sessionId === sid);
    const mirror = await mirrorOf(item?.id);
    const seen = await reach(mirror, 'rota');
    registerCrewHandle(sid, { sendServerTurn: () => true });
    return { ...seen, steps: await step('main', mirror!.id, { kind: 'refusal', action: 'allow' }, 'telegram'), asked: 1 };
  },
  'routine-awaiting-approval': () => routine('awaiting-approval'),
  'routine-denials': () => routine('denials'),
  'routine-card': () => routine('owner-card'),
  'routine-question': () => routine('question'),
  'three-members': async () => {
    for (const slug of ['scout', 'nova']) createAgent(root, { slug, title: slug, prompt: 'You help.' }, { approve: { now: new Date() } });
    let steps = 0;
    const mirrors: SuperQueueItem[] = [];
    for (const slug of ['rota', 'scout', 'nova']) {
      const { session } = await memberSession(slug);
      permission(crew(session, 'default'), `req-${slug}`, 'Bash', { command: 'node scripts/report.mjs' });
      await _superInboxDrained();
      const own = await ownItem(slug, (q) => q.kind === 'permission');
      mirrors.push((await mirrorOf(own?.id)) as SuperQueueItem);
    }
    const seen = await reach(mirrors[0], 'rota');
    for (const m of mirrors) steps += await step('main', m.id, { kind: 'permission', behavior: 'allow' }, 'telegram');
    return { ...seen, steps, asked: mirrors.filter(Boolean).length };
  },
  'same-script-thrice': async () => {
    const r = await memberRefusal('node scripts/funnel.mjs north', 'bar', 'job');
    // The next two runs of the same script in the same session: the job rule covers them.
    const grants = listGrants(projectOfRoot(root));
    let asked = 1;
    for (const arg of ['south', 'west']) {
      const g = match(grants, { project: projectOfRoot(root), pin: r.session, member: 'rota', tool: 'Bash', input: { command: `node scripts/funnel.mjs ${arg}` } }, grantCtx(root));
      if (!g) asked += 1;
    }
    return { sees: (r as ReachVerdict).sees, superTold: (r as ReachVerdict).superTold, steps: (r as ReachVerdict).steps, asked };
  },
  'member-outward': async () => {
    const r = await memberRefusal('git push origin main', 'bar');
    const own = await ownItem('rota', (q) => q.wait?.kind === 'refusal');
    expect(own?.offer?.sizes).toEqual(['once']);
    expect(own?.offer?.onceOnlyReason).toContain('off this Mac');
    return { sees: (r as ReachVerdict).sees, superTold: (r as ReachVerdict).superTold, steps: (r as ReachVerdict).steps, asked: 1 };
  },
  'main-off': async () => {
    const { session } = await memberSession();
    await writeSuper(root, (s) => { s.enabled = false; });
    await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'May I send the DM?', options: ['Send it', 'Do not send'], for: 'owner' });
    await _superInboxDrained();
    const anyMirror = (await main()).queue.find((q) => q.kind === 'member' && q.state !== 'done');
    // No Super stage: no bar; the member's own record holds it and its banner opens the member.
    // Its own bot is the member bot's rule (modeled: it carries what the member record holds).
    const seen = await reach(anyMirror, 'rota', { banner: true, ownBot: !anyMirror });
    return { ...seen, steps: 2, asked: 1 };
  },
  'hook-guidance': async () => {
    const { session } = await memberSession();
    refuse(crew(session), 'cat secrets.txt', { source: 'hook', reasonType: 'hook' });
    await _superInboxDrained();
    const any = (await member('rota')).queue.find((q) => q.own && q.state !== 'done');
    return { ...(await reach(any ? await mirrorOf(any.id) : undefined, null)), steps: 0, asked: any ? 1 : 0 };
  },
  // ─── Adversaries ───────────────────────────────────────────────────────────
  'adv-script-edited': async () => {
    const r = await memberRefusal('node scripts/funnel.mjs north', 'bar', 'job');
    shaVersion = 'v2';
    const g = match(listGrants(projectOfRoot(root)), { project: projectOfRoot(root), pin: r.session, member: 'rota', tool: 'Bash', input: { command: 'node scripts/funnel.mjs south' } }, grantCtx(root));
    return { allowed: !!g as false };
  },
  'adv-forged-env': async () => {
    const r = await memberRefusal('node scripts/funnel.mjs north', 'bar', 'job');
    expect(listGrants(projectOfRoot(root)).length).toBeGreaterThan(0);
    // A `claude` the agent started itself, claiming the member's session: no binding was written
    // for its process, so it has no identity and no grant can match it.
    const sys: ProcSys = { selfPid: 999_001, parentOf: () => 999_000, startTimeOf: () => 'Mon Nov 10 09:00:00 2026', realpath: (p) => p } as unknown as ProcSys;
    const who = whoAmI({ conversationId: r.session, project: projectOfRoot(root) }, sys, { mode: 'hook' });
    return { allowed: !!who as false };
  },
  'adv-telegram-cut': async () => {
    const long = `node scripts/funnel.mjs ${'x'.repeat(1600)}`;
    const sizes = shownWhole(long) ? (['once', 'job'] as const) : ([] as const);
    const { choices } = allowRows([...sizes], 'Rota', 'not_needed');
    return { allowed: choices.some((c) => c !== 'not_needed') as false };
  },
  'adv-handwritten-once': async () => {
    const { session } = await memberSession();
    const now = Date.now();
    writeGrant({ id: newGrantId('once'), scope: 'once', project: projectOfRoot(root), pin: session, tool: 'Bash', input: 'node scripts/funnel.mjs north', form: 'exact', createdAt: now, expiresAt: now + 60_000 });
    const g = match(listGrants(projectOfRoot(root)), { project: projectOfRoot(root), pin: session, member: 'rota', tool: 'Bash', input: { command: 'node scripts/funnel.mjs north' } }, grantCtx(root));
    return { allowed: !!g as false };
  },
  'adv-wrapper': async () => {
    const r = await memberRefusal('node scripts/funnel.mjs north', 'bar', 'job');
    const g = match(listGrants(projectOfRoot(root)), { project: projectOfRoot(root), pin: r.session, member: 'rota', tool: 'Bash', input: { command: 'env node scripts/funnel.mjs north' } }, grantCtx(root));
    return { allowed: !!g as false };
  },
};

beforeEach(() => {
  setTeamAskRouteForTest('request');
  // The grant store lives under HOME, set once per file: each test starts with none of the last
  // test's grants (a leftover one-shot names another item and would answer for it).
  rmSync(join(process.env.HOME as string, '.dreamcontext', 'grants'), { recursive: true, force: true });
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'owner-answer-')));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
  shaVersion = 'v1';
  banners = [];
  telegram = [];
  resetWindowControl();
  resetSuperIndex();
  _resetSuperInbox();
  _resetChatRegistry();
  _resetDelegating();
  _resetOwnerQuestions();
  _resetOwnerAnswers();
  setMemberGateForTest(null);
  setMemberTitleSource((_r, slug) => slug);
  setGrantEnvForTest({ resolver: () => RESOLVER, roots: (p) => [p, '/tmp'] });
  wireSuperInbox();
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: MAIN, enabled: true }));
  createAgent(root, { slug: 'rota', title: 'Rota Planner', prompt: 'You keep the routes.' }, { approve: { now: new Date() } });
});
afterEach(async () => {
  await _superInboxDrained();
  setTeamAskRouteForTest(null);
  setMemberGateForTest(null);
  setMemberTitleSource(null);
  setRoutineFactsForTest(null);
  setGrantEnvForTest({ resolver: null, roots: null });
  rmSync(dir, { recursive: true, force: true });
});

describe('the scenario walk: every row lands on its plan column', () => {
  it('every row has a verdict and a driver (a row nobody wrote is red)', () => {
    for (const row of SCENARIOS) {
      expect(row.plan, `${row.id} has no plan verdict`).not.toBeNull();
      expect(DRIVERS[row.driver], `${row.id} has no driver "${row.driver}"`).toBeTypeOf('function');
    }
    expect(SCENARIOS.filter((r) => r.id.startsWith('s'))).toHaveLength(22);
    expect(SCENARIOS.filter((r) => r.id.startsWith('a'))).toHaveLength(5);
    expect(new Set(SCENARIOS.map((r) => r.tool))).toEqual(new Set(['claude', 'codex', 'antigravity']));
  });

  for (const row of SCENARIOS) {
    it(`${row.id} [${row.tool}] ${row.who}`, async () => {
      if (!row.plan) throw new Error(`${row.id}: no verdict`);
      sinks(row.away === true);
      const got = await DRIVERS[row.driver](row);
      if ('allowed' in row.plan) {
        expect(got).toEqual({ allowed: false });
        return;
      }
      const want = row.plan;
      const g = got as ReachVerdict;
      expect([...g.sees].sort(), `${row.id} surfaces`).toEqual([...want.sees].sort());
      expect(g.superTold, `${row.id} Super told`).toBe(want.superTold);
      expect(g.steps, `${row.id} steps`).toBe(want.steps);
      expect(g.asked, `${row.id} asked`).toBe(want.asked);
    });
  }
});
