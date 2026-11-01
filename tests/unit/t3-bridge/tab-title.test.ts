import { describe, expect, it } from 'vitest';
import { isInjectedUserText } from '../../../src/lib/t3-bridge/codex-history.js';
import { HIDDEN_TITLE_PROMPT, TabTitler, titleBlock, titleIn } from '../../../src/lib/t3-bridge/tab-title.js';

const ok = { type: 'result', subtype: 'success', is_error: false };
const said = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

describe('a Codex tab names itself', () => {
  it('asks once, after a clean turn that left the tab unnamed', () => {
    const t = new TabTitler(() => true);
    expect(t.observe(said('hello'))).toBe(false);
    expect(t.observe(ok)).toBe(true);
    expect(t.observe(ok)).toBe(false);
  });

  it('a turn that named the tab needs no hidden turn', () => {
    const t = new TabTitler(() => true);
    t.observe(said(`done\n\n${titleBlock('Fatura dışa aktarma')}`));
    expect(t.observe(ok)).toBe(false);
    expect(t.nudge()).toEqual([]);
  });

  it('a failed, interrupted or synthetic turn spends nothing', () => {
    const t = new TabTitler(() => true);
    expect(t.observe({ ...ok, is_error: true })).toBe(false);
    expect(t.observe({ ...ok, subtype: 'error_during_execution' })).toBe(false);
    expect(t.observe({ ...ok, dc_synthetic: true })).toBe(false);
    expect(t.observe(ok)).toBe(true);
  });

  it('a tab the user named is left alone', () => {
    const t = new TabTitler(() => false);
    expect(t.nudge()).toEqual([]);
    expect(t.observe(ok)).toBe(false);
  });

  it('the first turn carries the line while the tab wants a name', () => {
    expect(new TabTitler(() => true).nudge().map((c) => c.key)).toEqual(['dreamcontext-tab-title']);
  });

  it('reads a title out of the block, escapes included; other views are not titles', () => {
    expect(titleIn(titleBlock('Fatura "2026" raporu'))).toBe('Fatura "2026" raporu');
    expect(titleIn('```dream-view\n{"type":"pin","id":"x"}\n```')).toBeNull();
    expect(titleIn('no block')).toBeNull();
    expect(titleIn('{"type":"title","text":"   "}')).toBeNull();
  });

  it('the hidden prompt never reads as the owner in a reopened pane', () => {
    expect(isInjectedUserText(HIDDEN_TITLE_PROMPT)).toBe(true);
  });
});
