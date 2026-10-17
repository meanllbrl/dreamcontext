/**
 * The notch's conversation starts on first use, and an unchanged poll re-renders nothing
 * (task: the desktop app stays light on an 8GB MacBook Air — AC11, plan lane P3).
 *
 * Owner decision 3 (2026-10-17): the Assistant's `claude` child starts when the notch is first
 * used (hover, open, hotkey, a file drop), not at launch. The rules live in
 * `components/assistant/sessionStarter.ts` (pure) and are pinned here; the wiring in Notch.tsx
 * is pinned by reading the source (root vitest runs in plain Node, no React renderer).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSessionStarter, type StarterStatus } from '../../dashboard/src/components/assistant/sessionStarter';
import { FRESH_AFTER_IDLE_MS, createRawGate } from '../../dashboard/src/components/assistant/notchModel';

const NOW = 1_800_000_000_000;

interface Fake { id: string | null; lastActiveAt: number }

function rig(status: StarterStatus | (() => Promise<StarterStatus>)) {
  let session: Fake | null = null;
  const starts: Array<{ id: string | null; lastActiveAt: number }> = [];
  let reads = 0;
  const starter = createSessionStarter<Fake>({
    current: () => session,
    readStatus: () => { reads++; return typeof status === 'function' ? status() : Promise.resolve(status); },
    start: (id, lastActiveAt) => { starts.push({ id, lastActiveAt }); session = { id, lastActiveAt }; return session; },
    now: () => NOW,
  });
  return {
    starter, starts,
    reads: () => reads,
    set: (s: Fake | null) => { session = s; },
  };
}

const assistant = (lastActiveAt: number | null, conversationId: string | null = 'conv-1'): StarterStatus =>
  ({ exists: true, config: { conversationId }, lastActiveAt });

describe('sessionStarter: lazy start', () => {
  it('nothing starts until it is asked for (0 children at boot)', () => {
    const r = rig(assistant(NOW - 1_000));
    expect(r.starts).toEqual([]);
    expect(r.reads()).toBe(0);
  });

  it('the first use resumes the remembered conversation when it is recent', async () => {
    const r = rig(assistant(NOW - 60_000));
    const s = await r.starter.ensure();
    expect(r.starts).toEqual([{ id: 'conv-1', lastActiveAt: NOW - 60_000 }]);
    expect(s?.id).toBe('conv-1');
  });

  it('a conversation idle past the fresh threshold AT FIRST USE starts a fresh one', async () => {
    const r = rig(assistant(NOW - FRESH_AFTER_IDLE_MS));
    await r.starter.ensure();
    expect(r.starts).toEqual([{ id: null, lastActiveAt: NOW }]);
  });

  it('unknown activity resumes (an unknown idle is not a long one)', async () => {
    const r = rig(assistant(null));
    await r.starter.ensure();
    expect(r.starts).toEqual([{ id: 'conv-1', lastActiveAt: NOW }]);
  });

  it('a hover and an open in the same moment share ONE start', async () => {
    const r = rig(assistant(NOW - 1_000));
    const [a, b] = await Promise.all([r.starter.ensure(), r.starter.ensure()]);
    expect(r.reads()).toBe(1);
    expect(r.starts).toHaveLength(1);
    expect(a).toBe(b);
  });

  it('a live session is returned as it is: no read, no second start', async () => {
    const r = rig(assistant(NOW - 1_000));
    await r.starter.ensure();
    const again = await r.starter.ensure();
    expect(r.reads()).toBe(1);
    expect(r.starts).toHaveLength(1);
    expect(again?.id).toBe('conv-1');
  });

  it('a failed warm-up never blocks a later start (the shared promise is dropped on rejection)', async () => {
    let fail = true;
    const r = rig(() => (fail ? Promise.reject(new Error('server not up')) : Promise.resolve(assistant(NOW - 1_000))));
    await expect(r.starter.ensure()).rejects.toThrow('server not up');
    fail = false;
    const s = await r.starter.ensure();
    expect(r.reads()).toBe(2);
    expect(s?.id).toBe('conv-1');
  });

  it('no assistant configured: nothing starts, and a later call asks again', async () => {
    let st: StarterStatus = { exists: false, config: null };
    const r = rig(() => Promise.resolve(st));
    expect(await r.starter.ensure()).toBeNull();
    expect(r.starts).toEqual([]);
    st = assistant(NOW - 1_000);
    expect((await r.starter.ensure())?.id).toBe('conv-1');
  });

  it('a session started another way during the read wins (a conversation switch): no second session', async () => {
    let release!: (s: StarterStatus) => void;
    const r = rig(() => new Promise<StarterStatus>((res) => { release = res; }));
    const pending = r.starter.ensure();
    r.set({ id: 'picked', lastActiveAt: NOW });
    release(assistant(NOW - 1_000));
    expect((await pending)?.id).toBe('picked');
    expect(r.starts).toEqual([]);
  });
});

describe('the raw gate: an unchanged poll answer is skipped', () => {
  it('records each key\'s last answer; the same text again is not a change; forget lets the next one land', () => {
    const g = createRawGate();
    expect(g.changed('glance', '{"chats":[]}')).toBe(true);
    expect(g.changed('glance', '{"chats":[]}')).toBe(false);
    expect(g.changed('inbox', '{"chats":[]}')).toBe(true);
    expect(g.changed('glance', '{"chats":[1]}')).toBe(true);
    g.forget('glance');
    expect(g.changed('glance', '{"chats":[1]}')).toBe(true);
  });
});

describe('Notch.tsx wiring (source scan)', () => {
  const src = readFileSync(new URL('../../dashboard/src/components/assistant/Notch.tsx', import.meta.url), 'utf-8');
  const between = (a: string, b: string) => {
    const i = src.indexOf(a);
    expect(i, `${a} not found`).toBeGreaterThan(-1);
    const j = src.indexOf(b, i);
    expect(j, `${b} not found`).toBeGreaterThan(i);
    return src.slice(i, j);
  };

  it('boot reads the status but starts no conversation', () => {
    const load = between('const loadStatus = useCallback', '}, []);');
    expect(load).not.toMatch(/startSession\(|createChatSession\(/);
  });

  it('nothing else can start one: every start site is a first use, a switch or a resume', () => {
    // The boot test above only looks inside loadStatus; a mount effect anywhere else would have
    // passed it (end review, 2026-10-18). So pin EVERY call site: each must sit in one of these.
    const allowed = [
      between('const starter = useMemo(() => createSessionStarter', '}), [startSession]);'),
      between('// Opened before the status read landed', '}, [hasAssistant, expanded, session, ensureSession]);'),
      between('const onHoverIn = useCallback', '}, [ensureSession]);'),
      between('const expand = useCallback', 'const collapse = useCallback'),
      between('const onDrop = ', 'el.addEventListener'),
      between('const switchConversation = useCallback', '}, [startSession]);'),
      between('resumeChat: (cs) => {', 'changePermissionMode'),
      between("onClick={() => { setTab('chat');", '}}>'),
    ];
    const calls = (t: string) => (t.match(/\b(?:ensureSession|startSession)\(/g) ?? []).length;
    expect(calls(src)).toBeGreaterThanOrEqual(8);
    expect(calls(src)).toBe(allowed.reduce((n, t) => n + calls(t), 0));
    // ...and a session is built in only two places: startSession, and the rotation (the "new
    // conversation" button, or the idle timer, which never runs while there is no session yet).
    expect(src.match(/createChatSession\(/g)).toHaveLength(2);
    expect(between('const startSession = useCallback', '}, []);')).toMatch(/createChatSession\(/);
    expect(between('const rotateConversation = useCallback', '}, []);')).toMatch(/createChatSession\(/);
    expect(between('const timer = window.setInterval(() => {', 'rotateConversation();')).toMatch(/if \(!cs \|\|/);
  });

  it('every first use goes through ensureSession: hover warms it, the open starts it, a file drop sends through it', () => {
    expect(between('const onHoverIn = useCallback', '}, [ensureSession]);')).toMatch(/if \(hasAssistantRef\.current\) void ensureSession\(\);/);
    expect(between('const expand = useCallback', 'const collapse = useCallback')).toMatch(/ensureSession\(\)/);
    expect(between('const onDrop = ', 'el.addEventListener')).toMatch(/const s = await ensureSession\(\);/);
  });

  it('the Chat tab starts it too, and an open made before the status landed starts once it is known', () => {
    // A failed first start, or a hotkey open at launch (no assistant known yet), left the Chat
    // tab empty until the pointer re-entered the notch (end review, 2026-10-18).
    expect(src).toMatch(/onClick=\{\(\) => \{ setTab\('chat'\); void ensureSession\(\)/);
    const late = between('// Opened before the status read landed', '}, [hasAssistant, expanded, session, ensureSession]);');
    expect(late).toMatch(/if \(hasAssistant && expanded && !session\) void ensureSession\(\);/);
  });

  it('the start decides fresh-vs-resume through the shared starter, never a second session', () => {
    expect(src).toMatch(/createSessionStarter<ChatSession>\(\{/);
    expect(between('const ensureSession = useCallback', '[starter]')).toMatch(/starter\.ensure\(\)\.catch\(\(\) => null\)/);
  });

  it('the glance (3 s) and the inbox (4 s) keep their cadence and skip an unchanged answer', () => {
    const glance = between("fetch('/api/assistant/rollup')", 'setInterval(tick, 3000)');
    expect(glance).toMatch(/rawGate\.changed\('rollup', rollupText\)/);
    expect(glance).toMatch(/rawGate\.changed\('glance', text\)/);
    expect(glance).toMatch(/rawGate\.changed\('proposals', text\)/);
    const inbox = between("fetch('/api/assistant/inbox')", 'setInterval(tick, 4000)');
    expect(inbox).toMatch(/rawGate\.changed\('inbox', text\)/);
  });

  it('the seat guard\'s slow check runs every 5 s, not every second', () => {
    const guard = between('const check = () => { void guardHeal(); };', 'const unlisteners');
    expect(guard).toMatch(/setInterval\(check, 5000\)/);
  });
});
