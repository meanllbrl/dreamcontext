/**
 * Unit tests for the Chat view's ⌃C interrupt rule
 * (`dashboard/src/components/sleepy/chat/interruptKey.ts`).
 *
 * The gap these lock down: ⌃C stopped a TERMINAL session (AgentSurface claims no Ctrl chord
 * but ⌃`, so ⌃C reaches the PTY and Claude's TUI cancels), but in the Chat renderer — which
 * has no PTY — the same keypress did nothing, leaving the composer's ■ button as the only way
 * to stop a turn. The two things the fix must not break are pinned here: ⌃C with a live
 * selection stays a COPY (it is the platform copy chord on Windows/Linux), and ⌃C on an idle
 * session is not claimed at all.
 */
import { describe, it, expect } from 'vitest';
import {
  isChatInterruptChord, shouldInterruptChat,
  type InterruptKeyStroke, type InterruptKeyState,
} from '../../dashboard/src/components/sleepy/chat/interruptKey.js';

const stroke = (over: Partial<InterruptKeyStroke> = {}): InterruptKeyStroke => ({
  key: 'c',
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

/** The common case the feature exists for: a turn in flight, nothing selected. */
const working: InterruptKeyState = { busy: true, hasSelection: false };

describe('isChatInterruptChord', () => {
  it('accepts ⌃C', () => {
    expect(isChatInterruptChord(stroke())).toBe(true);
  });

  it('accepts CapsLock ⌃C, which reports the key as uppercase with no shift', () => {
    expect(isChatInterruptChord(stroke({ key: 'C' }))).toBe(true);
  });

  it('rejects a bare C — an unmodified letter belongs to the draft', () => {
    expect(isChatInterruptChord(stroke({ ctrlKey: false }))).toBe(false);
  });

  it('rejects ⌘C, which is copy on macOS', () => {
    expect(isChatInterruptChord(stroke({ ctrlKey: false, metaKey: true }))).toBe(false);
    // …including the both-modifiers form, so a ⌘-copy with Ctrl held is still a copy.
    expect(isChatInterruptChord(stroke({ metaKey: true }))).toBe(false);
  });

  it('rejects ⌃⇧C, the browser inspector chord', () => {
    expect(isChatInterruptChord(stroke({ shiftKey: true }))).toBe(false);
  });

  it('rejects ⌃⌥C, so an Alt-qualified binding stays its owner’s', () => {
    expect(isChatInterruptChord(stroke({ altKey: true }))).toBe(false);
  });

  it('rejects other keys held with Ctrl (⌃D EOF, ⌃W delete-word, ⌃`)', () => {
    for (const key of ['d', 'w', '`', 'v', 'x']) {
      expect(isChatInterruptChord(stroke({ key }))).toBe(false);
    }
  });
});

describe('shouldInterruptChat', () => {
  it('interrupts a turn in flight', () => {
    expect(shouldInterruptChat(stroke(), working)).toBe(true);
  });

  it('does NOT interrupt when text is selected — that keypress is a copy', () => {
    expect(shouldInterruptChat(stroke(), { busy: true, hasSelection: true })).toBe(false);
  });

  it('does NOT interrupt an idle session — there is no turn to stop', () => {
    expect(shouldInterruptChat(stroke(), { busy: false, hasSelection: false })).toBe(false);
    // And it must not become a draft-clearing or session-closing chord either: idle stays
    // idle whether or not something is selected.
    expect(shouldInterruptChat(stroke(), { busy: false, hasSelection: true })).toBe(false);
  });

  it('ignores every non-chord keystroke regardless of state', () => {
    expect(shouldInterruptChat(stroke({ ctrlKey: false }), working)).toBe(false);
    expect(shouldInterruptChat(stroke({ key: 'Enter', ctrlKey: false }), working)).toBe(false);
    expect(shouldInterruptChat(stroke({ metaKey: true }), working)).toBe(false);
  });
});
