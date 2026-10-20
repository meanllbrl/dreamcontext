import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDeckSubmitter } from '../../dashboard/src/components/tasks/sleepEvalSubmit.js';

/**
 * The sleep-eval deck posts ONE label per card. A saved answer leaves the card in hand for
 * its 180 ms exit; a second tap, a held key's auto-repeat or a swipe in that window used to
 * label the same card twice and then skip the next one unseen.
 */

describe('the sleep-eval deck labels a card once', () => {
  it('drops a second answer while the first is saving and while the card is still leaving', async () => {
    const posted: string[] = [];
    const exits: string[] = [];
    const deck = createDeckSubmitter<{ id: string }>({
      save: async (input) => { posted.push(input.id); },
      advance: (dir) => { exits.push(dir); },
      onError: () => {},
    });

    // The tap and the key repeat, both before the save has resolved.
    const first = deck.submit({ id: 'orbit-1' }, 'right');
    const repeat = deck.submit({ id: 'orbit-1' }, 'right');
    expect(await first).toBe(true);
    expect(await repeat).toBe(false);
    // Saved, card sliding out, not released yet: a swipe still lands on the same card.
    expect(await deck.submit({ id: 'orbit-1' }, 'left')).toBe(false);
    expect(posted).toEqual(['orbit-1']);
    expect(exits).toEqual(['right']);

    deck.release(); // the next card is in place
    expect(await deck.submit({ id: 'orbit-2' }, 'left')).toBe(true);
    expect(posted).toEqual(['orbit-1', 'orbit-2']);
  });

  it('a failed save gives the card back for a retry and never starts the exit', async () => {
    let fail = true;
    const errors: unknown[] = [];
    const exits: string[] = [];
    const deck = createDeckSubmitter<{ id: string }>({
      save: async () => { if (fail) throw new Error('offline'); },
      advance: (dir) => { exits.push(dir); },
      onError: (e) => { errors.push(e); },
    });
    expect(await deck.submit({ id: 'orbit-1' }, 'right')).toBe(false);
    expect(errors).toHaveLength(1);
    expect(exits).toEqual([]);
    fail = false;
    expect(await deck.submit({ id: 'orbit-1' }, 'right')).toBe(true);
    expect(exits).toEqual(['right']);
  });

  it('the deck routes every answer through the gate, ignores key repeats and takes no pointer input while leaving', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'tasks', 'SleepEvalDeck.tsx'), 'utf-8');
    expect(src).toContain('createDeckSubmitter<LabelInput>(');
    expect(src).toContain('submitter.current?.release();');
    expect(src).toMatch(/if \(e\.repeat \|\|/);
    expect(src).toContain("pointerEvents: leaving ? 'none' : undefined");
    expect(src).not.toContain('save.mutateAsync(input);\n      advance(dir);');
  });
});
