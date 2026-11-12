import { describe, expect, it } from 'vitest';
import { isInjectedUserText } from '../../../src/lib/t3-bridge/codex-history.js';
import { HIDDEN_TITLE_PROMPT, TabTitler, titleBlock, titleIn } from '../../../src/lib/t3-bridge/tab-title.js';

const ok = { type: 'result', subtype: 'success', is_error: false };
const said = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

describe('a Codex tab is named by the server, never by a hidden turn', () => {
  it('never asks for the hidden turn, named or not', () => {
    const t = new TabTitler(() => true);
    expect(t.observe(said('hello'))).toBe(false);
    expect(t.observe(ok)).toBe(false);
    expect(t.observe(ok)).toBe(false);
    const named = new TabTitler(() => true);
    named.observe(said(`done\n\n${titleBlock('Fatura dışa aktarma')}`));
    expect(named.observe(ok)).toBe(false);
  });

  it('carries no naming line on any turn', () => {
    expect(new TabTitler(() => true).nudge()).toEqual([]);
    expect(new TabTitler(() => false).nudge()).toEqual([]);
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
