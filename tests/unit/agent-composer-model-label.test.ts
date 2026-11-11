/**
 * Unit tests for `modelLabelFor` (dashboard/src/lib/agentComposer.ts) — what the chat
 * composer's model picker prints.
 *
 * The regression this locks down: a chat session's `model` starts as an EMPTY STRING and
 * is only filled once `system:init` reports what the CLI picked — and what it reports is
 * the FULL model id (`claude-opus-4-5-20251101`), which is never one of the picker's alias
 * ids. Both cases used to fall through to a bare "—", so the pill said nothing about which
 * model was answering.
 */
import { describe, it, expect } from 'vitest';
import { modelLabelFor, modelNameFromId, FALLBACK_MODEL_CONFIG, type ModelConfig } from '../../dashboard/src/lib/agentComposer.js';

const CONFIG: ModelConfig = {
  models: [
    { id: 'opus', label: 'Opus 5.5' },
    { id: 'sonnet', label: 'Sonnet 5.5' },
    { id: 'haiku', label: 'Haiku 5.5' },
    { id: 'fable', label: 'Fable 5.2' },
  ],
  efforts: ['low', 'high'],
  defaultModel: 'opus',
  defaultEffort: 'high',
};

describe('modelLabelFor', () => {
  it('resolves a picker alias to its own label', () => {
    expect(modelLabelFor(CONFIG, 'sonnet')).toBe('Sonnet 5.5');
  });

  it("resolves the CLI's full model id by family — this is what system:init actually reports", () => {
    expect(modelLabelFor(CONFIG, 'claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabelFor(CONFIG, 'claude-fable-5-2[1m]')).toBe('Fable 5.2');
    // An older version the list does not name keeps its OWN version, never the current row's.
    expect(modelLabelFor(CONFIG, 'claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(modelLabelFor(CONFIG, 'claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  // Owner, 2026-11-10: a session running Fable 5.2 still read "Fable 5.1" because the label came
  // from a static row. The running session names itself from the id it reports.
  it('names a running session from the id it reports, not from a stale table row', () => {
    const stale: ModelConfig = { ...CONFIG, models: CONFIG.models.map((m) => (m.id === 'fable' ? { ...m, label: 'Fable 5.1' } : m)) };
    expect(modelLabelFor(stale, 'claude-fable-5-2')).toBe('Fable 5.2');
    expect(modelLabelFor(stale, 'claude-fable-5-2[1m]')).toBe('Fable 5.2');
    // A version newer than any table this build ships gets its own derived name.
    expect(modelLabelFor(CONFIG, 'claude-fable-5-3')).toBe('Fable 5.3');
    expect(modelLabelFor(FALLBACK_MODEL_CONFIG, 'claude-fable-5-3[1m]')).toBe('Fable 5.3');
    // Before init the picker alias still reads as its row.
    expect(modelLabelFor(FALLBACK_MODEL_CONFIG, 'fable')).toBe('Fable 5.2');
  });

  it('modelNameFromId derives the name from the id alone', () => {
    expect(modelNameFromId('claude-fable-5-2')).toBe('Fable 5.2');
    expect(modelNameFromId('claude-opus-5')).toBe('Opus 5');
    expect(modelNameFromId('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelNameFromId('fable')).toBe('Fable');
    expect(modelNameFromId('gpt-6.1-sol')).toBe('gpt-6.1-sol');
  });

  it('falls back to the user\'s default model before the first init frame lands (was: "—")', () => {
    expect(modelLabelFor(CONFIG, '')).toBe('Opus 5.5');
    expect(modelLabelFor(FALLBACK_MODEL_CONFIG, '')).toBe('Opus 5.5');
  });

  it('prints an unknown id verbatim rather than a dash — a raw id is still information', () => {
    expect(modelLabelFor(CONFIG, 'gpt-something-9')).toBe('gpt-something-9');
  });

  it('never returns "—", even when the config itself is empty', () => {
    const empty: ModelConfig = { models: [], efforts: [], defaultModel: '', defaultEffort: '' };
    expect(modelLabelFor(empty, '')).toBe('');
    expect(modelLabelFor(empty, 'opus')).toBe('opus');
  });
});
