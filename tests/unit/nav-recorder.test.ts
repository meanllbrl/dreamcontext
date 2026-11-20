/**
 * Navigation B, C3: the window's one recorder (dashboard/src/components/layout/navRecorder.ts),
 * with an injected clock. Times are pinned: SETTLE_MS 400, PAGE_MOVE_MAX_MS 5 s,
 * CHAT_MOVE_MAX_MS 20 s.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPlaceHistory, type Place } from '../../dashboard/src/lib/placeHistory';
import {
  createNavRecorder, targetOf, CHAT_MOVE_MAX_MS, PAGE_MOVE_MAX_MS, SETTLE_MS,
} from '../../dashboard/src/components/layout/navRecorder';

const page = (vault: string, p: string, id: string | null = null): Place => ({ vault, kind: 'page', page: p as never, id, label: null });
const chat = (vault: string): Place => ({ vault, kind: 'chat' });
const none = () => false;

/** A fake clock: timers fire in order as time advances. */
function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => { seq += 1; timers.set(seq, { at: now + ms, fn }); return seq; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    /** Run to absolute time `t`. */
    to(t: number) { this.advance(t - now); },
  };
}

function setup() {
  const c = clock();
  const history = createPlaceHistory({ now: () => 0, storage: null });
  const rec = createNavRecorder({ history, setTimer: c.setTimer, clearTimer: c.clearTimer });
  const list = () => history.entries().list;
  return { c, history, rec, list };
}

describe('navRecorder: settling', () => {
  it('records a place once it stayed SETTLE_MS; a quicker hop is no stop', () => {
    const { c, rec, list } = setup();
    rec.shown(page('a', 'tasks'), true);
    c.advance(SETTLE_MS - 1);
    rec.shown(page('a', 'lab'), true);
    c.advance(SETTLE_MS);
    expect(list()).toEqual([page('a', 'lab')]);
  });

  it('a slow item publish 600 ms after its page settled fills the entry, never splits it', () => {
    const { c, rec, list } = setup();
    rec.shown(page('a', 'whiteboards'), true);
    c.to(600);
    rec.shown(page('a', 'whiteboards', 'x'), false);
    c.advance(SETTLE_MS);
    expect(list()).toEqual([page('a', 'whiteboards', 'x')]);
  });
});

describe('navRecorder: moves', () => {
  it('a cold mount restoring another page, then the landing at 900 ms: one entry', () => {
    const { c, rec, list } = setup();
    rec.shown(page('a', 'whiteboards', 'x'), true);
    c.advance(SETTLE_MS);
    rec.move(targetOf(page('b', 'whiteboards', 'y')));
    c.to(1000);
    rec.shown(page('b', 'tasks'), false); // the stored page, for a beat
    c.advance(900);
    rec.shown(page('b', 'whiteboards', 'y'), false);
    c.advance(SETTLE_MS);
    expect(list()).toEqual([page('a', 'whiteboards', 'x'), page('b', 'whiteboards', 'y')]);
  });

  it('a carry onto Chat into a cold project whose chat opens at the 1200 ms retry: one entry', () => {
    const { c, rec, list } = setup();
    rec.move({ vault: 'b', kind: 'chat', place: chat('b') });
    rec.shown(page('b', 'tasks'), false);
    c.to(1200);
    rec.shown(chat('b'), false);
    c.advance(SETTLE_MS);
    expect(list()).toEqual([chat('b')]);
  });

  it('a drawer row into a cold project whose chat opens at 4 s: one entry', () => {
    const { c, rec, list } = setup();
    rec.move(targetOf(chat('b')));
    rec.shown(page('b', 'knowledge'), false);
    c.to(4000);
    rec.shown(chat('b'), false);
    c.advance(SETTLE_MS);
    expect(list()).toEqual([chat('b')]);
  });

  it('a session link into a cold project whose chat opens at 4 s: one entry', () => {
    const { c, rec, list } = setup();
    rec.move(targetOf(chat('b')));
    c.to(4000);
    rec.shown(chat('b'), false);
    c.advance(SETTLE_MS);
    expect(list()).toEqual([chat('b')]);
  });

  it('a switch to any page of a project ends on its first settled page', () => {
    const { c, rec, list } = setup();
    rec.move({ vault: 'b', kind: 'page', place: null });
    rec.shown(page('b', 'lab'), false);
    c.advance(SETTLE_MS);
    expect(list()).toEqual([page('b', 'lab')]);
  });

  it('a byOwner report during a move ends it, recording what had settled first, then the new place', () => {
    const { c, rec, list } = setup();
    rec.move(targetOf(page('b', 'whiteboards', 'y')));
    rec.shown(page('b', 'tasks'), false);
    c.advance(SETTLE_MS);
    rec.shown(page('b', 'knowledge'), true);
    c.advance(SETTLE_MS);
    expect(list()).toEqual([page('b', 'tasks'), page('b', 'knowledge')]);
  });

  it('a differing landing report never ends a move early (only its target, bound or owner do)', () => {
    const { c, rec, list } = setup();
    rec.move(targetOf(chat('b')));
    rec.shown(page('b', 'tasks'), false);
    c.advance(CHAT_MOVE_MAX_MS - 1);
    expect(list()).toEqual([]);
    c.advance(1);
    expect(list()).toEqual([page('b', 'tasks')]);
  });

  it('focused-window ends a move at once and lands nothing else', () => {
    const { c, rec, list } = setup();
    const id = rec.move(targetOf(page('b', 'tasks')));
    rec.focusedWindow(id);
    expect(rec.inFlight()).toBeNull();
    c.advance(PAGE_MOVE_MAX_MS);
    expect(list()).toEqual([]);
  });
});

describe('navRecorder: steps', () => {
  /** A·Boards·X → B·Boards → B·Tasks, each settled. */
  function walked() {
    const s = setup();
    for (const p of [page('a', 'whiteboards', 'x'), page('b', 'whiteboards', 'y'), page('b', 'tasks')]) {
      s.rec.shown(p, true);
      s.c.advance(SETTLE_MS);
    }
    return s;
  }

  it('a step into a mounted project now on another page commits without truncating forward', () => {
    const { c, rec, history } = walked();
    const step = rec.step(-1, none);
    expect(step?.target).toEqual(page('b', 'whiteboards', 'y'));
    rec.shown(page('b', 'whiteboards', 'y'), false);
    c.advance(SETTLE_MS);
    expect(history.entries()).toEqual({ list: [page('a', 'whiteboards', 'x'), page('b', 'whiteboards', 'y'), page('b', 'tasks')], cursor: 1 });
    expect(history.peekForward(none)).toEqual(page('b', 'tasks'));
  });

  it('a step to a cold project\'s Chat that opens at 5 s commits and → still works', () => {
    const s = setup();
    for (const p of [chat('a'), page('b', 'tasks')]) { s.rec.shown(p, true); s.c.advance(SETTLE_MS); }
    s.rec.step(-1, none);
    s.rec.shown(page('a', 'tasks'), false);
    s.c.advance(5000);
    s.rec.shown(chat('a'), false);
    s.c.advance(SETTLE_MS);
    expect(s.history.entries().cursor).toBe(0);
    expect(s.rec.step(1, none)?.target).toEqual(page('b', 'tasks'));
  });

  it('double ← before the first lands walks two back; the replaced step drops its intent', () => {
    const { c, rec, history } = walked();
    let dropped = 0;
    rec.step(-1, none, () => { dropped += 1; });
    const second = rec.step(-1, none);
    expect(second?.target).toEqual(page('a', 'whiteboards', 'x'));
    expect(dropped).toBe(1);
    rec.shown(page('a', 'whiteboards', 'x'), false);
    c.advance(SETTLE_MS);
    expect(history.entries().cursor).toBe(0);
    expect(history.entries().list).toHaveLength(3);
  });

  it('a refused landing (the ceiling) aborts: the cursor stays where it was', () => {
    const { rec, history } = walked();
    const step = rec.step(-1, none);
    rec.refused(step!.id);
    expect(history.entries().cursor).toBe(2);
  });

  it('a byOwner report during a step aborts it and records the new place', () => {
    const { c, rec, history } = walked();
    rec.step(-1, none);
    rec.shown(page('b', 'lab'), true);
    c.advance(SETTLE_MS);
    expect(history.entries().list.map((p) => (p.kind === 'page' ? p.page : 'chat'))).toEqual(['whiteboards', 'whiteboards', 'tasks', 'lab']);
  });

  it('at the bound, a neighbour page of the same project and kind commits in place', () => {
    const { c, rec, history } = walked();
    rec.step(-1, none);
    rec.shown(page('b', 'lab'), false);
    c.advance(PAGE_MOVE_MAX_MS);
    expect(history.entries()).toEqual({ list: [page('a', 'whiteboards', 'x'), page('b', 'lab'), page('b', 'tasks')], cursor: 1 });
  });

  it('focused-window commits the step at that entry and lands nothing else', () => {
    const { c, rec, history } = walked();
    const step = rec.step(-1, none);
    rec.focusedWindow(step!.id);
    c.advance(PAGE_MOVE_MAX_MS);
    expect(history.entries().cursor).toBe(1);
    expect(history.entries().list).toHaveLength(3);
  });

  it('W1-3: A·Boards·X → B·Boards → B·Tasks; ← B·Boards, ← A·Boards·X, → B·Boards, → B·Tasks', () => {
    const { c, rec } = walked();
    const land = (dir: -1 | 1) => {
      const s = rec.step(dir, none);
      rec.shown(s!.target, false);
      c.advance(SETTLE_MS);
      return s!.target;
    };
    expect(land(-1)).toEqual(page('b', 'whiteboards', 'y'));
    expect(land(-1)).toEqual(page('a', 'whiteboards', 'x'));
    expect(land(1)).toEqual(page('b', 'whiteboards', 'y'));
    expect(land(1)).toEqual(page('b', 'tasks'));
  });
});

describe('navRecorder: chat bound drift', () => {
  it('CHAT_MOVE_MAX_MS covers AgentSurface\'s own wait for a linked chat', () => {
    const src = readFileSync(join(__dirname, '../../dashboard/src/components/sleepy/AgentSurface.tsx'), 'utf8');
    const num = (name: string) => Number((src.match(new RegExp(`const ${name} = ([\\d_]+);`))?.[1] ?? 'NaN').replace(/_/g, ''));
    const wait = num('LINKED_SESSION_WAIT_MS');
    const slack = num('ARRIVAL_SLACK_MS');
    expect(Number.isFinite(wait) && Number.isFinite(slack)).toBe(true);
    expect(CHAT_MOVE_MAX_MS).toBeGreaterThanOrEqual(wait + slack);
  });
});
