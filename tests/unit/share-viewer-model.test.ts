// The live-link board viewer's state machine (dashboard/src/share/viewerModel.ts, tunel-paylasim C7,
// D13): open, closed at once on 410/401, a single miss keeps the last frame, a second miss ≥ 5 s
// later reads as gone, the guest's own network failing never counts, a non-JSON edge page never
// crashes it, gone keeps asking slower and opens again, and only a closed viewer never reopens.
import { describe, it, expect } from 'vitest';
import { GONE_AFTER_MS, GONE_POLL_MS, POLL_MS, initialViewer, kindLabel, nextPollMs, onBoard, onPoll, type ViewerState } from '../../dashboard/src/share/viewerModel.js';

const ok = (rev: string) => ({ status: 200, body: { rev } });

describe('viewer model', () => {
  it('the first good rev asks for the board; the board arriving opens the view', () => {
    const step = onPoll(initialViewer, ok('r1'), 0);
    expect(step.refetch).toBe(true);
    expect(step.state.phase).toBe('loading');
    const open = onBoard(step.state, 'r1');
    expect(open).toEqual({ phase: 'open', rev: 'r1', missSince: null });
    expect(onPoll(open, ok('r1'), 3000).refetch).toBe(false);
    expect(onPoll(open, ok('r2'), 3000).refetch).toBe(true);
  });

  it('410 and 401 close at once', () => {
    const open: ViewerState = { phase: 'open', rev: 'r1', missSince: null };
    expect(onPoll(open, { status: 410, body: { error: 'share_closed' } }, 0).state.phase).toBe('closed');
    expect(onPoll(open, { status: 401, body: null }, 0).state.phase).toBe('closed');
  });

  it('one miss keeps the frame; a second miss ≥ 5 s later is gone; a good answer in between resets', () => {
    const open: ViewerState = { phase: 'open', rev: 'r1', missSince: null };
    const miss1 = onPoll(open, { status: 404, body: { error: 'board_gone' } }, 1000).state;
    expect(miss1.phase).toBe('open');
    expect(miss1.missSince).toBe(1000);
    const miss2 = onPoll(miss1, { status: 404, body: null }, 1000 + GONE_AFTER_MS - 1).state;
    expect(miss2.phase).toBe('open');
    expect(onPoll(miss2, { status: 530, body: null }, 1000 + GONE_AFTER_MS).state.phase).toBe('gone');
    const healed = onPoll(miss1, ok('r1'), 4000).state;
    expect(healed.missSince).toBeNull();
    expect(onPoll(healed, { status: 404, body: null }, 7000).state.phase).toBe('open');
  });

  it('a non-JSON 530 (the edge page) or a 200 without a rev counts as a miss, never a crash', () => {
    const open: ViewerState = { phase: 'open', rev: 'r1', missSince: null };
    expect(() => onPoll(open, { status: 530, body: null }, 0)).not.toThrow();
    expect(onPoll(open, { status: 530, body: null }, 0).state.missSince).toBe(0);
    expect(onPoll(open, { status: 200, body: '<html>' }, 0).state.missSince).toBe(0);
    expect(onPoll(open, { status: 200, body: { rev: 7 } }, 0).state.missSince).toBe(0);
  });

  it("the guest's own network failing (status 0) never counts toward gone, however long", () => {
    const open: ViewerState = { phase: 'open', rev: 'r1', missSince: null };
    let s = open;
    for (let t = 0; t <= 60_000; t += POLL_MS) s = onPoll(s, { status: 0, body: null }, t).state;
    expect(s).toEqual(open);
    // Nor does it extend or end a run of real misses.
    const miss1 = onPoll(open, { status: 530, body: null }, 1000).state;
    expect(onPoll(miss1, { status: 0, body: null }, 9000).state).toEqual(miss1);
  });

  it('gone keeps asking slower and opens again on a good rev; a 410 then closes it', () => {
    const gone: ViewerState = { phase: 'gone', rev: 'r1', missSince: 1000 };
    expect(nextPollMs(gone)).toBe(GONE_POLL_MS);
    expect(nextPollMs({ ...gone, phase: 'open' })).toBe(POLL_MS);
    expect(onPoll(gone, { status: 530, body: null }, 99_000)).toEqual({ state: gone, refetch: false });
    const back = onPoll(gone, ok('r1'), 99_000);
    expect(back).toEqual({ state: { phase: 'loading', rev: null, missSince: null }, refetch: true });
    expect(onBoard(back.state, 'r1')).toEqual({ phase: 'open', rev: 'r1', missSince: null });
    expect(onPoll(gone, { status: 410, body: null }, 99_000).state.phase).toBe('closed');
    // A board that arrives while still gone is ignored (the canvas is not mounted).
    expect(onBoard(gone, 'r9')).toBe(gone);
  });

  it('closed never reopens, whatever comes next', () => {
    const s: ViewerState = { phase: 'closed', rev: 'r1', missSince: null };
    expect(onPoll(s, ok('r9'), 0)).toEqual({ state: s, refetch: false });
    expect(onBoard(s, 'r9')).toBe(s);
  });

  it('every widget kind has a Turkish label; an unknown kind is a plain card', () => {
    for (const k of ['task', 'insight', 'knowledge', 'lab-card', 'agent', 'note', 'todo', 'html', 'web', 'wiki']) expect(kindLabel(k)).not.toBe('Kart');
    expect(kindLabel('weird')).toBe('Kart');
  });
});
