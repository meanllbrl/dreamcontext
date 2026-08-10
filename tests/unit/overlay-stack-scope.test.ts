/**
 * Unit tests for `overlayStack.ts` — who owns the Escape key when one window holds several
 * projects at once.
 *
 * The stack used to be a single flat LIFO, which was correct while a window held exactly one
 * project: "the front-most overlay" and "the overlay the user can see" were the same thing.
 * They are not any more. Every project instance stays MOUNTED when its chip goes to the
 * background — that is the whole point of the design, so a running agent survives a switch —
 * and a mounted overlay's Escape handler is still registered on `window` and still fires.
 *
 * Two symmetric failures follow from one shared stack, and both are locked here:
 *
 *   A) Esc goes DEAF in the foreground. Panel open in A, switch to B, panel open in B,
 *      switch back to A. A's panel is the one on screen; B's entry is topmost; Esc in A
 *      does nothing and the panel cannot be dismissed.
 *   B) Esc hits the WRONG project. The same two panels, background pushed last. Esc in B
 *      closes A's invisible panel and leaves B's open — a keystroke acting on a project the
 *      user is not looking at.
 *
 * The fix is that entries remember the scope they were pushed in and Esc is answered per
 * scope. `scope === null` (no `WindowChrome`: the launcher, the browser build, these tests
 * before a scope is set) must keep the old flat behaviour EXACTLY — that path is what every
 * single-surface window still runs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushOverlay, popOverlay, isTopOverlay, setActiveOverlayScope, resetOverlayStack,
} from '../../dashboard/src/lib/overlayStack.js';

beforeEach(() => resetOverlayStack());

describe('overlayStack — unscoped (one project per window, the legacy path)', () => {
  it('the last overlay pushed owns Esc', () => {
    pushOverlay('palette');
    expect(isTopOverlay('palette')).toBe(true);
    pushOverlay('picker');
    expect(isTopOverlay('picker')).toBe(true);
    expect(isTopOverlay('palette')).toBe(false);
  });

  it('closing the top hands Esc back to the one underneath', () => {
    pushOverlay('palette');
    pushOverlay('picker');
    popOverlay('picker');
    expect(isTopOverlay('palette')).toBe(true);
  });

  it('an overlay that was never pushed never owns Esc', () => {
    expect(isTopOverlay('nobody')).toBe(false);
    pushOverlay('palette');
    expect(isTopOverlay('nobody')).toBe(false);
  });

  it('re-pushing an open overlay moves it to the top rather than duplicating it', () => {
    pushOverlay('a');
    pushOverlay('b');
    pushOverlay('a');
    expect(isTopOverlay('a')).toBe(true);
    // One entry, not two: a single pop must fully close it.
    popOverlay('a');
    expect(isTopOverlay('b')).toBe(true);
    expect(isTopOverlay('a')).toBe(false);
  });
});

describe('overlayStack — several projects live in one window', () => {
  it('REGRESSION A: the foreground project keeps Esc even when the background pushed later', () => {
    // Panel open in A…
    setActiveOverlayScope('inst-a');
    pushOverlay('inst-a::panel');
    // …switch to B, panel open in B (pushed LAST — this is what used to win)…
    setActiveOverlayScope('inst-b');
    pushOverlay('inst-b::panel');
    expect(isTopOverlay('inst-b::panel')).toBe(true);
    // …switch back to A. A's panel is the one on screen, so A's panel answers Esc.
    setActiveOverlayScope('inst-a');
    expect(isTopOverlay('inst-a::panel')).toBe(true);
    expect(isTopOverlay('inst-b::panel')).toBe(false);
  });

  it('REGRESSION B: a background overlay never answers Esc, however recently it was pushed', () => {
    setActiveOverlayScope('inst-b');
    pushOverlay('inst-b::panel');
    setActiveOverlayScope('inst-a');
    pushOverlay('inst-a::panel');   // pushed last, but A is about to go to the background
    setActiveOverlayScope('inst-b');
    expect(isTopOverlay('inst-a::panel')).toBe(false); // invisible — must not eat the key
    expect(isTopOverlay('inst-b::panel')).toBe(true);  // the one on screen gets it
  });

  it('stacking still works WITHIN the foreground project', () => {
    setActiveOverlayScope('inst-a');
    pushOverlay('inst-a::panel');
    pushOverlay('inst-a::palette');   // opened on top of the panel
    expect(isTopOverlay('inst-a::palette')).toBe(true);
    expect(isTopOverlay('inst-a::panel')).toBe(false);
    popOverlay('inst-a::palette');
    expect(isTopOverlay('inst-a::panel')).toBe(true);
  });

  it('a background project\'s overlays are untouched — switching back finds them as they were', () => {
    setActiveOverlayScope('inst-a');
    pushOverlay('inst-a::panel');
    pushOverlay('inst-a::palette');
    setActiveOverlayScope('inst-b');
    expect(isTopOverlay('inst-a::palette')).toBe(false);
    setActiveOverlayScope('inst-a');
    // Same LIFO order it had before the trip: the stack is scoped, not cleared.
    expect(isTopOverlay('inst-a::palette')).toBe(true);
    popOverlay('inst-a::palette');
    expect(isTopOverlay('inst-a::panel')).toBe(true);
  });

  it('no overlay open in the foreground means nobody owns Esc', () => {
    setActiveOverlayScope('inst-a');
    pushOverlay('inst-a::panel');
    setActiveOverlayScope('inst-b');
    expect(isTopOverlay('inst-a::panel')).toBe(false);
    expect(isTopOverlay('inst-b::panel')).toBe(false);
  });

  it('a revived cold chip does not inherit the dead instance\'s overlays', () => {
    // Closing a project at the ceiling tears the instance down; reopening mints a NEW id.
    setActiveOverlayScope('inst-a-1');
    pushOverlay('inst-a-1::panel');
    setActiveOverlayScope('inst-a-2');            // same vault, fresh instance
    expect(isTopOverlay('inst-a-1::panel')).toBe(false);
    pushOverlay('inst-a-2::panel');
    expect(isTopOverlay('inst-a-2::panel')).toBe(true);
  });

  it('an id-less popover (useId, no vault prefix) still owns Esc in the project it opened in', () => {
    // `RangeControl` / `FunnelOverviewPage` / `SkillPickerPopover` build ids from `useId()`
    // and know nothing about vaults. Scope is captured at PUSH time precisely so those keep
    // working without every popover having to become vault-aware.
    setActiveOverlayScope('inst-a');
    pushOverlay(':r7:');
    expect(isTopOverlay(':r7:')).toBe(true);
    setActiveOverlayScope('inst-b');
    expect(isTopOverlay(':r7:')).toBe(false);
  });

  it('an entry pushed before any scope existed answers in every scope', () => {
    // The launcher and the browser build never set a scope. Such an entry must not become
    // undismissable just because some other surface later declared one.
    pushOverlay('unscoped');
    setActiveOverlayScope('inst-a');
    expect(isTopOverlay('unscoped')).toBe(true);
  });
});
