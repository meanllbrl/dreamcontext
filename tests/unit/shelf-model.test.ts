/**
 * Unit tests for `shelfModel.ts` — the shelf's ceiling, its demotion order, its two overflow
 * mechanisms, and the id-keyed fold.
 *
 * The CEILING is the property worth the most here, and it is a safety property, not a
 * cosmetic one: the shelf sits on the composer, so a third row does not merely look wrong —
 * it eats the conversation, which is the single failure mode this placement has. It is
 * therefore tested against an adversarial input (twenty pins all demanding a row) rather
 * than against the happy path, because the criterion is "no sequence of agent blocks,
 * however many pins it sends, produces a third row" and an agent is exactly what sends them.
 */
import { describe, it, expect } from 'vitest';
import {
  effectiveWeight, clampLede, layoutShelf, foldViews, checkoutFact, restates,
  SHELF_MAX_ROWS, SHELF_DETAIL_PANE_FRACTION,
  type CheckoutFacts, type ShelfEntry, type ShelfFact,
} from '../../dashboard/src/lib/shelfModel.js';
import {
  MAX_PINS_PER_CONVERSATION, MAX_PIN_LEDE_CHARS, MAX_TAG_LABEL_CHARS,
  type ChatViewSpec,
} from '../../dashboard/src/lib/chatViewSpec.js';

function pin(id: string, at: number, extra: Partial<Extract<ShelfEntry, { kind: 'pin' }>> = {}): ShelfEntry {
  return { kind: 'pin', id, weight: 'tag', facts: [{ label: id }], updatedAt: at, ...extra };
}
function progress(task: string, at: number): ShelfEntry {
  return { kind: 'progress', id: `progress:${task}`, task, updatedAt: at };
}
const NO_FACTS: ShelfFact[] = [];

describe('effectiveWeight — weight is a request, not a command', () => {
  it('honours a row that has prose to open', () => {
    expect(effectiveWeight(pin('a', 1, { weight: 'row', detail: 'lots of prose' }))).toBe('row');
  });

  it('honours a row whose lede is too long for a chip', () => {
    const lede = 'x'.repeat(MAX_TAG_LABEL_CHARS + 1);
    expect(effectiveWeight(pin('a', 1, { weight: 'row', lede }))).toBe('row');
  });

  it('DEMOTES a row whose content is tag-sized — a label must not spend the ceiling', () => {
    expect(effectiveWeight(pin('a', 1, { weight: 'row', lede: 'short' }))).toBe('tag');
    expect(effectiveWeight(pin('a', 1, { weight: 'row' }))).toBe('tag');
  });

  it('never promotes a tag, whatever it carries', () => {
    expect(effectiveWeight(pin('a', 1, { weight: 'tag', detail: 'lots of prose' }))).toBe('tag');
  });

  it('always gives progress a row — a track and a live criterion do not fit a chip', () => {
    expect(effectiveWeight(progress('t', 1))).toBe('row');
  });
});

describe('clampLede', () => {
  it('leaves a short single line alone and reports no clamp', () => {
    expect(clampLede('16 tasks deleted.')).toEqual({ lede: '16 tasks deleted.', clamped: false });
  });

  it('cuts at the first line break and MARKS it — the rest is behind the affordance', () => {
    const r = clampLede('Session summary\n\nAll the prose that follows.');
    expect(r.lede).toBe('Session summary');
    expect(r.clamped).toBe(true);
  });

  it(`cuts at ${MAX_PIN_LEDE_CHARS} characters and marks it`, () => {
    const r = clampLede('y'.repeat(MAX_PIN_LEDE_CHARS + 40));
    expect(r.lede.length).toBeLessThanOrEqual(MAX_PIN_LEDE_CHARS);
    expect(r.clamped).toBe(true);
  });
});

describe('layoutShelf — the ceiling', () => {
  it('exposes at most ONE open row for any input', () => {
    const rows = Array.from({ length: 20 }, (_, i) => pin(`p${i}`, i, { weight: 'row', detail: `d${i}` }));
    const layout = layoutShelf(rows, NO_FACTS);
    expect(layout.row).not.toBeNull();
    // One row + the tag line = SHELF_MAX_ROWS. There is no list to overflow.
    expect(1 + 1).toBe(SHELF_MAX_ROWS);
    expect(layout.demotedIds).toHaveLength(19);
  });

  it('gives the row to the NEWEST row-weight pin', () => {
    const layout = layoutShelf(
      [pin('old', 1, { weight: 'row', detail: 'd' }), pin('new', 9, { weight: 'row', detail: 'd' })],
      NO_FACTS,
    );
    expect(layout.row?.id).toBe('new');
  });

  it('gives the row to PROGRESS even when a newer row-pin exists — a live run owns it', () => {
    const layout = layoutShelf(
      [progress('t', 1), pin('newer', 99, { weight: 'row', detail: 'd' })],
      NO_FACTS,
    );
    expect(layout.row?.kind).toBe('progress');
    expect(layout.demotedIds).toEqual(['newer']);
  });

  it('demotes displaced rows OLDEST FIRST — it demoted, it did not close', () => {
    const layout = layoutShelf(
      [pin('c', 3, { weight: 'row', detail: 'd' }),
        pin('a', 1, { weight: 'row', detail: 'd' }),
        pin('b', 2, { weight: 'row', detail: 'd' })],
      NO_FACTS,
    );
    expect(layout.row?.id).toBe('c');
    expect(layout.demotedIds).toEqual(['a', 'b']);
    expect(layout.tags.filter((t) => t.demoted).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('rests as a tag line with no open row when nothing wants one', () => {
    const layout = layoutShelf([pin('a', 1), pin('b', 2)], NO_FACTS);
    expect(layout.row).toBeNull();
    expect(layout.tags.map((t) => t.label)).toEqual(['a', 'b']);
  });

  it('renders nothing at all from an empty shelf', () => {
    const layout = layoutShelf([], NO_FACTS);
    expect(layout).toEqual({ row: null, tags: [], demotedIds: [], notices: [] });
  });
});

describe('layoutShelf — session facts lead and cannot be dismissed', () => {
  const facts: ShelfFact[] = [
    { label: 'feat/pin-surface', icon: 'branch' },
    { label: 'worktree', marker: true },
  ];

  it('puts server facts first, before every agent tag', () => {
    const layout = layoutShelf([pin('agent', 5)], facts);
    expect(layout.tags.map((t) => t.label)).toEqual(['feat/pin-surface', 'worktree', 'agent']);
  });

  it('marks server facts NOT dismissable and agent tags dismissable', () => {
    const layout = layoutShelf([pin('agent', 5)], facts);
    expect(layout.tags.map((t) => t.dismissable)).toEqual([false, false, true]);
  });

  it('keeps agent tags in age order so a new pin appends instead of reshuffling', () => {
    const layout = layoutShelf([pin('third', 3), pin('first', 1), pin('second', 2)], NO_FACTS);
    expect(layout.tags.map((t) => t.label)).toEqual(['first', 'second', 'third']);
  });
});

/**
 * The fold is GONE (owner, 2026-08-23, after live testing) — tags are always visible and the
 * renderer wraps. These tests are the guard against it creeping back: the model must never
 * hold a tag back, at any count, for any reason.
 */
describe('layoutShelf — every tag is returned, nothing is ever held back', () => {
  it('returns all of them well past the old per-line cap, in one list', () => {
    const many = Array.from({ length: 40 }, (_, i) => pin(`p${i}`, i));
    const layout = layoutShelf(many, NO_FACTS);
    expect(layout.tags).toHaveLength(40);
    expect(layout.tags.map((t) => t.label)).toEqual(many.map((_, i) => `p${i}`));
  });

  it('adds no notice for a long tag line — there is nothing to apologise for', () => {
    const many = Array.from({ length: 40 }, (_, i) => pin(`p${i}`, i));
    expect(layoutShelf(many, NO_FACTS).notices).toEqual([]);
    expect(layoutShelf([pin('a', 1)], NO_FACTS).notices).toEqual([]);
  });

  it('exposes no overflow bucket at all — a second list is how a fold comes back', () => {
    const layout = layoutShelf(Array.from({ length: 40 }, (_, i) => pin(`p${i}`, i)), NO_FACTS);
    expect(Object.keys(layout).sort()).toEqual(['demotedIds', 'notices', 'row', 'tags']);
  });

  it('gives every tag a unique key, even across pins with several facts', () => {
    const layout = layoutShelf([
      pin('a', 1, { facts: [{ label: 'x' }, { label: 'y' }] }),
      pin('b', 2, { facts: [{ label: 'x' }] }),
    ], NO_FACTS);
    const ids = layout.tags.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('foldViews — id-keyed, update in place, loud eviction', () => {
  const pinView = (id: string, label: string): ChatViewSpec =>
    ({ type: 'pin', id, weight: 'tag', facts: [{ label }] });

  it('appends a new pin', () => {
    const { entries, evicted } = foldViews([], [pinView('a', 'one')], 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('a');
    expect(entries[0].updatedAt).toBe(10);
    expect(evicted).toBe(0);
  });

  it('UPDATES the same id in place and never produces a second', () => {
    const first = foldViews([], [pinView('a', 'one')], 10).entries;
    const { entries } = foldViews(first, [pinView('a', 'two')], 20);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind === 'pin' && entries[0].facts[0].label).toBe('two');
    expect(entries[0].updatedAt).toBe(20);
  });

  it('keeps an updated pin in its ORIGINAL position so the tag line does not reshuffle', () => {
    const seeded = foldViews([], [pinView('a', 'A'), pinView('b', 'B'), pinView('c', 'C')], 1).entries;
    const { entries } = foldViews(seeded, [pinView('a', 'A2')], 5);
    expect(entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('keys progress by its task, so re-reporting a run updates one row', () => {
    const one = foldViews([], [{ type: 'progress', task: 't' }], 1).entries;
    const { entries } = foldViews(one, [{ type: 'progress', task: 't' }], 2);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('progress:t');
  });

  it('ignores view types that are not shelf types', () => {
    const { entries } = foldViews([], [{ type: 'chart', render: 'line', series: [] } as ChatViewSpec], 1);
    expect(entries).toEqual([]);
  });

  it('builds a lede from detail and MARKS it clamped — a cut line is never shown as complete', () => {
    const { entries } = foldViews([], [{
      type: 'pin', id: 'p', weight: 'row', facts: [], detail: 'Session summary\n\nlots more prose',
    }], 1);
    const entry = entries[0];
    expect(entry.kind === 'pin' && entry.lede).toBe('Session summary');
    expect(entry.kind === 'pin' && entry.ledeClamped).toBe(true);
  });

  it('does NOT mark an author-written lede as clamped', () => {
    const { entries } = foldViews([], [{
      type: 'pin', id: 'p', weight: 'row', facts: [], lede: 'Short and whole.', detail: 'more',
    }], 1);
    expect(entries[0].kind === 'pin' && entries[0].ledeClamped).toBeUndefined();
  });

  it(`evicts the OLDEST past ${MAX_PINS_PER_CONVERSATION} and REPORTS how many`, () => {
    const views = Array.from({ length: MAX_PINS_PER_CONVERSATION + 3 },
      (_, i) => pinView(`p${i}`, `l${i}`));
    const { entries, evicted } = foldViews([], views, 1);
    expect(entries).toHaveLength(MAX_PINS_PER_CONVERSATION);
    expect(evicted).toBe(3);
    expect(entries[0].id).toBe('p3'); // p0..p2 were the oldest
  });

  it('reports nothing evicted while under the cap', () => {
    expect(foldViews([], [pinView('a', 'x')], 1).evicted).toBe(0);
  });
});

/**
 * The DROP — the other half of the id-keyed contract, and the reason it had to exist: with
 * update alone, an agent could keep a pin current forever but could never retire one, so a
 * fact that had stopped being true stood on the shelf until the user dismissed it by hand.
 *
 * The position tests matter as much as the removal one. `foldViews` was rewritten onto a Map
 * to get `delete` without invalidating indices, and a Map that reorders on `set` would break
 * the older, still-load-bearing rule that an UPDATED pin keeps its place so the tag line does
 * not reshuffle under the user's cursor.
 */
describe('foldViews — the drop', () => {
  const pinView = (id: string, label: string): ChatViewSpec =>
    ({ type: 'pin', id, weight: 'tag', facts: [{ label }] });
  const dropView = (id: string): ChatViewSpec =>
    ({ type: 'pin', id, weight: 'tag', facts: [], drop: true });

  it('REMOVES the pin it names and reports the id it retired', () => {
    const seeded = foldViews([], [pinView('a', 'A'), pinView('b', 'B')], 1).entries;
    const { entries, retired } = foldViews(seeded, [dropView('a')], 2);
    expect(entries.map((e) => e.id)).toEqual(['b']);
    expect(retired).toEqual(['a']);
  });

  it('leaves every neighbour exactly where it was', () => {
    const seeded = foldViews([], [pinView('a', 'A'), pinView('b', 'B'), pinView('c', 'C')], 1).entries;
    const { entries } = foldViews(seeded, [dropView('b')], 2);
    expect(entries.map((e) => e.id)).toEqual(['a', 'c']);
    expect(entries.every((e) => e.updatedAt === 1)).toBe(true);
  });

  it('is a SILENT no-op for an id the shelf is not holding', () => {
    const seeded = foldViews([], [pinView('a', 'A')], 1).entries;
    const { entries, retired, evicted } = foldViews(seeded, [dropView('gone')], 2);
    expect(entries.map((e) => e.id)).toEqual(['a']);
    expect(retired).toEqual([]);
    expect(evicted).toBe(0);
  });

  it('drops nothing at all on an empty shelf', () => {
    const { entries, retired } = foldViews([], [dropView('a')], 1);
    expect(entries).toEqual([]);
    expect(retired).toEqual([]);
  });

  it('re-sending a dropped id brings it back, as the NEWEST entry', () => {
    const seeded = foldViews([], [pinView('a', 'A'), pinView('b', 'B')], 1).entries;
    const gone = foldViews(seeded, [dropView('a')], 2).entries;
    const { entries } = foldViews(gone, [pinView('a', 'A-again')], 3);
    expect(entries.map((e) => e.id)).toEqual(['b', 'a']);
    expect(entries[1].updatedAt).toBe(3);
  });

  it('applies a drop and an add from the SAME message in the order they were written', () => {
    const seeded = foldViews([], [pinView('a', 'A')], 1).entries;
    const { entries, retired } = foldViews(seeded, [dropView('a'), pinView('b', 'B')], 2);
    expect(entries.map((e) => e.id)).toEqual(['b']);
    expect(retired).toEqual(['a']);
  });

  it('a drop followed by the same id in one message ends with the pin PRESENT', () => {
    const seeded = foldViews([], [pinView('a', 'old')], 1).entries;
    const { entries } = foldViews(seeded, [dropView('a'), pinView('a', 'new')], 2);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind === 'pin' && entries[0].facts[0].label).toBe('new');
  });

  it('reports every id it retired when a message drops several', () => {
    const seeded = foldViews([], [pinView('a', 'A'), pinView('b', 'B'), pinView('c', 'C')], 1).entries;
    const { entries, retired } = foldViews(seeded, [dropView('a'), dropView('c')], 2);
    expect(entries.map((e) => e.id)).toEqual(['b']);
    expect(retired).toEqual(['a', 'c']);
  });

  it('retires a pin that was over the cap without counting it as an eviction', () => {
    const views = Array.from({ length: MAX_PINS_PER_CONVERSATION },
      (_, i) => pinView(`p${i}`, `l${i}`));
    const full = foldViews([], views, 1).entries;
    const { entries, evicted, retired } = foldViews(full, [dropView('p0')], 2);
    expect(entries).toHaveLength(MAX_PINS_PER_CONVERSATION - 1);
    expect(evicted).toBe(0);
    expect(retired).toEqual(['p0']);
  });

  it('a drop makes room, so a same-message add no longer evicts anyone', () => {
    const views = Array.from({ length: MAX_PINS_PER_CONVERSATION },
      (_, i) => pinView(`p${i}`, `l${i}`));
    const full = foldViews([], views, 1).entries;
    const { entries, evicted } = foldViews(full, [dropView('p0'), pinView('fresh', 'f')], 2);
    expect(entries).toHaveLength(MAX_PINS_PER_CONVERSATION);
    expect(evicted).toBe(0);
    expect(entries.map((e) => e.id)).toContain('fresh');
    expect(entries.map((e) => e.id)).not.toContain('p0');
  });

  it('a pin WITHOUT drop is never treated as one — the field is opt-in', () => {
    const seeded = foldViews([], [pinView('a', 'A')], 1).entries;
    const { entries, retired } = foldViews(seeded, [pinView('a', 'A2')], 2);
    expect(entries).toHaveLength(1);
    expect(retired).toEqual([]);
  });

  it('a drop never removes a progress row — progress has no drop, and its id cannot be spelled', () => {
    const seeded = foldViews([], [{ type: 'progress', task: 't' }], 1).entries;
    // `progress:t` is not a legal pin id (`validatePin` forbids `:`), so this is the closest
    // an agent could get. It must not reach the row.
    const { entries, retired } = foldViews(seeded, [dropView('progress'), dropView('t')], 2);
    expect(entries.map((e) => e.id)).toEqual(['progress:t']);
    expect(retired).toEqual([]);
  });
});

describe('constants', () => {
  it('caps a user-opened detail near 40% of the pane', () => {
    expect(SHELF_DETAIL_PANE_FRACTION).toBeCloseTo(0.4);
  });
});

/**
 * ONE chip for the checkout, never two.
 *
 * The shelf used to push a branch chip AND a worktree chip, which in the ordinary case printed
 * the same word twice — `⑂ worktree-run-progress-live` beside `⊞ run-progress-live`. The owner's
 * verdict on 2026-08-25 was "iki branch gösterimi saçma", and it was silly before any agent
 * pinned anything on top of it.
 */
describe('checkoutFact — the checkout is stated once', () => {
  const base: CheckoutFacts = {
    branch: 'main', defaultBranch: 'main', worktree: false, worktreeName: null, isRepo: true,
  };

  it('a worktree whose branch is IMPLIED by its name yields one chip, not the word twice', () => {
    for (const branch of ['run-progress-live', 'worktree-run-progress-live']) {
      const fact = checkoutFact({
        ...base, branch, worktree: true, worktreeName: 'run-progress-live',
      });
      expect(fact?.label, branch).toBe('run-progress-live');
      expect(fact?.icon).toBe('worktree');
      expect(fact?.marker).toBe(true);
    }
  });

  it('a worktree on a branch of its OWN names both — that is information, not repetition', () => {
    const fact = checkoutFact({
      ...base, branch: 'feat/eur-multicurrency', worktree: true, worktreeName: 'eur-multicurrency',
    });
    expect(fact?.label).toBe('eur-multicurrency · feat/eur-multicurrency');
  });

  it('an unnamed worktree still gets its marker rather than losing the chip', () => {
    const fact = checkoutFact({ ...base, branch: 'x', worktree: true, worktreeName: null });
    expect(fact?.label).toBe('worktree · x');
    expect(fact?.marker).toBe(true);
  });

  it('a worktree on a DETACHED head is still a worktree', () => {
    const fact = checkoutFact({ ...base, branch: null, worktree: true, worktreeName: 'wt-x' });
    expect(fact?.label).toBe('wt-x');
    expect(fact?.note).toMatch(/detached HEAD/);
  });

  it('the main checkout on its default branch is a plain, unmarked chip', () => {
    const fact = checkoutFact(base);
    expect(fact).toMatchObject({ label: 'main', icon: 'branch' });
    expect(fact?.marker).toBeUndefined();
  });

  it('the main checkout OFF its default branch is MARKED — the state the owner misread', () => {
    // Shown a bare `feat/shelf-pin-drop`, the owner read "you are in a different worktree".
    const fact = checkoutFact({ ...base, branch: 'feat/shelf-pin-drop' });
    expect(fact).toMatchObject({ label: 'feat/shelf-pin-drop', icon: 'branch', marker: true });
    expect(fact?.note).toMatch(/main checkout is on feat\/shelf-pin-drop, not main/);
    expect(fact?.note).toMatch(/not a worktree/);
  });

  it('does NOT mark when the default branch is unknown — an unprovable warning is worse than none', () => {
    const fact = checkoutFact({ ...base, branch: 'feat/x', defaultBranch: null });
    expect(fact?.marker).toBeUndefined();
  });

  it('says nothing at all for a non-repo, or a detached head outside a worktree', () => {
    expect(checkoutFact({ ...base, isRepo: false })).toBeNull();
    expect(checkoutFact({ ...base, branch: null })).toBeNull();
  });

  it('caps a pathological label instead of letting it run off the line', () => {
    const fact = checkoutFact({
      ...base, worktree: true, worktreeName: 'w'.repeat(40), branch: 'b'.repeat(40),
    });
    expect(fact!.label.length).toBeLessThanOrEqual(MAX_TAG_LABEL_CHARS);
    expect(fact!.label.endsWith('…')).toBe(true);
  });
});

/**
 * The duplicate the BRIEFING used to ask for. `chat-modes.ts`'s worktree paragraph told the
 * agent to pin the checkout itself whenever the server could not see the move, and the owner's
 * 2026-08-25 screenshot is what that cost: `main` + `wt: eur-multicurrency` +
 * `branch: feat/eur-multicurrency` — three chips, one branch stated twice, the server's copy of
 * it wrong. The briefing no longer asks; this is the net under it.
 */
describe('layoutShelf — an agent tag that restates the checkout is not shown twice', () => {
  const wtFact: ShelfFact = {
    label: 'eur-multicurrency · feat/eur-multicurrency',
    marker: true,
    icon: 'worktree',
    claims: ['eur-multicurrency', 'feat/eur-multicurrency'],
  };

  function tagPin(id: string, at: number, labels: string[]): ShelfEntry {
    return { kind: 'pin', id, weight: 'tag', facts: labels.map((label) => ({ label })), updatedAt: at };
  }

  it('drops exactly the two chips from the screenshot', () => {
    const layout = layoutShelf(
      [tagPin('checkout', 1, ['wt: eur-multicurrency', 'branch: feat/eur-multicurrency'])],
      [wtFact],
    );
    expect(layout.tags.map((t) => t.label)).toEqual([wtFact.label]);
  });

  it('strips the prefix case-insensitively and tolerates `=` and stray spacing', () => {
    const layout = layoutShelf(
      [tagPin('c', 1, ['WT:  eur-multicurrency', 'Branch = FEAT/EUR-MULTICURRENCY', 'worktree: eur-multicurrency'])],
      [wtFact],
    );
    expect(layout.tags).toHaveLength(1);
  });

  it('keeps a tag that says something MORE than the chip does', () => {
    const layout = layoutShelf(
      [tagPin('c', 1, ['branch: feat/eur-multicurrency (rebasing)', ':5173'])],
      [wtFact],
    );
    expect(layout.tags.map((t) => t.label)).toEqual([
      wtFact.label, 'branch: feat/eur-multicurrency (rebasing)', ':5173',
    ]);
  });

  it('never drops a LINK chip, even if its label matches — the url is the payload', () => {
    const layout = layoutShelf(
      [{
        kind: 'pin', id: 'c', weight: 'tag', updatedAt: 1,
        facts: [{ label: 'eur-multicurrency', url: 'http://localhost:5173/' }],
      }],
      [wtFact],
    );
    expect(layout.tags).toHaveLength(2);
  });

  it('suppresses nothing when the server has no facts to duplicate', () => {
    const layout = layoutShelf([tagPin('c', 1, ['wt: whatever', 'branch: whatever'])], NO_FACTS);
    expect(layout.tags).toHaveLength(2);
  });

  it('leaves a DEMOTED row alone — its `⌃` label is an affordance, not a restatement', () => {
    // `detail` is what keeps these at row weight (see `effectiveWeight`), so one really does
    // win the slot and the other really does demote to a tag. That demoted tag's label happens
    // to match a claim, and it must survive anyway: suppressing it would delete the only way
    // back to a panel the user can open.
    const row: ShelfEntry = {
      kind: 'pin', id: 'row', weight: 'row', facts: [],
      lede: 'eur-multicurrency', detail: 'the long prose', updatedAt: 9,
    };
    const layout = layoutShelf([row, { ...row, id: 'row2', updatedAt: 10 }], [wtFact]);
    expect(layout.row?.id).toBe('row2');
    expect(layout.tags.map((t) => t.label)).toEqual([wtFact.label, 'eur-multicurrency']);
    expect(layout.tags[1].demoted).toBe(true);
  });

  it('carries the server fact\'s note onto its tag so the chip can spell the state out', () => {
    const layout = layoutShelf([], [{ label: 'feat/x', icon: 'branch', note: 'the whole sentence' }]);
    expect(layout.tags[0].note).toBe('the whole sentence');
  });
});

describe('restates (pure)', () => {
  const claims = new Set(['main', 'feat/x']);
  it('matches a bare value and every prefix spelling', () => {
    for (const label of ['main', 'wt: main', 'worktree:main', 'branch: main', 'checkout = main', ' MAIN ']) {
      expect(restates(label, claims), label).toBe(true);
    }
  });
  it('does not match a value the server never claimed, or a bare prefix', () => {
    expect(restates('feat/y', claims)).toBe(false);
    expect(restates('branch:', claims)).toBe(false);
    expect(restates('', claims)).toBe(false);
  });
});
