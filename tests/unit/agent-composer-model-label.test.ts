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
import { modelLabelFor, FALLBACK_MODEL_CONFIG, type ModelConfig } from '../../dashboard/src/lib/agentComposer.js';

const CONFIG: ModelConfig = {
  models: [
    { id: 'opus', label: 'Opus 4.8' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
    { id: 'fable', label: 'Fable' },
  ],
  efforts: ['low', 'high'],
  defaultModel: 'opus',
  defaultEffort: 'high',
};

describe('modelLabelFor', () => {
  it('resolves a picker alias to its own label', () => {
    expect(modelLabelFor(CONFIG, 'sonnet')).toBe('Sonnet');
  });

  it("resolves the CLI's full model id by family — this is what system:init actually reports", () => {
    expect(modelLabelFor(CONFIG, 'claude-opus-4-5-20251101')).toBe('Opus 4.8');
    expect(modelLabelFor(CONFIG, 'claude-sonnet-4-5-20250929')).toBe('Sonnet');
    expect(modelLabelFor(CONFIG, 'claude-haiku-4-5-20251001')).toBe('Haiku');
  });

  it('falls back to the user\'s default model before the first init frame lands (was: "—")', () => {
    expect(modelLabelFor(CONFIG, '')).toBe('Opus 4.8');
    expect(modelLabelFor(FALLBACK_MODEL_CONFIG, '')).toBe('Opus');
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
