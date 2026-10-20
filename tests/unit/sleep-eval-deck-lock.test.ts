import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDeckSubmitter } from '../../dashboard/src/components/tasks/sleepEvalSubmit.js';

/**
 * The sleep-eval deck posts ONE label per card. A saved answer leaves the card in hand for
 * its 180 ms exit; a second tap, a held key's auto-repeat or a swipe in that window used to
 * label the same card twice and then skip the next one unseen. And the gate must stay shut
 * until the NEXT card has committed, not merely until the exit timer queued it.
 */

afterEach(() => { vi.useRealTimers(); });

function deckFor(o: { fail?: () => boolean } = {}) {
  const posted: string[] = [];
  const exits: string[] = [];
  const errors: unknown[] = [];
  let queued = 0;
  const deck = createDeckSubmitter<{ id: string }>({
    save: async (input) => { if (o.fail?.()) throw new Error('offline'); posted.push(input.id); },
    leave: (dir) => { exits.push(dir); },
    // setIndex: queues the next card's render; React commits it later.
    next: () => { queued += 1; },
    exitMs: 180,
    onError: (e) => { errors.push(e); },
  });
  return { deck, posted, exits, errors, queued: () => queued };
}

describe('the sleep-eval deck labels a card once', () => {
  it('drops a second answer while the first is saving and while the card is still leaving', async () => {
    vi.useFakeTimers();
    const { deck, posted, exits } = deckFor();
    deck.shown('orbit-1');

    // The tap and the key repeat, both before the save has resolved.
    const first = deck.submit({ id: 'orbit-1' }, 'right');
    const repeat = deck.submit({ id: 'orbit-1' }, 'right');
    expect(await first).toBe(true);
    expect(await repeat).toBe(false);
    // Saved, card sliding out, not released yet: a swipe still lands on the same card.
    expect(await deck.submit({ id: 'orbit-1' }, 'left')).toBe(false);
    expect(posted).toEqual(['orbit-1']);
    expect(exits).toEqual(['right']);

    vi.advanceTimersByTime(180);
    deck.shown('orbit-2'); // the next card has committed
    expect(await deck.submit({ id: 'orbit-2' }, 'left')).toBe(true);
    expect(posted).toEqual(['orbit-1', 'orbit-2']);
  });

  it('the exit timer only queues the next card: the gate opens when it commits, and only for it', async () => {
    vi.useFakeTimers();
    const { deck, posted, exits, queued } = deckFor();
    deck.shown('orbit-1');
    expect(await deck.submit({ id: 'orbit-1' }, 'right')).toBe(true);

    vi.advanceTimersByTime(179);
    expect(queued()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(queued()).toBe(1); // setIndex ran; React has not committed orbit-2 yet

    // A tap landing between setIndex and the commit still reaches orbit-1's handlers.
    expect(await deck.submit({ id: 'orbit-1' }, 'right')).toBe(false);
    expect(deck.busy).toBe(true);
    expect(deck.accepts('orbit-2')).toBe(false);

    deck.shown('orbit-2'); // the layout effect keyed on the card
    // The window key listener re-subscribes in a passive effect, later: it may still name orbit-1.
    expect(deck.accepts('orbit-1')).toBe(false);
    expect(await deck.submit({ id: 'orbit-1' }, 'right')).toBe(false);
    expect(await deck.submit({ id: 'orbit-2' }, 'left')).toBe(true);
    vi.advanceTimersByTime(180);

    // Two answers, two cards, one advance each: nothing labelled twice, nothing skipped.
    expect(posted).toEqual(['orbit-1', 'orbit-2']);
    expect(exits).toEqual(['right', 'left']);
    expect(queued()).toBe(2);

    deck.shown(null); // the deck is done
    expect(await deck.submit({ id: 'orbit-2' }, 'left')).toBe(false);
  });

  it('a failed save gives the card back for a retry and never starts the exit', async () => {
    vi.useFakeTimers();
    let fail = true;
    const { deck, errors, exits, queued } = deckFor({ fail: () => fail });
    deck.shown('orbit-1');
    expect(await deck.submit({ id: 'orbit-1' }, 'right')).toBe(false);
    expect(errors).toHaveLength(1);
    expect(exits).toEqual([]);
    vi.advanceTimersByTime(180);
    expect(queued()).toBe(0);
    fail = false;
    expect(await deck.submit({ id: 'orbit-1' }, 'right')).toBe(true);
    expect(exits).toEqual(['right']);
  });

  it('the deck routes every answer through the gate, opens it on commit, ignores key repeats and takes no pointer input while leaving', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'tasks', 'SleepEvalDeck.tsx'), 'utf-8');
    expect(src).toContain('createDeckSubmitter<LabelInput>(');
    // Opened by a layout effect keyed on the card, never from the exit timer.
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{\s*submitter\.current\?\.shown\(cardId\);\s*\}, \[index, cardId\]\);/);
    expect(src).toMatch(/const cardId = card\?\.id \?\? null;/);
    const next = src.slice(src.indexOf('next: () => {'), src.indexOf('exitMs: 180,'));
    expect(next).toContain('setIndex((i) => i + 1);');
    expect(next).not.toMatch(/shown\(|release\(/);
    expect(src).not.toMatch(/setTimeout\(/);
    // Every answer names the card it is for, and the gate checks it is the one on screen.
    expect(src).toContain('if (!submitter.current?.accepts(input.id)) return;');
    expect(src).toContain('!submitter.current?.accepts(card.id)) return;');
    expect(src).toMatch(/if \(e\.repeat \|\|/);
    expect(src).toContain("pointerEvents: leaving ? 'none' : undefined");
    expect(src).not.toContain('save.mutateAsync(input);\n      advance(dir);');
  });
});
