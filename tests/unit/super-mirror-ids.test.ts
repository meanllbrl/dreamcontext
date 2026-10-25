/**
 * The hands-free phone's Super view survives a reload (end review 2026-10-23): the ids the phone
 * was told are a Super's conversation are kept in localStorage, so a restored tab or any other
 * way into that conversation is still a `superMirror` session (strips, groups, the ↩ chip).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
let store: Record<string, string> = {};

beforeEach(() => {
  store = {};
  vi.resetModules();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('superMirrorIds', () => {
  it('remembers an id and keeps it across a reload (a fresh module reads the store)', async () => {
    const a = await import('../../dashboard/src/components/sleepy/superMirrorIds');
    expect(a.isSuperMirrorId('conv-1')).toBe(false);
    a.rememberSuperMirrorIds(['conv-1']);
    expect(a.isSuperMirrorId('conv-1')).toBe(true);
    vi.resetModules();
    const b = await import('../../dashboard/src/components/sleepy/superMirrorIds');
    expect(b.isSuperMirrorId('conv-1')).toBe(true);
    expect(b.isSuperMirrorId('')).toBe(false);
  });

  it('a broken store reads as empty; it keeps at most 40, newest last', async () => {
    store['dreamcontext-super-mirror-ids'] = '{nope';
    const m = await import('../../dashboard/src/components/sleepy/superMirrorIds');
    expect(m.isSuperMirrorId('x')).toBe(false);
    m.rememberSuperMirrorIds(Array.from({ length: 45 }, (_, i) => `c${i}`));
    expect(m.isSuperMirrorId('c0')).toBe(false);
    expect(m.isSuperMirrorId('c44')).toBe(true);
    expect((JSON.parse(store['dreamcontext-super-mirror-ids']) as string[]).length).toBe(40);
  });

  it('the phone list feeds it from `live.supers`, the Super row\'s tap too, and every chat spawn reads it', () => {
    // The one list's data (W3) reads live-chats for the list and the chat screen alike.
    const list = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/usePhoneHome.ts'), 'utf-8');
    expect(list).toMatch(/rememberSuperMirrorIds\(\(wire\.supers \?\? \[\]\)\.map\(\(x\) => x\.conversationId\)\);/);
    const surface = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/AgentSurface.tsx'), 'utf-8');
    expect(surface).toMatch(/const mirror = mode !== 'super' && isSuperMirrorId\(cid\);/);
    expect(surface).toMatch(/rememberSuperMirrorIds\(\[row\.conversationId\]\);/);
  });
});
