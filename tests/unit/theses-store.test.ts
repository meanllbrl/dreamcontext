import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createThesis,
  getThesis,
  listTheses,
  isSafeThesisSlug,
  addPrediction,
  addEvidence,
  setStatus,
  linkThesis,
  unlinkThesis,
  appendChangelogEntry,
  setBlocked,
  promoteThesis,
  parseChangelog,
  serializeChangelog,
  thesisPath,
} from '../../src/lib/theses/store.js';
import { ThesisError, type ChangelogEntry } from '../../src/lib/theses/types.js';
import { createInsight } from '../../src/lib/lab/store.js';
import { createObjective } from '../../src/lib/objectives-store.js';
import { writeFrontmatter } from '../../src/lib/frontmatter.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-theses-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function createTask(slug: string): void {
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFrontmatter(join(root, 'state', `${slug}.md`), { status: 'todo' }, '');
}

describe('theses store — create/list/get', () => {
  it('lazily creates theses/ and scaffolds a draft manifest', () => {
    const t = createThesis(root, { claim: 'Compressing stale memories improves recall precision.' });
    expect(t.status).toBe('draft');
    expect(t.kind).toBe('observational');
    expect(t.confidence).toBe(0.5);
    expect(t.slug).toBe('compressing-stale-memories-improves-recall-precision');
    expect(existsSync(thesisPath(root, t.slug))).toBe(true);
  });

  it('accepts an explicit slug', () => {
    const t = createThesis(root, { claim: 'X improves Y', slug: 'x-improves-y' });
    expect(t.slug).toBe('x-improves-y');
  });

  it('rejects an invalid explicit slug', () => {
    expect(() => createThesis(root, { claim: 'X improves Y', slug: 'Not Valid!' })).toThrow(ThesisError);
  });

  it('rejects a duplicate slug', () => {
    createThesis(root, { claim: 'X improves Y', slug: 'dupe' });
    expect(() => createThesis(root, { claim: 'X improves Y again', slug: 'dupe' })).toThrow(ThesisError);
  });

  it('rejects an empty claim', () => {
    expect(() => createThesis(root, { claim: '   ' })).toThrow(ThesisError);
  });

  it('list shows a created thesis; getThesis returns null for missing/unsafe slug', () => {
    createThesis(root, { claim: 'X improves Y', slug: 'x-improves-y' });
    expect(listTheses(root).map((t) => t.slug)).toContain('x-improves-y');
    expect(getThesis(root, 'missing')).toBeNull();
    expect(getThesis(root, 'Not Valid!')).toBeNull();
  });

  it('isSafeThesisSlug matches the kebab-case shape used elsewhere', () => {
    expect(isSafeThesisSlug('a-b-2')).toBe(true);
    expect(isSafeThesisSlug('A-b')).toBe(false);
    expect(isSafeThesisSlug('a--b')).toBe(false);
    expect(isSafeThesisSlug('a-')).toBe(false);
    expect(isSafeThesisSlug('')).toBe(false);
  });

  it('open:true without a prediction throws (draft→open hard gate)', () => {
    expect(() => createThesis(root, { claim: 'X improves Y', open: true })).toThrow(ThesisError);
  });

  it('open:true with a prediction creates directly in open status', () => {
    const t = createThesis(root, { claim: 'X improves Y', predictions: ['Y will rise 10%'], open: true });
    expect(t.status).toBe('open');
    expect(t.predictions).toHaveLength(1);
    expect(t.predictions[0]!.standing).toBe('untested');
  });

  it('validates linked insight/objective/task exist at create time', () => {
    expect(() => createThesis(root, { claim: 'X improves Y', insights: ['no-such-insight'] })).toThrow(ThesisError);
    expect(() => createThesis(root, { claim: 'X improves Y', objectives: ['no-such-objective'] })).toThrow(ThesisError);
    expect(() => createThesis(root, { claim: 'X improves Y', relatedTasks: ['no-such-task'] })).toThrow(ThesisError);

    createInsight(root, { slug: 'wau', title: 'WAU' });
    createObjective(root, { slug: 'grow', title: 'Grow' });
    createTask('fix-x');
    const t = createThesis(root, {
      claim: 'X improves Y',
      insights: ['wau'],
      objectives: ['grow'],
      relatedTasks: ['fix-x'],
    });
    expect(t.insights).toEqual(['wau']);
    expect(t.objectives).toEqual(['grow']);
    expect(t.related_tasks).toEqual(['fix-x']);
  });
});

describe('theses store — predictions + evidence + derived confidence', () => {
  it('addPrediction appends an untested prediction', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    const updated = addPrediction(root, t.slug, 'Y rises within 2 cycles');
    expect(updated.predictions).toHaveLength(1);
    expect(updated.predictions[0]!.standing).toBe('untested');
  });

  it('rejects empty prediction text', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    expect(() => addPrediction(root, t.slug, '   ')).toThrow(ThesisError);
  });

  it('addEvidence appends oldest-first, recomputes confidence, bumps cycles_checked', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    const withOne = addEvidence(root, t.slug, { verdict: 'supports', source: 'insight', ref: 'wau', note: 'first' });
    expect(withOne.evidence).toHaveLength(1);
    expect(withOne.cycles_checked).toBe(1);
    expect(withOne.checked_at).toBe(withOne.evidence[0]!.date);
    // single entry => weight 1 => confidence = 1.4/1.8
    expect(withOne.confidence).toBeCloseTo(1.4 / 1.8, 10);

    const withTwo = addEvidence(root, t.slug, { verdict: 'contradicts', source: 'task', note: 'second' });
    expect(withTwo.evidence).toHaveLength(2);
    expect(withTwo.evidence[0]!.note).toBe('first'); // oldest-first: original entry stays at index 0
    expect(withTwo.evidence[1]!.note).toBe('second');
    expect(withTwo.cycles_checked).toBe(2);
    // reads recompute from the ledger — never trust a stale persisted value
    expect(getThesis(root, t.slug)!.confidence).toBe(withTwo.confidence);
  });

  it('rejects an unknown verdict/source', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    // @ts-expect-error deliberately invalid verdict for the runtime guard
    expect(() => addEvidence(root, t.slug, { verdict: 'maybe', source: 'insight' })).toThrow(ThesisError);
    // @ts-expect-error deliberately invalid source for the runtime guard
    expect(() => addEvidence(root, t.slug, { verdict: 'supports', source: 'nowhere' })).toThrow(ThesisError);
  });

  it('a no-signal event contributes zero weight but still occupies an index', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    addEvidence(root, t.slug, { verdict: 'supports', source: 'insight' });
    addEvidence(root, t.slug, { verdict: 'no-signal', source: 'external' });
    const updated = addEvidence(root, t.slug, { verdict: 'supports', source: 'insight' });
    expect(updated.evidence).toHaveLength(3);
    // ws = w0 + w2 = 0.55 + 1.0 (i=0,2 of L=3: w_i = 0.55 + 0.45*(i/2))
    const expectedWs = (0.55 + 0.45 * (0 / 2)) + (0.55 + 0.45 * (2 / 2));
    expect(updated.confidence).toBeCloseTo((expectedWs + 0.4) / (expectedWs + 0.8), 10);
  });
});

describe('theses store — status lifecycle gates', () => {
  it('draft→open without any prediction throws', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    expect(() => setStatus(root, t.slug, 'open')).toThrow(ThesisError);
  });

  it('draft→open with a prediction succeeds', () => {
    const t = createThesis(root, { claim: 'X improves Y', predictions: ['Y rises'] });
    const updated = setStatus(root, t.slug, 'open');
    expect(updated.status).toBe('open');
  });

  it('a manual flip to validated/invalidated without a citation throws', () => {
    const t = createThesis(root, { claim: 'X improves Y', predictions: ['Y rises'], open: true });
    addEvidence(root, t.slug, { verdict: 'supports', source: 'insight' });
    expect(() => setStatus(root, t.slug, 'validated')).toThrow(ThesisError);
  });

  it('a manual flip with an out-of-range citation throws', () => {
    const t = createThesis(root, { claim: 'X improves Y', predictions: ['Y rises'], open: true });
    addEvidence(root, t.slug, { verdict: 'supports', source: 'insight' });
    expect(() => setStatus(root, t.slug, 'validated', { citations: [5] })).toThrow(ThesisError);
  });

  it('a manual flip citing evidence succeeds', () => {
    const t = createThesis(root, { claim: 'X improves Y', predictions: ['Y rises'], open: true });
    addEvidence(root, t.slug, { verdict: 'supports', source: 'insight' });
    const updated = setStatus(root, t.slug, 'validated', { citations: [0] });
    expect(updated.status).toBe('validated');
  });

  it('force bypasses the citation gate (the agent/data-driven path)', () => {
    const t = createThesis(root, { claim: 'X improves Y', predictions: ['Y rises'], open: true });
    const updated = setStatus(root, t.slug, 'invalidated', { force: true });
    expect(updated.status).toBe('invalidated');
  });

  it('records a prediction standing alongside a flip', () => {
    const t = createThesis(root, { claim: 'X improves Y', predictions: ['Y rises'], open: true });
    addEvidence(root, t.slug, { verdict: 'supports', source: 'insight' });
    const predId = t.predictions[0]!.id;
    const updated = setStatus(root, t.slug, 'validated', {
      citations: [0],
      predictionStandings: { [predId]: 'supported' },
    });
    expect(updated.predictions[0]!.standing).toBe('supported');
  });

  it('rejects an unknown prediction id in predictionStandings', () => {
    const t = createThesis(root, { claim: 'X improves Y', predictions: ['Y rises'], open: true });
    addEvidence(root, t.slug, { verdict: 'supports', source: 'insight' });
    expect(() =>
      setStatus(root, t.slug, 'validated', { citations: [0], predictionStandings: { 'pred_nope': 'supported' } }),
    ).toThrow(ThesisError);
  });

  it('retire/restore-to-draft are unrestricted', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    expect(setStatus(root, t.slug, 'retired').status).toBe('retired');
    expect(setStatus(root, t.slug, 'draft').status).toBe('draft');
  });
});

describe('theses store — links', () => {
  it('linkThesis validates the target exists (dangling ref throws)', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    expect(() => linkThesis(root, t.slug, 'insight', 'no-such-insight')).toThrow(ThesisError);
    expect(() => linkThesis(root, t.slug, 'objective', 'no-such-objective')).toThrow(ThesisError);
    expect(() => linkThesis(root, t.slug, 'task', 'no-such-task')).toThrow(ThesisError);
  });

  it('links and unlinks an insight/objective/task; linking is idempotent', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    createObjective(root, { slug: 'grow', title: 'Grow' });
    createTask('fix-x');
    const t = createThesis(root, { claim: 'X improves Y' });

    const linked = linkThesis(root, t.slug, 'insight', 'wau');
    expect(linked.insights).toEqual(['wau']);
    const linkedAgain = linkThesis(root, t.slug, 'insight', 'wau');
    expect(linkedAgain.insights).toEqual(['wau']); // no duplicate

    linkThesis(root, t.slug, 'objective', 'grow');
    linkThesis(root, t.slug, 'task', 'fix-x');
    expect(getThesis(root, t.slug)!.objectives).toEqual(['grow']);
    expect(getThesis(root, t.slug)!.related_tasks).toEqual(['fix-x']);

    const unlinked = unlinkThesis(root, t.slug, 'insight', 'wau');
    expect(unlinked.insights).toEqual([]);
  });
});

describe('theses store — blocked-on-instrumentation', () => {
  it('setBlocked round-trips: sets the metric + flag, then clears both', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    const blocked = setBlocked(root, t.slug, 'weekly retention delta');
    expect(blocked.blocked_on_instrumentation).toBe(true);
    expect(blocked.blocked_metric).toBe('weekly retention delta');

    // re-read from disk independently — the flag persisted, not just in-memory
    const reread = getThesis(root, t.slug)!;
    expect(reread.blocked_on_instrumentation).toBe(true);
    expect(reread.blocked_metric).toBe('weekly retention delta');

    const unblocked = setBlocked(root, t.slug, null);
    expect(unblocked.blocked_on_instrumentation).toBe(false);
    expect(unblocked.blocked_metric).toBeNull();
    expect(getThesis(root, t.slug)!.blocked_on_instrumentation).toBe(false);
  });

  it('an empty/whitespace metric also clears the flag', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    setBlocked(root, t.slug, 'some metric');
    const cleared = setBlocked(root, t.slug, '   ');
    expect(cleared.blocked_on_instrumentation).toBe(false);
    expect(cleared.blocked_metric).toBeNull();
  });
});

describe('theses store — promotion', () => {
  it('promoteThesis sets promoted_to and optionally retires', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    const promoted = promoteThesis(root, t.slug, { knowledgePath: 'knowledge/x-improves-y.md' });
    expect(promoted.promoted_to).toBe('knowledge/x-improves-y.md');
    expect(promoted.status).toBe(t.status); // not retired by default

    const retired = promoteThesis(root, t.slug, { knowledgePath: 'knowledge/x-improves-y.md', retire: true });
    expect(retired.status).toBe('retired');
  });

  it('requires a non-empty knowledge path', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    expect(() => promoteThesis(root, t.slug, { knowledgePath: '  ' })).toThrow(ThesisError);
  });
});

describe('understanding changelog — parse/serialize round-trip + LIFO cap', () => {
  it('round-trips cycle, manual, and condensed entries exactly', () => {
    const entries: ChangelogEntry[] = [
      { cycle: 5, condensed: false, when: '2026-07-19', text: 'Confidence rose after two more supports.' },
      { cycle: null, condensed: false, when: '2026-07-18', text: 'User noted an outlier — flagged for next cycle.' },
      { cycle: null, condensed: true, when: '2026-07-10', text: 'Condensed summary of 4 earlier cycles.' },
    ];
    const serialized = serializeChangelog(entries);
    expect(serialized.startsWith('## Understanding changelog')).toBe(true);
    expect(parseChangelog(serialized)).toEqual(entries);
  });

  it('an empty entries list serializes to nothing and parses back to nothing', () => {
    expect(serializeChangelog([])).toBe('');
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog('some unrelated prose with no changelog section')).toEqual([]);
  });

  it('appendChangelogEntry prepends newest-first and persists across reads', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    appendChangelogEntry(root, t.slug, { text: 'first cycle note', cycle: 1 });
    const afterSecond = appendChangelogEntry(root, t.slug, { text: 'second cycle note', cycle: 2 });
    expect(afterSecond.changelog).toHaveLength(2);
    expect(afterSecond.changelog[0]!.text).toBe('second cycle note'); // newest first
    expect(afterSecond.changelog[1]!.text).toBe('first cycle note');
    expect(getThesis(root, t.slug)!.changelog).toEqual(afterSecond.changelog);
  });

  it('keeps the newest 10 raw entries and condenses the rest into one CONDENSED entry', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    let latest = t;
    for (let cycle = 1; cycle <= 13; cycle++) {
      latest = appendChangelogEntry(root, t.slug, { text: `note for cycle ${cycle}`, cycle });
    }
    // 10 raw + 1 condensed = 11 total entries
    expect(latest.changelog).toHaveLength(11);
    const raw = latest.changelog.filter((e) => !e.condensed);
    const condensed = latest.changelog.filter((e) => e.condensed);
    expect(raw).toHaveLength(10);
    expect(condensed).toHaveLength(1);
    // newest raw entry is cycle 13, oldest kept raw entry is cycle 4 (13,12,...,4 = 10 entries)
    expect(raw[0]!.cycle).toBe(13);
    expect(raw[raw.length - 1]!.cycle).toBe(4);
    // cycles 1-3 condensed => 3 earlier cycles
    expect(condensed[0]!.text).toBe('Condensed summary of 3 earlier cycles.');

    // one more append: the running condensed count keeps growing, never resets
    const again = appendChangelogEntry(root, t.slug, { text: 'note for cycle 14', cycle: 14 });
    const rawAgain = again.changelog.filter((e) => !e.condensed);
    const condensedAgain = again.changelog.filter((e) => e.condensed);
    expect(rawAgain).toHaveLength(10);
    expect(condensedAgain[0]!.text).toBe('Condensed summary of 4 earlier cycles.');
  });

  it('preserves free prose ahead of the changelog section across appends', () => {
    const t = createThesis(root, { claim: 'X improves Y' });
    // Seed prose manually (createThesis writes empty body by default).
    writeFrontmatter(thesisPath(root, t.slug), { claim: t.claim, status: t.status, kind: t.kind }, 'Some hand-written notes.');
    const updated = appendChangelogEntry(root, t.slug, { text: 'first note', cycle: 1 });
    expect(updated.body.startsWith('Some hand-written notes.')).toBe(true);
    expect(updated.body).toContain('## Understanding changelog');
  });
});
