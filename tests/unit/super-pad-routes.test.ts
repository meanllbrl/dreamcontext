/**
 * Task ajanda-gunluk C6, criteria 9-11: the owner's agenda routes. Add and remove need the shell's
 * owner key (else `owner_page_only`); a status change works without it but leaves no mark; his
 * add never takes over a Super line; remove refuses a Done line; a refused add answers
 * `pad_full`; a delegate whose note is refused still starts its child with `noteRefused`;
 * `agenda-day` refuses a malformed date and returns a past day; Done on a running job's line
 * leaves the job alone and queues nothing; the Super's own `super state` never shows his marks.
 * Fictional project (synthetic fixtures).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/pad-routes-home-`);
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import { readSuperState, resetSuperIndex, superAgendaDaysDir, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { archiveDoneLines, localDay } from '../../src/lib/super/pad-archive.js';
import { MAX_PAD, emptySuperState, type SuperPadItem } from '../../src/lib/super/types.js';
import { SUPER_OWNER_HANDLERS, handleSuperAgendaDay, handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const KEY = 'a1'.repeat(32);
const PAGE = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
const OWNER = { ...PAGE, [OWNER_KEY_HEADER]: KEY };
const SUPER = 'sup-routes';
const KID = '12345678-1234-4234-8234-123456789abc';
let dir: string;
let root: string;

beforeEach(() => {
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  setOwnerKey(KEY);
  dir = mkdtempSync(join(tmpdir(), 'pad-routes-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
});
afterEach(() => { setOwnerKey(null); _resetSuperInbox(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

function seed(over: Record<string, unknown> = {}): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...over }));
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  (out as unknown as { setHeader: () => void }).setHeader = () => {};
  return out;
}
const reqOf = (headers: Record<string, string>, url = '/') => ({ headers, url, method: 'POST', socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
async function owner(verb: 'pad' | 'pad-add' | 'pad-remove', body: Record<string, unknown>, headers: Record<string, string> = OWNER) {
  const r = res();
  await SUPER_OWNER_HANDLERS[verb](reqOf(headers), r, root, body, 'main');
  return r;
}
const pad = async () => (await readSuperState(root)).pad ?? [];
const line = (id: string, over: Partial<SuperPadItem> = {}): SuperPadItem => ({ id, section: 'now', text: `Acme ${id}`, at: Date.now() - 1000, ...over });

describe('his add and remove need the owner key', () => {
  it('add writes a NEW Not started line of his, even when a Super line says the same; a mark rides it', async () => {
    seed({ pad: [line('n1', { text: 'Call the Acme printer' })], padSeq: 1 });
    const r = await owner('pad-add', { text: 'Call the Acme printer' });
    expect(r.status).toBe(200);
    const p = await pad();
    expect(p).toHaveLength(2);
    expect(p[1]).toMatchObject({ id: 'n2', section: 'now', stage: 'todo', author: 'owner', by: 'owner' });
    expect(p[0]).not.toHaveProperty('author');
    expect((await readSuperState(root)).ownerMarks).toEqual([expect.objectContaining({ key: 'pad:n2', kind: 'pad-add' })]);
  });

  it('without the key add and remove answer owner_page_only and write nothing', async () => {
    seed({ pad: [line('n1', { author: 'owner' })], padSeq: 1 });
    expect((await owner('pad-add', { text: 'x' }, PAGE)).json.error).toBe('owner_page_only');
    expect((await owner('pad-remove', { id: 'n1' }, PAGE)).json.error).toBe('owner_page_only');
    expect(await pad()).toHaveLength(1);
  });

  it('remove takes his open line only: a Done line is history, a Super line closes with Done', async () => {
    seed({ pad: [line('n1', { author: 'owner' }), line('n2', { author: 'owner', section: 'done' }), line('n3')], padSeq: 3 });
    expect((await owner('pad-remove', { id: 'n2' })).json.error).toBe('not_open');
    expect((await owner('pad-remove', { id: 'n3' })).json.error).toBe('not_owner');
    expect((await owner('pad-remove', { id: 'n9' })).json.error).toBe('unknown_note');
    expect((await owner('pad-remove', { id: 'n1' })).status).toBe(200);
    expect((await pad()).map((p) => p.id)).toEqual(['n2', 'n3']);
    // A line added and removed before his next message leaves no mark at all.
    await owner('pad-add', { text: 'Book the Acme venue' });
    const added = (await pad()).find((p) => p.text === 'Book the Acme venue')!;
    await owner('pad-remove', { id: added.id });
    expect((await readSuperState(root)).ownerMarks?.some((m) => m.key === `pad:${added.id}`)).toBeFalsy();
  });

  it('a full pad with no Done line answers pad_full in plain words', async () => {
    seed({ pad: Array.from({ length: MAX_PAD }, (_, i) => line(`n${i + 1}`)), padSeq: MAX_PAD });
    const r = await owner('pad-add', { text: 'one more' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'pad_full', message: 'Agenda is full: close a line first.' });
  });

  it('a full pad whose eviction cannot be archived refuses the new line and leaves no mark', async () => {
    seed({ pad: [line('n1', { section: 'done' }), ...Array.from({ length: MAX_PAD - 1 }, (_, i) => line(`n${i + 2}`))], padSeq: MAX_PAD });
    mkdirSync(join(root, 'state', '.super'), { recursive: true });
    mkdirSync(join(dir, 'away'));
    symlinkSync(join(dir, 'away'), superAgendaDaysDir(root));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await owner('pad-add', { text: 'one more' });
    expect(r.json.error).toBe('pad_full');
    const s = await readSuperState(root);
    expect(s.pad).toHaveLength(MAX_PAD);
    expect(s.pad!.some((p) => p.id === 'n1')).toBe(true);
    expect(s.ownerMarks).toBeUndefined();
  });
});

describe('his status changes', () => {
  it('five statuses (and the older section body); a mark only with the key', async () => {
    seed({ pad: [line('n1'), line('n2')], padSeq: 2 });
    expect((await owner('pad', { id: 'n1', status: 'almost-done' }, PAGE)).status).toBe(200);
    expect((await pad()).find((p) => p.id === 'n1')).toMatchObject({ stage: 'almost', by: 'owner' });
    expect((await readSuperState(root)).ownerMarks).toBeUndefined();
    expect((await owner('pad', { id: 'n2', section: 'done' })).status).toBe(200);
    expect((await pad()).find((p) => p.id === 'n2')).toMatchObject({ section: 'done', by: 'owner' });
    expect((await readSuperState(root)).ownerMarks).toEqual([expect.objectContaining({ key: 'pad:n2', from: 'in-progress', to: 'done' })]);
    expect((await owner('pad', { id: 'n2', status: 'later' })).status).toBe(400);
    expect((await owner('pad', { id: 'n9', status: 'done' })).json.error).toBe('unknown_note');
  });

  it('Done on a running job\'s line closes the line, leaves the job running and queues no turn', async () => {
    seed({ children: { [KID]: { sessionId: KID, brief: 'Acme build', adopted: false, startedAt: 1, row: 'working' } }, pad: [line('n1', { for: KID })], padSeq: 1 });
    await owner('pad', { id: 'n1', status: 'done' });
    const s = await readSuperState(root);
    expect(s.pad![0]).toMatchObject({ section: 'done', by: 'owner' });
    expect(s.children[KID].row).toBe('working');
    expect(s.children[KID].endedAt).toBeUndefined();
    expect(s.queue).toEqual([]);
  });
});

describe('a past day', () => {
  const saved = process.env.DREAMCONTEXT_DESKTOP;
  beforeEach(() => { process.env.DREAMCONTEXT_DESKTOP = '1'; });
  afterEach(() => { if (saved === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = saved; });
  async function day(date: string) {
    const r = res();
    await handleSuperAgendaDay({ headers: PAGE, url: `/api/super/agenda-day?date=${encodeURIComponent(date)}`, method: 'GET', socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage, r, {}, root);
    return r;
  }
  it('refuses a malformed date before it touches a path', async () => {
    seed();
    for (const bad of ['../../etc', '2026-13-01', '2026-11-14x', '']) expect((await day(bad)).status).toBe(400);
  });
  it('returns Done that day and Started that day, still open', async () => {
    const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(12, 0, 0, 0);
    seed({ pad: [line('n2', { bornAt: y.getTime(), at: Date.now() })], padSeq: 2 });
    await archiveDoneLines(root, 'main', [line('n1', { section: 'done', at: y.getTime() })]);
    const r = await day(localDay(y.getTime()));
    expect(r.status).toBe(200);
    expect((r.json.done as SuperPadItem[]).map((p) => p.id)).toEqual(['n1']);
    expect((r.json.open as SuperPadItem[]).map((p) => p.id)).toEqual(['n2']);
  });
});

describe('the Super\'s side', () => {
  let token = '';
  const frames: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    frames.length = 0;
    token = mintWindowToken({
      send: (frame) => {
        frames.push(frame);
        setImmediate(() => deliverSuperResult(token, frame.id, { ok: true, result: { sessionId: KID } }));
        return true;
      },
      vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super',
    }).token;
  });
  function req(body: unknown): IncomingMessage {
    const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
    setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
    return r;
  }
  async function verb(name: string, body: Record<string, unknown> = {}) {
    const r = res();
    await handleSuperVerb(req(body), r, { verb: name });
    return r;
  }

  it('`super state` never shows his marks', async () => {
    seed({ ownerMarks: [{ key: 'pad:n1', kind: 'pad-status', text: 'Acme', from: 'in-progress', to: 'done', at: 1, seq: 1 }], ownerMarkSeq: 1 });
    const r = await verb('state');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain('ownerMarks');
  });

  it('a delegate whose note is refused (full pad, failing archive) still starts its child, with noteRefused', async () => {
    seed({ pad: [line('n1', { section: 'done' }), ...Array.from({ length: MAX_PAD - 1 }, (_, i) => line(`n${i + 2}`))], padSeq: MAX_PAD });
    mkdirSync(join(root, 'state', '.super'), { recursive: true });
    mkdirSync(join(dir, 'away2'));
    symlinkSync(join(dir, 'away2'), superAgendaDaysDir(root));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await verb('delegate', { model: 'sonnet', prompt: 'Build the Acme page.', brief: 'Acme page', note: 'Acme page build' });
    expect(r.status).toBe(200);
    const out = r.json.result as Record<string, unknown>;
    expect(out.sessionId).toBe(KID);
    expect(out.noteRefused).toMatch(/pad_full/);
    const s = await readSuperState(root);
    expect(s.children[KID]).toBeDefined();
    expect(s.pad).toHaveLength(MAX_PAD);
    expect(s.pad!.some((p) => p.id === 'n1')).toBe(true);
  });

  it('`note add` refused the same way answers pad_full', async () => {
    seed({ pad: [line('n1', { section: 'done' }), ...Array.from({ length: MAX_PAD - 1 }, (_, i) => line(`n${i + 2}`))], padSeq: MAX_PAD });
    mkdirSync(join(root, 'state', '.super'), { recursive: true });
    mkdirSync(join(dir, 'away3'));
    symlinkSync(join(dir, 'away3'), superAgendaDaysDir(root));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await verb('note-add', { section: 'now', text: 'one more' });
    expect(r.json.error).toBe('pad_full');
  });
});


describe('the days that have a file (agenda search)', () => {
  const saved = process.env.DREAMCONTEXT_DESKTOP;
  beforeEach(() => { process.env.DREAMCONTEXT_DESKTOP = '1'; });
  afterEach(() => { if (saved === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = saved; });
  it('lists every archived day, newest first', async () => {
    seed();
    const d1 = new Date(2026, 10, 10, 12).getTime(); const d2 = new Date(2026, 10, 12, 12).getTime();
    await archiveDoneLines(root, 'main', [line('x1', { section: 'done', at: d1 }), line('x2', { section: 'done', at: d2 })]);
    const { agendaDays } = await import('../../src/lib/super/pad-archive.js');
    expect(await agendaDays(root, 'main')).toEqual(['2026-11-12', '2026-11-10']);
  });
  it('a days folder that is a link lists nothing', async () => {
    seed();
    mkdirSync(join(root, 'state', '.super'), { recursive: true });
    mkdirSync(join(dir, 'away4'));
    writeFileSync(join(dir, 'away4', '2026-11-12.json'), JSON.stringify({ lines: [] }));
    symlinkSync(join(dir, 'away4'), superAgendaDaysDir(root));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { agendaDays } = await import('../../src/lib/super/pad-archive.js');
    expect(await agendaDays(root, 'main')).toEqual([]);
  });
  it('the route is the owner window only: a page without the desktop shell is refused', async () => {
    seed();
    delete process.env.DREAMCONTEXT_DESKTOP;
    const { handleSuperAgendaDays } = await import('../../src/server/routes/super.js');
    const r = res();
    await handleSuperAgendaDays({ headers: PAGE, url: '/api/super/agenda-days', method: 'GET', socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage, r, {}, root);
    expect([401, 403]).toContain(r.status);
  });
  it('the route answers the owner window with the days', async () => {
    seed();
    await archiveDoneLines(root, 'main', [line('y1', { section: 'done', at: new Date(2026, 10, 9, 12).getTime() })]);
    const { handleSuperAgendaDays } = await import('../../src/server/routes/super.js');
    const r = res();
    await handleSuperAgendaDays({ headers: PAGE, url: '/api/super/agenda-days', method: 'GET', socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage, r, {}, root);
    expect(r.status).toBe(200);
    expect(r.json.days).toEqual(['2026-11-09']);
  });
  it('no days folder is no days', async () => {
    seed();
    const { agendaDays } = await import('../../src/lib/super/pad-archive.js');
    expect(await agendaDays(root, 'main')).toEqual([]);
  });
});
