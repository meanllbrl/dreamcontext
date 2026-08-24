/**
 * Unit tests for coerceAgentSettings — the blob→settings normalizer shared (in shape)
 * by the dashboard and the server's agent-ui.json persistence. The server's own
 * `coerceAgentSettings` (src/server/routes/launcher.ts) USED to be module-private, so the
 * older describes below exercise the dashboard side only and rely on "the identical rule
 * per field, verified by inspection". That convention is fine for a default (`webgl`,
 * `chatView`) and NOT fine for a VALIDATION rule, so the `chatDefault*` fields added for
 * the composer's model+effort menu are asserted against BOTH functions, plus an explicit
 * lockstep describe that runs one input table through the pair — inspection cannot catch a
 * regex that drifts on one side only.
 *
 * Focus of the older describes: the `renderer` field added for the GPU/comfort terminal
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
  writeAgentSettings, AGENT_SETTINGS_EVENT,
  CHAT_PERMISSION_MODE_KEY, CHAT_PERMISSION_MODE_EVENT,
  type AgentSettings as AgentSettingsShape,
} from '../../dashboard/src/lib/agentSettings.js';
import { coerceAgentSettings as coerceServerAgentSettings } from '../../src/server/routes/launcher.js';
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

// The composer's model+effort menu has a "Set as default" footer (the mode menu deliberately
// does NOT — owner delta). What it writes lands in these two fields, and from there in
// `~/.dreamcontext/agent-ui.json`, and from there into a `claude --model` / `--effort` argv
// inside a login-shell command string. So '' is the resting value ("inherit the CLI's own
// default"), and anything that could not be spawned must never be persisted.

/** Values that must survive both coercers untouched. */
const VALID_MODELS = ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5', 'claude-fable-5', 'a.b_c-1', 'x'];
/** Values that must be rejected to '' by both coercers. */
const BAD_MODELS: unknown[] = [
  'opus; rm -rf /',      // command chaining
  'opus && whoami',      // ditto
  'opus`id`',            // backtick substitution
  'opus$(id)',           // $() substitution
  'opus|tee /tmp/x',     // pipe
  'opus model',          // whitespace splits the argv element
  'opus\nsonnet',        // newline
  "opus'",               // quote — the argv is double-quoted into a shell string
  'opus"',
  '../../etc/passwd',    // slashes are outside the class
  '',                    // the resting value, spelled explicitly
  '   ',
  'x'.repeat(65),        // 64-char ceiling
  42, true, null, undefined, { id: 'opus' }, ['opus'],
];

describe('chatDefaultModel / chatDefaultEffort (composer "Set as default")', () => {
  it("defaults to '' on both sides — nothing is forced until the user pins one", () => {
    expect(DEFAULT_AGENT_SETTINGS.chatDefaultModel).toBe('');
    expect(DEFAULT_AGENT_SETTINGS.chatDefaultEffort).toBe('');
    for (const coerce of [coerceAgentSettings, coerceServerAgentSettings]) {
      const cfg = coerce({});
      expect(cfg.chatDefaultModel).toBe('');
      expect(cfg.chatDefaultEffort).toBe('');
    }
    expect(coerceAgentSettings(null).chatDefaultModel).toBe('');
    expect(coerceAgentSettings(undefined).chatDefaultEffort).toBe('');
  });

  it('round-trips a valid model + effort through both coercers', () => {
    for (const model of VALID_MODELS) {
      expect(coerceAgentSettings({ chatDefaultModel: model }).chatDefaultModel).toBe(model);
      expect(coerceServerAgentSettings({ chatDefaultModel: model }).chatDefaultModel).toBe(model);
    }
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(coerceAgentSettings({ chatDefaultEffort: effort }).chatDefaultEffort).toBe(effort);
      expect(coerceServerAgentSettings({ chatDefaultEffort: effort }).chatDefaultEffort).toBe(effort);
    }
    // …and a re-coerce is a no-op, so a persisted blob survives every reload.
    const once = coerceAgentSettings({ chatDefaultModel: 'fable', chatDefaultEffort: 'xhigh' });
    expect(coerceAgentSettings(once).chatDefaultModel).toBe('fable');
    expect(coerceAgentSettings(once).chatDefaultEffort).toBe('xhigh');
  });

  it("rejects a shell-metacharacter (or otherwise unspawnable) model to '' on both sides", () => {
    for (const bad of BAD_MODELS) {
      expect(coerceAgentSettings({ chatDefaultModel: bad as never }).chatDefaultModel,
        `dashboard accepted ${JSON.stringify(bad)}`).toBe('');
      expect(coerceServerAgentSettings({ chatDefaultModel: bad }).chatDefaultModel,
        `server accepted ${JSON.stringify(bad)}`).toBe('');
    }
  });

  it("rejects an off-list effort to '' on both sides", () => {
    const bad: unknown[] = ['HIGH', 'Medium', 'extreme', 'high ', ' high', 'high;id', '', 7, true, null, ['high']];
    for (const v of bad) {
      expect(coerceAgentSettings({ chatDefaultEffort: v as never }).chatDefaultEffort,
        `dashboard accepted ${JSON.stringify(v)}`).toBe('');
      expect(coerceServerAgentSettings({ chatDefaultEffort: v }).chatDefaultEffort,
        `server accepted ${JSON.stringify(v)}`).toBe('');
    }
  });

  it('one bad field never takes the other down with it', () => {
    const cfg = coerceServerAgentSettings({ chatDefaultModel: 'opus; id', chatDefaultEffort: 'max' });
    expect(cfg.chatDefaultModel).toBe('');
    expect(cfg.chatDefaultEffort).toBe('max');
  });

  it('keeps the pre-existing field contracts intact alongside the chat defaults (regression)', () => {
    const cfg = coerceAgentSettings({
      enabled: false, autoTitle: true, hotkey: '  ', renderer: 'dom',
      chatView: false, screenMigrated: true, chatDefaultModel: 'opus', chatDefaultEffort: 'low',
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.restoreTabs).toBe(true);
    expect(cfg.autoTitle).toBe(true);
    expect(cfg.hotkey).toBe(DEFAULT_AGENT_SETTINGS.hotkey);
    expect(cfg.renderer).toBe('dom');
    expect(cfg.chatView).toBe(false);
    expect(cfg.chatDefaultModel).toBe('opus');
    expect(cfg.chatDefaultEffort).toBe('low');
  });

  it('an empty blob still lands on every default at once, including the chat defaults', () => {
    expect(coerceAgentSettings({})).toEqual(DEFAULT_AGENT_SETTINGS);
  });

  // The event's `detail` is the whole coerced blob, so the new fields ride it by
  // construction — asserted rather than assumed, because `AgentSurface`'s spawn path learns
  // about a "Set as default" only through this event (no reload).
  it('rides the AGENT_SETTINGS_EVENT payload so a live surface sees the change', async () => {
    const realWindow = (globalThis as { window?: unknown }).window;
    const realFetch = globalThis.fetch;
    const bus = new EventTarget();
    (globalThis as { window?: unknown }).window = bus;
    // The write also POSTs to the local server; stubbed so this test never depends on a
    // socket (and so a relative-URL fetch can't reject differently across Node versions).
    globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      let heard: AgentSettingsShape | null = null;
      bus.addEventListener(AGENT_SETTINGS_EVENT, (e) => {
        heard = (e as CustomEvent<AgentSettingsShape>).detail;
      });
      writeAgentSettings(coerceAgentSettings({ chatDefaultModel: 'fable', chatDefaultEffort: 'max' }));
      expect(heard).not.toBeNull();
      expect(heard!.chatDefaultModel).toBe('fable');
      expect(heard!.chatDefaultEffort).toBe('max');
    } finally {
      if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = realWindow;
      globalThis.fetch = realFetch;
    }
  });
});

// The dashboard re-spells the server's `sanitizeModel` / `EFFORT_LEVELS` rules because it
// cannot import a Node module. This describe is what stops that copy from drifting: one
// table, both functions, identical verdicts. A regex tightened on one side only fails HERE
// rather than in production, where the two would silently disagree about what is persisted.
describe('chatDefault* server/dashboard lockstep', () => {
  it('both coercers agree on every value in the model + effort tables', () => {
    const efforts: unknown[] = ['low', 'medium', 'high', 'xhigh', 'max', 'HIGH', 'extreme', '', 7, null];
    for (const v of [...VALID_MODELS, ...BAD_MODELS]) {
      expect(
        coerceServerAgentSettings({ chatDefaultModel: v }).chatDefaultModel,
        `model disagreement on ${JSON.stringify(v)}`,
      ).toBe(coerceAgentSettings({ chatDefaultModel: v as never }).chatDefaultModel);
    }
    for (const v of efforts) {
      expect(
        coerceServerAgentSettings({ chatDefaultEffort: v }).chatDefaultEffort,
        `effort disagreement on ${JSON.stringify(v)}`,
      ).toBe(coerceAgentSettings({ chatDefaultEffort: v as never }).chatDefaultEffort);
    }
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
