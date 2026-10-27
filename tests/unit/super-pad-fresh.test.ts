/**
 * The agenda keeps itself true (owner 2026-10-27: "the agenda goes stale" — a job finished
 * before noon and its Now line stayed under Now until he asked; the Super forgot to close it):
 *  - a Now line linked to a job (`note add now --for <child>`, `delegate --note`) moves to Done by
 *    itself when that child is done, ended or gone (`by: 'auto'`, `why`), and back to Now when it
 *    works again — on every write of the record;
 *  - a line the owner moved by hand (`POST /api/super/pad`, `by: 'owner'`) is never moved by the
 *    server again; a line the super moved itself (`note done`) is its own;
 *  - a Now line with no job, unchanged for PAD_STALE_MS, is flagged in `super state` and told in
 *    the next event batch once (`[agenda]`), with every auto move; `note keep` clears the flag.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { readSuperState, resetSuperIndex, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { _resetSuperInbox, superBatchText, superEventText, writeSuper } from '../../src/lib/super/inbox.js';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { markPadTold, padDayStart, padNotice, padRolledOff, padStale, settlePad } from '../../src/lib/super/pad.js';
import { PAD_STALE_MS, emptySuperState, type SuperChild, type SuperPadItem, type SuperState } from '../../src/lib/super/types.js';
import { SUPER_OWNER_HANDLERS, SUPER_VERB_HANDLERS, type SuperCaller } from '../../src/server/routes/super.js';
import { superNotepad } from '../../dashboard/src/components/sleepy/super/superHandover.js';

const SESSION = 'sess-pad';
const KID = 'kid-1';
const NOW = 10 * PAD_STALE_MS;

const child = (extra: Partial<SuperChild> = {}): SuperChild => ({ sessionId: KID, brief: 'Board layout', adopted: false, startedAt: 1, row: 'working', ...extra });
const line = (extra: Partial<SuperPadItem> = {}): SuperPadItem => ({ id: 'n1', section: 'now', text: 'Task board layout and sprints', at: NOW - 1000, ...extra });
function state(extra: Partial<SuperState> = {}): SuperState {
  return { ...emptySuperState(), session: SESSION, enabled: true, children: { [KID]: child() }, pad: [line()], ...extra };
}

describe('settlePad: a linked Now line follows its job', () => {
  it('moves to Done when the child is done, ended or gone (and when it left the record)', () => {
    const cases: Array<[string, Partial<SuperState>]> = [
      ['done', { children: { [KID]: child({ row: 'done' }) } }],
      ['ended', { children: { [KID]: child({ row: 'working', endedAt: 5 }) } }],
      ['gone', { children: { [KID]: child({ row: 'gone' }) } }],
      ['gone', { children: {} }],
    ];
    for (const [why, extra] of cases) {
      const s = state({ pad: [line({ for: KID, toldAt: NOW - 10 })], ...extra });
      expect(settlePad(s, NOW)).toBe(true);
      expect(s.pad).toEqual([{ id: 'n1', section: 'done', text: 'Task board layout and sprints', at: NOW, for: KID, by: 'auto', why }]);
    }
  });

  it('stays in Now while the job works, asks, waits on the owner or is stuck', () => {
    for (const row of ['working', 'asking', 'waiting', 'stuck'] as const) {
      const s = state({ children: { [KID]: child({ row }) }, pad: [line({ for: KID })] });
      expect(settlePad(s, NOW)).toBe(false);
      expect(s.pad?.[0].section).toBe('now');
    }
  });

  it('an auto-closed line comes back to Now when the job works again; the super\'s own Done line does not', () => {
    const s = state({ pad: [line({ section: 'done', for: KID, by: 'auto', why: 'done', toldAt: NOW })] });
    expect(settlePad(s, NOW + 1)).toBe(true);
    expect(s.pad).toEqual([{ id: 'n1', section: 'now', text: 'Task board layout and sprints', at: NOW + 1, for: KID }]);
    const mine = state({ pad: [line({ section: 'done', for: KID })] });
    expect(settlePad(mine, NOW)).toBe(false);
  });

  it('a line relinked to a successor (`delegate --succeeds`) follows the new child back to Now', () => {
    const s = state({ children: { [KID]: child({ row: 'done', endedAt: 4 }), 'kid-2': child({ sessionId: 'kid-2', row: 'working' }) },
      pad: [line({ section: 'done', for: KID, by: 'auto', why: 'ended' })] });
    s.pad = s.pad!.map((p) => (p.for === KID ? { ...p, for: 'kid-2' } : p));
    expect(settlePad(s, NOW)).toBe(true);
    expect(s.pad[0]).toEqual({ id: 'n1', section: 'now', text: 'Task board layout and sprints', at: NOW, for: 'kid-2' });
  });

  it('a row cleared for a moment (a gone child starting again) does not flip a closed line back', () => {
    const s = state({ children: { [KID]: child({ row: undefined }) }, pad: [line({ section: 'done', for: KID, by: 'auto', why: 'gone' })] });
    expect(settlePad(s, NOW)).toBe(false);
    expect(s.pad?.[0].section).toBe('done');
  });

  it('a linked line the owner put back goes stale like a jobless one', () => {
    expect(padStale(line({ for: KID, by: 'owner', at: NOW - PAD_STALE_MS }), NOW)).toBe(true);
    expect(padStale(line({ for: KID, at: NOW - PAD_STALE_MS }), NOW)).toBe(false);
  });

  it('never moves a line the owner moved by hand, nor a line with no job', () => {
    const owner = state({ children: { [KID]: child({ row: 'done' }) }, pad: [line({ for: KID, by: 'owner' })] });
    expect(settlePad(owner, NOW)).toBe(false);
    expect(owner.pad?.[0]).toMatchObject({ section: 'now', by: 'owner' });
    const free = state({ children: { [KID]: child({ row: 'done' }) } });
    expect(settlePad(free, NOW)).toBe(false);
  });

  it('runs on every write of the record: a row that finishes closes its line in the same write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'super-pad-'));
    const root = join(dir, 'acme', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    try {
      writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify(state({ pad: [line({ for: KID })] })));
      const after = await writeSuper(root, (s) => { s.children[KID].row = 'done'; });
      expect(after.pad?.[0]).toMatchObject({ section: 'done', by: 'auto', why: 'done', for: KID });
      // The store keeps the new fields.
      expect((await readSuperState(root)).pad?.[0]).toMatchObject({ section: 'done', by: 'auto', why: 'done', for: KID });
    } finally {
      _resetSuperInbox();
      resetSuperIndex();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('padNotice: what the next event batch tells the super, once', () => {
  it('tells an auto move once, then not again', () => {
    const s = state({ pad: [line({ section: 'done', for: KID, by: 'auto', why: 'done', at: NOW })] });
    const n = padNotice(s, NOW + 5);
    expect(n.ids).toEqual(['n1']);
    expect(n.lines.join('\n')).toContain(`note=n1 moved Now -> Done by itself: its job (child=${KID}) is done`);
    markPadTold(s, n.ids, NOW + 5);
    expect(padNotice(s, NOW + 6).ids).toEqual([]);
  });

  it('flags a jobless Now line unchanged for PAD_STALE_MS; again only after another window', () => {
    const s = state({ pad: [line({ at: NOW - PAD_STALE_MS })] });
    expect(padStale(s.pad![0], NOW)).toBe(true);
    expect(padStale(s.pad![0], NOW - 1)).toBe(false);
    expect(padStale({ ...s.pad![0], for: KID }, NOW)).toBe(false);
    const n = padNotice(s, NOW);
    expect(n.ids).toEqual(['n1']);
    expect(n.lines.join('\n')).toContain('has stood in Now unchanged for 120 min and nothing moves it');
    markPadTold(s, n.ids, NOW);
    expect(padNotice(s, NOW + PAD_STALE_MS - 1).ids).toEqual([]);
    expect(padNotice(s, NOW + PAD_STALE_MS).ids).toEqual(['n1']);
  });

  it('rides in the `[super events]` text, and nothing is added when the pad is fine', () => {
    const item = { id: 'q-1', sessionId: KID, kind: 'done' as const, state: 'pending' as const, createdAt: 1 };
    const moved = state({ pad: [line({ section: 'done', for: KID, by: 'auto', why: 'done', at: NOW })] });
    const text = superBatchText('/tmp/acme/_dream_context', moved, [item], 'b-1', NOW + 1);
    expect(text).toContain('[agenda] The owner reads these lines on his agenda card:');
    expect(text).toContain('`dreamcontext super note keep <id>`');
    expect(superBatchText('/tmp/acme/_dream_context', state(), [item], 'b-1', NOW + 1)).not.toContain('[agenda]');
  });
});

describe('the card reads the same record', () => {
  it('marks an auto-closed line and a stale line', () => {
    const look = { live: () => null, titleFor: (s: string) => s, superTitle: 'Super' };
    const rows = superNotepad({ queue: [], pad: [
      line({ id: 'n1', at: NOW - PAD_STALE_MS }),
      line({ id: 'n2', text: 'Linked', for: KID, at: NOW - PAD_STALE_MS }),
      line({ id: 'n3', text: 'Closed', section: 'done', for: KID, by: 'auto', why: 'done', at: NOW }),
    ] }, look, NOW);
    expect(rows.now.map((r) => [r.note, !!r.stale])).toEqual([['n1', true], ['n2', false]]);
    expect(rows.done.map((r) => [r.note, !!r.auto])).toEqual([['n3', true]]);
  });
});

// ─── A new day (owner 2026-10-28: "is the agenda current?" — yesterday's Done sat under today) ──

describe('a new day keeps the agenda current', () => {
  // 10:00 local on a real day; the day before, 15:00.
  const TODAY = new Date(2026, 9, 28, 10, 0).getTime();
  const YESTERDAY = new Date(2026, 9, 27, 15, 0).getTime();
  const look = { live: () => null, titleFor: (s: string) => s, superTitle: 'Super' };

  it('padDayStart is local midnight', () => {
    expect(padDayStart(TODAY)).toBe(new Date(2026, 9, 28).getTime());
  });

  it('drops an earlier day\'s Done line on the next write; today\'s and the owner\'s own move stay', () => {
    const s = state({ children: {}, pad: [
      line({ id: 'n1', section: 'done', at: YESTERDAY }),
      line({ id: 'n2', section: 'done', by: 'auto', why: 'done', at: YESTERDAY }),
      line({ id: 'n3', section: 'done', at: TODAY - 1000 }),
      line({ id: 'n4', section: 'done', by: 'owner', at: YESTERDAY }),
      line({ id: 'n5', section: 'waiting', at: YESTERDAY }),
    ] });
    expect(padRolledOff(s.pad![0], TODAY)).toBe(true);
    expect(settlePad(s, TODAY)).toBe(true);
    expect(s.pad!.map((p) => p.id)).toEqual(['n3', 'n4', 'n5']);
    expect(settlePad(s, TODAY)).toBe(false);
  });

  it('a Waiting line with no job left from an earlier day is stale; today\'s and a linked one are not', () => {
    expect(padStale(line({ section: 'waiting', at: YESTERDAY }), TODAY)).toBe(true);
    expect(padStale(line({ section: 'waiting', at: TODAY - PAD_STALE_MS - 1 }), TODAY)).toBe(false);
    expect(padStale(line({ section: 'waiting', at: YESTERDAY, for: KID }), TODAY)).toBe(false);
    // Just before midnight is not a day old: it still needs PAD_STALE_MS.
    expect(padStale(line({ section: 'waiting', at: padDayStart(TODAY) - 1000 }), padDayStart(TODAY) + 1000)).toBe(false);
    const told = padNotice(state({ pad: [line({ id: 'n7', section: 'waiting', at: YESTERDAY, text: 'Restart the app' })] }), TODAY);
    expect(told.ids).toEqual(['n7']);
    expect(told.lines.join('\n')).toContain('note=n7 has stood in Waiting unchanged');
  });

  it('the card hides an earlier day\'s Done line and flags a day-old Waiting line, like the server', () => {
    const rows = superNotepad({ queue: [], pad: [
      line({ id: 'n1', section: 'done', at: YESTERDAY }),
      line({ id: 'n2', section: 'done', at: TODAY - 1000 }),
      line({ id: 'n3', section: 'done', by: 'owner', at: YESTERDAY }),
      line({ id: 'n4', section: 'waiting', at: YESTERDAY }),
    ] }, look, TODAY);
    expect(rows.done.map((r) => r.note)).toEqual(['n2', 'n3']);
    expect(rows.waiting.map((r) => [r.note, !!r.stale])).toEqual([['n4', true]]);
  });

  it('a recap and a handover turn carry the agenda check; a fresh turn does not', () => {
    const s = state({ children: {}, pad: [line({ id: 'n8', at: TODAY - 3 * PAD_STALE_MS })] });
    const item = (kind: 'recap' | 'handover' | 'fresh') => ({ id: 'q-9', sessionId: SESSION, kind, state: 'pending' as const, createdAt: 1 });
    expect(superEventText('/tmp/acme/_dream_context', s, item('recap'), TODAY)).toContain('note=n8 has stood in Now');
    expect(superEventText('/tmp/acme/_dream_context', s, item('handover'), TODAY)).toContain('[agenda]');
    expect(superEventText('/tmp/acme/_dream_context', s, item('fresh'), TODAY)).not.toContain('[agenda]');
    expect(superEventText('/tmp/acme/_dream_context', state({ children: {}, pad: [] }), item('recap'), TODAY)).not.toContain('[agenda]');
  });
});

// ─── The verbs and the owner's route ──────────────────────────────────────────

let dir: string;
let root: string;
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function verb(name: keyof typeof SUPER_VERB_HANDLERS, body: Record<string, unknown>) {
  const r = res();
  const caller = { token: 't', who: { contextRoot: root }, state: await readSuperState(root) } as unknown as SuperCaller;
  await SUPER_VERB_HANDLERS[name](caller, body, r);
  return r;
}
async function ownerPad(body: Record<string, unknown>) {
  const r = res();
  await SUPER_OWNER_HANDLERS.pad({} as never, r, root, body);
  return r;
}
const result = (r: { json: Record<string, unknown> }) => r.json.result as Record<string, unknown>;

describe('`super note add --for`, `note keep`, `note done` and the owner\'s hand', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'super-pad-verbs-'));
    root = join(dir, 'acme', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
    process.env.DREAMCONTEXT_DESKTOP = '1';
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify(state({ pad: [] })));
  });
  afterEach(() => {
    _resetSuperInbox();
    resetSuperIndex();
    if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
    rmSync(dir, { recursive: true, force: true });
  });

  it('links a Now line to a child; refuses an unknown child, the super itself, and a non-Now section', async () => {
    const a = await verb('note-add', { section: 'now', text: 'Task board layout', for: KID });
    expect(result(a).note).toMatchObject({ id: 'n1', section: 'now', for: KID });
    expect((await verb('note-add', { section: 'now', text: 'x', for: 'nobody' })).json.error).toBe('unknown_child');
    expect((await verb('note-add', { section: 'now', text: 'x', for: SESSION })).json.error).toBe('unknown_child');
    expect((await verb('note-add', { section: 'waiting', text: 'x', for: KID })).json.error).toBe('invalid_args');
    // The owner's own chat and a job already over are refused (the line would come and go).
    await writeSuper(root, (s) => {
      s.children['own-1'] = { ...child({ sessionId: 'own-1' }), adopted: true };
      s.children['old-1'] = child({ sessionId: 'old-1', row: 'done' });
    });
    expect((await verb('note-add', { section: 'now', text: 'x', for: 'own-1' })).json.error).toBe('adopted');
    expect((await verb('note-add', { section: 'now', text: 'x', for: 'old-1' })).json.error).toBe('job_over');
    // The same line again with a link is the same note, now linked.
    await verb('note-add', { section: 'now', text: 'Plain line' });
    expect(result(await verb('note-add', { section: 'now', text: 'Plain line', for: KID })).note).toMatchObject({ id: 'n2', for: KID });
  });

  it('the linked line closes itself when the child finishes, and the owner can put it back for good', async () => {
    await verb('note-add', { section: 'now', text: 'Task board layout', for: KID });
    await writeSuper(root, (s) => { s.children[KID].row = 'done'; });
    expect((await readSuperState(root)).pad?.[0]).toMatchObject({ section: 'done', by: 'auto', why: 'done' });
    const back = await ownerPad({ id: 'n1', section: 'now' });
    expect(back.status).toBe(200);
    expect((back.json.state as SuperState).pad?.[0]).toMatchObject({ section: 'now', by: 'owner' });
    // Another write with the child still done: the owner's move stands.
    await writeSuper(root, (s) => { s.children[KID].brief = 'still done'; });
    expect((await readSuperState(root)).pad?.[0]).toMatchObject({ section: 'now', by: 'owner' });
    expect((await ownerPad({ id: 'n9', section: 'done' })).status).toBe(404);
    expect((await ownerPad({ id: 'n1', section: 'waiting' })).status).toBe(400);
  });

  it('`note done` makes the line the super\'s own: no longer the server\'s to move back', async () => {
    await verb('note-add', { section: 'now', text: 'Task board layout', for: KID });
    await writeSuper(root, (s) => { s.children[KID].row = 'done'; });
    expect(result(await verb('note-done', { id: 'n1' })).note).toEqual(expect.not.objectContaining({ by: 'auto' }));
    await writeSuper(root, (s) => { s.children[KID].row = 'working'; });
    expect((await readSuperState(root)).pad?.[0].section).toBe('done');
  });

  it('`super state` flags a stale line; `note keep` clears it', async () => {
    const old = Date.now() - PAD_STALE_MS - 60_000;
    await writeSuper(root, (s) => { s.pad = [line({ at: old })]; s.padSeq = 1; });
    const st = await verb('state', {});
    const pad = result(st).pad as Array<Record<string, unknown>>;
    expect(pad[0]).toMatchObject({ id: 'n1', stale: true });
    expect(pad[0].staleMin).toBeGreaterThanOrEqual(121);
    expect(result(st).padStale).toMatchObject({ ids: ['n1'] });
    expect(result(await verb('note-keep', { id: 'n1' })).note).toMatchObject({ id: 'n1', section: 'now' });
    const again = result(await verb('state', {}));
    expect((again.pad as Array<Record<string, unknown>>)[0].stale).toBeUndefined();
    expect(again.padStale).toBeUndefined();
    expect((await verb('note-keep', { id: 'n7' })).json.error).toBe('unknown_note');
  });
});
