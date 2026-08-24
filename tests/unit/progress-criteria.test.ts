/**
 * The run-progress CHECKLIST — `listCheckboxes` (src/lib/markdown.ts), the criteria the
 * `/api/agent/task-progress` route ships, and the pure reasoning the panel draws from
 * (dashboard/src/lib/progressModel.ts).
 *
 * The defect these tests exist to keep closed: the panel used to state `8/20` in its header
 * and render TWO rows, because the route only ever derived two strings (owner, 2026-08-24).
 * So the property under test throughout is not "the list looks right" — it is that the LIST
 * and the NUMBER BESIDE IT can never describe different sets of lines, including on the
 * malformed task files where a lenient parser would quietly drop one and leave 19 rows under
 * a 20.
 *
 * Root vitest runs under plain Node with no jsdom (see chat-shelf-placement.test.ts), which is
 * exactly why `progressModel.ts` holds no React: everything decidable without a DOM is decided
 * there and asserted here. The rendered result is asserted separately, against real boxes in
 * real Chromium, by scripts/verify/chat-shelf-ui.mjs.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countCheckboxes, firstUnticked, listCheckboxes } from '../../src/lib/markdown.js';
import { handleAgentTaskProgress, type TaskProgress } from '../../src/server/routes/agent-shelf.js';
import {
  criterionKey, groupCriteria, inFlightIndex, newlyTicked, sinceLabel,
} from '../../dashboard/src/lib/progressModel.js';

// ─── listCheckboxes: one reader, one grammar ────────────────────────────────────────

describe('listCheckboxes', () => {
  it('returns one entry per checkbox, ticked state and all, in document order', () => {
    const body = [
      '- [x] the first thing',
      '- [ ] the second thing',
      '* [X] an asterisk bullet, capital X',
    ].join('\n');
    expect(listCheckboxes(body)).toEqual([
      { done: true, text: 'the first thing', group: null },
      { done: false, text: 'the second thing', group: null },
      { done: true, text: 'an asterisk bullet, capital X', group: null },
    ]);
  });

  it('carries the nearest ### heading above each line as its group', () => {
    const body = [
      '### Part A — the payload',
      '- [x] A1',
      '- [ ] A2',
      '### Validation',
      '- [ ] V1',
    ].join('\n');
    expect(listCheckboxes(body).map((c) => c.group))
      .toEqual(['Part A — the payload', 'Part A — the payload', 'Validation']);
  });

  it('gives a criterion ABOVE the first heading a null group, never the heading below it', () => {
    const body = ['- [ ] written before any milestone', '### Part A', '- [ ] A1'].join('\n');
    expect(listCheckboxes(body).map((c) => c.group)).toEqual([null, 'Part A']);
  });

  it('is null throughout when the section has no headings at all', () => {
    expect(listCheckboxes('- [ ] one\n- [ ] two').every((c) => c.group === null)).toBe(true);
  });

  it('reads #### too, and drops the trailing hashes of a closed ATX heading', () => {
    expect(listCheckboxes('#### Sub-phase ####\n- [ ] x')[0].group).toBe('Sub-phase');
  });

  it('strips emphasis in both the criterion and its heading, and keeps paths intact', () => {
    const body = ['### **Part A** — `wiring`', '- [ ] `_dream_context/state/x.md` is the source'].join('\n');
    const [c] = listCheckboxes(body);
    expect(c.group).toBe('Part A — wiring');
    // The conservative rule `firstUnticked` already follows: a single underscore is a path far
    // more often than an italic, so `_dream_context` must survive.
    expect(c.text).toBe('_dream_context/state/x.md is the source');
  });

  it('an empty ### resets to ungrouped rather than becoming a blank heading on screen', () => {
    expect(listCheckboxes('### Part A\n- [ ] a\n###   \n- [ ] b').map((c) => c.group))
      .toEqual(['Part A', null]);
  });

  // ── The invariant the whole feature rests on ──
  it('length ALWAYS equals countCheckboxes().total — including on a malformed line', () => {
    // `firstUnticked` skips a `- [ ]` with no text; a LIST that skipped it would render 2 rows
    // under a header reading 3, which is the exact defect being fixed. So it is KEPT, empty.
    const body = ['- [x] real', '- [ ] ', '- [ ] also real'].join('\n');
    expect(countCheckboxes(body)).toEqual({ total: 3, done: 1 });
    expect(listCheckboxes(body)).toHaveLength(3);
    expect(listCheckboxes(body)[1].text).toBe('');
    // …and the two readers still agree on WHICH line is in flight, because the panel picks the
    // first unticked with non-empty text — the same rule `firstUnticked` applies.
    expect(firstUnticked(body)).toBe('also real');
    expect(listCheckboxes(body)[inFlightIndex(listCheckboxes(body))].text).toBe('also real');
  });

  it('agrees with countCheckboxes on a REAL task body, headings and prose included', () => {
    const body = [
      '### Part A — the payload carries every criterion',
      '',
      '- [x] **A1 · One reader, one grammar.** New `listCheckboxes(sectionBody)` in markdown.ts.',
      'Some prose between criteria that is not a checkbox.',
      '- [ ] **A2 · Each criterion knows its group.**',
      '',
      '### Validation',
      '- [ ] **V1 · `npx tsc --noEmit` clean.**',
    ].join('\n');
    const counted = countCheckboxes(body);
    const listed = listCheckboxes(body);
    expect(listed).toHaveLength(counted.total);
    expect(listed.filter((c) => c.done)).toHaveLength(counted.done);
    expect(listed[0].text).toBe('A1 · One reader, one grammar. New listCheckboxes(sectionBody) in markdown.ts.');
  });
});

// ─── The route ships the list ───────────────────────────────────────────────────────

const FIXTURE = mkdtempSync(join(tmpdir(), 'dc-progress-criteria-'));
const CONTEXT_ROOT = join(FIXTURE, '_dream_context');
const STATE_DIR = join(CONTEXT_ROOT, 'state');

afterAll(() => { rmSync(FIXTURE, { recursive: true, force: true }); });

function writeTask(slug: string, body: string): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, `${slug}.md`), `---\nid: task_${slug}\n---\n${body}`, 'utf-8');
}

function criteriaSection(lines: string[]): string {
  return [
    '## Acceptance Criteria',
    '',
    ...lines,
    '',
    '## Changelog',
    '',
    '### 2026-08-24 - Session Update',
    '- the newest thing that happened',
  ].join('\n');
}

interface Captured { status: number; body: unknown }

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: null };
  const res = {
    writeHead(status: number) { captured.status = status; return this; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : null; },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function get(slug: string, contextRoot: string | null = CONTEXT_ROOT): Promise<TaskProgress> {
  const req = {
    url: `/api/agent/task-progress?slug=${encodeURIComponent(slug)}`,
    headers: { host: '127.0.0.1:1234' },
  } as unknown as IncomingMessage;
  const { res, captured } = fakeRes();
  await handleAgentTaskProgress(req, res, {}, contextRoot);
  return captured.body as TaskProgress;
}

describe('GET /api/agent/task-progress — the criteria list', () => {
  beforeEach(() => { process.env.DREAMCONTEXT_DESKTOP = '1'; });

  it('ships EVERY criterion, not the two strings the panel used to draw', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `- [${i < 8 ? 'x' : ' '}] criterion ${i + 1}`);
    writeTask('twenty', criteriaSection(lines));
    const p = await get('twenty');

    expect(p.state).toBe('ok');
    expect(p.done).toBe(8);
    expect(p.total).toBe(20);
    expect(p.percent).toBe(40);
    // The header said 8/20 and the body showed 2. It now shows 20.
    expect(p.criteria).toHaveLength(20);
    expect(p.criteria.filter((c) => c.done)).toHaveLength(8);
    expect(p.truncated).toBe(0);
  });

  it('carries the milestone headings the task was written under', async () => {
    writeTask('grouped', criteriaSection([
      '### Part A — the payload',
      '- [x] A1',
      '- [ ] A2',
      '### Validation',
      '- [ ] V1',
    ]));
    const p = await get('grouped');
    expect(p.criteria.map((c) => c.group)).toEqual(['Part A — the payload', 'Part A — the payload', 'Validation']);
  });

  it('`now` still names the line the list marks in flight — one truth, two renderings', async () => {
    writeTask('agreement', criteriaSection(['- [x] done one', '- [ ] the live one', '- [ ] later']));
    const p = await get('agreement');
    expect(p.now).toBe('the live one');
    expect(p.criteria[inFlightIndex(p.criteria)].text).toBe('the live one');
  });

  it('an all-done task carries the full list too — 100% is a reading, not an empty panel', async () => {
    writeTask('finished', criteriaSection(['- [x] one', '- [x] two']));
    const p = await get('finished');
    expect(p.state).toBe('all-done');
    expect(p.criteria).toHaveLength(2);
    expect(p.criteria.every((c) => c.done)).toBe(true);
    expect(inFlightIndex(p.criteria)).toBe(-1);
  });

  it('every degenerate state carries an EMPTY list and its notice — never a half-drawn panel', async () => {
    writeTask('no-boxes', criteriaSection(['just prose, no checkboxes']));
    const none = await get('no-boxes');
    expect(none.state).toBe('no-criteria');
    expect(none.criteria).toEqual([]);
    expect(none.truncated).toBe(0);
    expect(none.notice).toBeTruthy();

    const missing = await get('no-such-task-anywhere');
    expect(missing.state).toBe('unknown-slug');
    expect(missing.criteria).toEqual([]);

    const rootless = await get('twenty', null);
    expect(rootless.state).toBe('unreadable');
    expect(rootless.criteria).toEqual([]);
  });

  it('caps the list at 200 and SAYS how many it dropped', async () => {
    const lines = Array.from({ length: 214 }, (_, i) => `- [ ] criterion ${i + 1}`);
    writeTask('runaway', criteriaSection(lines));
    const p = await get('runaway');
    // The total stays honest — it is the number `tasks doctor` reports — and the shortfall is
    // reported rather than swallowed. A short list under an honest total, silently, is the
    // defect; at the cap it has to be loud.
    expect(p.total).toBe(214);
    expect(p.criteria).toHaveLength(200);
    expect(p.truncated).toBe(14);
  });

  it('caps each criterion to one line, like `now` and `last` — this route is polled', async () => {
    writeTask('verbose', criteriaSection([`- [ ] ${'a'.repeat(900)}`]));
    const p = await get('verbose');
    expect(p.criteria[0].text.length).toBeLessThanOrEqual(240);
    expect(p.criteria[0].text.endsWith('…')).toBe(true);
  });
});

// ─── progressModel: what the panel reasons about before it draws ────────────────────

const c = (text: string, done: boolean, group: string | null = null) => ({ text, done, group });

describe('newlyTicked', () => {
  it('names only the criteria that flipped unticked → ticked between two readings', () => {
    const prev = [c('one', true), c('two', false), c('three', false)];
    const next = [c('one', true), c('two', true), c('three', false)];
    expect(newlyTicked(prev, next)).toEqual([criterionKey(c('two', true))]);
  });

  it('flashes NOTHING on the first reading of a run', () => {
    // Twenty already-ticked criteria arriving at once are the state of the world, not twenty
    // things that just happened — the difference between a live panel and a confetti cannon.
    expect(newlyTicked([], [c('one', true), c('two', true)])).toEqual([]);
  });

  it('is asymmetric — work being taken back gets no celebratory highlight', () => {
    expect(newlyTicked([c('one', true)], [c('one', false)])).toEqual([]);
  });

  it('keys on group + text, so a criterion inserted above does not flash the ones below it', () => {
    const prev = [c('A1', false, 'Part A'), c('B1', false, 'Part B')];
    const next = [c('A0', false, 'Part A'), c('A1', false, 'Part A'), c('B1', true, 'Part B')];
    // B1 moved from index 1 to index 2 and is the only thing that ticked.
    expect(newlyTicked(prev, next)).toEqual([criterionKey(c('B1', true, 'Part B'))]);
  });

  it('does not confuse two criteria with the same text under different headings', () => {
    const prev = [c('tsc clean', false, 'Part A'), c('tsc clean', false, 'Validation')];
    const next = [c('tsc clean', false, 'Part A'), c('tsc clean', true, 'Validation')];
    expect(newlyTicked(prev, next)).toEqual([criterionKey(c('tsc clean', true, 'Validation'))]);
  });
});

describe('inFlightIndex', () => {
  it('is the first unticked criterion', () => {
    expect(inFlightIndex([c('a', true), c('b', true), c('c', false), c('d', false)])).toBe(2);
  });
  it('skips a malformed empty criterion, matching what `firstUnticked` names', () => {
    expect(inFlightIndex([c('a', true), c('', false), c('c', false)])).toBe(2);
  });
  it('is -1 when everything is ticked — a real state, not an error', () => {
    expect(inFlightIndex([c('a', true)])).toBe(-1);
    expect(inFlightIndex([])).toBe(-1);
  });
});

describe('groupCriteria', () => {
  it('folds the flat list into its headings, each with its own tally', () => {
    const groups = groupCriteria([
      c('A1', true, 'Part A'), c('A2', false, 'Part A'), c('V1', false, 'Validation'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ name: 'Part A', done: 1, total: 2 });
    expect(groups[1]).toMatchObject({ name: 'Validation', done: 0, total: 1 });
  });

  it('keeps the flat index, so a grouped row and the in-flight index agree without a lookup', () => {
    const criteria = [c('A1', true, 'Part A'), c('A2', false, 'Part A'), c('V1', false, 'Validation')];
    const groups = groupCriteria(criteria);
    // Every item's index points back at the same object in the flat list…
    for (const g of groups) {
      for (const item of g.items) expect(criteria[item.index]).toBe(item.criterion);
    }
    // …which is what lets the panel mark exactly one row in flight by comparing indices.
    const flight = inFlightIndex(criteria);
    const marked = groups.flatMap((g) => g.items).filter((i) => i.index === flight);
    expect(marked).toHaveLength(1);
    expect(marked[0].criterion.text).toBe('A2');
  });

  it('an ungrouped list is ONE group named null — the panel renders it flat', () => {
    const groups = groupCriteria([c('one', false), c('two', false)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBeNull();
    expect(groups[0].total).toBe(2);
  });

  it('does NOT merge a heading that repeats non-adjacently — that is the document as written', () => {
    const groups = groupCriteria([c('A1', false, 'Part A'), c('V1', false, 'Validation'), c('A2', false, 'Part A')]);
    expect(groups.map((g) => g.name)).toEqual(['Part A', 'Validation', 'Part A']);
  });

  it('is empty for an empty list, so a degenerate reading draws no group frame', () => {
    expect(groupCriteria([])).toEqual([]);
  });
});

describe('sinceLabel', () => {
  const T = 1_700_000_000_000;

  it('moves every second below a minute — the whole point is that it visibly ticks', () => {
    expect(sinceLabel(T, T)).toBe('0s ago');
    expect(sinceLabel(T, T + 9_000)).toBe('9s ago');
    expect(sinceLabel(T, T + 59_000)).toBe('59s ago');
  });

  it('steps to minutes, then hours', () => {
    expect(sinceLabel(T, T + 60_000)).toBe('1m ago');
    expect(sinceLabel(T, T + 59 * 60_000)).toBe('59m ago');
    expect(sinceLabel(T, T + 3_600_000)).toBe('1h ago');
    expect(sinceLabel(T, T + 5 * 3_600_000)).toBe('5h ago');
  });

  it('an unread mtime shows NO clock rather than a confident "0s ago"', () => {
    expect(sinceLabel(0, T)).toBeNull();
  });

  it('never reads negative when the clock is behind the file mtime', () => {
    expect(sinceLabel(T, T - 30_000)).toBe('0s ago');
  });
});
