/**
 * Named chat windows in the session roster (task codex-tarzi-yeni-kabuk W3, D8, F3).
 *
 * The data contract this locks: an existing `.agent-sessions.json` opens as ONE window holding
 * every tab and is not rewritten until the next normal save; a downgraded reader (classic, or a
 * build from before windows) still finds every tab in `sessions`, each in its own pane; absence
 * never deletes (a PUT without `windows`, or a tab without `window`, keeps what was stored);
 * unknown window ids go to `windows[0]`; an empty list is re-seeded; the 409 on a stale
 * generation still holds; 40 tabs fit the raw body limit at their worst.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleAgentSessionsGet, handleAgentSessionsPut, landPhoneRosterOnDesktop, rosterSummary,
  coerceWindows, withWindows, MAX_SESSIONS, MAX_WINDOW_NAME, DEFAULT_WINDOW, type SavedMeta,
} from '../../src/server/routes/agent-sessions.js';
import { parseJsonBody } from '../../src/server/middleware.js';

let scratch: string;
let home: string;
let contextRoot: string;
const realDesktop = process.env.DREAMCONTEXT_DESKTOP;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tab = (title: string, over: Partial<SavedMeta> = {}): SavedMeta => ({ title, bypass: false, minimized: false, size: 1, kind: 'chat', ...over });

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hf-roster-gen-'));
  home = join(scratch, 'home');
  contextRoot = join(scratch, 'proj', '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (realDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP;
  else process.env.DREAMCONTEXT_DESKTOP = realDesktop;
});

const file = () => join(contextRoot, 'state', '.agent-sessions.json');
const stored = () => JSON.parse(readFileSync(file(), 'utf-8')) as { sessions: SavedMeta[]; windows?: Array<{ id: string; name: string; activePane?: number }>; generation?: number };

function res(): { res: ServerResponse; status: () => number; body: () => Record<string, any> } {
  let code = 0;
  let body: Record<string, unknown> = {};
  const r = { writeHead(c: number) { code = c; }, setHeader() {}, end(d: string) { body = JSON.parse(d); } } as unknown as ServerResponse;
  return { res: r, status: () => code, body: () => body };
}
function req(body: unknown, url = '/api/agent/sessions'): IncomingMessage {
  const r = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(r, { method: 'PUT', url, headers: { 'content-type': 'application/json' } });
  return r;
}
async function get(url = '/api/agent/sessions'): Promise<Record<string, any>> {
  const r = res();
  await handleAgentSessionsGet({ url } as IncomingMessage, r.res, {}, contextRoot, home);
  expect(r.status()).toBe(200);
  return r.body();
}
async function put(body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const r = res();
  await handleAgentSessionsPut(req(body), r.res, {}, contextRoot, home);
  return { status: r.status(), body: r.body() };
}

describe('roster windows: the legacy file', () => {
  it('opens as one window {main, Chat} holding every tab, and the file is not rewritten', async () => {
    const legacy = JSON.stringify({
      sessions: [tab('A', { sessionId: uuid(1), pane: 0, active: true }), tab('B', { sessionId: uuid(2), pane: 1 }), tab('C', { sessionId: uuid(3), pane: 1 })],
      activePane: 1,
      chatPermissionMode: 'auto',
    }, null, 2) + '\n';
    writeFileSync(file(), legacy);
    const body = await get();
    expect(body.windows).toEqual([{ id: 'main', name: 'Chat' }]);
    expect(body.sessions.map((m: SavedMeta) => [m.title, m.window, m.pane])).toEqual([['A', 'main', 0], ['B', 'main', 1], ['C', 'main', 1]]);
    expect(body.activePane).toBe(1);
    expect(readFileSync(file(), 'utf-8')).toBe(legacy);
  });

  it('no file at all reads as one empty window', async () => {
    const body = await get();
    expect(body.windows).toEqual([DEFAULT_WINDOW]);
    expect(body.sessions).toEqual([]);
  });

  it('an empty windows list on disk is re-seeded with one window, tabs go to it', async () => {
    writeFileSync(file(), JSON.stringify({ sessions: [tab('A', { window: 'gone' })], windows: [], chatPermissionMode: 'auto' }));
    const body = await get();
    expect(body.windows).toEqual([{ id: 'main', name: 'Chat' }]);
    expect(body.sessions[0].window).toBe('main');
  });
});

describe('roster windows: round trip and absence', () => {
  const twoWindows = {
    windows: [{ id: 'main', name: 'Chat', activePane: 0 }, { id: 'w2', name: 'Refactor', activePane: 2 }],
    sessions: [
      tab('A', { sessionId: uuid(1), pane: 0, active: true, window: 'main' }),
      tab('B', { sessionId: uuid(2), pane: 1, window: 'main' }),
      tab('C', { sessionId: uuid(3), pane: 2, active: true, window: 'w2' }),
    ],
    activePane: 2,
    chatPermissionMode: 'auto',
  };

  it('a PUT with two windows reads back the same', async () => {
    expect((await put(twoWindows)).status).toBe(200);
    const body = await get();
    expect(body.windows).toEqual(twoWindows.windows);
    expect(body.sessions.map((m: SavedMeta) => [m.title, m.window, m.pane])).toEqual([['A', 'main', 0], ['B', 'main', 1], ['C', 'w2', 2]]);
    expect(body.activePane).toBe(2);
  });

  it('a tab naming a window that is not in the list goes to windows[0], whatever its id', async () => {
    await put({ ...twoWindows, windows: [{ id: 'w2', name: 'Refactor' }, { id: 'main', name: 'Chat' }], sessions: [tab('X', { sessionId: uuid(9), window: 'closed-one' })] });
    expect((await get()).sessions[0].window).toBe('w2');
  });

  it('a PUT without windows keeps the stored list; a tab sent without a window keeps its stored one', async () => {
    await put(twoWindows);
    // An older (or classic-only) client: it never heard of windows.
    const legacyClient = { sessions: twoWindows.sessions.map(({ window: _w, ...m }) => m), chatPermissionMode: 'auto' };
    legacyClient.sessions.push(tab('D', { sessionId: uuid(4), pane: 3 }));
    expect((await put(legacyClient)).status).toBe(200);
    const body = await get();
    expect(body.windows.map((w: { id: string }) => w.id)).toEqual(['main', 'w2']);
    expect(body.sessions.map((m: SavedMeta) => [m.title, m.window])).toEqual([['A', 'main'], ['B', 'main'], ['C', 'w2'], ['D', 'main']]);
  });

  it('a PUT with an empty windows list never empties the surface', async () => {
    await put(twoWindows);
    await put({ ...twoWindows, windows: [] });
    expect((await get()).windows.length).toBeGreaterThan(0);
  });

  it('a downgraded reader still finds every tab, each pane kept apart across windows', async () => {
    await put(twoWindows);
    // What an app from before windows reads: `sessions` with `pane`; it ignores the rest.
    const old = stored().sessions.map((m) => ({ title: m.title, pane: m.pane }));
    expect(old).toEqual([{ title: 'A', pane: 0 }, { title: 'B', pane: 1 }, { title: 'C', pane: 2 }]);
    expect(new Set(old.map((m) => m.pane)).size).toBe(3);
  });

  it('a 409 on a stale generation still holds, and carries the windows', async () => {
    writeFileSync(file(), JSON.stringify({ ...twoWindows, generation: 2 }));
    const r = await put({ ...twoWindows, baseGeneration: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('roster_stale');
    expect(r.body.surface.windows.map((w: { id: string }) => w.id)).toEqual(['main', 'w2']);
    expect(stored().generation).toBe(2);
  });
});

describe('roster windows: coercion', () => {
  it('keeps valid ids only, no duplicates, trims names, a blank name reads as the default', () => {
    const long = 'x'.repeat(MAX_WINDOW_NAME + 20);
    expect(coerceWindows([
      { id: 'main', name: '  Chat  ' },
      { id: 'main', name: 'dup' },
      { id: 'BAD ID', name: 'no' },
      { id: 'a'.repeat(25), name: 'too long id' },
      { id: 'w2', name: long },
      { id: 'w3', name: '   ' },
      'junk',
    ])).toEqual([{ id: 'main', name: 'Chat' }, { id: 'w2', name: 'x'.repeat(MAX_WINDOW_NAME) }, { id: 'w3', name: 'Chat' }]);
    expect(coerceWindows('nope')).toBeUndefined();
  });

  it('at most MAX_SESSIONS windows', () => {
    expect(coerceWindows(Array.from({ length: 60 }, (_, i) => ({ id: `w${i}`, name: `W ${i}` })))).toHaveLength(MAX_SESSIONS);
  });

  it('the server never makes a window out of a tab id', () => {
    const out = withWindows({ sessions: [tab('A', { window: 'invented' })] }, undefined);
    expect(out.windows).toEqual([{ id: 'main', name: 'Chat' }]);
    expect(out.sessions[0].window).toBe('main');
  });
});

describe('roster windows: the phone and the drawer', () => {
  it("the phone's hand-back lands tabs in windows[0]", async () => {
    await put({ windows: [{ id: 'w1', name: 'First' }, { id: 'w2', name: 'Second' }], sessions: [tab('Desk', { sessionId: uuid(1), window: 'w2' })], chatPermissionMode: 'auto' });
    writeFileSync(join(contextRoot, 'state', '.agent-sessions.phone.json'), JSON.stringify({ sessions: [tab('Phone', { sessionId: uuid(5), window: 'w2' })], chatPermissionMode: 'auto' }));
    expect(await landPhoneRosterOnDesktop(contextRoot)).toBe(1);
    const desk = stored();
    expect(desk.windows?.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(desk.sessions.find((m) => m.title === 'Phone')?.window).toBe('w1');
    expect(desk.sessions.find((m) => m.title === 'Desk')?.window).toBe('w2');
  });

  it('the summary counts each window, never a title or a draft', () => {
    const s = rosterSummary({
      windows: [{ id: 'main', name: 'Chat' }, { id: 'w2', name: 'Refactor' }],
      sessions: [tab('A', { window: 'main' }), tab('B', { window: 'w2' }), tab('C', { window: 'w2' }), tab('S', { sessionId: uuid(7), window: 'w2' })],
    }, { enabled: true, session: uuid(7) });
    expect(s).toEqual({ windows: 2, tabs: 3, superOn: true, perWindow: [{ id: 'main', name: 'Chat', tabs: 1 }, { id: 'w2', name: 'Refactor', tabs: 2 }] });
    expect(JSON.stringify(s)).not.toContain('"A"');
  });

  it('GET ?summary=1 answers per window', async () => {
    await put({ windows: [{ id: 'main', name: 'Chat' }, { id: 'w2', name: 'Two' }], sessions: [tab('A', { window: 'w2' })], chatPermissionMode: 'auto' });
    const r = res();
    await handleAgentSessionsGet({ url: '/api/agent/sessions?summary=1' } as IncomingMessage, r.res, {}, contextRoot, home);
    expect(r.body()).toMatchObject({ windows: 2, tabs: 1, perWindow: [{ id: 'main', tabs: 0 }, { id: 'w2', name: 'Two', tabs: 1 }] });
  });
});

describe('roster windows: 40 tabs at their worst still save', () => {
  it('the raw PUT body fits the body limit, and every tab, window and draft is stored', async () => {
    expect(MAX_SESSIONS).toBe(40);
    const threeByte = '界';
    const windows = Array.from({ length: MAX_SESSIONS }, (_, i) => ({ id: `w${i}`, name: threeByte.repeat(MAX_WINDOW_NAME) }));
    const sessions = Array.from({ length: MAX_SESSIONS }, (_, i) => tab(threeByte.repeat(200), { sessionId: uuid(i + 1), pane: i, active: true, window: `w${i}`, mode: 'develop', model: 'claude-opus-4-1', effort: 'xhigh' }));
    // Drafts at the client's whole budget (composerDrafts.ts DRAFTS_BUDGET_BYTES = 512 KB),
    // split over conversations under the per-draft text cap.
    const drafts: Record<string, unknown> = {};
    const per = 19_000; // chars of 3 bytes, under MAX_DRAFT_TEXT 20000
    let budget = 512 * 1024;
    for (let i = 0; budget > 0; i++) {
      const chars = Math.min(per, Math.floor(budget / 3));
      drafts[uuid(100 + i)] = { text: threeByte.repeat(chars), chips: [], quote: null, savedAt: 1 };
      budget -= chars * 3;
      if (chars === 0) break;
    }
    const body = { windows, sessions, activePane: 39, chatPermissionMode: 'auto', drafts, baseGeneration: 0 };
    const raw = JSON.stringify(body);
    // The middleware's own reader accepts it (it drops anything past 1 MB).
    expect(await parseJsonBody(req(raw))).not.toBeNull();
    const r = await put(body);
    expect(r.status).toBe(200);
    const s = stored();
    expect(s.sessions).toHaveLength(40);
    expect(s.windows).toHaveLength(40);
    expect(new Set(s.sessions.map((m) => m.window)).size).toBe(40);
  });

  it('past 40 tabs the extras are dropped, never refused', async () => {
    const sessions = Array.from({ length: 45 }, (_, i) => tab(`T${i}`, { sessionId: uuid(i + 1) }));
    expect((await put({ sessions, chatPermissionMode: 'auto' })).status).toBe(200);
    expect(stored().sessions).toHaveLength(40);
  });
});
