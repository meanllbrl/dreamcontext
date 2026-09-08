/**
 * WHICH chat answers the push-to-talk chord.
 *
 * The bug this pins is not subtle once seen: `AgentSurface` portals EVERY live chat session's
 * pane into its own container and parks the off-screen ones in a `display: none` garage, so a
 * pane never unmounts while its session lives. Every J.A.R.V.I.S session in the window was
 * therefore listening on `window` for the chord — minimized ones, background tabs, and panes
 * behind a collapsed overlay — and one press started a take in all of them at once. The owner
 * met it as "farklı yerlerde de o tuşa bastığımda mikrofonu açıyor, hatta farklı projede bile".
 *
 * Tested against fake elements rather than a DOM: the suite runs in Node, and the RULE — who
 * wins, and when nobody does — is the whole of the fix.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerPushToTalk, pushToTalkOwner, ownsPushToTalk, resetPushToTalkScope,
} from '../../dashboard/src/lib/voice/pushToTalkScope.js';

type FakeEl = HTMLElement & { _visible: boolean; _children: unknown[] };

function el(visible = true): FakeEl {
  const node = {
    _visible: visible,
    _children: [] as unknown[],
    isConnected: true,
    checkVisibility() { return node._visible; },
    contains(other: unknown) { return other === node || node._children.includes(other); },
  };
  return node as unknown as FakeEl;
}

let focusIn: ((e: unknown) => void) | null = null;
let activeElement: unknown = null;

beforeEach(() => {
  resetPushToTalkScope();
  focusIn = null;
  activeElement = null;
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'focusin') focusIn = fn; },
    removeEventListener: () => { focusIn = null; },
  });
  vi.stubGlobal('document', {
    get activeElement() { return activeElement; },
    hasFocus: () => true,
  });
});

describe('pushToTalkOwner — exactly one composer answers a press', () => {
  it('gives the press to the ONE visible pane, whatever else is mounted', () => {
    const onScreen = el(true);
    const garaged = el(false);       // minimized, background tab, collapsed overlay
    registerPushToTalk(() => onScreen);
    registerPushToTalk(() => garaged);

    expect(pushToTalkOwner()).toBe(onScreen);
    expect(ownsPushToTalk(onScreen)).toBe(true);
    // THE BUG: this one used to start a take too, in a conversation nobody was looking at.
    expect(ownsPushToTalk(garaged)).toBe(false);
  });

  it('gives it to nobody when no chat is on screen — a settings page must not open the mic', () => {
    registerPushToTalk(() => el(false));
    registerPushToTalk(() => el(false));
    expect(pushToTalkOwner()).toBeNull();
  });

  it('prefers the pane holding the focused element over every other visible one', () => {
    const a = el(true);
    const b = el(true);
    const box = {};
    (b as unknown as { _children: unknown[] })._children.push(box);
    registerPushToTalk(() => a);
    registerPushToTalk(() => b);
    activeElement = box;
    expect(pushToTalkOwner()).toBe(b);
  });

  it('falls back to the pane last touched when two are visible and focus is in neither', () => {
    const a = el(true);
    const b = el(true);
    registerPushToTalk(() => a);
    registerPushToTalk(() => b);
    // Split panes with focus nowhere: ambiguous, so nobody, rather than two microphones.
    expect(pushToTalkOwner()).toBeNull();
    focusIn!({ target: b });
    activeElement = null;
    expect(pushToTalkOwner()).toBe(b);
  });

  it('forgets a pane that unregistered, including as the last-touched one', () => {
    const a = el(true);
    const b = el(true);
    registerPushToTalk(() => a);
    const off = registerPushToTalk(() => b);
    focusIn!({ target: b });
    off();
    // `a` is now the only visible candidate, so it wins on its own — not because it was
    // touched, which it never was.
    expect(pushToTalkOwner()).toBe(a);
  });

  it('answers nothing while this window is not the focused one', () => {
    const only = el(true);
    registerPushToTalk(() => only);
    vi.stubGlobal('document', { get activeElement() { return null; }, hasFocus: () => false });
    expect(ownsPushToTalk(only)).toBe(false);
  });

  it('treats a disconnected element as gone, so a torn-down pane never wins', () => {
    const dead = el(true);
    (dead as unknown as { isConnected: boolean }).isConnected = false;
    registerPushToTalk(() => dead);
    expect(pushToTalkOwner()).toBeNull();
  });
});
