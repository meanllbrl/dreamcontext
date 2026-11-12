/**
 * Several Supers in one project (plan-r10 1, Wave 2 lane A, step A1): the project's own Super
 * (`main`, its record unchanged on disk) and one Super per AI Team member (`m:<slug>`, its record in
 * `state/.super/members/<slug>.json`).
 *
 * A1 pins: separate records; the token's super decides which record a verb reads and writes (a
 * member token never reaches main's, nor main's a member's: 403 both ways); an unknown member is
 * 404; traversal and links are refused; a member's third child is held in ITS pool; the vault-wide
 * ceiling of 15 binds main and members together; `delegating` is per super; a member cannot
 * `team ask` (403), cannot `team answer`, main cannot `team done`; an unapproved member gets no
 * record (409); member sessions resolve after a restart; a global member becomes a Super in a
 * project with its identity from the global manifest.
 *
 * Everything on a scratch HOME and a scratch vault: never the real ~/.dreamcontext.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import {
  MEMBER_SUPER_DIR, SUPER_STATE_REL, SuperStoreRefused, listMemberSupers, parseSuperId, parseSuperKey, primeSuperIndex, readSuperState,
  resetSuperIndex, superEntry, superIndex, superKey, superOfChild, superOfSession, superRecordPath, superReadMarksPath, superHandoffPath, withSuperState,
} from '../../src/lib/super/store.js';
import { emptySuperState, type SuperId } from '../../src/lib/super/types.js';
import { delegationAllowed } from '../../src/lib/super/capacity.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { ensureMemberSuper } from '../../src/lib/super/member-birth.js';
import { handleSuperMember, handleSuperVerb, superVerbRefusal } from '../../src/server/routes/super.js';
import { createAgent, createGlobalAgent } from '../../src/lib/agents/store.js';
import { prepareAgentChat } from '../../src/lib/whiteboards/card-chat.js';
import { memberSlotOf, memberNewRoutineLine, superBriefing, superMemberBriefing, MEMBER_ABOUT_TASK_LINE, MEMBER_ORIGIN_LINE } from '../../src/server/chat-modes.js';
import { aboutHeads } from '../../src/lib/super/types.js';

let dir: string;
let root: string;
const saved = { HOME: process.env.HOME, DESKTOP: process.env.DREAMCONTEXT_DESKTOP };
const MAIN = 'sess-main';
const ROTA = 'sess-rota';

function writeMain(state: Record<string, unknown>): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: MAIN, enabled: true, ...state }));
}
async function writeMember(slug: string, state: Record<string, unknown>): Promise<void> {
  await withSuperState(root, `m:${slug}`, (s) => Object.assign(s, { enabled: true, ...state }));
}
const tokenFor = (sessionId: string, superId?: SuperId, contextRoot = root) =>
  mintWindowToken({ send: () => true, vault: 'acme', contextRoot, sessionId, mode: 'super', ...(superId ? { superId } : {}) }).token;
const youngChildren = (n: number, prefix: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => {
  const id = `${prefix}-${i}`;
  return [id, { sessionId: id, brief: 'job', adopted: false, startedAt: Date.now() }];
}));

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
async function verb(token: string, name: string, body: Record<string, unknown> = {}) {
  const r = res();
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: name });
  return r;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-multi-')));
  process.env.HOME = join(dir, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  resetWindowControl();
  resetSuperIndex();
  _resetSuperInbox();
  _resetChatRegistry();
  writeMain({});
  createAgent(root, { slug: 'rota', title: 'Rota', prompt: 'You keep the delivery routes on time.\nMore lines.' }, { approve: { now: new Date() } });
  createAgent(root, { slug: 'mira', title: 'Mira', prompt: 'You write the newsletter.' }, { approve: { now: new Date() } });
});
afterEach(() => {
  if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
  if (saved.DESKTOP === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = saved.DESKTOP;
  rmSync(dir, { recursive: true, force: true });
});

describe('superId: one parser, one path accessor, one key', () => {
  it('absent is main; a member id takes the agent slug charset; traversal and anything else are refused', () => {
    for (const raw of [undefined, null, '', 'main']) expect(parseSuperId(raw)).toBe('main');
    expect(parseSuperId('m:rota')).toBe('m:rota');
    for (const raw of ['m:..', 'm:../x', 'm:a/b', 'm:', 'm:Rota', 'm:a--b', 'm:a-', 'member:rota', 'rota', 7]) expect(parseSuperId(raw), String(raw)).toBeNull();
  });

  it('main keeps today\'s file; a member\'s record, read marks and handoff live under state/.super/members/', () => {
    expect(superRecordPath(root)).toBe(join(root, SUPER_STATE_REL));
    expect(superRecordPath(root, 'main')).toBe(join(root, 'state', '.super-agent.json'));
    expect(superRecordPath(root, 'm:rota')).toBe(join(root, MEMBER_SUPER_DIR, 'rota.json'));
    expect(superReadMarksPath(root, 'm:rota')).toBe(join(root, MEMBER_SUPER_DIR, 'rota.read-marks.json'));
    expect(superHandoffPath(root, 'm:rota')).toBe(join(root, MEMBER_SUPER_DIR, 'rota.handoff.md'));
    expect(superReadMarksPath(root)).toBe(join(root, 'state', '.super', 'read-marks.json'));
  });

  it('a super key is main\'s root itself, a member\'s decodes back', () => {
    expect(superKey(root)).toBe(root);
    expect(superKey(root, 'm:rota')).not.toBe(superKey(root));
    expect(parseSuperKey(superKey(root, 'm:rota'))).toEqual({ root, superId: 'm:rota' });
    expect(parseSuperKey(superKey(root))).toEqual({ root, superId: 'main' });
  });
});

describe('two supers, two records', () => {
  it('a member\'s write never touches main\'s record, and each record names whose it is', async () => {
    const before = readFileSync(join(root, SUPER_STATE_REL), 'utf-8');
    await writeMember('rota', { session: ROTA, children: youngChildren(1, 'rc') });
    expect(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')).toBe(before);
    const m = await readSuperState(root, 'm:rota');
    expect(m).toMatchObject({ session: ROTA, enabled: true, member: 'rota' });
    expect(Object.keys(m.children)).toEqual(['rc-0']);
    const main = await readSuperState(root);
    expect(main.member).toBeUndefined();
    expect(main.session).toBe(MAIN);
    expect(Object.keys(main.children)).toEqual([]);
    // A record that claims another member is still the file's own.
    writeFileSync(superRecordPath(root, 'm:mira'), JSON.stringify({ ...emptySuperState(), session: 'sess-mira', enabled: true, member: 'rota' }));
    expect((await readSuperState(root, 'm:mira')).member).toBe('mira');
    const idx = superIndex(root);
    expect([...idx.keys()].sort()).toEqual(['m:mira', 'm:rota', 'main']);
    expect(superEntry(root, 'm:rota').session).toBe(ROTA);
    expect(superOfSession(ROTA)).toEqual({ root, superId: 'm:rota' });
    expect(superOfChild('rc-0')).toEqual({ root, superId: 'm:rota' });
    expect(superOfSession(MAIN)).toEqual({ root, superId: 'main' });
  });

  it('member sessions resolve after a restart (primeSuperIndex loads members/*.json)', async () => {
    await writeMember('rota', { session: ROTA });
    resetSuperIndex();
    expect(superOfSession(ROTA)).toBeNull();
    await primeSuperIndex([root]);
    expect(superOfSession(ROTA)).toEqual({ root, superId: 'm:rota' });
    expect(superEntry(root, 'm:rota')).toMatchObject({ session: ROTA, enabled: true });
    expect(await listMemberSupers(root)).toEqual(['rota']);
  });

  it('a members folder or record that is a link is refused, read and write', async () => {
    await writeMember('rota', { session: ROTA });
    const outside = join(dir, 'outside.json');
    writeFileSync(outside, JSON.stringify({ ...emptySuperState(), session: 'evil', enabled: true }));
    symlinkSync(outside, superRecordPath(root, 'm:mira'));
    await expect(readSuperState(root, 'm:mira')).rejects.toBeInstanceOf(SuperStoreRefused);
    await expect(withSuperState(root, 'm:mira', () => {})).rejects.toBeInstanceOf(SuperStoreRefused);

    // The whole members folder swapped for a link: refused, and never listed.
    const other = join(dir, 'elsewhere');
    mkdirSync(other, { recursive: true });
    rmSync(join(root, MEMBER_SUPER_DIR), { recursive: true, force: true });
    symlinkSync(other, join(root, MEMBER_SUPER_DIR));
    await expect(readSuperState(root, 'm:rota')).rejects.toBeInstanceOf(SuperStoreRefused);
    await expect(withSuperState(root, 'm:rota', () => {})).rejects.toBeInstanceOf(SuperStoreRefused);
    expect(existsSync(join(other, 'rota.json'))).toBe(false);
    expect(await listMemberSupers(root)).toEqual([]);
  });
});

describe('the token\'s super decides the record (403 both ways, 404 unknown)', () => {
  beforeEach(async () => { await writeMember('rota', { session: ROTA }); });

  it('each token reads its own record', async () => {
    const m = await verb(tokenFor(ROTA, 'm:rota'), 'state');
    expect(m.status).toBe(200);
    expect((m.json.result as { session: string }).session).toBe(ROTA);
    const main = await verb(tokenFor(MAIN), 'state');
    expect(main.status).toBe(200);
    expect((main.json.result as { session: string }).session).toBe(MAIN);
  });

  it('a member token never reaches main\'s record, nor main\'s token a member\'s', async () => {
    // A member token naming main, and main's token naming the member: 403.
    expect((await verb(tokenFor(ROTA, 'm:rota'), 'state', { superId: 'main' })).json.error).toBe('not_your_super');
    expect((await verb(tokenFor(MAIN), 'state', { superId: 'm:rota' })).status).toBe(403);
    // Main's session carried as a member token is checked against the MEMBER's record, and back.
    expect((await verb(tokenFor(MAIN, 'm:rota'), 'state')).status).toBe(403);
    expect((await verb(tokenFor(ROTA), 'state')).status).toBe(403);
    // Another member's token cannot act as this member.
    await writeMember('mira', { session: 'sess-mira' });
    expect((await verb(tokenFor('sess-mira', 'm:mira'), 'state', { superId: 'm:rota' })).status).toBe(403);
    expect((await verb(tokenFor(ROTA, 'm:mira'), 'state')).status).toBe(403);
    // A malformed super id in the body is a 400.
    expect((await verb(tokenFor(ROTA, 'm:rota'), 'state', { superId: 'm:../x' })).status).toBe(400);
  });

  it('a member\'s write lands in its own record only', async () => {
    const before = readFileSync(join(root, SUPER_STATE_REL), 'utf-8');
    const r = await verb(tokenFor(ROTA, 'm:rota'), 'note-add', { section: 'now', text: 'routes for Tuesday' });
    expect(r.status).toBe(200);
    expect((await readSuperState(root, 'm:rota')).pad?.map((p) => p.text)).toEqual(['routes for Tuesday']);
    expect(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')).toBe(before);
  });

  it('a member with no manifest is 404', async () => {
    await writeMember('ghost', { session: 'sess-ghost' });
    const r = await verb(tokenFor('sess-ghost', 'm:ghost'), 'state');
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('unknown_member');
  });
});

describe('caps: a member 2, main 15, the vault 15 together', () => {
  it('a member\'s third delegate is held in ITS pool', async () => {
    await writeMember('rota', { session: ROTA, children: youngChildren(2, 'rc') });
    const r = await verb(tokenFor(ROTA, 'm:rota'), 'delegate', { prompt: 'plan the Friday routes', brief: 'Friday routes' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'held', held: true, live: 2, max: 2, reason: 'cap', kept: true });
    const m = await readSuperState(root, 'm:rota');
    expect(m.pool.map((p) => p.title)).toEqual(['Friday routes']);
    expect((await readSuperState(root)).pool).toEqual([]);
  });

  it('the vault-wide ceiling binds main and members together (a young unregistered child counts)', async () => {
    writeMain({ children: youngChildren(14, 'mc') });
    await writeMember('rota', { session: ROTA, children: youngChildren(1, 'rc') });
    const m = await verb(tokenFor(ROTA, 'm:rota'), 'delegate', { prompt: 'one more route', brief: 'route' });
    expect(m.status).toBe(409);
    expect(m.json).toMatchObject({ error: 'held', reason: 'vault_cap', live: 15, max: 15 });
    const main = await verb(tokenFor(MAIN), 'delegate', { prompt: 'one more job', brief: 'job' });
    expect(main.status).toBe(409);
    expect(main.json).toMatchObject({ error: 'held', reason: 'vault_cap', live: 15, max: 15 });
  });

  it('delegationAllowed: the super\'s own cap and the vault\'s, kept apart', () => {
    const member = { ...emptySuperState(), member: 'rota', children: youngChildren(1, 'a') };
    expect(delegationAllowed(member, Date.now(), 1)).toMatchObject({ ok: true, live: 1, max: 2, bound: null });
    expect(delegationAllowed({ ...member, children: youngChildren(2, 'b') }, Date.now(), 2)).toMatchObject({ ok: false, max: 2, bound: 'own' });
    expect(delegationAllowed(member, Date.now(), 15)).toMatchObject({ ok: false, bound: 'vault', vaultLive: 15, vaultMax: 15 });
    expect(delegationAllowed({ ...emptySuperState(), children: youngChildren(14, 'c') })).toMatchObject({ ok: true, max: 15 });
  });

  it('delegating is counted per super: the in-flight keys of two supers never meet', () => {
    expect(superKey(root, 'm:rota')).not.toBe(superKey(root, 'm:mira'));
    expect(superKey(root, 'm:rota').startsWith(`${root}\u0000`)).toBe(true);
  });
});

describe('who may run which team verb', () => {
  beforeEach(async () => { await writeMember('rota', { session: ROTA }); });

  it('a member cannot give another member work (403 member_cannot_assign), nor answer as main, nor amend', async () => {
    const ask = await verb(tokenFor(ROTA, 'm:rota'), 'team-ask', { member: 'mira', text: 'write it' });
    expect(ask.status).toBe(403);
    expect(ask.json.error).toBe('member_cannot_assign');
    expect((await verb(tokenFor(ROTA, 'm:rota'), 'team-answer', { item: 'q-x-00000000', text: 'yes' })).json.error).toBe('main_only');
    expect((await verb(tokenFor(ROTA, 'm:rota'), 'team-amend', { member: 'mira', why: 'x', prompt: 'y' })).status).toBe(403);
    expect(superVerbRefusal('m:rota', 'team-ask')?.error).toBe('member_cannot_assign');
    expect(superVerbRefusal('main', 'team-ask')).toBeNull();
  });

  it('main cannot `team done`; a member closes its request once (second 409), main\'s record untouched', async () => {
    expect((await verb(tokenFor(MAIN), 'team-done', { item: 'q-x-00000000', result: 'done' })).json.error).toBe('member_only');
    await writeMember('rota', { queue: [{ id: 'q-abc-0000000a', sessionId: ROTA, kind: 'request', state: 'delivered', createdAt: 1, text: 'plan Friday', acceptedAt: 2 }] });
    const before = readFileSync(join(root, SUPER_STATE_REL), 'utf-8');
    const done = await verb(tokenFor(ROTA, 'm:rota'), 'team-done', { item: 'q-abc-0000000a', result: 'Friday has 3 routes.' });
    expect(done.status).toBe(200);
    expect((await readSuperState(root, 'm:rota')).queue[0]).toMatchObject({ kind: 'request', state: 'done', result: 'Friday has 3 routes.' });
    const again = await verb(tokenFor(ROTA, 'm:rota'), 'team-done', { item: 'q-abc-0000000a', result: 'again' });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('already_done');
    expect((await verb(tokenFor(ROTA, 'm:rota'), 'team-done', { item: 'q-nope-0000000b', result: 'x' })).status).toBe(404);
    expect(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')).toBe(before);
  });

  it('`--for` names the owner or an open request; main has no `--for`', async () => {
    await writeMember('rota', { queue: [{ id: 'q-abc-0000000a', sessionId: ROTA, kind: 'request', state: 'pending', createdAt: 1, text: 'plan Friday' }] });
    expect((await verb(tokenFor(MAIN), 'delegate', { prompt: 'x', for: 'owner' })).status).toBe(400);
    expect((await verb(tokenFor(ROTA, 'm:rota'), 'delegate', { prompt: 'x', for: 'q-nope-0000000b' })).status).toBe(404);
  });
});

describe('a member\'s Super is born on its first request', () => {
  it('an approved member: enabled, a fresh session, its slug; the same record on the next request', async () => {
    const a = await ensureMemberSuper(root, 'rota');
    expect(a).toMatchObject({ ok: true, superId: 'm:rota', born: true });
    if (!a.ok) return;
    expect(a.state).toMatchObject({ enabled: true, member: 'rota', session: a.session });
    const b = await ensureMemberSuper(root, 'rota');
    expect(b).toMatchObject({ ok: true, born: false, session: a.session });
    expect(superOfSession(a.session)).toEqual({ root, superId: 'm:rota' });
  });

  it('an unapproved member is 409 member_unapproved and gets NO record; a missing one 404', async () => {
    createAgent(root, { slug: 'pera', title: 'Pera', prompt: 'You price things.' });
    expect(await ensureMemberSuper(root, 'pera')).toMatchObject({ ok: false, status: 409, error: 'member_unapproved' });
    expect(existsSync(superRecordPath(root, 'm:pera'))).toBe(false);
    expect(await ensureMemberSuper(root, 'nobody')).toMatchObject({ ok: false, status: 404, error: 'unknown_member' });
    expect(await ensureMemberSuper(root, '../x')).toMatchObject({ ok: false, status: 404 });
  });

  it('the owner\'s door (`POST /api/super/member`) answers the session the window spawns with', async () => {
    const r = res();
    await handleSuperMember(req({ slug: 'rota' }), r, {}, root);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ superId: 'm:rota', born: true });
    expect(typeof r.json.session).toBe('string');
    const refused = res();
    createAgent(root, { slug: 'pera', title: 'Pera', prompt: 'You price things.' });
    await handleSuperMember(req({ slug: 'pera' }), refused, {}, root);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('member_unapproved');
  });

  it('a global member becomes a Super in THIS project, its identity from the global manifest', async () => {
    createGlobalAgent({ slug: 'ua-manager', title: 'UA Manager', prompt: 'You run the paid acquisition budget.' }, { approve: { now: new Date() } });
    const born = await ensureMemberSuper(root, 'ua-manager');
    expect(born).toMatchObject({ ok: true, superId: 'm:ua-manager' });
    expect(existsSync(superRecordPath(root, 'm:ua-manager'))).toBe(true);
    // The record is the project's: none under the global agent's own folder.
    expect(superRecordPath(root, 'm:ua-manager').startsWith(root)).toBe(true);
    const prep = prepareAgentChat(root, 'ua-manager');
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.manifest.title).toBe('UA Manager');
    const brief = superMemberBriefing(memberSlotOf(prep.manifest));
    expect(brief).toContain('You are UA Manager (`ua-manager`); your field: You run the paid acquisition budget.');
  });
});

describe('the member slot in the Super briefing', () => {
  const slot = memberSlotOf({ slug: 'rota', title: 'Rota', prompt: '# Routes\nYou keep the delivery routes on time.' });

  it('names the member, its field, its two children, no leading, `team done`, origin and [About task]', () => {
    const b = superMemberBriefing(slot);
    expect(slot).toEqual({ slug: 'rota', title: 'Rota', field: 'Routes' });
    expect(b).toContain('At most 2 children run at once');
    expect(b).toContain('You do not lead other members');
    expect(b).toContain('dreamcontext super team done <item>');
    expect(b).toContain(MEMBER_ORIGIN_LINE);
    expect(b).toContain(MEMBER_ABOUT_TASK_LINE);
    // 2026-11-12 (gece-duzeltme B7, IN-13): `tasks show` does not exist; a task is read from its file.
    expect(MEMBER_ABOUT_TASK_LINE).toBe('On `[About task X]` read its file, `_dream_context/state/X.md`.');
    // "+ New routine" on its stage arrives as a chip titled New routine: it sets the routine up as itself.
    expect(b).toContain(memberNewRoutineLine('rota'));
    expect(memberNewRoutineLine('rota')).toContain('titled “New routine”');
    expect(memberNewRoutineLine('rota')).toContain('`dreamcontext automations create <routine-slug> --agent rota --job "<what to do>" --days <days> --at <HH:MM>`');
    expect(superBriefing()).not.toContain('titled “New routine”');
    expect(b).toContain('state/.super/members/rota.handoff.md');
    // Not the team lead's lines: no team ask advice, no amend, no global-member line.
    expect(b).not.toContain('Your AI Team, when the project has one');
    expect(b).not.toContain('super team amend <member>');
    expect(b).not.toContain('A global agent (this Mac');
  });

  it('main\'s briefing is unchanged: no member slot, its 15 children and its team lines', () => {
    const main = superBriefing();
    expect(main).not.toContain('## You are a member\'s Super');
    expect(main).toContain('At most 15 children run at once');
    expect(main).toContain('Your AI Team, when the project has one');
    expect(main).toContain('A global agent (this Mac');
    expect(main).toContain('_dream_context/state/.super/handoff.md');
  });

  it('[About task X] is a header of its own kind, with no second line', () => {
    expect(aboutHeads('[About task fix-login-form]\nwhy is this stuck?')).toEqual([{ kind: 'task', id: 'fix-login-form', at: 0, end: 27 }]);
  });
});
