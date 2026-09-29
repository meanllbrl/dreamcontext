import { describe, it, expect } from 'vitest';
import {
  getConsolidationDirective,
  userPromptReminder,
  mustSleepTier,
  MUST_SLEEP_TIER_HEADERS,
} from '../../src/cli/commands/hook.js';
import {
  DEFAULT_SLEEP_THRESHOLDS,
  resolveSleepThresholds,
  SLEEP_COOLDOWN_MS,
  type SleepState,
  type Bookmark,
} from '../../src/lib/sleep-consolidation.js';

/**
 * Past Must Sleep the directive used to read the same at debt 60 and 175, and it
 * was injected into builder and automation sessions that cannot sleep at all.
 * These tests pin the three tiers (their edges are the thresholds sleep already
 * runs on) and the spawned-session silence.
 */

function baseState(over: Partial<SleepState> = {}): SleepState {
  return {
    debt: 0,
    last_sleep: null,
    last_sleep_summary: null,
    sleep_started_at: null,
    last_consolidated_at: null,
    sessions_since_last_sleep: 0,
    sessions: [],
    bookmarks: [],
    triggers: [],
    knowledge_access: {},
    dashboard_changes: [],
    compaction_log: [],
    recall_mode: 'hybrid',
    consolidation_depth: null,
    pendingMigrationNotices: [],
    ...over,
  };
}

const critical: Bookmark = {
  id: 'bm-crit', message: 'schema change', salience: 3,
  created_at: new Date().toISOString(), session_id: null, task_slug: null,
};

const OFF = { enabled: false, consentStale: false };
const EM_DASH = '—';

describe('mustSleepTier', () => {
  const t = DEFAULT_SLEEP_THRESHOLDS;
  it.each([
    [59, null],
    [60, 'required'],
    [89, 'required'],
    [90, 'deep'],
    [119, 'deep'],
    [120, 'overdue'],
    [300, 'overdue'],
  ] as const)('debt %i → %s (defaults 60 / 90 / 120)', (debt, tier) => {
    expect(mustSleepTier(debt, t)).toBe(tier);
  });

  it('follows a configured Must Sleep: 40 → deep at 60, overdue at 80', () => {
    const custom = resolveSleepThresholds({ thresholds: { drowsy: 16, sleepy: 27, mustSleep: 40 } });
    expect(mustSleepTier(39, custom)).toBeNull();
    expect(mustSleepTier(40, custom)).toBe('required');
    expect(mustSleepTier(60, custom)).toBe('deep');
    expect(mustSleepTier(80, custom)).toBe('overdue');
  });
});

describe('the Must Sleep directive names its tier', () => {
  it.each([
    [60, MUST_SLEEP_TIER_HEADERS.required],
    [89, MUST_SLEEP_TIER_HEADERS.required],
    [90, MUST_SLEEP_TIER_HEADERS.deep],
    [119, MUST_SLEEP_TIER_HEADERS.deep],
    [120, MUST_SLEEP_TIER_HEADERS.overdue],
  ] as const)('SessionStart directive at debt %i starts with its header', (debt, header) => {
    const d = getConsolidationDirective(baseState({ debt }))!;
    expect(d.split('\n')[0]).toBe(header);
    expect(d).toContain(`Sleep debt is ${debt}`);
    expect(d).toContain('dreamcontext sleep start');
  });

  it('every tier keeps the CONSOLIDATION REQUIRED marker, and only the right tier carries its suffix', () => {
    for (const debt of [60, 90, 120]) {
      expect(getConsolidationDirective(baseState({ debt }))).toContain('CONSOLIDATION REQUIRED');
      expect(userPromptReminder(baseState({ debt }))).toContain('CONSOLIDATION REQUIRED');
    }
    expect(userPromptReminder(baseState({ debt: 60 }))).not.toMatch(/DEEP CYCLE|OVERDUE/);
    expect(userPromptReminder(baseState({ debt: 90 }))).toContain('CONSOLIDATION REQUIRED: DEEP CYCLE');
    expect(userPromptReminder(baseState({ debt: 120 }))).toContain('CONSOLIDATION REQUIRED: OVERDUE');
  });

  it('the overdue tier says it overrides the cooldown, and fires through one', () => {
    const justSlept = baseState({
      debt: 130,
      last_consolidated_at: new Date(Date.now() - SLEEP_COOLDOWN_MS / 10).toISOString(),
    });
    expect(getConsolidationDirective(justSlept)).toContain(MUST_SLEEP_TIER_HEADERS.overdue);
    expect(getConsolidationDirective(justSlept)).toContain('overrides the post-sleep cooldown');
  });

  it('tiers follow configured thresholds end to end', () => {
    const custom = resolveSleepThresholds({ thresholds: { drowsy: 16, sleepy: 27, mustSleep: 40 } });
    expect(getConsolidationDirective(baseState({ debt: 60 }), custom)).toContain(MUST_SLEEP_TIER_HEADERS.deep);
  });

  it('no em dash in any directive or reminder, across the whole debt range and every branch', () => {
    const variants: Array<(debt: number) => SleepState> = [
      (debt) => baseState({ debt }),
      (debt) => baseState({ debt, bookmarks: [critical] }),
      (debt) => baseState({ debt, sessions_since_last_sleep: 20 }),
      (debt) => baseState({ debt, last_consolidated_at: new Date().toISOString() }),
      (debt) => baseState({ debt, sleep_started_at: new Date().toISOString() }),
    ];
    for (let debt = 0; debt <= 300; debt += 5) {
      for (const make of variants) {
        const state = make(debt);
        expect(getConsolidationDirective(state) ?? '').not.toContain(EM_DASH);
        expect(userPromptReminder(state) ?? '').not.toContain(EM_DASH);
      }
    }
    for (const auto of [{ enabled: true, consentStale: false }, { enabled: true, consentStale: true }]) {
      expect(getConsolidationDirective(baseState({ debt: 200 }), undefined, auto) ?? '').not.toContain(EM_DASH);
    }
  });
});

describe('a spawned session is never told to sleep', () => {
  const spawned = { spawned: true };
  it.each([
    ['debt 0', baseState()],
    ['required', baseState({ debt: 60 })],
    ['overdue', baseState({ debt: 250 })],
    ['critical bookmark', baseState({ bookmarks: [critical] })],
    ['sleep in progress', baseState({ debt: 200, sleep_started_at: new Date().toISOString() })],
    ['cooling down', baseState({ debt: 50, last_consolidated_at: new Date().toISOString() })],
    ['rhythm', baseState({ sessions_since_last_sleep: 40 })],
  ])('%s → null from both the directive and the reminder', (_label, state) => {
    expect(getConsolidationDirective(state, undefined, OFF, spawned)).toBeNull();
    expect(userPromptReminder(state, undefined, OFF, spawned)).toBeNull();
  });

  it('even with auto sleep on (its one-line notice is also a sleep line)', () => {
    const on = { enabled: true, consentStale: false };
    expect(getConsolidationDirective(baseState({ debt: 200 }), undefined, on, spawned)).toBeNull();
    expect(userPromptReminder(baseState({ debt: 200 }), undefined, on, spawned)).toBeNull();
  });

  it('a human session (the default origin) still gets the directive', () => {
    expect(getConsolidationDirective(baseState({ debt: 200 }), undefined, OFF)).toContain('CONSOLIDATION REQUIRED');
  });
});
