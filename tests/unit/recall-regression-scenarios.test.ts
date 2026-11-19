/**
 * Standing recall regression set, query half (2026-11-20 diagnosis: the recall evals never saw a framed
 * turn). The gold corpus stored each turn as the PRODUCT's own query (`turnQuery` -> `recallQuery`), so an
 * agenda line, a card or a reply quote was already cut out before any eval read it, and no eval could
 * notice when the query lost the turn's subject. These cases feed the RAW framed prompt, the shape the
 * owner's surfaces really send, and assert the subject survives.
 *
 * Fixtures are synthetic (tests/helpers/recall-regression-fixtures.ts, a fictional invoicing project). The integration half, which runs the
 * real prompt hook, is tests/integration/recall-regression-scenarios.test.ts.
 *
 * `it.fails` = a scenario that is broken on today's dev (0.41.20 `24f62d121` cut the frame out of the query).
 * It stays green while the product is broken and turns RED the moment the fix lands: the fixing change then
 * flips it to `it`, and from then on it guards the fix. Never delete one to make the suite green.
 */
import { describe, expect, it } from 'vitest';
import { recallQuery } from '../../src/lib/agents/team-roster.js';
import { aboutHeads } from '../../src/lib/super/types.js';
import { FRAMED, NUMBER_TURN, SUBJECT } from '../helpers/recall-regression-fixtures.js';

describe('fixtures are real frames (guards the guard)', () => {
  it.each(Object.entries(FRAMED))('%s parses as one reference head', (_k, prompt) => {
    expect(aboutHeads(prompt)).toHaveLength(1);
  });

  it('the owner words alone never name the subject', () => {
    for (const p of Object.values(FRAMED)) {
      const own = p.slice(p.lastIndexOf('\n\n') + 2);
      expect(own).not.toMatch(SUBJECT);
    }
  });

  it('a plain turn naming the subject keeps it (control: the query path itself works)', () => {
    expect(recallQuery('is the Northwind invoice export tested?')).toMatch(SUBJECT);
  });
});

describe('framed turn: the recall query keeps the frame subject', () => {
  // REGRESSED since 0.41.20 (24f62d121, ownerWords strips aboutHeads). Waits for product fix 1
  // (the frame subject goes back into the query; Doc's 2026-11-20 recall regression diagnosis).
  it.fails('agenda line: the line text is searched', () => {
    expect(recallQuery(FRAMED.agenda)).toMatch(SUBJECT);
  });
  it.fails('reply: the quoted message is searched', () => {
    expect(recallQuery(FRAMED.reply)).toMatch(SUBJECT);
  });
  it.fails('card: the card quote is searched', () => {
    expect(recallQuery(FRAMED.card)).toMatch(SUBJECT);
  });
  it.fails('task: the task named by the header is searched', () => {
    expect(recallQuery(FRAMED.task)).toMatch(SUBJECT);
  });
  it.fails('a framed turn whose own words are short still gets a query at all', () => {
    // "ok" alone is under RECALL_QUERY_MIN_CHARS once the quote is gone: today null, no recall.
    expect(recallQuery('[Reply to message ref=k3f9q0 from=super]\nquote: "The Northwind ledger CSV is ready"\n\nok')).not.toBeNull();
  });
});

describe('very short / number-only owner turn', () => {
  it('a phone number with a short ask is still a query (not dropped as a machine turn)', () => {
    expect(recallQuery(NUMBER_TURN)).not.toBeNull();
  });
});
