/**
 * Unit tests for coerceAgentSettings — the blob→settings normalizer shared (in shape)
 * by the dashboard and the server's agent-ui.json persistence (src/server/routes/
 * launcher.ts's own coerceAgentSettings is module-private, so this file exercises the
 * dashboard side only; the two are kept in lockstep by applying the identical rule per
 * field — verified by inspection, same convention as the existing renderer/chatView
 * coverage below). Focus: the `renderer` field added for the GPU/comfort terminal
 * toggle and the `chatView` field added for the Agent Chat view (beta) — task_nQb0y85X.
 * Contract for both: the default (webgl / Chat) applies whenever the key is absent or
 * garbage, and ONLY the documented explicit opt-out value flips it, so an old persisted
 * blob without the key never silently changes behavior.
 *
 * `chatView` is the one field with a MIGRATION on top of that contract: Chat became the
 * standard Agent screen in 0.22, and every blob written before then carries a
 * `chatView:false` that came from the old opt-in default rather than from a user's
 * choice — so an explicit `false` is honoured only on a `screenMigrated` blob.
 *
 * `chatPermissionMode` USED to be a field of this blob and is now a per-vault value with
 * its own accessors — a permission gate cannot be shared by every project living in one
 * window. Its old coercion contract ("only an exact 'bypass' opts in") is unchanged and is
 * asserted at the bottom of this file against `readChatPermissionMode`, alongside the
 * isolation and legacy-drop rules that are new. `localStorage` is shimmed in-memory here
 * for the same reason as in `scoped-storage.test.ts`: root vitest runs under plain Node.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  coerceAgentSettings, DEFAULT_AGENT_SETTINGS,
  readChatPermissionMode, writeChatPermissionMode,
  CHAT_PERMISSION_MODE_KEY, CHAT_PERMISSION_MODE_EVENT,
} from '../../dashboard/src/lib/agentSettings.js';
import { SCOPE_PREFIX } from '../../dashboard/src/lib/scopedStorage.js';

function makeLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  } as unknown as Storage;
}

// `scopedStorage`'s migration latch is module-level and survives between tests in a file, so
// each test below uses its OWN vault name rather than trying to reset it.
beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = makeLocalStorageStub();
});

describe('coerceAgentSettings renderer', () => {
  it('defaults to webgl when the key is absent (old persisted blob)', () => {
    expect(coerceAgentSettings({}).renderer).toBe('webgl');
    expect(coerceAgentSettings(null).renderer).toBe('webgl');
    expect(coerceAgentSettings(undefined).renderer).toBe('webgl');
  });

  it('honors an explicit dom opt-out', () => {
    expect(coerceAgentSettings({ renderer: 'dom' }).renderer).toBe('dom');
  });

  it('coerces garbage values to the webgl default', () => {
    expect(coerceAgentSettings({ renderer: 'canvas' as never }).renderer).toBe('webgl');
    expect(coerceAgentSettings({ renderer: 42 as never }).renderer).toBe('webgl');
  });

  it('keeps the pre-existing field contracts intact alongside renderer', () => {
    const cfg = coerceAgentSettings({ enabled: false, autoTitle: true, hotkey: '  ' });
    expect(cfg.enabled).toBe(false);          // explicit false disables
    expect(cfg.restoreTabs).toBe(true);       // absent → default true
    expect(cfg.autoTitle).toBe(true);         // explicit true enables
    expect(cfg.hotkey).toBe(DEFAULT_AGENT_SETTINGS.hotkey); // blank → default
    expect(cfg.renderer).toBe('webgl');
  });
});

describe('coerceAgentSettings chatView (Chat is the default Agent screen, 0.22)', () => {
  it('defaults to true when the key is absent (fresh install)', () => {
    expect(coerceAgentSettings({}).chatView).toBe(true);
    expect(coerceAgentSettings(null).chatView).toBe(true);
    expect(coerceAgentSettings(undefined).chatView).toBe(true);
    expect(DEFAULT_AGENT_SETTINGS.chatView).toBe(true);
  });

  it('MIGRATES an existing user off the legacy terminal: a pre-flip blob\'s chatView:false is ignored', () => {
    // Every blob written before the flip carries `chatView:false` from the old opt-in
    // default, so it is NOT evidence anyone chose Terminal. Without `screenMigrated`,
    // the surface must come up as Chat regardless of what is on disk.
    expect(coerceAgentSettings({ chatView: false }).chatView).toBe(true);
    expect(coerceAgentSettings({ chatView: false, renderer: 'dom', autoTitle: true }).chatView).toBe(true);
  });

  it('honors a DELIBERATE switch back to Terminal (legacy) once the blob is migrated', () => {
    expect(coerceAgentSettings({ chatView: false, screenMigrated: true }).chatView).toBe(false);
    // …and the choice survives a re-coerce (the marker rides along on every write).
    const once = coerceAgentSettings({ chatView: false, screenMigrated: true });
    expect(coerceAgentSettings(once).chatView).toBe(false);
  });

  it('stamps screenMigrated on every coerced blob, so the migration fires exactly once', () => {
    expect(coerceAgentSettings({}).screenMigrated).toBe(true);
    expect(coerceAgentSettings({ chatView: false }).screenMigrated).toBe(true);
    expect(DEFAULT_AGENT_SETTINGS.screenMigrated).toBe(true);
  });

  it('coerces garbage values to the true default (only a real `false` can opt out)', () => {
    expect(coerceAgentSettings({ chatView: 'no' as never, screenMigrated: true }).chatView).toBe(true);
    expect(coerceAgentSettings({ chatView: 0 as never, screenMigrated: true }).chatView).toBe(true);
    expect(coerceAgentSettings({ chatView: null as never, screenMigrated: true }).chatView).toBe(true);
    expect(coerceAgentSettings({ chatView: undefined, screenMigrated: true }).chatView).toBe(true);
    // A garbage marker is not a migration marker → still forced onto Chat.
    expect(coerceAgentSettings({ chatView: false, screenMigrated: 'yes' as never }).chatView).toBe(true);
  });

  it('keeps the pre-existing field contracts intact alongside chatView (regression)', () => {
    const cfg = coerceAgentSettings({ enabled: false, autoTitle: true, hotkey: '  ', renderer: 'dom', chatView: false, screenMigrated: true });
    expect(cfg.enabled).toBe(false);          // explicit false disables
    expect(cfg.restoreTabs).toBe(true);       // absent → default true
    expect(cfg.autoTitle).toBe(true);         // explicit true enables
    expect(cfg.hotkey).toBe(DEFAULT_AGENT_SETTINGS.hotkey); // blank → default
    expect(cfg.renderer).toBe('dom');         // explicit dom opt-out honored
    expect(cfg.chatView).toBe(false);         // migrated + explicit false → legacy terminal
  });

  it('an empty blob lands on every default at once, including chatView', () => {
    expect(coerceAgentSettings({})).toEqual(DEFAULT_AGENT_SETTINGS);
  });
});

describe('chatPermissionMode (per vault, split out of the global blob)', () => {
  it('is NOT part of the app-global settings blob any more', () => {
    // The whole point of the split: a permission gate cannot ride a blob that every project
    // in the window shares. A stray `chatPermissionMode` in an old persisted blob is dropped
    // on the floor by the coercer rather than being carried into the new shape.
    expect(DEFAULT_AGENT_SETTINGS).not.toHaveProperty('chatPermissionMode');
    expect(coerceAgentSettings({ chatPermissionMode: 'bypass' } as never)).not.toHaveProperty('chatPermissionMode');
  });

  it('defaults to auto when this vault has never chosen', () => {
    expect(readChatPermissionMode('proj-unset')).toBe('auto');
    expect(readChatPermissionMode(null)).toBe('auto');
  });

  it('honors an explicit bypass opt-in', () => {
    writeChatPermissionMode(new EventTarget(), 'proj-optin', 'bypass');
    expect(readChatPermissionMode('proj-optin')).toBe('bypass');
  });

  // Same contract the coercer used to hold, asserted on the new reader: ONLY an exact
  // 'bypass' opts into the caution mode, so a stale or malformed value can never fail open.
  it('coerces garbage values to the auto default', () => {
    for (const [i, garbage] of ['yes', '1', 'Bypass', 'null', '{"mode":"bypass"}', ''].entries()) {
      const vault = `proj-garbage-${i}`;
      localStorage.setItem(`${SCOPE_PREFIX}${vault}:${CHAT_PERMISSION_MODE_KEY}`, garbage);
      expect(readChatPermissionMode(vault)).toBe('auto');
    }
  });

  it('one project opting into bypass leaves every OTHER project on auto', () => {
    // The defect the split exists for. With the value on the global blob, flipping bypass in
    // one project rewrote the remembered default for every project in the window.
    writeChatPermissionMode(new EventTarget(), 'proj-a', 'bypass');
    expect(readChatPermissionMode('proj-a')).toBe('bypass');
    expect(readChatPermissionMode('proj-b')).toBe('auto');
  });

  it('DROPS a pre-split global bypass instead of migrating it into every vault', () => {
    // Deliberate: carrying the legacy value forward is the harm here — a `bypass` set once,
    // when it meant "this window's project", would fan out to every project at once. The key
    // is new, so nothing is at the legacy name to migrate and every vault starts at 'auto'.
    localStorage.setItem(CHAT_PERMISSION_MODE_KEY, 'bypass');
    expect(readChatPermissionMode('proj-legacy')).toBe('auto');
  });

  it('notifies the INSTANCE bus, never window', () => {
    // A permission change must reach only the project it was made in.
    const bus = new EventTarget();
    let heard: string | null = null;
    bus.addEventListener(CHAT_PERMISSION_MODE_EVENT, (e) => { heard = (e as CustomEvent<string>).detail; });
    writeChatPermissionMode(bus, 'proj-bus', 'bypass');
    expect(heard).toBe('bypass');
  });

  it('keeps the pre-existing field contracts intact after the split (regression)', () => {
    const cfg = coerceAgentSettings({
      enabled: false, autoTitle: true, hotkey: '  ', renderer: 'dom', chatView: true,
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.restoreTabs).toBe(true);
    expect(cfg.autoTitle).toBe(true);
    expect(cfg.hotkey).toBe(DEFAULT_AGENT_SETTINGS.hotkey);
    expect(cfg.renderer).toBe('dom');
    expect(cfg.chatView).toBe(true);
  });
});
