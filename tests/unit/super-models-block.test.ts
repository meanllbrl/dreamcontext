import { describe, it, expect } from 'vitest';
import { renderModelsBlock, modelsStateIn, superModelsState, superModelsTurn, stripSuperModelsBlocks } from '../../src/lib/super/models-block.js';

/** Plan eco-plus D5 / K6: the `<super-models>` block, its delivery rule and its transcript state. */
const snap = (systemPrompt: string) => JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt } });
const user = (...texts: string[]) => JSON.stringify({ type: 'user', message: { role: 'user', content: texts.map((text) => ({ type: 'text', text })) } });
const compact = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });

describe('the block', () => {
  it('eco=plus carries the Eco Plus table and the escalation; eco=off hands the rows back', () => {
    const plus = renderModelsBlock('plus');
    expect(plus.startsWith('<super-models eco=plus>')).toBe(true);
    expect(plus).toContain('REPLACES the Model rows');
    expect(plus).toContain('multi-file develop, a bug with a repro, analysis: `sonnet` `medium`');
    expect(plus).toContain('--model opus --effort high');
    expect(plus).toContain('super update <child> --model opus');
    expect(plus).toContain('mid model');
    expect(plus).not.toMatch(/—/);
    expect(renderModelsBlock('off')).toContain('Model rows of your briefing apply again');
    expect(modelsStateIn(`x ${renderModelsBlock('off')} y ${renderModelsBlock('plus')}`)).toBe('plus');
  });

  it('rides once per change, never on a slash command; unknown (null) rides once', () => {
    expect(superModelsTurn({ text: 'hi', now: 'plus', delivered: 'off' })).toContain('eco=plus');
    expect(superModelsTurn({ text: 'hi', now: 'plus', delivered: 'plus' })).toBeNull();
    expect(superModelsTurn({ text: 'hi', now: 'off', delivered: null })).toContain('eco=off');
    expect(superModelsTurn({ text: '/clear', now: 'plus', delivered: 'off' })).toBeNull();
  });

  it('recall strips it', () => {
    expect(stripSuperModelsBlocks(`a\n${renderModelsBlock('plus')}\nb`)).toBe('a\nb');
  });
});

describe('the state a resumed session holds', () => {
  it('born off: off; born under Eco Plus: plus; a turn block wins until a compaction', () => {
    expect(superModelsState(snap('briefing'))).toEqual({ inPrompt: 'off', delivered: 'off' });
    expect(superModelsState(snap(`briefing\n${renderModelsBlock('plus')}`))).toEqual({ inPrompt: 'plus', delivered: 'plus' });
    const j = [snap('briefing'), user('hi', renderModelsBlock('plus'))].join('\n');
    expect(superModelsState(j)).toEqual({ inPrompt: 'off', delivered: 'plus' });
    expect(superModelsState([j, compact].join('\n'))).toEqual({ inPrompt: 'off', delivered: 'off' });
  });
  it('no snapshot at all: unknown', () => {
    expect(superModelsState(user('hi'))).toEqual({ inPrompt: null, delivered: null });
  });
});
