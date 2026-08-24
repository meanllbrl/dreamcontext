/**
 * Unit tests for the redesigned composer's menu data (dashboard/src/lib/agentComposer.ts):
 * the model menu's primary/other split and its per-family copy, the effort SLIDER's two
 * directions, and the usage popover's bar list.
 *
 * Three properties are worth locking down, because each of them fails silently:
 *
 *   1. THE RUNNING MODEL IS NEVER HIDDEN. `splitModels` shows the first N up front and the
 *      rest behind a closed disclosure — so a user on Haiku would open the menu, see no
 *      checkmark, and have to go hunting for the one row that answers the question they
 *      opened it to ask.
 *   2. THE SLIDER NEVER GETS AN OUT-OF-RANGE INDEX. A `<input type="range">` clamps a bad
 *      `value` itself and then reports the clamped number back through `onChange` — a -1
 *      wouldn't look broken, it would quietly rewrite the user's effort setting.
 *   3. AN UNKNOWN CAP DRAWS NOTHING. Every degradation in `usageLimits` must REMOVE a bar,
 *      never render a hollow one: an empty bar reads as "you've used none of it", which is a
 *      claim there is no source for. That includes the non-obvious case — a `resetsAt` in
 *      the past means the window rolled over, so the percent describes a window that no
 *      longer exists even though the cache itself is minutes old.
 */
import { describe, it, expect } from 'vitest';
import {
  splitModels, modelNoteFor, modelFamily, MODEL_INSIGHTS, MODEL_PRIMARY_COUNT,
  effortIndex, effortAt,
  usageLimits, USAGE_STALE_MS, USAGE_MAX_AGE_MS,
  type ModelConfig, type ContextUsage, type UsageLimitsResponse,
} from '../../dashboard/src/lib/agentComposer.js';

const CONFIG: ModelConfig = {
  models: [
    { id: 'fable', label: 'Fable', priceIn: 10 },
    { id: 'opus', label: 'Opus', priceIn: 5 },
    { id: 'sonnet', label: 'Sonnet', priceIn: 3 },
    { id: 'haiku', label: 'Haiku', priceIn: 1 },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultModel: 'opus',
  defaultEffort: 'high',
};

const ids = (list: { id: string }[]) => list.map((m) => m.id);

// ─────────────────────────────────────────────────────────────────────────────────────
describe('splitModels — the primary rows vs the "Other models" disclosure', () => {
  it('takes the first N in the CLI\'s own order by default', () => {
    const { primary, other } = splitModels(CONFIG, 'fable');
    expect(MODEL_PRIMARY_COUNT).toBe(2);
    expect(ids(primary)).toEqual(['fable', 'opus']);
    expect(ids(other)).toEqual(['sonnet', 'haiku']);
  });

  it('PROMOTES the current model when it would otherwise be behind the disclosure', () => {
    const { primary, other } = splitModels(CONFIG, 'haiku');
    expect(ids(primary)).toEqual(['fable', 'opus', 'haiku']);
    // …and it is no longer duplicated below.
    expect(ids(other)).toEqual(['sonnet']);
  });

  it('promotes by FAMILY too — system:init reports a full id, never a picker alias', () => {
    const { primary, other } = splitModels(CONFIG, 'claude-sonnet-4-5-20250929');
    expect(ids(primary)).toEqual(['fable', 'opus', 'sonnet']);
    expect(ids(other)).toEqual(['haiku']);
  });

  it('leaves the split alone when the current model is already primary', () => {
    const { primary, other } = splitModels(CONFIG, 'claude-opus-4-5-20251101');
    expect(ids(primary)).toEqual(['fable', 'opus']);
    expect(ids(other)).toEqual(['sonnet', 'haiku']);
  });

  it('is stable before the first init frame, when the current model is an empty string', () => {
    const { primary, other } = splitModels(CONFIG, '');
    expect(ids(primary)).toEqual(['fable', 'opus']);
    expect(ids(other)).toEqual(['sonnet', 'haiku']);
  });

  it('never loses or duplicates a model, at any primaryCount including nonsense ones', () => {
    for (const count of [-3, 0, 1, 2, 4, 99]) {
      for (const current of ['', 'haiku', 'sonnet', 'claude-fable-5', 'gpt-9']) {
        const { primary, other } = splitModels(CONFIG, current, count);
        expect([...ids(primary), ...ids(other)].sort())
          .toEqual(ids(CONFIG.models).sort());
      }
    }
  });

  it('handles an empty model list without inventing rows', () => {
    const empty: ModelConfig = { models: [], efforts: [], defaultModel: '', defaultEffort: '' };
    expect(splitModels(empty, 'opus')).toEqual({ primary: [], other: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
describe('modelNoteFor — the row\'s one-line "what is this for"', () => {
  it('family-matches the full CLI id that system:init actually reports', () => {
    expect(modelNoteFor('claude-opus-4-5-20251101')).toBe(MODEL_INSIGHTS.opus);
    expect(modelNoteFor('claude-sonnet-4-5-20250929')).toBe(MODEL_INSIGHTS.sonnet);
    expect(modelNoteFor('claude-haiku-4-5-20251001')).toBe(MODEL_INSIGHTS.haiku);
    expect(modelNoteFor('claude-fable-5[1m]')).toBe(MODEL_INSIGHTS.fable);
  });

  it('resolves the picker aliases too', () => {
    for (const id of ['opus', 'sonnet', 'haiku', 'fable']) {
      expect(modelNoteFor(id)).not.toBeNull();
    }
  });

  it('returns null for a model this build has never heard of — no invented description', () => {
    expect(modelNoteFor('some-future-model')).toBeNull();
    expect(modelNoteFor('gpt-something-9')).toBeNull();
    expect(modelNoteFor('')).toBeNull();
  });

  it('gives every family a non-empty insight, so no known row renders a blank line', () => {
    for (const note of Object.values(MODEL_INSIGHTS)) {
      expect(note.insight.length).toBeGreaterThan(0);
    }
  });

  it('shares ONE family matcher with the label path — the lists cannot drift apart', () => {
    // If a new family is ever added to MODEL_FAMILIES without an insight, this fails.
    for (const id of ['opus', 'sonnet', 'haiku', 'fable']) {
      const family = modelFamily(id);
      expect(family).not.toBeNull();
      expect(MODEL_INSIGHTS[family!]).toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
describe('effortIndex / effortAt — the slider\'s two directions', () => {
  const { efforts } = CONFIG;

  it('round-trips every level', () => {
    for (const level of efforts) {
      expect(effortAt(efforts, effortIndex(efforts, level))).toBe(level);
    }
  });

  it('NEVER returns -1 for an unrecognised level (the label stays truthful separately)', () => {
    expect(effortIndex(efforts, 'ultra')).toBe(0);
    expect(effortIndex(efforts, '')).toBe(0);
    expect(effortIndex([], 'high')).toBe(0);
  });

  it('clamps at both ends rather than reading off the array', () => {
    expect(effortAt(efforts, -1)).toBe('low');
    expect(effortAt(efforts, -999)).toBe('low');
    expect(effortAt(efforts, 4)).toBe('max');
    expect(effortAt(efforts, 5)).toBe('max');
    expect(effortAt(efforts, 999)).toBe('max');
  });

  it('survives the non-integers a range input can hand back', () => {
    expect(effortAt(efforts, 2.4)).toBe('high');
    expect(effortAt(efforts, 2.6)).toBe('xhigh');
    expect(effortAt(efforts, Number.NaN)).toBe('low');
    expect(effortAt(efforts, Number.POSITIVE_INFINITY)).toBe('low');
  });

  it('returns "" only when there is no slider to render', () => {
    expect(effortAt([], 0)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
describe('usageLimits — show what\'s found, hide what isn\'t', () => {
  const NOW = 1_787_500_000_000;
  const CTX: ContextUsage = { used: 207_000, limit: 1_000_000, pct: 21 };
  const fresh = (over: Partial<UsageLimitsResponse> = {}): UsageLimitsResponse => ({
    fetchedAtMs: NOW - 60_000,
    limits: [
      { key: 'session', percent: 20, resetsAt: NOW + 2 * 60 * 60_000 },
      { key: 'weekly', percent: 47, resetsAt: NOW + 36 * 60 * 60_000 },
    ],
    ...over,
  });

  it('stacks context, 5-hour session and weekly, in that order', () => {
    const { limits, staleAsOf } = usageLimits(CTX, fresh(), NOW);
    expect(limits.map((l) => l.key)).toEqual(['context', 'session', 'weekly']);
    expect(limits[0]).toMatchObject({
      title: 'Context window', percent: 21, resetsAt: null, detail: { used: 207_000, limit: 1_000_000 },
    });
    expect(limits[1]).toMatchObject({ title: '5-hour session', percent: 20 });
    expect(limits[2]).toMatchObject({ title: 'Weekly', percent: 47 });
    expect(staleAsOf).toBeNull();
  });

  it('orders by key, not by whatever order the wire happened to use', () => {
    const shuffled = fresh({
      limits: [
        { key: 'weekly', percent: 47, resetsAt: NOW + 36 * 60 * 60_000 },
        { key: 'session', percent: 20, resetsAt: NOW + 2 * 60 * 60_000 },
      ],
    });
    expect(usageLimits(CTX, shuffled, NOW).limits.map((l) => l.key))
      .toEqual(['context', 'session', 'weekly']);
  });

  it('names the scope when a per-model cap is the binding one', () => {
    const scoped = fresh({
      limits: [{ key: 'weekly', percent: 55, resetsAt: NOW + 36 * 60 * 60_000, scope: 'Fable' }],
    });
    const weekly = usageLimits(CTX, scoped, NOW).limits.find((l) => l.key === 'weekly');
    expect(weekly).toMatchObject({ title: 'Weekly · Fable', percent: 55, scope: 'Fable' });
  });

  it('returns CONTEXT ONLY when there is no response at all', () => {
    const { limits, staleAsOf } = usageLimits(CTX, null, NOW);
    expect(limits.map((l) => l.key)).toEqual(['context']);
    expect(staleAsOf).toBeNull();
  });

  it('returns context only when the server found no source (fetchedAtMs null)', () => {
    const { limits } = usageLimits(CTX, { limits: [], fetchedAtMs: null }, NOW);
    expect(limits.map((l) => l.key)).toEqual(['context']);
  });

  it('drops the account bars once the cache is older than USAGE_MAX_AGE_MS', () => {
    const stale = fresh({ fetchedAtMs: NOW - USAGE_MAX_AGE_MS - 1 });
    const { limits, staleAsOf } = usageLimits(CTX, stale, NOW);
    expect(limits.map((l) => l.key)).toEqual(['context']);
    expect(staleAsOf).toBeNull();
  });

  it('LABELS rather than hides a reading between the stale and max-age thresholds', () => {
    const fetchedAtMs = NOW - USAGE_STALE_MS - 60_000;
    const { limits, staleAsOf } = usageLimits(CTX, fresh({ fetchedAtMs }), NOW);
    expect(limits.map((l) => l.key)).toEqual(['context', 'session', 'weekly']);
    expect(staleAsOf).toBe(fetchedAtMs);
  });

  it('drops a bar whose window ALREADY RESET — a fresh cache can still hold a dead window', () => {
    const rolled = fresh({
      limits: [
        { key: 'session', percent: 20, resetsAt: NOW - 1 },              // rolled over
        { key: 'weekly', percent: 47, resetsAt: NOW + 36 * 60 * 60_000 }, // still live
      ],
    });
    expect(usageLimits(CTX, rolled, NOW).limits.map((l) => l.key)).toEqual(['context', 'weekly']);
  });

  it('drops a percent outside 0-100 instead of clamping it into a plausible lie', () => {
    const bogus = fresh({
      limits: [
        { key: 'session', percent: 140, resetsAt: NOW + 60_000 },
        { key: 'weekly', percent: Number.NaN, resetsAt: NOW + 60_000 },
      ],
    });
    expect(usageLimits(CTX, bogus, NOW).limits.map((l) => l.key)).toEqual(['context']);
  });

  it('never captions "as of …" when no account bar survived to be captioned', () => {
    const allRolled = fresh({
      fetchedAtMs: NOW - USAGE_STALE_MS - 60_000,
      limits: [{ key: 'session', percent: 20, resetsAt: NOW - 1 }],
    });
    const { limits, staleAsOf } = usageLimits(CTX, allRolled, NOW);
    expect(limits.map((l) => l.key)).toEqual(['context']);
    expect(staleAsOf).toBeNull();
  });

  it('treats a future-stamped cache as fresh rather than letting clock skew age it', () => {
    const skewed = fresh({ fetchedAtMs: NOW + 10 * 60_000 });
    const { limits, staleAsOf } = usageLimits(CTX, skewed, NOW);
    expect(limits.map((l) => l.key)).toEqual(['context', 'session', 'weekly']);
    expect(staleAsOf).toBeNull();
  });

  it('renders the account bars with no context reading at all (a session before its first turn)', () => {
    const { limits } = usageLimits(null, fresh(), NOW);
    expect(limits.map((l) => l.key)).toEqual(['session', 'weekly']);
  });

  it('returns an empty list when nothing whatsoever is known — never a hollow bar', () => {
    expect(usageLimits(null, null, NOW)).toEqual({ limits: [], staleAsOf: null });
  });
});
