/**
 * Unit tests for coerceAgentSettings — the blob→settings normalizer shared (in shape)
 * by the dashboard and the server's agent-ui.json persistence (src/server/routes/
 * launcher.ts's own coerceAgentSettings is module-private, so this file exercises the
 * dashboard side only; the two are kept in lockstep by applying the identical rule per
 * field — verified by inspection, same convention as the existing renderer/chatView
 * coverage below). Focus: the `renderer` field added for the GPU/comfort terminal
 * toggle, the `chatView` field added for the Agent Chat view (beta) — task_nQb0y85X —
 * and `chatPermissionMode` added for the Agent Chat redesign's state-6 remembered
 * permission-mode dropdown. Contract for all three: the default (webgl / false / auto)
 * applies whenever the key is absent or garbage, and ONLY the documented explicit
 * opt-in value flips it, so an old persisted blob without the key never silently
 * changes behavior.
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

describe('coerceAgentSettings chatView (Agent Chat view beta, task_nQb0y85X)', () => {
  it('defaults to false when the key is absent (old persisted blob)', () => {
    expect(coerceAgentSettings({}).chatView).toBe(false);
    expect(coerceAgentSettings(null).chatView).toBe(false);
    expect(coerceAgentSettings(undefined).chatView).toBe(false);
    expect(DEFAULT_AGENT_SETTINGS.chatView).toBe(false);
  });

  it('honors an explicit true opt-in', () => {
    expect(coerceAgentSettings({ chatView: true }).chatView).toBe(true);
  });

  it('coerces garbage / truthy-but-not-boolean values to the false default', () => {
    expect(coerceAgentSettings({ chatView: 'yes' as never }).chatView).toBe(false);
    expect(coerceAgentSettings({ chatView: 1 as never }).chatView).toBe(false);
    expect(coerceAgentSettings({ chatView: 'true' as never }).chatView).toBe(false);
    expect(coerceAgentSettings({ chatView: null as never }).chatView).toBe(false);
    expect(coerceAgentSettings({ chatView: undefined }).chatView).toBe(false);
  });

  it('keeps the pre-existing field contracts intact alongside chatView (regression)', () => {
    const cfg = coerceAgentSettings({ enabled: false, autoTitle: true, hotkey: '  ', renderer: 'dom', chatView: true });
    expect(cfg.enabled).toBe(false);          // explicit false disables
    expect(cfg.restoreTabs).toBe(true);       // absent → default true
    expect(cfg.autoTitle).toBe(true);         // explicit true enables
    expect(cfg.hotkey).toBe(DEFAULT_AGENT_SETTINGS.hotkey); // blank → default
    expect(cfg.renderer).toBe('dom');         // explicit dom opt-out honored
    expect(cfg.chatView).toBe(true);          // explicit true enables
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
