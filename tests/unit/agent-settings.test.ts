/**
 * Unit tests for coerceAgentSettings — the blob→settings normalizer shared (in shape)
 * by the dashboard and the server's agent-ui.json persistence. Focus: the `renderer`
 * field added for the GPU/comfort terminal toggle. Contract: 'webgl' is the default
 * (smoothness), ONLY an explicit 'dom' opts back into comfort rendering, and an old
 * persisted blob without the key must land on the default rather than break.
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
