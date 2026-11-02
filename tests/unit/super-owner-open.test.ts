/**
 * The owner opens a card himself (`POST /api/super/open`, task sahip-super-sahnesinde-…): the same
 * ask makes the same record from either door (AC2), only `{ kind, ref }` or `{ path }` gets through
 * (AC3), the stage planner places the card and the limits bind him too (AC4), and a success answers
 * with the state because his request may have no socket to push on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-owner-open-home-`);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { readSuperState, resetSuperIndex, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { MAX_CONTAINERS, MAX_FLOAT, emptySuperState, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import { SUPER_OWNER_HANDLERS, SUPER_VERB_HANDLERS, type SuperCaller } from '../../src/server/routes/super.js';
import { insightPath } from '../../src/lib/lab/store.js';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { _resetSuperInbox, containerIdFor } from '../../src/lib/super/inbox.js';

type Reply = ServerResponse & { status: number; json: Record<string, unknown> };
type Body = Record<string, unknown>;

let dir: string;
let agentRoot: string;
let ownerRoot: string;

function res(): Reply {
  const out = { status: 0, json: {} } as Reply;
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}

function vault(name: string, extra: Partial<SuperState>): string {
  const root = join(dir, name, 'pocket-ledger', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  const project = dirname(root);
  mkdirSync(join(project, 'docs'), { recursive: true });
  for (const f of ['a.png', 'b.png', 'c.png', 'r.pdf', 'p.html', 'q.html', 'v.mp4', 'n.md']) writeFileSync(join(project, 'docs', f), 'x');
  writeFileSync(join(project, 'docs', 'sketch.excalidraw.md'), 'x');
  const insight = insightPath(root, 'weekly-signups');
  mkdirSync(dirname(insight), { recursive: true });
  writeFileSync(insight, '{}');
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sess-owner-open', enabled: true, ...extra }));
  return root;
}

async function agentOpen(root: string, body: Body): Promise<Reply> {
  const r = res();
  const caller = { token: 't', who: { contextRoot: root }, state: await readSuperState(root) } as unknown as SuperCaller;
  await SUPER_VERB_HANDLERS.open(caller, body, r);
  return r;
}

async function ownerOpen(root: string, body: Body): Promise<Reply> {
  const r = res();
  await SUPER_OWNER_HANDLERS.open({} as never, r, root, body);
  return r;
}

/** Group ids are random: numbered in order of first use, the rest must match byte for byte. */
function normal(value: unknown): unknown {
  const seen = new Map<string, string>();
  const text = JSON.stringify(value).replace(/grp-[a-z0-9]+-[a-z0-9]+/g, (id) => {
    if (!seen.has(id)) seen.set(id, `group-${seen.size + 1}`);
    return seen.get(id) as string;
  });
  return JSON.parse(text);
}

async function record(root: string) {
  const s = await readSuperState(root);
  return normal({ containers: s.containers, groups: s.groups, view: s.view });
}

/** A file kind is refused as `{ kind, ref }` at the owner's door: he names the path. */
const ownerAsk = (ask: Body): Body => (['image', 'pdf', 'video', 'board'].includes(String(ask.kind)) ? { path: ask.ref } : ask);

/** One ask through both doors, each on its own record; every step must leave the same record. */
async function parity(start: Partial<SuperState>, asks: Body[]): Promise<void> {
  agentRoot = vault('agent', start);
  ownerRoot = vault('owner', start);
  for (const ask of asks) {
    const a = await agentOpen(agentRoot, ask);
    const o = await ownerOpen(ownerRoot, ownerAsk(ask));
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    expect(await record(ownerRoot)).toEqual(await record(agentRoot));
    expect(normal(o.json.result)).toEqual(normal(a.json.result));
    // The agent's answer keeps its shape; the owner's adds the state.
    expect(Object.keys(a.json).sort()).toEqual(['ok', 'result']);
    expect(Object.keys(o.json).sort()).toEqual(['ok', 'result', 'state']);
  }
}

const card = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'task', ref: id, shape: 'square', place: 'float', ...extra });
const web = (id: string, url: string): SuperContainer => card(id, { kind: 'web', ref: url, shape: 'wide' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-owner-open-'));
  _resetChatRegistry();
  _resetSuperInbox();
  resetSuperIndex();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('AC2: the same record from either door', () => {
  it.each<[string, Body]>([
    ['a task', { kind: 'task', ref: 'ship-the-ledger' }],
    ['a knowledge page', { kind: 'knowledge', ref: 'pricing-model' }],
    ['an insight', { kind: 'insight', ref: 'weekly-signups' }],
    ['the default whiteboard, made on first ask', { kind: 'whiteboard', ref: 'control-panel' }],
    ['a project page', { kind: 'web', ref: 'docs/p.html' }],
    ['a PDF', { kind: 'pdf', ref: 'docs/r.pdf' }],
    ['a clip', { kind: 'video', ref: 'docs/v.mp4' }],
    ['a board file', { kind: 'board', ref: 'docs/sketch.excalidraw.md' }],
  ])('on an empty stage: %s', async (_n, ask) => {
    await parity({}, [ask]);
    expect((await readSuperState(ownerRoot)).containers).toHaveLength(1);
  });

  it('a card resting in Others comes back the same', async () => {
    await parity({ containers: [card(containerIdFor('task', 'a'), { ref: 'a', place: 'others' })] }, [{ kind: 'task', ref: 'a' }]);
    expect((await readSuperState(ownerRoot)).containers.map((k) => k.place)).toEqual(['float']);
  });

  it('a chain of pictures makes one group, joined the same', async () => {
    await parity({}, [{ kind: 'image', ref: 'docs/a.png' }, { kind: 'image', ref: 'docs/b.png' }, { kind: 'image', ref: 'docs/c.png' }]);
    const s = await readSuperState(ownerRoot);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].cards).toHaveLength(3);
  });

  it('a page in a floating view is shown side by side', async () => {
    await parity({}, [{ kind: 'web', ref: 'https://pocket-ledger.example/plans' }]);
    expect((await readSuperState(ownerRoot)).view.mode).toBe('half');
  });

  it('a page over a side-by-side page takes its place', async () => {
    const shown = web('web-old', 'https://pocket-ledger.example/old');
    await parity({ containers: [shown], view: { mode: 'half', card: shown.id } }, [{ kind: 'web', ref: 'docs/q.html' }]);
    const view = (await readSuperState(ownerRoot)).view;
    expect(view.mode).toBe('half');
    expect(view.mode === 'half' && view.card).not.toBe(shown.id);
  });

  it('a page never covers a presentation', async () => {
    const shown = [card('task-a', { ref: 'a' }), card('task-b', { ref: 'b' })];
    await parity({ containers: shown, view: { mode: 'present', cards: shown.map((k) => k.id) } }, [{ kind: 'web', ref: 'https://pocket-ledger.example/plans' }]);
    expect((await readSuperState(ownerRoot)).view.mode).toBe('present');
  });

  it('a whiteboard named by its own file opens as the whiteboard', async () => {
    ownerRoot = vault('owner', {});
    expect((await ownerOpen(ownerRoot, { kind: 'whiteboard', ref: 'control-panel' })).status).toBe(200);
    const r = await ownerOpen(ownerRoot, { path: '_dream_context/whiteboards/control-panel/control-panel.excalidraw.md' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json.result as { kind: string }).kind).toBe('whiteboard');
    expect((await readSuperState(ownerRoot)).containers.map((k) => k.kind)).toEqual(['whiteboard']);
  });
});

describe('AC3: only { kind, ref } or { path } gets through', () => {
  const noise = { group: 'Mine', for: 'child-x', present: true, shape: 'tall', size: 'large', refs: ['one', 'two'], title: 'Owned', titles: ['Owned'] };

  it('every other field is ignored', async () => {
    agentRoot = vault('agent', {});
    ownerRoot = vault('owner', {});
    expect((await agentOpen(agentRoot, { kind: 'task', ref: 'plain' })).status).toBe(200);
    expect((await ownerOpen(ownerRoot, { kind: 'task', ref: 'plain', ...noise })).status).toBe(200);
    expect(await record(ownerRoot)).toEqual(await record(agentRoot));
  });

  it('every other field is ignored beside a path too', async () => {
    agentRoot = vault('agent', {});
    ownerRoot = vault('owner', {});
    expect((await agentOpen(agentRoot, { kind: 'image', ref: 'docs/a.png' })).status).toBe(200);
    expect((await ownerOpen(ownerRoot, { path: 'docs/a.png', ...noise })).status).toBe(200);
    expect(await record(ownerRoot)).toEqual(await record(agentRoot));
  });

  it.each(['chat', 'browser', 'team', 'agenda', 'image', 'pdf', 'video', 'board'])('kind %s is refused as { kind, ref }', async (kind) => {
    ownerRoot = vault('owner', { children: { 'child-x': { sessionId: 'child-x', brief: '', adopted: true, startedAt: 1 } } as unknown as SuperState['children'] });
    const r = await ownerOpen(ownerRoot, { kind, ref: kind === 'chat' || kind === 'browser' ? 'child-x' : 'docs/a.png' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_args');
    expect((await readSuperState(ownerRoot)).containers).toEqual([]);
  });

  it('a path with a kind, or a path that is no text, is refused', async () => {
    ownerRoot = vault('owner', {});
    for (const body of [{ path: 'docs/a.png', kind: 'image' }, { path: 7 }, { path: null }, { path: '  ' }, {}]) {
      const r = await ownerOpen(ownerRoot, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error).toBe('invalid_args');
    }
  });

  it('a stage not handed over is refused', async () => {
    ownerRoot = vault('owner', { enabled: false });
    const r = await ownerOpen(ownerRoot, { kind: 'task', ref: 'a' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('not_handed_over');
  });

  it('the agent\'s rules for a ref hold at this door too', async () => {
    ownerRoot = vault('owner', {});
    expect((await ownerOpen(ownerRoot, { kind: 'insight', ref: 'no-such-insight' })).json.error).toBe('unknown_insight');
    expect((await ownerOpen(ownerRoot, { kind: 'whiteboard', ref: 'no-such-board' })).json.error).toBe('unknown_whiteboard');
    expect((await ownerOpen(ownerRoot, { kind: 'web', ref: 'http://example.com' })).json.error).toBe('invalid_ref');
    expect((await readSuperState(ownerRoot)).containers).toEqual([]);
  });

  it.each([
    ['../outside.html', 'unknown_file', 404], ['docs/n.md', 'unsupported_file', 400], ['docs', 'not_a_file', 400],
    // A file that exists on every OS, outside the project (Windows has no /etc/hosts: it would read unknown_file).
    [process.execPath, 'outside_project', 400], ['docs/none.png', 'unknown_file', 404],
  ])('the file %s is refused with %s', async (path, error, status) => {
    ownerRoot = vault('owner', {});
    const r = await ownerOpen(ownerRoot, { path });
    expect(r.json.error).toBe(error);
    expect(r.status).toBe(status);
    expect((await readSuperState(ownerRoot)).containers).toEqual([]);
  });
});

describe('AC4: the planner places it and the limits bind the owner', () => {
  it('the record names no place and no owner stamp', async () => {
    ownerRoot = vault('owner', {});
    await ownerOpen(ownerRoot, { kind: 'task', ref: 'a' });
    await ownerOpen(ownerRoot, { kind: 'web', ref: 'docs/p.html' });
    await ownerOpen(ownerRoot, { path: 'docs/a.png' });
    const s = await readSuperState(ownerRoot);
    expect(s.containers).toHaveLength(3);
    for (const k of s.containers) {
      expect(k).not.toHaveProperty('pos');
      expect(k).not.toHaveProperty('sizeBy');
    }
  });

  it('a full stage answers stage_full and adds nothing', async () => {
    const containers = Array.from({ length: MAX_FLOAT }, (_v, i) => card(`task-${i}`, { ref: `t${i}` }));
    ownerRoot = vault('owner', { containers });
    const r = await ownerOpen(ownerRoot, { kind: 'task', ref: 'one-more' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('stage_full');
    expect((await readSuperState(ownerRoot)).containers).toHaveLength(MAX_FLOAT);
    // The agent's words for the same limit do not change.
    agentRoot = vault('agent', { containers });
    expect((await agentOpen(agentRoot, { kind: 'task', ref: 'one-more' })).json.error).toBe('too_many_containers');
  });

  it('on a full stage, the card already there opens again instead of being refused', async () => {
    const containers = Array.from({ length: MAX_FLOAT }, (_v, i) => card(containerIdFor('task', `t${i}`), { ref: `t${i}` }));
    ownerRoot = vault('owner', { containers });
    const r = await ownerOpen(ownerRoot, { kind: 'task', ref: 't3' });
    expect(r.status).toBe(200);
    expect((await readSuperState(ownerRoot)).containers).toHaveLength(MAX_FLOAT);
  });

  it('a full record answers record_full and adds nothing', async () => {
    // Sized by the owner: none of these can retire (room.ts).
    const containers = Array.from({ length: MAX_CONTAINERS }, (_v, i) => card(`task-${i}`, { ref: `t${i}`, place: 'others', sizeBy: 'owner', size: 'large' }));
    ownerRoot = vault('owner', { containers });
    const r = await ownerOpen(ownerRoot, { kind: 'task', ref: 'one-more' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('record_full');
    expect((await readSuperState(ownerRoot)).containers).toHaveLength(MAX_CONTAINERS);
  });
});

describe('the answer carries the state', () => {
  it('a window with no socket can draw the card from the answer alone', async () => {
    ownerRoot = vault('owner', {});
    const r = await ownerOpen(ownerRoot, { kind: 'task', ref: 'a' });
    const view = r.json.state as { containers: SuperContainer[] };
    expect(view.containers.map((k) => k.ref)).toEqual(['a']);
    expect((r.json.result as { container: { id: string } }).container.id).toBe(view.containers[0].id);
  });
});
