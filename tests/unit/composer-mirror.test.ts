/**
 * The highlight mirror behind the composer textarea (composerMirror.ts): its text box is as wide
 * as the textarea's (a scrollbar takes width from one and not the other) and it scrolls with it.
 */
import { describe, it, expect } from 'vitest';
import { MIRROR_TAIL, syncMirror } from '../../dashboard/src/components/sleepy/chat/composerMirror.js';

const mirror = () => {
  const vars: Record<string, string> = {};
  return { scrollTop: 0, vars, style: { setProperty: (k: string, v: string) => { vars[k] = v; } } };
};

describe('syncMirror', () => {
  it('copies the textarea scroll position', () => {
    const m = mirror();
    syncMirror({ scrollTop: 34, offsetWidth: 500, clientWidth: 500 }, m);
    expect(m.scrollTop).toBe(34);
  });

  it('gives up the width the textarea scrollbar takes, and none when there is no scrollbar', () => {
    const m = mirror();
    syncMirror({ scrollTop: 0, offsetWidth: 500, clientWidth: 485 }, m);
    expect(m.vars['--chat-cmp-hl-gutter']).toBe('15px');
    syncMirror({ scrollTop: 0, offsetWidth: 500, clientWidth: 500 }, m);
    expect(m.vars['--chat-cmp-hl-gutter']).toBe('0px');
  });

  it('closes the mirror text with a zero-width space so a trailing newline owns a line', () => {
    expect(MIRROR_TAIL).toBe('​');
  });
});
