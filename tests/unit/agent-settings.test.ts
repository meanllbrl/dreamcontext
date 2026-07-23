/**
 * Unit tests for coerceAgentSettings — the blob→settings normalizer shared (in shape)
 * by the dashboard and the server's agent-ui.json persistence. Focus: the `renderer`
 * field added for the GPU/comfort terminal toggle, and the `chatView` field added for
 * the Agent Chat view (beta) — task_nQb0y85X. Contract for both: the default (webgl /
 * false) applies whenever the key is absent or garbage, and ONLY the documented
 * explicit opt-in value flips it, so an old persisted blob without the key never
 * silently changes behavior.
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
