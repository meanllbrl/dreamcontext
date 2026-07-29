import { describe, it, expect } from 'vitest';
import { getConsolidationDirective, userPromptReminder } from '../../src/cli/commands/hook.js';
import {
  inspectSleepCooldown,
  formatCooldownRemaining,
  SLEEP_COOLDOWN_MS,
  DEBT_COOLDOWN_OVERRIDE,
  DEBT_DROWSY,
  DEBT_SLEEPY,
  DEBT_MUST_SLEEP,
  RHYTHM_SESSIONS,
  type SleepState,
  type Bookmark,
} from '../../src/lib/sleep-consolidation.js';

/**
 * Post-consolidation cooldown — the TIME half of the consolidation-cadence fix.
 *
 * Debt thresholds bound how much work one sleep is worth; they cannot bound how
 * close together two sleeps land. Measured over 30 real days of this project,
 * daily accrued debt reaches 185 at its heaviest, so a threshold alone still
 * permits three consolidations stacked into a single busy afternoon — the debt
 * arithmetic is right and the experience ("it asks again half an hour later") is
 * still wrong. These tests pin the floor that stops that.
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

/** A state whose last completed consolidation was `agoMs` ago. */
function consolidatedAgo(agoMs: number, over: Partial<SleepState> = {}): SleepState {
  return baseState({
    last_consolidated_at: new Date(Date.now() - agoMs).toISOString(),
    ...over,
  });
}

function critical(message: string): Bookmark {
  return {
    id: 'bm-crit', message, salience: 3,
    created_at: new Date().toISOString(), session_id: null, task_slug: null,
  };
}

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const stampAgo = (ms: number) => new Date(NOW - ms).toISOString();

describe('inspectSleepCooldown', () => {
  it('is inactive when no cycle has ever completed', () => {
    expect(inspectSleepCooldown({ last_consolidated_at: null }, NOW, 999))
      .toEqual({ active: false, remainingMs: 0, overridden: false });
  });

  it('is inactive on an unparseable stamp — a bad timestamp can only ever un-silence', () => {
    expect(inspectSleepCooldown({ last_consolidated_at: 'not-a-date' }, NOW, 999).active).toBe(false);
  });

  it('is inactive on a FUTURE stamp (clock skew / hand-edited state)', () => {
    const future = new Date(NOW + 60 * 60 * 1000).toISOString();
    expect(inspectSleepCooldown({ last_consolidated_at: future }, NOW, 999).active).toBe(false);
  });

  it('is active inside the window and reports the remaining time', () => {
    const elapsed = SLEEP_COOLDOWN_MS / 3;
    const c = inspectSleepCooldown({ last_consolidated_at: stampAgo(elapsed) }, NOW, DEBT_MUST_SLEEP);
    expect(c.active).toBe(true);
    expect(c.overridden).toBe(false);
    expect(c.remainingMs).toBe(SLEEP_COOLDOWN_MS - elapsed);
  });

  it('expires EXACTLY at the window boundary, not a millisecond later', () => {
    // Debt held below DEBT_COOLDOWN_OVERRIDE so this measures the BOUNDARY and
    // not the override path.
    const debt = DEBT_MUST_SLEEP;
    expect(debt).toBeLessThan(DEBT_COOLDOWN_OVERRIDE);
    expect(inspectSleepCooldown({ last_consolidated_at: stampAgo(SLEEP_COOLDOWN_MS - 1) }, NOW, debt).active).toBe(true);
    expect(inspectSleepCooldown({ last_consolidated_at: stampAgo(SLEEP_COOLDOWN_MS) }, NOW, debt).active).toBe(false);
  });

  it('is overridden by extreme debt — a huge burst is never held for the full window', () => {
    const stamp = stampAgo(SLEEP_COOLDOWN_MS / 2);
    expect(inspectSleepCooldown({ last_consolidated_at: stamp }, NOW, DEBT_COOLDOWN_OVERRIDE - 1).active).toBe(true);

    const over = inspectSleepCooldown({ last_consolidated_at: stamp }, NOW, DEBT_COOLDOWN_OVERRIDE);
    expect(over.active).toBe(false);
    expect(over.overridden).toBe(true);
  });

  it('sets the override threshold above Must Sleep so it is an escape hatch, not the normal path', () => {
    expect(DEBT_COOLDOWN_OVERRIDE).toBeGreaterThan(DEBT_MUST_SLEEP);
  });
});

describe('formatCooldownRemaining', () => {
  it('renders hours and minutes, and never rounds a live window down to "0m"', () => {
    expect(formatCooldownRemaining(2 * 60 * 60 * 1000 + 5 * 60 * 1000)).toBe('2h 5m');
    expect(formatCooldownRemaining(18 * 60 * 1000)).toBe('18m');
    expect(formatCooldownRemaining(1)).toBe('1m');
  });
});

describe('directives respect the cooldown', () => {
  const HALFWAY = SLEEP_COOLDOWN_MS / 2;

  it('does NOT demand consolidation again right after one completed', () => {
    const state = consolidatedAgo(HALFWAY, { debt: DEBT_MUST_SLEEP });
    const d = getConsolidationDirective(state);
    expect(d).not.toBeNull();
    expect(d).toContain('Cooling down');
    expect(d).not.toContain('CONSOLIDATION REQUIRED');
  });

  it('silences the per-message reminder too — that is where the nagging is felt', () => {
    const state = consolidatedAgo(HALFWAY, { debt: DEBT_MUST_SLEEP });
    const r = userPromptReminder(state);
    expect(r).not.toBeNull();
    expect(r).toContain('Cooling down');
    expect(r).not.toContain('CONSOLIDATION REQUIRED');
  });

  it('goes fully silent below DEBT_DROWSY instead of emitting a cooling-down note', () => {
    const state = consolidatedAgo(HALFWAY, { debt: DEBT_DROWSY - 1 });
    expect(getConsolidationDirective(state)).toBeNull();
    expect(userPromptReminder(state)).toBeNull();
  });

  it('suppresses the rhythm advisory as well (it asks to consolidate too)', () => {
    const state = consolidatedAgo(HALFWAY, { debt: 1, sessions_since_last_sleep: RHYTHM_SESSIONS });
    expect(getConsolidationDirective(state)).toBeNull();
  });

  it('resumes normally once the window expires', () => {
    const state = consolidatedAgo(SLEEP_COOLDOWN_MS + 1000, { debt: DEBT_MUST_SLEEP });
    expect(getConsolidationDirective(state)).toContain('CONSOLIDATION REQUIRED');
    expect(userPromptReminder(state)).toContain('CONSOLIDATION REQUIRED');
  });

  it('never suppresses a hand-tagged ★★★ bookmark', () => {
    // Salience 3 is only ever set by hand (auto-detectors top out at 2), so it
    // is a deliberate "this matters now" and must survive the cooldown.
    const state = consolidatedAgo(HALFWAY, { debt: 0, bookmarks: [critical('ship the migration before release')] });
    expect(getConsolidationDirective(state)).toContain('CRITICAL BOOKMARKS');
    expect(userPromptReminder(state)).toContain('critical bookmark');
  });

  it('lets extreme debt through even inside the window', () => {
    const state = consolidatedAgo(HALFWAY, { debt: DEBT_COOLDOWN_OVERRIDE });
    expect(getConsolidationDirective(state)).toContain('CONSOLIDATION REQUIRED');
  });

  it('behaves exactly as before for a brain that has never consolidated', () => {
    const state = baseState({ debt: DEBT_MUST_SLEEP, last_consolidated_at: null });
    expect(getConsolidationDirective(state)).toContain('CONSOLIDATION REQUIRED');
  });

  it('an in-progress lock still wins over the cooldown (no duplicate sleep)', () => {
    const state = consolidatedAgo(HALFWAY, {
      debt: DEBT_MUST_SLEEP,
      sleep_started_at: new Date().toISOString(),
    });
    expect(getConsolidationDirective(state)).toContain('already in progress');
  });
});

describe('daily consolidation ceiling', () => {
  // Measured over 30 real days of this project under the weighted scorer.
  const DAILY_DEBT = { median: 42, p75: 107, p90: 168, busiest: 185 } as const;

  it('caps the busiest measured day at 3 required consolidations', () => {
    expect(Math.floor(DAILY_DEBT.busiest / DEBT_MUST_SLEEP)).toBe(3);
  });

  it('asks for at most 2 on a p90 day and 1 on a p75 day', () => {
    expect(Math.floor(DAILY_DEBT.p90 / DEBT_MUST_SLEEP)).toBe(2);
    expect(Math.floor(DAILY_DEBT.p75 / DEBT_MUST_SLEEP)).toBe(1);
  });

  it('never REQUIRES one on a median day — it only advises, and the user decides', () => {
    expect(DAILY_DEBT.median).toBeLessThan(DEBT_MUST_SLEEP);
    expect(DAILY_DEBT.median).toBeGreaterThanOrEqual(DEBT_SLEEPY);
    expect(getConsolidationDirective(baseState({ debt: DAILY_DEBT.median })))
      .toContain('CONSOLIDATION RECOMMENDED');
  });

  it('the cooldown alone bounds a 24h day to at most 8 windows — the threshold is the tighter limit', () => {
    // Belt and braces: even if debt accrued arbitrarily fast, the time floor
    // caps the count. The two mechanisms agree on the ceiling rather than one
    // silently overriding the other.
    const windowsPerDay = Math.floor((24 * 60 * 60 * 1000) / SLEEP_COOLDOWN_MS);
    expect(windowsPerDay).toBeLessThanOrEqual(8);
    expect(Math.floor(DAILY_DEBT.busiest / DEBT_MUST_SLEEP)).toBeLessThan(windowsPerDay);
  });
});
