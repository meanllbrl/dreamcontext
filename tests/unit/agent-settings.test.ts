/**
 * Unit tests for coerceAgentSettings — the blob→settings normalizer shared (in shape)
 * by the dashboard and the server's agent-ui.json persistence (src/server/routes/
 * launcher.ts's own coerceAgentSettings is module-private, so this file exercises the
 * dashboard side only; the two are kept in lockstep by applying the identical rule per
 * field — verified by inspection, same convention as the existing renderer/chatView
 * coverage below). Focus: the `renderer` field added for the GPU/comfort terminal
 * toggle, the `chatView` field added for the Agent Chat view (beta) — task_nQb0y85X —
 * and `chatPermissionMode` added for the Agent Chat redesign's state-6 remembered
 * permission-mode dropdown. Contract for all three: the default (webgl / Chat / auto)
 * applies whenever the key is absent or garbage, and ONLY the documented explicit
 * opt-out value flips it, so an old persisted blob without the key never silently
 * changes behavior.
 *
 * `chatView` is the one field with a MIGRATION on top of that contract: Chat became the
 * standard Agent screen in 0.22, and every blob written before then carries a
 * `chatView:false` that came from the old opt-in default rather than from a user's
 * choice — so an explicit `false` is honoured only on a `screenMigrated` blob.
 */
import { describe, it, expect } from 'vitest';
import { coerceAgentSettings, DEFAULT_AGENT_SETTINGS } from '../../dashboard/src/lib/agentSettings.js';

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

describe('coerceAgentSettings chatPermissionMode (Agent Chat redesign, state 6 remembered mode)', () => {
  it('defaults to auto when the key is absent (old persisted blob)', () => {
    expect(coerceAgentSettings({}).chatPermissionMode).toBe('auto');
    expect(coerceAgentSettings(null).chatPermissionMode).toBe('auto');
    expect(coerceAgentSettings(undefined).chatPermissionMode).toBe('auto');
    expect(DEFAULT_AGENT_SETTINGS.chatPermissionMode).toBe('auto');
  });

  it('honors an explicit bypass opt-in', () => {
    expect(coerceAgentSettings({ chatPermissionMode: 'bypass' }).chatPermissionMode).toBe('bypass');
  });

  it('coerces garbage values to the auto default', () => {
    expect(coerceAgentSettings({ chatPermissionMode: 'yes' as never }).chatPermissionMode).toBe('auto');
    expect(coerceAgentSettings({ chatPermissionMode: 1 as never }).chatPermissionMode).toBe('auto');
    expect(coerceAgentSettings({ chatPermissionMode: 'Bypass' as never }).chatPermissionMode).toBe('auto');
    expect(coerceAgentSettings({ chatPermissionMode: null as never }).chatPermissionMode).toBe('auto');
    expect(coerceAgentSettings({ chatPermissionMode: undefined }).chatPermissionMode).toBe('auto');
  });

  it('keeps the pre-existing field contracts intact alongside chatPermissionMode (regression)', () => {
    const cfg = coerceAgentSettings({
      enabled: false, autoTitle: true, hotkey: '  ', renderer: 'dom', chatView: true, chatPermissionMode: 'bypass',
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.restoreTabs).toBe(true);
    expect(cfg.autoTitle).toBe(true);
    expect(cfg.hotkey).toBe(DEFAULT_AGENT_SETTINGS.hotkey);
    expect(cfg.renderer).toBe('dom');
    expect(cfg.chatView).toBe(true);
    expect(cfg.chatPermissionMode).toBe('bypass');
  });
});
