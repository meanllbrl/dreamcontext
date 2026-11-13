import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  INPUT_QUIET_MS, answerRowAfter, followStep, ownAnchorIndex, shouldWrite,
} from '../../dashboard/src/components/sleepy/super/superScroll';
import { landingFor } from '../../dashboard/src/components/sleepy/super/superUnread';

const CLEAR = 64;
const VIEW = 600;

/** A pane in miniature: content grows by `chunk` px per step, the follow runs once per step. */
function stream(o: { scrollTop: number; height: number; anchorTop: number | null; chunk: number; steps: number }) {
  let { scrollTop, height } = o;
  const writes: number[] = [];
  let stopped = false;
  for (let i = 0; i < o.steps && !stopped; i++) {
    height += o.chunk;
    const r = followStep({ scrollTop, maxTop: height - VIEW, anchorTop: o.anchorTop, clearance: CLEAR });
    if (shouldWrite(scrollTop, r.top, -Infinity, 0)) { writes.push(r.top - scrollTop); scrollTop = r.top; }
    stopped = r.stop;
  }
  return { scrollTop, height, writes, stopped };
}

describe('the Super chat scrolls like Telegram (owner 2026-11-13, rule C)', () => {
  it('his own send goes to the bottom, and a short reply is followed to its end', () => {
    // He sent at 1400 (his row's top); the view is at the bottom (maxTop 1000 → content 1600).
    const r = stream({ scrollTop: 1000, height: 1600, anchorTop: 1400, chunk: 30, steps: 5 });
    expect(r.stopped).toBe(false);
    expect(r.scrollTop).toBe(r.height - VIEW);
  });

  it('at the bottom, a long streamed answer stops with its start at the top of the view', () => {
    const start = 1500;
    const r = stream({ scrollTop: 1000, height: 1600, anchorTop: start, chunk: 40, steps: 100 });
    expect(r.stopped).toBe(true);
    // Its first line rests the rail's clearance under the view's top. (Mutation: cap off → at the bottom.)
    expect(start - r.scrollTop).toBe(CLEAR);
    // Each write moved the view down, never up, never by zero.
    for (const w of r.writes) expect(w).toBeGreaterThan(0);
  });

  it('never upward: a start already above the view stops the follow where it stands, with no write', () => {
    const r = followStep({ scrollTop: 900, maxTop: 1400, anchorTop: 300, clearance: CLEAR });
    expect(r).toEqual({ top: 900, stop: true });
    expect(shouldWrite(900, r.top, -Infinity, 0)).toBe(false);
  });

  it('no jump after the answer ends: once stopped, content growing below moves nothing', () => {
    const stoppedAt = 1436;
    // The pane no longer follows; were it asked again, the start is above its cap: no write.
    for (const maxTop of [1500, 2400, 9000]) {
      const r = followStep({ scrollTop: stoppedAt, maxTop, anchorTop: 1500, clearance: CLEAR });
      expect(r.top).toBe(stoppedAt);
      expect(shouldWrite(stoppedAt, r.top, -Infinity, 0)).toBe(false);
    }
  });

  it('scrolled up, nothing moves: no anchor follow is ever uncapped above the reader', () => {
    // The anchor's row is gone (-Infinity): the follow stops where it stands, never to the bottom.
    expect(followStep({ scrollTop: 120, maxTop: 900, anchorTop: Number.NEGATIVE_INFINITY, clearance: CLEAR })).toEqual({ top: 120, stop: true });
    // Nothing new yet (anchorTop null): only ever down to the bottom, never above scrollTop.
    expect(followStep({ scrollTop: 500, maxTop: 300, anchorTop: null, clearance: CLEAR }).top).toBe(500);
  });

  it('writes nothing during his gesture, and nothing that moves less than a pixel', () => {
    expect(shouldWrite(100, 160, 1000, 1000 + INPUT_QUIET_MS - 1)).toBe(false);
    expect(shouldWrite(100, 160, 1000, 1000 + INPUT_QUIET_MS)).toBe(true);
    expect(shouldWrite(100, 100.4, -Infinity, 0)).toBe(false);
    expect(INPUT_QUIET_MS).toBe(300);
  });

  it('the new answer is the row after the newest one on screen when the follow began', () => {
    expect(answerRowAfter(3, 1)).toBe(2);
    // The row he was looking at (even one still being written) is read: nothing new yet.
    expect(answerRowAfter(2, 1)).toBe(-1);
    // An empty transcript when the follow began: the first row is the answer.
    expect(answerRowAfter(1, -1)).toBe(0);
    expect(answerRowAfter(0, -1)).toBe(-1);
  });

  it('his own message anchors, unless it is taller than the view: then the reply after it', () => {
    const rows = [{ top: 0, height: 200 }, { top: 216, height: 100 }, { top: 332, height: 900 }];
    expect(ownAnchorIndex(rows, 1, VIEW, CLEAR)).toBe(1);
    const tall = [{ top: 0, height: 200 }, { top: 216, height: 800 }, { top: 1032, height: 100 }];
    expect(ownAnchorIndex(tall, 1, VIEW, CLEAR)).toBe(2);
    // Tall and nothing after it yet: nothing to stop at, the follow goes on (r1 minor).
    expect(ownAnchorIndex(tall.slice(0, 2), 1, VIEW, CLEAR)).toBe(-1);
    expect(ownAnchorIndex(rows, -1, VIEW, CLEAR)).toBe(-1);
  });

  it('a question card is never cut: it lands whole when it fits, its top when it does not', () => {
    expect(landingFor('question', 300, 500)).toBe(64);
    expect(landingFor('question', 470, 500)).toBe(30);
    expect(500 - landingFor('question', 470, 500)).toBeGreaterThanOrEqual(470);
    expect(landingFor('question', 584, 459)).toBe(12);
  });
});

describe('ONE scroll owner in the Super pane', () => {
  const pane = readFileSync('dashboard/src/components/sleepy/ChatPane.tsx', 'utf8');
  it('every follow write in the Super view goes through superStep', () => {
    expect(pane).toMatch(/if \(superRef\.current\) \{ superStep\(el\); return; \}/);
    expect(pane).not.toMatch(/holdAtUnread|useFollowUnread|followRowRef|SuperUnreadBar/);
  });
  it('only his own send moves the view: the mount and an echo do not', () => {
    expect(pane).toMatch(/if \(superView && !sent\) return;/);
    expect(pane).toMatch(/if \(superView\) \{ placeAtBottom\(lastUserItemId\); return; \}/);
    expect(pane).toMatch(/!it\.echo && !it\.queued && !superEventOf\(it\.text\)/);
  });
  it('a queued message moves the view at his press, never at the queue drain (r1)', () => {
    const session = readFileSync('dashboard/src/components/sleepy/chatSession.ts', 'utf8');
    const composer = readFileSync('dashboard/src/components/sleepy/chat/Composer.tsx', 'utf8');
    // Only the drain marks its item; a "Send now" press does not.
    expect(session).toMatch(/\.\.\.\(draining \? \{ queued: true as const \} : \{\}\)/);
    expect(session).toMatch(/draining = true;\n\s+try \{ flushOne\(\); \} finally \{ draining = was; \}/);
    // Every Composer enqueue goes through the one helper that tells the pane.
    expect(composer).toMatch(/const enqueue = \(opts\?: \{ steerWhenPossible: true \}\): void => \{ session\.enqueue\(message, opts\); onQueued\?\.\(\); \};/);
    expect(composer.match(/session\.enqueue\(message/g)).toHaveLength(1);
    expect(pane).toMatch(/onQueued=\{onQueued\}/);
  });
  it('the anchor is an item, never a scroll number, and is not taken unmeasured (r1)', () => {
    expect(pane).not.toMatch(/answerRowIndex|contentEnd\(/);
    // Anchored on item rows only: never a trailing card or the live line (r2).
    expect(pane).toMatch(/\{superView && <div data-items-end hidden \/>\}/);
    expect(pane).not.toMatch(/transcriptRows\(\)\.at\(-1\)/);
    expect(pane).toMatch(/if \(after < 0 && \(at\.after \|\| at\.afterId\)\) return ANCHOR_GONE;/);
    expect(pane).toMatch(/const ready = !!el && el\.clientHeight > 0 && !historyPendingRef\.current;/);
    // A garaged turn end keeps his own anchor.
    expect(pane).toMatch(/if \(!el \|\| el\.clientHeight === 0\) return;\n\s+takeAnchor\(null\);/);
  });
  it('the jump hands the focus back to the composer on a pointer screen (r1)', () => {
    expect(pane).toMatch(/const refocusComposer = \(\) => \{ if \(window\.matchMedia\('\(hover: hover\)'\)\.matches\) session\.focus\(\); \};/);
    expect(pane).toMatch(/onGone=\{refocusComposer\}/);
  });
  it('the follow re-arms only on HIS scroll to the bottom', () => {
    expect(pane).toMatch(/setStick\(superView && stick && !stickRef\.current && !readerMoving \? false : stick\);/);
  });
  it('the button strip is reserved all the time in the Super view', () => {
    const css = readFileSync('dashboard/src/components/sleepy/ChatPane.css', 'utf8');
    expect(css).toMatch(/\.chat-transcript--super > \.chat-scroll \{ margin-bottom: var\(--chat-float-strip\); \}/);
  });
});
