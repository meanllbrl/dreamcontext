/**
 * A member's answer reaches the owner again (plan r4 D6, D7; regression from 0.40.0):
 *  - a member Super's own reply to him is a banner titled with the MEMBER, with sound, linking its
 *    session (the window routes it to the member's stage), and a notch row named for the member;
 *  - it raises that member's unread in the Team summary, and its own running turn counts as working;
 *  - a reply he watched arrive never counts; `seen` clears the rest; main's marks are never touched;
 *  - a turn of main Super's work (also after a restart: an open request on the record), and an
 *    interrupted turn, post and count nothing; an owner message typed into main's turn makes it his;
 *  - the phone push is titled with the member, body generic, and main's work is never pushed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/member-notify-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { _resetNotchInbox, listNotchEvents, setPresence, setSuperFinishBanner, wireNotchInbox } from '../../src/lib/assistant/notch-inbox.js';
import { SUPER_STATE_REL, resetSuperIndex, superRecordPath } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox, memberTurnOrigin, startSuperInbox, superOwnerSpoke } from '../../src/lib/super/inbox.js';
import { applyReadMarks, markSeen, noteReply, parseReadPatch, readReadMarks, sanitizeReadMarks, unseenReplies } from '../../src/lib/super/read-marks.js';
import { memberSummaries, ownerTurnRuns, summarizeMember } from '../../src/lib/super/member-summary.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { PushNotifier, pushFor } from '../../src/lib/handsfree/mac/push-notifier.js';
import { handleSuperReadPost } from '../../src/server/routes/super-read.js';

let dir: string;
let root: string;
const MAIN = 'sess-main';
const ROTA = 'sess-rota';

async function makeVault(member: Partial<SuperState> = {}): Promise<void> {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state', '.super', 'members'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: MAIN, enabled: true }));
  writeFileSync(superRecordPath(root, 'm:rota'), JSON.stringify({ ...emptySuperState(), session: ROTA, enabled: true, member: 'rota', ...member }));
  createAgent(root, { slug: 'rota', title: 'Rota Planner', prompt: 'Plans routes.' }, { approve: { now: new Date() } });
  await startSuperInbox([root]);
}

const reg = (sid: string, mode = 'super'): ChatHandle => registerChat({ sessionId: sid, conversationId: sid, vault: 'acme', mode });
const answer = (h: ChatHandle, text = 'Route is ready.') => {
  h.userSent('plan it');
  h.observe({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  h.observe({ type: 'result' });
};
const settle = () => new Promise((r) => setTimeout(r, 30));
const openRequest = { id: 'q-1', kind: 'request', state: 'delivered', createdAt: 1, sessionId: MAIN, text: 'do it' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'member-notify-'));
  _resetChatRegistry();
  _resetNotchInbox();
  resetSuperIndex();
  _resetSuperInbox();
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  _resetSuperInbox();
  rmSync(dir, { recursive: true, force: true });
});

describe('a member\'s own reply to the owner', () => {
  it('is a banner titled with the member, with sound, to its session, and a notch row named for it', async () => {
    await makeVault();
    wireNotchInbox();
    const banners: Array<[string, string, string | null, string | undefined]> = [];
    setSuperFinishBanner((t, b, l, s) => { banners.push([t, b, l, s]); });
    answer(reg(ROTA));
    expect(banners).toEqual([['Rota Planner · acme', 'Route is ready.', `dreamcontext://project/acme/session/${ROTA}`, 'Glass']]);
    const row = listNotchEvents().find((e) => e.kind === 'finished') as { sessionId: string; member?: string };
    expect(row).toMatchObject({ sessionId: ROTA, member: 'Rota Planner' });
    // Main's own banner is unchanged: its name, no sound.
    answer(reg(MAIN));
    expect(banners[1].slice(0, 1)).toEqual(['Super Agent · acme']);
    expect(banners[1][3]).toBeUndefined();
  });

  it('raises the member\'s unread in the Team summary; a watched one never counts; seen clears', async () => {
    await makeVault();
    wireNotchInbox();
    const h = reg(ROTA);
    const unread = async () => (await memberSummaries(root)).find((m) => m.slug === 'rota')!.unread;
    // He watches it arrive on the member's stage: it never counts.
    setPresence('vault-acme', 'acme', ROTA);
    answer(h);
    await settle();
    expect(await unread()).toBe(0);
    // He looks elsewhere: the next one counts.
    setPresence('vault-acme', 'acme', 'other');
    answer(h);
    await settle();
    expect(await unread()).toBe(1);
    await markSeen(root, 'm:rota');
    expect((await memberSummaries(root)).find((m) => m.slug === 'rota')!.unread).toBe(0);
  });

  it('a turn of main Super\'s work posts and counts nothing, also after a restart (open request)', async () => {
    await makeVault({ queue: [openRequest] as unknown as SuperState['queue'] });
    wireNotchInbox();
    const banners: string[] = [];
    setSuperFinishBanner((t) => { banners.push(t); });
    expect(memberTurnOrigin(ROTA)).toBe('main:restart');
    answer(reg(ROTA));
    await settle();
    expect(banners).toEqual([]);
    expect(listNotchEvents().filter((e) => e.kind === 'finished')).toHaveLength(0);
    expect((await readReadMarks(root, 'm:rota'))?.replies).toBeUndefined();
    // He typed into it: the turn is his, so it notifies and counts.
    superOwnerSpoke(ROTA);
    answer(reg(ROTA));
    await settle();
    expect(banners).toEqual(['Rota Planner · acme']);
    expect((await readReadMarks(root, 'm:rota'))?.replies).toHaveLength(1);
  });

  it('after a restart, a turn that closed main\'s request itself (team done) is still main\'s work', async () => {
    await makeVault({ queue: [openRequest] as unknown as SuperState['queue'] });
    wireNotchInbox();
    const banners: string[] = [];
    setSuperFinishBanner((t) => { banners.push(t); });
    // The member closes the request mid-turn: the record's request is done before the turn ends.
    const { writeSuper } = await import('../../src/lib/super/inbox.js');
    await writeSuper(root, 'm:rota', (s) => { for (const q of s.queue) q.state = 'done'; });
    expect(memberTurnOrigin(ROTA)).toBe('main:restart');
    answer(reg(ROTA));
    await settle();
    expect(banners).toEqual([]);
    expect((await readReadMarks(root, 'm:rota'))?.replies).toBeUndefined();
  });

  it('an interrupted turn posts and counts nothing', async () => {
    await makeVault();
    wireNotchInbox();
    const banners: string[] = [];
    setSuperFinishBanner((t) => { banners.push(t); });
    const h = reg(ROTA);
    h.userSent('plan it');
    h.interrupted();
    h.observe({ type: 'result' });
    await settle();
    expect(banners).toEqual([]);
    expect(await readReadMarks(root, 'm:rota')).toBeNull();
  });

  it('its own running owner turn counts as working; main\'s work does not', () => {
    const s = { ...emptySuperState(), session: ROTA, enabled: true } as SuperState;
    const facts = { global: false, enabled: true, approval: false };
    expect(summarizeMember('rota', s, facts, () => false, null, () => true).ownerWorking).toBe(1);
    expect(summarizeMember('rota', s, facts, () => false, null, () => false).ownerWorking).toBe(0);
    expect(summarizeMember('rota', s, facts, () => false, { since: 0, read: [], replies: [5, 9], seenAt: 6 }, () => false).unread).toBe(1);
  });

  it('a member session still starting (spawned, no frame yet) is not working; its turn is', () => {
    const h = reg(ROTA);
    expect(ownerTurnRuns(ROTA)).toBe(false);
    const s = { ...emptySuperState(), session: ROTA, enabled: true } as SuperState;
    const facts = { global: false, enabled: true, approval: false };
    expect(summarizeMember('rota', s, facts).ownerWorking).toBe(0);
    h.userSent('plan it');
    expect(ownerTurnRuns(ROTA)).toBe(true);
    expect(summarizeMember('rota', s, facts).ownerWorking).toBe(1);
  });
});

describe('the member\'s read marks', () => {
  it('replies and seenAt are sanitized; seen only rises; main is never written', async () => {
    root = mkdtempSync(join(tmpdir(), 'member-marks-'));
    expect(sanitizeReadMarks({ since: 1, read: [], replies: [3, -1, 'x', 2, Infinity], seenAt: 'no' })).toEqual({ since: 1, read: [], replies: [2, 3] });
    const many = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(sanitizeReadMarks({ since: 0, read: [], replies: many })!.replies).toHaveLength(20);
    await noteReply(root, 'm:rota', 10, false);
    await noteReply(root, 'm:rota', 20, true);
    let m = await readReadMarks(root, 'm:rota');
    expect(m).toMatchObject({ replies: [10, 20], seenAt: 20 });
    expect(unseenReplies(m)).toBe(0);
    await noteReply(root, 'm:rota', 30, false);
    await markSeen(root, 'm:rota', 5);
    m = await readReadMarks(root, 'm:rota');
    expect(m!.seenAt).toBe(20);
    expect(unseenReplies(m)).toBe(1);
    // A read-marks merge keeps the reply fields.
    await applyReadMarks(root, { read: [{ key: 'k', ts: 40 }] }, 40, 'm:rota');
    expect((await readReadMarks(root, 'm:rota'))!.replies).toEqual([10, 20, 30]);
    expect(await noteReply(root, 'main', 1, false)).toBeNull();
    expect(await markSeen(root, 'main')).toBeNull();
    expect(await readReadMarks(root, 'main')).toBeNull();
    expect(parseReadPatch({ seen: true })).toEqual({ seen: true });
    expect(parseReadPatch({ seen: 1 })).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('POST seen is a 400 for main and raises a member\'s seenAt', async () => {
    await makeVault();
    const req = (q: string, body: unknown): IncomingMessage => {
      const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
      Object.assign(r, { headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'x-dreamcontext-desktop': '1' }, socket: { remoteAddress: '127.0.0.1', setTimeout: () => undefined }, method: 'POST', url: `/api/agent/super-read${q}` });
      setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
      return r;
    };
    const res = () => {
      const out = { status: 0, json: {} as Record<string, unknown> } as unknown as ServerResponse & { status: number; json: Record<string, unknown> };
      (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
      (out as unknown as { setHeader: () => void }).setHeader = () => undefined;
      (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
      return out;
    };
    const mainRes = res();
    await handleSuperReadPost(req('', { seen: true }), mainRes, {}, root);
    expect(mainRes.status).toBe(400);
    await noteReply(root, 'm:rota', 1, false);
    const memRes = res();
    await handleSuperReadPost(req('?superId=m:rota', { seen: true }), memRes, {}, root);
    expect(memRes.status).toBe(200);
    expect((await readReadMarks(root, 'm:rota'))!.seenAt).toBeGreaterThan(1);
    expect(await readReadMarks(root, 'main')).toBeNull();
  });
});

describe('the phone push', () => {
  const entry = (sid: string) => ({ sessionId: sid, conversationId: sid, vault: 'acme', title: 'plan it', status: 'idle', lastTurn: { endedAt: '', interrupted: false, resultSeq: 7 } });
  it('a member\'s turn is titled with the member and says only that it answered', () => {
    const p = pushFor({ entry: entry(ROTA), from: 'working' } as never, { name: 'Rota Planner' });
    expect(p!.payload).toMatchObject({ kind: 'turn', title: 'Rota Planner', body: 'Cevap verdi' });
  });

  it('a member\'s turn of main\'s work is never pushed', async () => {
    const sent: unknown[] = [];
    const n = new PushNotifier({
      exposed: () => ['acme'],
      store: () => ({ entries: () => [['dev', { endpoint: 'https://push.example/x', keys: {} }]], remove: () => undefined }) as never,
      deviceValid: () => true,
      showingDevice: () => null,
      send: async (_s, p) => { sent.push(p); return { ok: true, gone: false, status: 201 }; },
      memberOf: () => ({ name: 'Rota Planner', mainWork: true }),
    });
    expect(await n.onChange({ entry: entry(ROTA), from: 'working' } as never)).toBe(0);
    const own = new PushNotifier({
      exposed: () => ['acme'],
      store: () => ({ entries: () => [['dev', { endpoint: 'https://push.example/x', keys: {} }]], remove: () => undefined }) as never,
      deviceValid: () => true,
      showingDevice: () => null,
      send: async (_s, p) => { sent.push(p); return { ok: true, gone: false, status: 201 }; },
      memberOf: () => ({ name: 'Rota Planner', mainWork: false }),
    });
    expect(await own.onChange({ entry: entry(ROTA), from: 'working' } as never)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: 'Rota Planner', body: 'Cevap verdi' });
  });
});
