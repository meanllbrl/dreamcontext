/**
 * The Super Agent's state file (plan-r7 D2): local-only, server-written, and read through a
 * sanitizer, because anyone with a shell can edit it and a widened record would widen what the
 * super agent's token reaches (D4b) or where server-run git goes (D12).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SUPER_STATE_REL, SuperStoreRefused, acceptableWorktree, clearSuperNote, isSuperChild, isSuperSessionId,
  peekSuperNote, primeSuperIndex, readSuperState, resetSuperIndex, sanitizeSuperState,
  superEntry, superOfChild, superOfSession, updateSuperState,
} from '../../src/lib/super/store.js';
import { emptySuperState, MAX_CONTAINERS } from '../../src/lib/super/types.js';
import { FULL_REPO_LOCAL_GITIGNORE_ENTRIES, buildBrainGitignore } from '../../src/lib/git-sync/brain-repo.js';

let dir: string;
let root: string;
let home: string;

beforeEach(() => {
  resetSuperIndex();
  dir = mkdtempSync(join(tmpdir(), 'super-store-'));
  root = join(dir, 'vault', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  home = join(dir, 'home');
  mkdirSync(join(home, '.claude-worktrees'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const raw = (over: Record<string, unknown> = {}) => ({ ...emptySuperState(), session: 'sess-super', enabled: true, ...over });
const child = (id: string, over: Record<string, unknown> = {}) => ({ sessionId: id, brief: 'b', adopted: true, startedAt: 1, ...over });

describe('the file is local-only', () => {
  it('is in both gitignore lists (brain folder and full-repo root)', () => {
    expect(buildBrainGitignore().split('\n')).toContain('state/.super-agent.json');
    expect(FULL_REPO_LOCAL_GITIGNORE_ENTRIES).toContain('_dream_context/state/.super-agent.json');
    expect(SUPER_STATE_REL).toBe(join('state', '.super-agent.json'));
  });
});

describe('read and write', () => {
  it('reads an absent file as the empty state', async () => {
    expect(await readSuperState(root)).toEqual(emptySuperState());
  });

  it('writes atomically (no temp file left), 0600, and reads back what it wrote', async () => {
    const written = await updateSuperState(root, (s) => {
      s.session = 'sess-super';
      s.enabled = true;
      s.children['c-1'] = { sessionId: 'c-1', brief: 'Fix login', adopted: true, startedAt: 10 };
    });
    expect(written.children['c-1'].brief).toBe('Fix login');
    expect(readdirSync(join(root, 'state')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(join(root, SUPER_STATE_REL)).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    expect(await readSuperState(root)).toEqual(written);
  });

  it('serializes concurrent updates per vault (none is lost)', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => updateSuperState(root, (s) => {
      s.queue.push({ id: `q-${i}`, sessionId: 'c-1', kind: 'done', state: 'pending', createdAt: i });
    })));
    expect((await readSuperState(root)).queue.map((q) => q.id).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `q-${i}`).sort());
  });

  it('refuses a symlinked state file, for reads and writes', async () => {
    const elsewhere = join(dir, 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify(raw()));
    symlinkSync(elsewhere, join(root, SUPER_STATE_REL));
    await expect(readSuperState(root)).rejects.toBeInstanceOf(SuperStoreRefused);
    await expect(updateSuperState(root, () => undefined)).rejects.toBeInstanceOf(SuperStoreRefused);
    expect(JSON.parse(readFileSync(elsewhere, 'utf-8')).session).toBe('sess-super');
  });

  it('refuses a state directory that resolves outside the vault', async () => {
    rmSync(join(root, 'state'), { recursive: true });
    mkdirSync(join(dir, 'outside'));
    symlinkSync(join(dir, 'outside'), join(root, 'state'));
    await expect(readSuperState(root)).rejects.toMatchObject({ reason: 'outside' });
  });

  it('a garbled file reads as the empty state (never a crash)', async () => {
    writeFileSync(join(root, SUPER_STATE_REL), '{ not json');
    expect(await readSuperState(root)).toEqual(emptySuperState());
  });
});

describe('hostile fields are dropped (D2)', () => {
  it('a worktree outside ~/.claude-worktrees, nested, relative or traversing is dropped with its branch', () => {
    const good = join(home, '.claude-worktrees', 'acme-login');
    for (const worktree of ['/etc', join(home, 'projects', 'x'), join(home, '.claude-worktrees'), join(home, '.claude-worktrees', 'a', 'b'),
      'relative/path', join(home, '.claude-worktrees', '..', 'x'), `${good}\u0000`]) {
      const s = sanitizeSuperState(raw({ children: { 'c-1': child('c-1', { worktree, branch: 'super/acme-login' }) } }), { home });
      expect(s.children['c-1'], worktree).toBeDefined();
      expect(s.children['c-1'].worktree, worktree).toBeUndefined();
      expect(s.children['c-1'].branch, worktree).toBeUndefined();
    }
    const kept = sanitizeSuperState(raw({ children: { 'c-1': child('c-1', { worktree: good, branch: 'super/acme-login' }) } }), { home });
    expect(kept.children['c-1']).toMatchObject({ worktree: good, branch: 'super/acme-login' });
  });

  it('a branch outside super/* is dropped with its worktree', () => {
    const worktree = join(home, '.claude-worktrees', 'acme-login');
    for (const branch of ['main', 'super/', 'super/../main', 'super/Upper', 'super/a b', '-c core.hooksPath=x', `super/${'a'.repeat(61)}`, 'refs/heads/super/x']) {
      const s = sanitizeSuperState(raw({ children: { 'c-1': child('c-1', { worktree, branch }) } }), { home });
      expect(s.children['c-1'].branch, branch).toBeUndefined();
      expect(s.children['c-1'].worktree, branch).toBeUndefined();
    }
  });

  it('a worktree git does not list is dropped when the listing is known', () => {
    const listed = join(home, '.claude-worktrees', 'listed');
    const unlisted = join(home, '.claude-worktrees', 'unlisted');
    const opts = { home, listedWorktrees: new Set([listed]) };
    expect(acceptableWorktree(listed, opts)).toBe(true);
    expect(acceptableWorktree(unlisted, opts)).toBe(false);
  });

  it('the super session is never its own child; other modes\' chats never become children', () => {
    const s = sanitizeSuperState(raw({
      children: { 'sess-super': child('sess-super'), 'c-asst': child('c-asst'), 'c-1': child('c-1'), 'bad id!': child('bad id!'), 'c-2': child('c-3') },
      notes: { 'sess-super': 'handover', 'c-1': 'handover', 'c-x': 'gossip' },
    }), { home, isExcludedChat: (id) => id === 'c-asst' });
    expect(Object.keys(s.children)).toEqual(['c-1']);
    expect(s.notes).toEqual({ 'c-1': 'handover' });
  });

  it('cards: unknown kinds dropped, ids unique, shape and place defaulted per kind, at most MAX_CONTAINERS (plan-r8 F1)', () => {
    const containers = [
      { id: 'a', kind: 'chat', ref: 'c-1', shape: 'square', place: 'others' },
      { id: 'a', kind: 'chat', ref: 'c-2', shape: 'tall', place: 'float' },
      { id: 'b', kind: 'movie', ref: 'x', shape: 'tall', place: 'float' },
      { id: 'c', kind: 'web', ref: 'https://example.com', shape: 'round', place: 'nowhere' },
      { id: 'd', kind: 'task', ref: 'my-task' },
      ...Array.from({ length: MAX_CONTAINERS + 8 }, (_, i) => ({ id: `n-${i}`, kind: 'insight', ref: `i-${i}`, shape: 'square', place: 'float' })),
    ];
    const s = sanitizeSuperState(raw({ containers }));
    expect(s.containers).toHaveLength(MAX_CONTAINERS);
    expect(s.containers.slice(0, 3)).toEqual([
      { id: 'a', kind: 'chat', ref: 'c-1', shape: 'square', place: 'others' },
      { id: 'c', kind: 'web', ref: 'https://example.com', shape: 'tall', place: 'float' },
      { id: 'd', kind: 'task', ref: 'my-task', shape: 'square', place: 'float' },
    ]);
  });

  it('jarvis r9: a browser card names a recorded child; `by` survives only as \'auto\'; dismissals expire and are capped', () => {
    const s = sanitizeSuperState(raw({
      children: { 'kid-1': child('kid-1') },
      containers: [
        { id: 'browser-a', kind: 'browser', ref: 'kid-1', shape: 'square', place: 'float', by: 'auto' },
        { id: 'browser-b', kind: 'browser', ref: 'stranger', shape: 'square', place: 'float' },
        { id: 'browser-c', kind: 'browser', ref: 'sess-super', shape: 'square', place: 'float' },
        { id: 'web-a', kind: 'web', ref: 'http://localhost:5173/', shape: 'tall', place: 'float', by: 'agent' },
      ],
      dismissed: [
        { kind: 'web', ref: 'http://localhost:5173/', until: 2_000 },
        { kind: 'web', ref: 'http://localhost:3000/', until: 500 },
        { kind: 'nope', ref: 'x', until: 2_000 },
        ...Array.from({ length: 60 }, (_, i) => ({ kind: 'browser', ref: `k-${i}`, until: 3_000 + i })),
      ],
    }), { now: 1_000 });
    expect(s.containers.map((c) => c.id)).toEqual(['browser-a', 'web-a']);
    expect(s.containers[0].by).toBe('auto');
    expect(s.containers[1].by).toBeUndefined();
    expect(s.dismissed).toHaveLength(50);
    expect(s.dismissed.some((d) => d.ref === 'http://localhost:3000/')).toBe(false);
    expect(s.dismissed.at(-1)).toEqual({ kind: 'browser', ref: 'k-59', until: 3_059 });
  });

  it('a record written for the r7 ring (sizes, regions, a focus flag) reads back as floating cards', () => {
    const s = sanitizeSuperState(raw({ containers: [
      { id: 'a', kind: 'chat', ref: 'c-1', size: 'M', region: 'left', focus: true },
      { id: 'b', kind: 'image', ref: 'docs/a.png', size: 'XL', region: 'top' },
    ] }));
    expect(s.containers).toEqual([
      { id: 'a', kind: 'chat', ref: 'c-1', shape: 'tall', place: 'float' },
      { id: 'b', kind: 'image', ref: 'docs/a.png', shape: 'square', place: 'float' },
    ]);
    expect(s.view).toEqual({ mode: 'float' });
  });

  it('a drop position needs two finite numbers and is clamped into [0, 1]', () => {
    const s = sanitizeSuperState(raw({ containers: [
      { id: 'a', kind: 'task', ref: 't-a', pos: { x: 0.25, y: 0.5 } },
      { id: 'b', kind: 'task', ref: 't-b', pos: { x: -3, y: 7 } },
      { id: 'c', kind: 'task', ref: 't-c', pos: { x: 'left', y: 0.1 } },
      { id: 'd', kind: 'task', ref: 't-d', pos: { x: Number.NaN, y: 0.1 } },
      { id: 'e', kind: 'task', ref: 't-e', pos: [0.1, 0.2] },
    ] }));
    expect(s.containers.map((c) => c.pos)).toEqual([{ x: 0.25, y: 0.5 }, { x: 0, y: 1 }, undefined, undefined, undefined]);
  });

  it('the view names only cards the record holds; otherwise it is the floating stage', () => {
    const cards = [{ id: 'a', kind: 'task', ref: 't-a' }, { id: 'b', kind: 'task', ref: 't-b' }];
    expect(sanitizeSuperState(raw({ containers: cards, view: { mode: 'half', card: 'b' } })).view).toEqual({ mode: 'half', card: 'b' });
    expect(sanitizeSuperState(raw({ containers: cards, view: { mode: 'half', card: 'gone' } })).view).toEqual({ mode: 'float' });
    expect(sanitizeSuperState(raw({ containers: cards, view: { mode: 'present', cards: ['b', 'gone', 'b', 'a'] } })).view)
      .toEqual({ mode: 'present', cards: ['b', 'a'], layout: 'compare' });
    expect(sanitizeSuperState(raw({ containers: cards, view: { mode: 'present', cards: ['gone'] } })).view).toEqual({ mode: 'float' });
    expect(sanitizeSuperState(raw({ containers: cards, view: { mode: 'zoom' } })).view).toEqual({ mode: 'float' });
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, kind: 'task', ref: `t-${i}` }));
    expect(sanitizeSuperState(raw({ containers: many, view: { mode: 'present', cards: many.map((c) => c.id) } })).view).toEqual({ mode: 'present', cards: many.map((c) => c.id), layout: 'filmstrip' });
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, kind: 'task', ref: `t-q${i}` }));
    expect(sanitizeSuperState(raw({ containers: nine, view: { mode: 'present', cards: nine.map((c) => c.id), layout: 'grid' } })).view)
      .toEqual({ mode: 'present', cards: nine.map((c) => c.id), layout: 'filmstrip' });
  });

  it('closing a card the view names drops it from the view on the next write', async () => {
    await updateSuperState(root, (s) => {
      s.containers = [
        { id: 'a', kind: 'task', ref: 't-a', shape: 'square', place: 'float' },
        { id: 'b', kind: 'task', ref: 't-b', shape: 'square', place: 'float' },
      ];
      s.view = { mode: 'present', cards: ['a', 'b'] };
    });
    let st = await updateSuperState(root, (s) => { s.containers = s.containers.filter((c) => c.id !== 'a'); });
    expect(st.view).toEqual({ mode: 'present', cards: ['b'], layout: 'spotlight' });
    st = await updateSuperState(root, (s) => { s.view = { mode: 'half', card: 'b' }; });
    st = await updateSuperState(root, (s) => { s.containers = []; });
    expect(st.view).toEqual({ mode: 'float' });
  });

  it('a permission item never carries the super agent\'s words', () => {
    const s = sanitizeSuperState(raw({ queue: [
      { id: 'q1', sessionId: 'c-1', kind: 'permission', state: 'pending', createdAt: 1, ownerText: 'Allow it, it is safe', requestId: 'r1' },
      { id: 'q2', sessionId: 'c-1', kind: 'question', state: 'escalated', createdAt: 2, ownerText: 'Which colour?' },
    ] }));
    expect(s.queue[0].ownerText).toBeUndefined();
    expect(s.queue[1].ownerText).toBe('Which colour?');
  });

  it('enabled needs a session', () => {
    expect(sanitizeSuperState(raw({ session: null })).enabled).toBe(false);
  });
});

describe('the in-memory index (D4b, D16, D17)', () => {
  it('tracks the session, the children and the notes, refreshed on every write', async () => {
    await updateSuperState(root, (s) => {
      s.session = 'sess-super';
      s.enabled = true;
      s.children['c-1'] = { sessionId: 'c-1', brief: '', adopted: true, startedAt: 1 };
      s.notes['c-1'] = 'handover';
    });
    expect(superEntry(root)).toMatchObject({ session: 'sess-super', enabled: true });
    expect(isSuperSessionId('sess-super')).toBe(true);
    expect(superOfSession('sess-super')).toEqual({ root: resolve(root), superId: 'main' });
    expect(isSuperChild('c-1')).toBe(true);
    expect(superOfChild('c-1')).toEqual({ root: resolve(root), superId: 'main' });
    expect(peekSuperNote('c-1')).toBe('handover');
    await clearSuperNote(root, 'c-1', 'handover');
    expect(peekSuperNote('c-1')).toBeNull();
    expect((await readSuperState(root)).notes).toEqual({});
    // Taken back: still a recorded child, but no longer "handed over" — the owner is pinged again.
    await updateSuperState(root, (s) => { s.enabled = false; });
    expect(isSuperChild('c-1')).toBe(false);
    expect(superOfChild('c-1')).toEqual({ root: resolve(root), superId: 'main' });
  });

  // Review W1 Major: a read takes no lock, so it can start before a write and finish after it
  // holding the OLD record. It must never put that record back into memory.
  async function raceSlowRead(during: () => Promise<void>) {
    const real = fsp.readFile.bind(fsp);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
      const text = await real(...args);
      if (first) { first = false; await gate; }
      return text;
    }) as typeof fsp.readFile);
    try {
      const slow = readSuperState(root);
      await new Promise((r) => setTimeout(r, 20));
      await during();
      release();
      return await slow;
    } finally { spy.mockRestore(); }
  }

  it('a read that started before Take back cannot put enabled:true back in memory', async () => {
    await updateSuperState(root, (s) => {
      s.session = 'sess-super'; s.enabled = true;
      s.children['c-1'] = { sessionId: 'c-1', brief: '', adopted: true, startedAt: 1 };
    });
    const stale = await raceSlowRead(async () => {
      await updateSuperState(root, (s) => { s.enabled = false; s.notes['c-1'] = 'takeback'; });
    });
    expect(stale.enabled).toBe(true); // the read really did see the old record
    expect(isSuperChild('c-1')).toBe(false);
    expect(peekSuperNote('c-1')).toBe('takeback');
  });

  it('a read that started before a note was cleared cannot put the note back', async () => {
    await updateSuperState(root, (s) => {
      s.session = 'sess-super'; s.enabled = true;
      s.children['c-1'] = { sessionId: 'c-1', brief: '', adopted: true, startedAt: 1 };
      s.notes['c-1'] = 'handover';
    });
    const stale = await raceSlowRead(() => clearSuperNote(root, 'c-1', 'handover'));
    expect(stale.notes['c-1']).toBe('handover');
    expect(peekSuperNote('c-1')).toBeNull();
  });

  // Review W1 round 2: a read that STARTS after the in-memory clear, before its persist lands.
  it('a read that starts while a clear is persisting cannot put the note back', async () => {
    await updateSuperState(root, (s) => {
      s.session = 'sess-super'; s.enabled = true;
      s.children['c-1'] = { sessionId: 'c-1', brief: '', adopted: true, startedAt: 1 };
      s.notes['c-1'] = 'handover';
    });
    const real = fsp.readFile.bind(fsp);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
      const text = await real(...args);
      if (first) { first = false; await gate; } // hold the clear's own locked load
      return text;
    }) as typeof fsp.readFile);
    try {
      const clear = clearSuperNote(root, 'c-1', 'handover');
      await new Promise((r) => setTimeout(r, 20));
      const during = await readSuperState(root); // starts and finishes inside the window
      expect(during.notes['c-1']).toBe('handover'); // disk still had it
      expect(peekSuperNote('c-1')).toBeNull();
      release();
      await clear;
    } finally { spy.mockRestore(); }
    expect(peekSuperNote('c-1')).toBeNull();
    expect((await readSuperState(root)).notes).toEqual({});
  });

  it('a clear removes only the note it delivered: a take-back note written meanwhile stays', async () => {
    await updateSuperState(root, (s) => {
      s.session = 'sess-super'; s.enabled = true;
      s.children['c-1'] = { sessionId: 'c-1', brief: '', adopted: true, startedAt: 1 };
      s.notes['c-1'] = 'handover';
    });
    // Take back is queued on the vault lock FIRST, so its write lands before the clear's.
    const takeBack = updateSuperState(root, (s) => { s.enabled = false; s.notes['c-1'] = 'takeback'; });
    const clear = clearSuperNote(root, 'c-1', 'handover');
    await Promise.all([takeBack, clear]);
    expect((await readSuperState(root)).notes).toEqual({ 'c-1': 'takeback' });
    expect(peekSuperNote('c-1')).toBe('takeback');
  });

  // Review W1 round 3: a LOCKED write that loaded the note before the clear's persist ran.
  it('a write queued ahead of the clear\'s persist cannot put the note back', async () => {
    await updateSuperState(root, (s) => {
      s.session = 'sess-super'; s.enabled = true;
      s.children['c-1'] = { sessionId: 'c-1', brief: '', adopted: true, startedAt: 1 };
      s.notes['c-1'] = 'handover';
    });
    let afterPush: string | null = 'unset';
    const push = updateSuperState(root, (s) => {
      s.queue.push({ id: 'q-1', sessionId: 'c-1', kind: 'idle', state: 'pending', createdAt: 1 });
    }).then(() => { afterPush = peekSuperNote('c-1'); });
    const clear = clearSuperNote(root, 'c-1', 'handover');
    await Promise.all([push, clear]);
    expect(afterPush).toBeNull();
    expect(peekSuperNote('c-1')).toBeNull();
    expect((await readSuperState(root)).notes).toEqual({});
  });

  it('two overlapping clears: the second note is never re-shown by the first clear\'s persist', async () => {
    await updateSuperState(root, (s) => {
      s.session = 'sess-super'; s.enabled = true;
      s.children['c-1'] = { sessionId: 'c-1', brief: '', adopted: true, startedAt: 1 };
      s.notes['c-1'] = 'handover';
    });
    const seen: Array<string | null> = [];
    // Take back takes the vault lock FIRST; clear A's persist queues behind it.
    const takeBack = updateSuperState(root, (s) => { s.enabled = false; s.notes['c-1'] = 'takeback'; })
      .then(() => { seen.push(peekSuperNote('c-1')); });
    const clearA = clearSuperNote(root, 'c-1', 'handover').then(() => { seen.push(peekSuperNote('c-1')); });
    await takeBack;
    // The take-back note rides the next message: B delivers it while A's persist is still queued.
    const clearB = clearSuperNote(root, 'c-1', 'takeback');
    await clearA;
    await clearB;
    expect(seen).toEqual(['takeback', null]);
    expect(peekSuperNote('c-1')).toBeNull();
    expect((await readSuperState(root)).notes).toEqual({});
  });

  it('a read with no write meanwhile still refreshes the index (a hand edit is seen)', async () => {
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify(raw({ children: { 'c-7': child('c-7') } })));
    await readSuperState(root);
    expect(isSuperChild('c-7')).toBe(true);
  });

  it('is primed at boot; a refused vault is indexed as off', async () => {
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify(raw({ children: { 'c-9': child('c-9') } })));
    const bad = join(dir, 'bad', '_dream_context');
    mkdirSync(join(bad, 'state'), { recursive: true });
    symlinkSync(join(root, SUPER_STATE_REL), join(bad, SUPER_STATE_REL));
    await primeSuperIndex([root, bad]);
    expect(isSuperChild('c-9')).toBe(true);
    expect(superEntry(bad)).toMatchObject({ session: null, enabled: false });
  });
});

describe('reserved ids (security minor)', () => {
  it('`__proto__`, `constructor` and `prototype` never load as a session, child, note or queue owner', async () => {
    const { sanitizeSuperState: sanitize } = await import('../../src/lib/super/store.js');
    const raw = JSON.parse(JSON.stringify({ v: 1, session: '__proto__', enabled: true, containers: [], queue: [], away: { since: null, events: 0 } }));
    raw.children = JSON.parse('{"__proto__":{"sessionId":"__proto__","brief":"x","adopted":true,"startedAt":1},"constructor":{"sessionId":"constructor","brief":"x","adopted":true,"startedAt":1},"ok":{"sessionId":"ok","brief":"","adopted":true,"startedAt":1}}');
    raw.notes = JSON.parse('{"__proto__":"handover","prototype":"takeback","ok":"handover"}');
    raw.queue = [{ id: 'q-1', sessionId: 'constructor', kind: 'idle', state: 'pending', createdAt: 1 }];
    const s = sanitize(raw);
    expect(s.session).toBeNull();
    expect(s.enabled).toBe(false);
    expect(Object.keys(s.children)).toEqual(['ok']);
    expect(Object.keys(s.notes)).toEqual(['ok']);
    expect(s.queue).toEqual([]);
    expect((Object.prototype as Record<string, unknown>).brief).toBeUndefined();
  });

  it('keeps a queue item\'s attempt count (M1), bounded', async () => {
    const { sanitizeSuperState: sanitize } = await import('../../src/lib/super/store.js');
    const s = sanitize({ v: 1, session: 's', enabled: false, containers: [], children: {}, notes: {}, away: { since: null, events: 0 },
      queue: [{ id: 'q-1', sessionId: 'c', kind: 'question', requestId: 'r', state: 'pending', createdAt: 1, attempts: 1 },
        { id: 'q-2', sessionId: 'c', kind: 'question', requestId: 'r2', state: 'pending', createdAt: 2, attempts: -3 }] });
    expect(s.queue[0].attempts).toBe(1);
    expect(s.queue[1].attempts).toBeUndefined();
  });
});

describe('uye-bildirim W4: own items, refusals, stalls and routine items survive only well formed', () => {
  const item = (over: Record<string, unknown>) => ({ id: 'q1', sessionId: 'c-1', state: 'escalated', createdAt: 1, ...over });
  const fact = { tool: 'Bash', input: 'node scripts/build.mjs', whole: true, source: 'classifier', category: 'interfere_with_workloads', reason: 'blocked' };

  it('a refusal wait keeps its fact; a refusal with no readable fact is dropped with its item', () => {
    const s = sanitizeSuperState(raw({ queue: [
      item({ id: 'q1', kind: 'owner', wait: { kind: 'refusal', id: 'rf-0123456789abcdef', key: 'Bash', refusal: fact } }),
      item({ id: 'q2', kind: 'owner', wait: { kind: 'refusal', id: 'rf-1' } }),
      item({ id: 'q3', kind: 'owner', wait: { kind: 'refusal', id: 'rf-2', refusal: { ...fact, tool: 'bad tool name!' } } }),
      item({ id: 'q4', kind: 'owner', wait: { kind: 'stalled', id: 'st-req-1' } }),
    ] }));
    expect(s.queue.map((q) => q.id)).toEqual(['q1', 'q4']);
    expect(s.queue[0].wait).toEqual({ kind: 'refusal', id: 'rf-0123456789abcdef', key: 'Bash', refusal: fact });
    expect(s.queue[1].wait).toEqual({ kind: 'stalled', id: 'st-req-1' });
  });

  it('a refusal fact is capped: an over-long input is cut and never whole; an unknown source reads unknown; a bad sha drops', () => {
    const long = 'x'.repeat(16_010);
    const s = sanitizeSuperState(raw({ queue: [
      item({ kind: 'owner', wait: { kind: 'refusal', id: 'rf-a', refusal: { tool: 'Bash', input: long, whole: true, source: 'martian', reason: `a\u0000b${'r'.repeat(400)}`, scriptSha: 'nothex', category: 'two words' } } }),
    ] }));
    const r = s.queue[0].wait?.refusal;
    expect(r?.input.length).toBe(16_000);
    expect(r?.whole).toBe(false);
    expect(r?.source).toBe('unknown');
    expect(r?.reason?.length).toBeLessThanOrEqual(300);
    expect(r?.reason).not.toMatch(/\u0000/);
    expect(r?.scriptSha).toBeUndefined();
    expect(r?.category).toBeUndefined();
  });

  it('a refusal fact rides only a refusal wait', () => {
    const s = sanitizeSuperState(raw({ queue: [item({ kind: 'owner', wait: { kind: 'run', id: 'login', key: 'gcloud auth login', refusal: fact } })] }));
    expect(s.queue[0].wait).toEqual({ kind: 'run', id: 'login', key: 'gcloud auth login' });
  });

  it('`own` stays only on a question, permission or owner item of the record\'s own session', () => {
    const s = sanitizeSuperState(raw({ queue: [
      item({ id: 'q1', sessionId: 'sess-super', kind: 'question', own: true }),
      item({ id: 'q2', sessionId: 'sess-super', kind: 'owner', own: true, wait: { kind: 'stalled', id: 'st-r1' } }),
      item({ id: 'q3', sessionId: 'c-1', kind: 'question', own: true }),
      item({ id: 'q4', sessionId: 'sess-super', kind: 'done', own: true }),
    ] }));
    expect(s.queue.map((q) => [q.id, q.own ?? null])).toEqual([['q1', true], ['q2', true], ['q3', null], ['q4', null]]);
  });

  it('a routine item needs its routine and its fact; member and the rang-once mark ride along', () => {
    const s = sanitizeSuperState(raw({ queue: [
      item({ id: 'r1', sessionId: 'sess-super', kind: 'routine', routine: 'daily-report', fact: 'run:2026-11-10T09:00:00.000Z', member: 'rota', ownerText: 'Daily report waits for approval', shown: true }),
      item({ id: 'r2', sessionId: 'sess-super', kind: 'routine', routine: 'daily-report' }),
      item({ id: 'r3', sessionId: 'sess-super', kind: 'routine', fact: 'run:1' }),
      item({ id: 'r4', sessionId: 'sess-super', kind: 'routine', routine: '../x', fact: 'run:1' }),
      item({ id: 'r5', sessionId: 'sess-super', kind: 'routine', routine: 'daily-report', fact: 'has spaces' }),
      item({ id: 'r6', sessionId: 'sess-super', kind: 'question', routine: 'daily-report', fact: 'run:1', shown: true }),
    ] }));
    expect(s.queue.map((q) => q.id)).toEqual(['r1', 'r6']);
    expect(s.queue[0]).toMatchObject({ kind: 'routine', routine: 'daily-report', fact: 'run:2026-11-10T09:00:00.000Z', member: 'rota', ownerText: 'Daily report waits for approval', shown: true });
    expect(s.queue[1].routine).toBeUndefined();
    expect(s.queue[1].fact).toBeUndefined();
    expect(s.queue[1].shown).toBeUndefined();
  });

  it('a grant offer: known sizes only, deduped, at most three; one-line texts capped; the rule capped; no size, no offer', () => {
    const offer = { sizes: ['job', 'once', 'job', 'forever', 'member', 7], onceOnlyReason: `pushes\noutward ${'r'.repeat(400)}`, notChecked: 'what it loads \u202e is not checked', rule: 'x'.repeat(16_050) };
    const s = sanitizeSuperState(raw({ queue: [
      item({ id: 'p1', kind: 'permission', requestId: 'r1', offer }),
      item({ id: 'p2', kind: 'permission', requestId: 'r2', offer: { sizes: ['forever'] } }),
      item({ id: 'p3', kind: 'owner', wait: { kind: 'refusal', id: 'rf-a', refusal: fact }, offer: { sizes: ['once'] } }),
      item({ id: 'p4', kind: 'owner', wait: { kind: 'run', id: 'login', key: 'gcloud auth login' }, offer: { sizes: ['once'] } }),
      item({ id: 'p5', sessionId: 'sess-super', kind: 'member', member: 'rota', answers: 'q-9', of: 'permission', offer: { sizes: ['member'] } }),
      item({ id: 'p6', sessionId: 'sess-super', kind: 'member', member: 'rota', answers: 'q-8', of: 'ask', offer: { sizes: ['once'] } }),
      item({ id: 'p7', kind: 'question', offer: { sizes: ['once'] } }),
    ] }));
    const by = (id: string) => s.queue.find((q) => q.id === id);
    const o = by('p1')?.offer;
    expect(o?.sizes).toEqual(['job', 'once', 'member']);
    expect(o?.onceOnlyReason).not.toMatch(/\n/);
    expect(o?.onceOnlyReason?.length).toBe(300);
    // Bidi and control characters stay as text: the surfaces escape what they draw.
    expect(o?.notChecked).toBe('what it loads \u202e is not checked');
    expect(o?.rule?.length).toBe(16_000);
    expect(by('p2')?.offer).toBeUndefined();
    expect(by('p3')?.offer).toEqual({ sizes: ['once'] });
    expect(by('p4')?.offer).toBeUndefined();
    expect(by('p5')?.offer).toEqual({ sizes: ['member'] });
    expect(by('p6')?.offer).toBeUndefined();
    expect(by('p7')?.offer).toBeUndefined();
  });

  it('a nudge item is a plain queue item', () => {
    const s = sanitizeSuperState(raw({ queue: [item({ sessionId: 'sess-super', kind: 'nudge', state: 'pending' })] }));
    expect(s.queue[0]).toMatchObject({ kind: 'nudge', state: 'pending' });
  });
});

// The dashboard answers a member's item in place only after it showed the call whole (G2), so the
// mirror must carry what the member's item holds: the permission's call, the refusal's wait.
describe('uye-bildirim w5-D: a member mirror carries the call and the wait a surface must show', () => {
  const item = (over: Record<string, unknown>) => ({ id: 'q1', sessionId: 'c-1', state: 'escalated', createdAt: 1, ...over });
  const mirror = (over: Record<string, unknown>) => item({ sessionId: 'sess-super', kind: 'member', member: 'rota', answers: 'q-9', ...over });
  const fact = { tool: 'Bash', input: 'node scripts/build.mjs', whole: true, source: 'classifier', reason: 'blocked' };
  const call = { tool: 'Bash', input: 'node scripts/build.mjs --fast', whole: true };

  it('a permission and its mirror keep a well-formed call; no other kind or mirror does', () => {
    const s = sanitizeSuperState(raw({ queue: [
      item({ id: 'c1', kind: 'permission', requestId: 'r1', call }),
      mirror({ id: 'c2', of: 'permission', call }),
      mirror({ id: 'c3', of: 'ask', call }),
      mirror({ id: 'c4', of: 'owner', call, wait: { kind: 'refusal', id: 'rf-a', refusal: fact } }),
      item({ id: 'c5', kind: 'question', call }),
      item({ id: 'c6', kind: 'owner', wait: { kind: 'run', id: 'login', key: 'gcloud auth login' }, call }),
    ] }));
    const by = (id: string) => s.queue.find((q) => q.id === id);
    expect(by('c1')?.call).toEqual(call);
    expect(by('c2')?.call).toEqual(call);
    for (const id of ['c3', 'c4', 'c5', 'c6']) expect(by(id)?.call, id).toBeUndefined();
  });

  it('a call is dropped when malformed, cut and never whole when long, and whole only when the server said so', () => {
    const long = 'x'.repeat(16_010);
    const s = sanitizeSuperState(raw({ queue: [
      item({ id: 'b1', kind: 'permission', requestId: 'r1', call: { tool: 'bad tool name!', input: 'ls', whole: true } }),
      item({ id: 'b2', kind: 'permission', requestId: 'r2', call: { tool: 'Bash', input: 42, whole: true } }),
      item({ id: 'b3', kind: 'permission', requestId: 'r3', call: 'rm -rf /' }),
      mirror({ id: 'b4', answers: 'q-4', of: 'permission', call: { tool: 'Bash', input: long, whole: true } }),
      mirror({ id: 'b5', answers: 'q-5', of: 'permission', call: { tool: 'Bash', input: 'ls' } }),
      mirror({ id: 'b6', answers: 'q-6', of: 'permission', call: { tool: 'Bash', input: 'ls', whole: 'yes' } }),
    ] }));
    const by = (id: string) => s.queue.find((q) => q.id === id);
    // A bad call drops the call, never the item: the surface then offers Open only.
    expect(s.queue.map((q) => q.id)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
    for (const id of ['b1', 'b2', 'b3']) expect(by(id)?.call, id).toBeUndefined();
    expect(by('b4')?.call?.input.length).toBe(16_000);
    expect(by('b4')?.call?.whole).toBe(false);
    expect(by('b5')?.call).toEqual({ tool: 'Bash', input: 'ls', whole: false });
    expect(by('b6')?.call?.whole).toBe(false);
  });

  it('a mirror of an owner item keeps its wait, refusal fact included, through the same checks as the item', () => {
    const long = 'y'.repeat(16_010);
    const s = sanitizeSuperState(raw({ queue: [
      mirror({ id: 'w1', answers: 'q-1', of: 'owner', wait: { kind: 'refusal', id: 'rf-0123456789abcdef', key: 'Bash', refusal: fact } }),
      mirror({ id: 'w2', answers: 'q-2', of: 'owner', wait: { kind: 'run', id: 'login', key: 'gcloud auth login' } }),
      mirror({ id: 'w3', answers: 'q-3', of: 'owner', wait: { kind: 'refusal', id: 'rf-1' } }),
      mirror({ id: 'w4', answers: 'q-4', of: 'owner' }),
      mirror({ id: 'w5', answers: 'q-5', of: 'owner', wait: { kind: 'refusal', id: 'rf-b', refusal: { ...fact, input: long } } }),
      mirror({ id: 'w6', answers: 'q-6', of: 'permission', wait: { kind: 'refusal', id: 'rf-c', refusal: fact } }),
    ] }));
    const by = (id: string) => s.queue.find((q) => q.id === id);
    expect(by('w1')?.wait).toEqual({ kind: 'refusal', id: 'rf-0123456789abcdef', key: 'Bash', refusal: fact });
    expect(by('w2')?.wait).toEqual({ kind: 'run', id: 'login', key: 'gcloud auth login' });
    // A mirror whose wait does not read stays (an older record): it is drawn as Open, without a wait.
    expect(by('w3')).toBeDefined();
    expect(by('w3')?.wait).toBeUndefined();
    expect(by('w4')?.wait).toBeUndefined();
    expect(by('w5')?.wait?.refusal?.input.length).toBe(16_000);
    expect(by('w5')?.wait?.refusal?.whole).toBe(false);
    expect(by('w6')?.wait).toBeUndefined();
  });

  it('`allowed` is a known size, kept only on what can be allowed and on its mirror', () => {
    const s = sanitizeSuperState(raw({ queue: [
      item({ id: 'a1', kind: 'permission', requestId: 'r1', allowed: 'once' }),
      item({ id: 'a2', kind: 'owner', wait: { kind: 'refusal', id: 'rf-a', refusal: fact }, allowed: 'job' }),
      mirror({ id: 'a3', answers: 'q-3', of: 'owner', wait: { kind: 'refusal', id: 'rf-a', refusal: fact }, allowed: 'member' }),
      mirror({ id: 'a4', answers: 'q-4', of: 'permission', allowed: 'once' }),
      item({ id: 'a5', kind: 'permission', requestId: 'r5', allowed: 'forever' }),
      item({ id: 'a6', kind: 'owner', wait: { kind: 'run', id: 'login', key: 'gcloud auth login' }, allowed: 'once' }),
      mirror({ id: 'a7', answers: 'q-7', of: 'owner', allowed: 'once' }),
      mirror({ id: 'a8', answers: 'q-8', of: 'ask', allowed: 'once' }),
      item({ id: 'a9', kind: 'question', allowed: 'once' }),
    ] }));
    const by = (id: string) => s.queue.find((q) => q.id === id);
    expect(by('a1')?.allowed).toBe('once');
    expect(by('a2')?.allowed).toBe('job');
    expect(by('a3')?.allowed).toBe('member');
    expect(by('a4')?.allowed).toBe('once');
    for (const id of ['a5', 'a6', 'a7', 'a8', 'a9']) expect(by(id)?.allowed, id).toBeUndefined();
  });

  it('a mirror keeps an offer only for a permission or a refusal, never for a sign-in card', () => {
    const s = sanitizeSuperState(raw({ queue: [
      mirror({ id: 'o1', answers: 'q-1', of: 'permission', offer: { sizes: ['once', 'member'] } }),
      mirror({ id: 'o2', answers: 'q-2', of: 'owner', wait: { kind: 'refusal', id: 'rf-a', refusal: fact }, offer: { sizes: ['once'], onceOnlyReason: 'classified' } }),
      mirror({ id: 'o3', answers: 'q-3', of: 'owner', wait: { kind: 'run', id: 'login', key: 'gcloud auth login' }, offer: { sizes: ['once'] } }),
      mirror({ id: 'o4', answers: 'q-4', of: 'owner', offer: { sizes: ['once'] } }),
      mirror({ id: 'o5', answers: 'q-5', of: 'question', offer: { sizes: ['once'] } }),
    ] }));
    const by = (id: string) => s.queue.find((q) => q.id === id);
    expect(by('o1')?.offer).toEqual({ sizes: ['once', 'member'] });
    expect(by('o2')?.offer).toEqual({ sizes: ['once'], onceOnlyReason: 'classified' });
    for (const id of ['o3', 'o4', 'o5']) expect(by(id)?.offer, id).toBeUndefined();
  });
});
