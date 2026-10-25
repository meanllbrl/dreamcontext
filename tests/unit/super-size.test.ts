/**
 * Card sizes on the Super Agent's stage (owner 2026-10-22: "like Apple widgets"): a floating card
 * is small (1×1 tile), medium (2×1), large (2×2) or wide (3×2).
 *
 *  - the record keeps a size only when it is one, small is the absence of one, and the owner's
 *    mark (`sizeBy: 'owner'`) stands with or without a size: every older record reads as today;
 *  - the agent sizes a card with `super open --shape|--size` and `super shape`; the old
 *    square|tall still work and only record;
 *  - the owner's choice wins: his layout PATCH writes the size and the mark, the agent's `shape`
 *    on that card is a 409 `owner_sized`, its `open` keeps his size and lists the card in `kept`;
 *    the check is taken inside the locked write, so an owner resize landing between the agent's
 *    read and its write still wins; `size: null` hands the card back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-size-home-`);
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { CONTAINER_SIZES, SIZE_UNITS, emptySuperState, viewWithout as serverViewWithout, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import * as client from '../../dashboard/src/lib/superTypes.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperLayout, handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { fileURLToPath } from 'node:url';

let dir: string;
let root: string;
const SUPER = 'sup-size';
let token = '';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

const card = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'task', ref: `ref-${id}`, shape: 'square', place: 'float', ...extra });

function makeVault(state: Partial<SuperState> = {}): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    containers: [card('task-a'), card('task-b'), card('task-c', { pos: { x: 0.1, y: 0.2 } })],
    ...state,
  }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-size-'));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(dir, { recursive: true, force: true });
});

/** A request whose body is sent when `gate` resolves; `reading` resolves once the route starts
 *  reading the body (it has authorized and read its snapshot of the record by then). */
function gatedReq(body: unknown, headers: Record<string, string>, gate: Promise<void> = Promise.resolve()): { req: IncomingMessage; reading: Promise<void> } {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const on = r.on.bind(r);
  (r as unknown as { on: typeof on }).on = ((event: string, fn: (...a: unknown[]) => void) => {
    if (event === 'data') started();
    return on(event, fn);
  }) as typeof on;
  void gate.then(() => setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); }));
  return { req: r, reading };
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function verb(name: string, body: Record<string, unknown>) {
  const r = res();
  await handleSuperVerb(gatedReq(body, { 'x-dreamcontext-window-token': token }).req, r, { verb: name });
  return r;
}
async function layout(body: Record<string, unknown>) {
  const r = res();
  await handleSuperLayout(gatedReq(body, {}).req, r, {}, root);
  return r;
}
const onDisk = (): SuperState => JSON.parse(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')) as SuperState;
const cardOf = (id: string) => onDisk().containers.find((c) => c.id === id);

describe('sizes: the presets and their mirror', () => {
  it('four presets, in tile units, the same on both sides of the wire', () => {
    expect([...CONTAINER_SIZES]).toEqual(['small', 'medium', 'large', 'wide']);
    expect(SIZE_UNITS).toEqual({ small: { w: 1, h: 1 }, medium: { w: 2, h: 1 }, large: { w: 2, h: 2 }, wide: { w: 3, h: 2 } });
    expect([...client.CONTAINER_SIZES]).toEqual([...CONTAINER_SIZES]);
    expect(client.SIZE_UNITS).toEqual(SIZE_UNITS);
  });
});

describe('sizes: the record', () => {
  it('a record with no size reads as small, and nothing is added to it', async () => {
    makeVault();
    const s = await readSuperState(root);
    for (const c of s.containers) { expect(c.size).toBeUndefined(); expect(c.sizeBy).toBeUndefined(); }
  });

  it('keeps a real size and the owner\'s mark; drops a bogus size, small, and any other mark', async () => {
    makeVault({
      containers: [
        card('task-a', { size: 'large' }),
        card('task-b', { size: 'huge' as never, sizeBy: 'agent' as never }),
        card('task-c', { size: 'small', sizeBy: 'owner' }),
        card('task-d', { size: 'wide', sizeBy: 'owner' }),
      ],
    });
    const s = await readSuperState(root);
    const by = (id: string) => s.containers.find((c) => c.id === id)!;
    expect(by('task-a')).toMatchObject({ size: 'large' });
    expect(by('task-a').sizeBy).toBeUndefined();
    expect(by('task-b').size).toBeUndefined();
    expect(by('task-b').sizeBy).toBeUndefined();
    // He chose small: no size, but his mark stays (no agent may grow it).
    expect(by('task-c').size).toBeUndefined();
    expect(by('task-c').sizeBy).toBe('owner');
    expect(by('task-d')).toMatchObject({ size: 'wide', sizeBy: 'owner' });
  });
});

describe('sizes: the agent\'s verbs', () => {
  it('`shape <card> <size>` sizes a card; small takes the size off; square|tall still only record', async () => {
    makeVault();
    let r = await verb('shape', { container: 'task-a', shape: 'large' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, result: { container: 'task-a', size: 'large' } });
    expect(cardOf('task-a')).toMatchObject({ size: 'large', shape: 'square' });
    r = await verb('shape', { container: 'task-a', shape: 'tall' });
    expect(r.status).toBe(200);
    expect(cardOf('task-a')).toMatchObject({ size: 'large', shape: 'tall' });
    r = await verb('shape', { container: 'task-a', shape: 'small' });
    expect(r.status).toBe(200);
    expect(cardOf('task-a')!.size).toBeUndefined();
  });

  it('refuses a size that is not one', async () => {
    makeVault();
    const r = await verb('shape', { container: 'task-a', shape: 'huge' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_args');
    expect(String(r.json.message)).toMatch(/small \| medium \| large \| wide/);
  });

  it('`open --size` and `open --shape <size>` size a new card; disagreeing flags are a 400', async () => {
    makeVault();
    let r = await verb('open', { kind: 'web', ref: 'https://example.com/a', size: 'wide' });
    expect(r.status).toBe(200);
    expect(((r.json.result as Record<string, unknown>).container as SuperContainer).size).toBe('wide');
    r = await verb('open', { kind: 'task', ref: 'ship-it', shape: 'medium' });
    expect(((r.json.result as Record<string, unknown>).container as SuperContainer).size).toBe('medium');
    // An old shape still opens a 1:1 card.
    r = await verb('open', { kind: 'task', ref: 'write-docs', shape: 'tall' });
    expect(((r.json.result as Record<string, unknown>).container as SuperContainer).size).toBeUndefined();
    r = await verb('open', { kind: 'web', ref: 'https://example.com/d', shape: 'large', size: 'wide' });
    expect(r.status).toBe(400);
    // Same size on both: fine.
    r = await verb('open', { kind: 'web', ref: 'https://example.com/e', shape: 'large', size: 'large' });
    expect(r.status).toBe(200);
  });
});

describe('sizes: the owner\'s choice wins', () => {
  it('his layout PATCH writes the size and his mark; the agent\'s shape on it is a 409 and changes nothing', async () => {
    makeVault();
    let r = await layout({ cards: [{ id: 'task-a', size: 'large' }] });
    expect(r.status).toBe(200);
    expect(cardOf('task-a')).toMatchObject({ size: 'large', sizeBy: 'owner' });
    r = await verb('shape', { container: 'task-a', shape: 'small' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('owner_sized');
    expect(cardOf('task-a')).toMatchObject({ size: 'large', sizeBy: 'owner' });
    // An old shape only records, so it is not his size and goes through.
    r = await verb('shape', { container: 'task-a', shape: 'tall' });
    expect(r.status).toBe(200);
  });

  it('he may choose small: his mark protects it too', async () => {
    makeVault({ containers: [card('task-a', { size: 'wide' })] });
    await layout({ cards: [{ id: 'task-a', size: 'small' }] });
    expect(cardOf('task-a')!.size).toBeUndefined();
    expect(cardOf('task-a')!.sizeBy).toBe('owner');
    const r = await verb('shape', { container: 'task-a', shape: 'large' });
    expect(r.status).toBe(409);
  });

  it('`open` on a card he sized keeps his size and lists it in kept; a card he did not size takes the agent\'s', async () => {
    makeVault();
    const first = await verb('open', { kind: 'web', ref: 'https://example.com/a' });
    const id = ((first.json.result as Record<string, unknown>).container as SuperContainer).id;
    await layout({ cards: [{ id, size: 'medium' }] });
    const r = await verb('open', { kind: 'web', refs: ['https://example.com/a', 'https://example.com/b'], size: 'wide' });
    expect(r.status).toBe(200);
    expect((r.json.result as Record<string, unknown>).kept).toEqual([id]);
    expect(cardOf(id)).toMatchObject({ size: 'medium', sizeBy: 'owner' });
    const other = ((r.json.result as Record<string, unknown>).containers as SuperContainer[]).find((c) => c.id !== id)!;
    expect(other.size).toBe('wide');
    // Nothing kept: no `kept` in the answer.
    const again = await verb('open', { kind: 'web', ref: 'https://example.com/b', size: 'large' });
    expect((again.json.result as Record<string, unknown>).kept).toBeUndefined();
  });

  it('`size: null` hands the card back: no size, no mark, and the agent may size it again', async () => {
    makeVault();
    await layout({ cards: [{ id: 'task-a', size: 'large' }] });
    await layout({ cards: [{ id: 'task-a', size: null }] });
    expect(cardOf('task-a')!.size).toBeUndefined();
    expect(cardOf('task-a')!.sizeBy).toBeUndefined();
    const r = await verb('shape', { container: 'task-a', shape: 'wide' });
    expect(r.status).toBe(200);
  });

  it('a size and a drop position land together in one PATCH entry', async () => {
    makeVault();
    await layout({ cards: [{ id: 'task-c', size: 'large', pos: { x: 0.05, y: 0.2 } }] });
    expect(cardOf('task-c')).toMatchObject({ size: 'large', sizeBy: 'owner', pos: { x: 0.05, y: 0.2 } });
  });

  it('a bogus size in his PATCH is ignored; a group named in it is not sized', async () => {
    makeVault({ groups: [{ id: 'grp-1', name: 'Pair', cards: ['task-a', 'task-b'], place: 'float' }] });
    await layout({ cards: [{ id: 'task-c', size: 'huge' }, { id: 'grp-1', size: 'large' }] });
    expect(cardOf('task-c')!.size).toBeUndefined();
    expect(cardOf('task-c')!.sizeBy).toBeUndefined();
    const g = onDisk().groups.find((x) => x.id === 'grp-1') as Record<string, unknown>;
    expect(g.size).toBeUndefined();
    expect(g.sizeBy).toBeUndefined();
  });

  it('an owner resize landing between the agent\'s read and its write still wins (decided under the lock)', async () => {
    makeVault();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { req, reading } = gatedReq({ container: 'task-a', shape: 'wide' }, { 'x-dreamcontext-window-token': token }, gate);
    const r = res();
    const agent = handleSuperVerb(req, r, { verb: 'shape' });
    // The agent's route has authorized and holds its snapshot (no owner size yet)...
    await reading;
    // ...the owner sizes the card...
    await layout({ cards: [{ id: 'task-a', size: 'medium' }] });
    // ...then the agent's write runs.
    release();
    await agent;
    expect(r.status).toBe(409);
    expect(cardOf('task-a')).toMatchObject({ size: 'medium', sizeBy: 'owner' });
  });
});

describe('owner 2026-10-22: a page the agent opens is shown, never a small tile', () => {
  const result = (r: { json: Record<string, unknown> }) => r.json.result as Record<string, unknown>;

  it('`open web` makes the card large (a smaller size is raised) and puts it side by side', async () => {
    makeVault();
    let r = await verb('open', { kind: 'web', ref: 'http://localhost:5173/' });
    expect(r.status).toBe(200);
    const id = (result(r).container as SuperContainer).id;
    expect(cardOf(id)!.size).toBe('large');
    expect(onDisk().view).toEqual({ mode: 'half', card: id });
    expect(result(r).view).toEqual({ mode: 'half', card: id });
    r = await verb('open', { kind: 'web', ref: 'mockups/a.html', size: 'medium' });
    const id2 = (result(r).container as SuperContainer).id;
    expect(cardOf(id2)!.size).toBe('large');
    // The newer page takes the half place from the older page.
    expect(onDisk().view).toEqual({ mode: 'half', card: id2 });
    // Wide stays wide.
    r = await verb('open', { kind: 'web', ref: 'https://example.com/w', size: 'wide' });
    expect(cardOf((result(r).container as SuperContainer).id)!.size).toBe('wide');
  });

  it('other kinds open as before: no size, the view untouched', async () => {
    makeVault();
    const r = await verb('open', { kind: 'task', ref: 'ship-it' });
    expect((result(r).container as SuperContainer).size).toBeUndefined();
    expect(onDisk().view).toEqual({ mode: 'float' });
  });

  it('a half page showing something else (a chat, a task) and a presentation are left alone; a group never goes half', async () => {
    makeVault({ view: { mode: 'half', card: 'task-a' } });
    let r = await verb('open', { kind: 'web', ref: 'https://example.com/a' });
    expect(r.status).toBe(200);
    expect(onDisk().view).toEqual({ mode: 'half', card: 'task-a' });
    expect(cardOf((result(r).container as SuperContainer).id)!.size).toBe('large');
    makeVault({ view: { mode: 'present', cards: ['task-a', 'task-b'] } });
    await verb('open', { kind: 'web', ref: 'https://example.com/b' });
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['task-a', 'task-b'], layout: 'compare' });
    makeVault();
    r = await verb('open', { kind: 'web', refs: ['https://example.com/c', 'https://example.com/d'], group: 'Pages' });
    expect(r.status).toBe(200);
    expect(onDisk().view).toEqual({ mode: 'float' });
  });

  it('a page he sized keeps his size, even small; re-opening an agent-sized one raises it', async () => {
    makeVault();
    let r = await verb('open', { kind: 'web', ref: 'https://example.com/a' });
    const id = (result(r).container as SuperContainer).id;
    await layout({ cards: [{ id, size: 'small' }], view: { mode: 'float' } });
    expect(cardOf(id)).toMatchObject({ sizeBy: 'owner' });
    expect(cardOf(id)!.size).toBeUndefined();
    await verb('open', { kind: 'web', ref: 'https://example.com/a' });
    expect(cardOf(id)!.size).toBeUndefined();
    expect(cardOf(id)!.sizeBy).toBe('owner');
    r = await verb('open', { kind: 'web', ref: 'https://example.com/a', size: 'wide' });
    expect(result(r).kept).toEqual([id]);
  });

  it('`shape <page> small` writes large and says so', async () => {
    makeVault();
    const o = await verb('open', { kind: 'web', ref: 'https://example.com/a' });
    const id = (result(o).container as SuperContainer).id;
    const r = await verb('shape', { container: id, shape: 'small' });
    expect(r.status).toBe(200);
    expect(result(r).size).toBe('large');
    expect(cardOf(id)!.size).toBe('large');
  });

  it('the owner\'s view never carries the server\'s auto mark', async () => {
    makeVault();
    await layout({ view: { mode: 'half', card: 'task-a', auto: true } });
    // His own mark instead (`by: owner`, task a-picture-question…): never the server's `auto`.
    expect(onDisk().view).toEqual({ mode: 'half', card: 'task-a', by: 'owner' });
  });
});

describe('the window reads the server\'s auto mark, and holds that view while the owner types or drags', () => {
  it('readSuperStateView keeps `auto` on a half page only as a real true', () => {
    const wire = { ...emptySuperState(), vault: 'acme', session: SUPER, enabled: true, containers: [card('web-a', { kind: 'web', ref: 'https://example.com/' })] };
    expect(client.readSuperStateView({ ...wire, view: { mode: 'half', card: 'web-a', auto: true } })?.view).toEqual({ mode: 'half', card: 'web-a', auto: true });
    expect(client.readSuperStateView({ ...wire, view: { mode: 'half', card: 'web-a', auto: 'yes' } })?.view).toEqual({ mode: 'half', card: 'web-a' });
  });

  it('the surface plans a held page or a held automatic half as float (source pin)', () => {
    const ROOT = fileURLToPath(new URL('../../', import.meta.url));
    const surface = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/super/SuperSurface.tsx'), 'utf-8');
    const cues = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/super/useStageCues.ts'), 'utf-8');
    expect(surface).toMatch(/const autoHalf = state\.view\.mode === 'half' && state\.view\.auto && state\.view\.card \? state\.view\.card : null;/);
    expect(surface).toMatch(/stageCues\.held\.has\(state\.view\.card\) \|\| stageCues\.autoHalfHeld/);
    expect(surface).toMatch(/halfHeld \? heldFallback\(drawnView\.current, state\.view, state\.containers\) : state\.view/);
    // The automatic half waits on the same rule as a new card: typing or a drag.
    expect(cues).toMatch(/autoHalf !== null && autoHalf !== shownAuto\.current\s*\n\s*&& holdsNewCards\(\{ dragging, typedAt: typedAt\(\), now: Date\.now\(\) \}\)/);
  });
});

describe('a held half page keeps the view already drawn (second review)', () => {
  it('another page side by side stays; a presentation stays; a gone card or the waiting one floats', async () => {
    const { heldFallback } = await import('../../dashboard/src/components/sleepy/super/SuperSurface.js');
    const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const wanted = { mode: 'half' as const, card: 'b', auto: true as const };
    expect(heldFallback({ mode: 'half', card: 'a' }, wanted, cards)).toEqual({ mode: 'half', card: 'a' });
    expect(heldFallback({ mode: 'present', cards: ['a', 'c', 'b'] }, wanted, cards)).toEqual({ mode: 'present', cards: ['a', 'c'] });
    expect(heldFallback({ mode: 'half', card: 'b' }, wanted, cards)).toEqual({ mode: 'float' });
    expect(heldFallback({ mode: 'half', card: 'gone' }, wanted, cards)).toEqual({ mode: 'float' });
    expect(heldFallback({ mode: 'float' }, wanted, cards)).toEqual({ mode: 'float' });
    // The budget is the cold import, not the assertions: transforming SuperSurface.tsx and its
    // component tree takes 1.4-4.3s alone (20 runs) and passes 5s under the full suite's load.
  }, 30_000);
});

describe('owner 2026-10-22 13:19: a card that leaves the stage leaves the presentation too', () => {
  const PRES = { mode: 'present' as const, cards: ['task-a', 'task-b'] };

  it('viewWithout: the same rule on both sides of the wire', () => {
    const cases: Array<[client.SuperView, string[]]> = [
      [PRES, ['task-a']], [PRES, ['task-a', 'task-b']], [PRES, ['zzz']], [PRES, []],
      [{ mode: 'half', card: 'task-a' }, ['task-a']], [{ mode: 'half', card: 'task-a', auto: true }, ['task-b']], [{ mode: 'float' }, ['task-a']],
    ];
    for (const [v, ids] of cases) expect(client.viewWithout(v, new Set(ids))).toEqual(serverViewWithout(v, new Set(ids)));
    expect(client.viewWithout(PRES, new Set(['task-a']))).toEqual({ mode: 'present', cards: ['task-b'] });
    expect(client.viewWithout(PRES, new Set(['task-a', 'task-b']))).toEqual({ mode: 'float' });
    expect(client.viewWithout({ mode: 'half', card: 'task-a' }, new Set(['task-a']))).toEqual({ mode: 'float' });
  });

  it('Move to Others on a presented card: the presentation goes on with the rest, then floats', async () => {
    makeVault({ view: PRES });
    await layout({ cards: [{ id: 'task-a', place: 'others' }] });
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['task-b'], layout: 'spotlight' });
    await layout({ cards: [{ id: 'task-b', place: 'others' }] });
    expect(onDisk().view).toEqual({ mode: 'float' });
  });

  it('closed, resized or grouped by the owner: out of the presentation; a half page floats', async () => {
    makeVault({ view: PRES });
    await layout({ closed: ['task-a'] });
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['task-b'], layout: 'spotlight' });
    makeVault({ view: PRES });
    await layout({ cards: [{ id: 'task-b', size: 'large' }] });
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['task-a'], layout: 'spotlight' });
    makeVault({ view: PRES });
    await layout({ group: { id: 'grp-n', cards: ['task-a', 'task-c'] } });
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['task-b'], layout: 'spotlight' });
    makeVault({ view: { mode: 'half', card: 'task-a' } });
    await layout({ cards: [{ id: 'task-a', place: 'others' }] });
    expect(onDisk().view).toEqual({ mode: 'float' });
    // A drop position or a move back to the stage leaves the view alone; an explicit view wins.
    makeVault({ view: PRES });
    await layout({ cards: [{ id: 'task-a', pos: { x: 0.2, y: 0.2 } }, { id: 'task-b', place: 'float' }] });
    expect(onDisk().view).toEqual({ ...PRES, layout: 'compare' });
    await layout({ cards: [{ id: 'task-a', place: 'others' }], view: { mode: 'half', card: 'task-b' } });
    expect(onDisk().view).toEqual({ mode: 'half', card: 'task-b', by: 'owner' });
  });

  it('a group moved to Others takes its presented cards out (the owner\'s drop and the agent\'s stack)', async () => {
    const groups = [{ id: 'grp-1', name: 'Pair', cards: ['task-a', 'task-c'], place: 'float' as const }];
    makeVault({ groups, view: { mode: 'present', cards: ['task-a', 'task-b'] } });
    await layout({ cards: [{ id: 'grp-1', place: 'others' }] });
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['task-b'], layout: 'spotlight' });
    makeVault({ groups, view: { mode: 'present', cards: ['task-a', 'task-b'] } });
    const r = await verb('stack', { container: 'grp-1' });
    expect(r.status).toBe(200);
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['task-b'], layout: 'spotlight' });
  });

  it('the agent\'s group and stack verbs follow the same rule', async () => {
    makeVault({ view: PRES });
    await verb('stack', { container: 'task-a' });
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['task-b'], layout: 'spotlight' });
    makeVault({ view: PRES });
    const r = await verb('group', { containers: ['task-b', 'task-c'], name: 'Two' });
    expect(r.status).toBe(200);
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['task-a'], layout: 'spotlight' });
  });

  it('the window applies the same rule the moment the owner presses (applyLayoutPatch)', async () => {
    const { applyLayoutPatch } = await import('../../dashboard/src/components/sleepy/super/superLayout.js');
    const st = { containers: [card('task-a'), card('task-b'), card('task-c')], groups: [], view: PRES as client.SuperView };
    expect(applyLayoutPatch(st, { cards: [{ id: 'task-a', place: 'others' }] }).view).toEqual({ mode: 'present', cards: ['task-b'], layout: 'spotlight' });
    expect(applyLayoutPatch(st, { closed: ['task-a', 'task-b'] }).view).toEqual({ mode: 'float' });
    expect(applyLayoutPatch(st, { cards: [{ id: 'task-b', size: 'medium' }] }).view).toEqual({ mode: 'present', cards: ['task-a'], layout: 'spotlight' });
    expect(applyLayoutPatch(st, { group: { id: 'grp-z', cards: ['task-a', 'task-c'] } }).view).toEqual({ mode: 'present', cards: ['task-b'], layout: 'spotlight' });
    expect(applyLayoutPatch(st, { cards: [{ id: 'task-a', pos: { x: 0.1, y: 0.1 } }] }).view).toEqual({ ...PRES, layout: 'compare' });
  });
});
