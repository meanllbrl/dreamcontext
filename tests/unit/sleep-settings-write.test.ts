import { describe, it, expect } from 'vitest';
import {
  setSleepConfigKey,
  resetSleepConfigKey,
  validateThresholdLadder,
  isKnownSleepModel,
  resolveMaxNewTasksPerCycle,
  DEFAULT_MAX_NEW_TASKS_PER_CYCLE,
  applySleepConfigPatch,
} from '../../src/lib/sleep-settings.js';
import { effectiveSpecialist, readSetupConfig } from '../../src/lib/setup-config.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Round-trip the sleep block through the defensive reader (the real `.config.json` parse). */
const readSetupConfigSleep = (sleep: object) => {
  const root = mkdtempSync(join(tmpdir(), 'dc-sleep-line-'));
  try {
    mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(root, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: ['claude'], packs: [], sleep }));
    const out = readSetupConfig(root)?.sleep ?? {};
    return { model: out.model, effort: out.effort };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
import { resolveSleepThresholds, DEFAULT_SLEEP_THRESHOLDS } from '../../src/lib/sleep-consolidation.js';

/**
 * The WRITE side is deliberately louder than the read side: `sanitizeSleep`
 * drops a bad field so a Stop hook can never break, but a person typing
 * `sleep config set` must be TOLD what they got wrong — otherwise they set Must
 * Sleep to 30, the reader discards the whole ladder as non-monotonic, and the
 * brain silently keeps nagging at 60.
 */

const ok = (r: ReturnType<typeof setSleepConfigKey>) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
};

describe('setSleepConfigKey — thresholds', () => {
  it('sets a level and reports no specialist needs re-injecting', () => {
    const r = ok(setSleepConfigKey({}, 'thresholds.drowsy', '10'));
    expect(r.config.thresholds).toEqual({ drowsy: 10 });
    expect(r.changedSpecialists).toEqual([]);
  });

  it('accepts the camelCase spelling of must-sleep too', () => {
    expect(ok(setSleepConfigKey({}, 'thresholds.mustSleep', '80')).config.thresholds).toEqual({ mustSleep: 80 });
  });

  it('REFUSES a value that would invert the ladder, naming the rule', () => {
    // The trap: lowering only Must Sleep leaves the default Sleepy (40) above it.
    const r = setSleepConfigKey({}, 'thresholds.must-sleep', '30');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('sleepy (40) must be less than must-sleep (30)');
    expect(r.error).toContain('the whole ladder is ignored');
  });

  it('accepts the same value once the rest of the ladder makes room', () => {
    let cfg = ok(setSleepConfigKey({}, 'thresholds.drowsy', '10')).config;
    cfg = ok(setSleepConfigKey(cfg, 'thresholds.sleepy', '20')).config;
    cfg = ok(setSleepConfigKey(cfg, 'thresholds.must-sleep', '30')).config;
    expect(resolveSleepThresholds(cfg)).toEqual({
      drowsy: 10, sleepy: 20, mustSleep: 30, deepAuthority: 45, cooldownOverride: 60,
    });
  });

  it.each(['0', '-5', '1001', 'abc', '4.5', ''])('refuses the out-of-range/non-integer value %s', (v) => {
    expect(setSleepConfigKey({}, 'thresholds.drowsy', v).ok).toBe(false);
  });

  it('whatever it accepts, the reader agrees with — never silently discarded', () => {
    const cfg = ok(setSleepConfigKey({}, 'thresholds.must-sleep', '90')).config;
    expect(resolveSleepThresholds(cfg).mustSleep).toBe(90);
  });
});

describe('setSleepConfigKey — specialists', () => {
  it('sets a model and names the specialist to re-inject', () => {
    const r = ok(setSleepConfigKey({}, 'specialists.sleep-tasks.model', 'claude-opus-5'));
    expect(r.config.specialists).toEqual({ 'sleep-tasks': { model: 'claude-opus-5' } });
    expect(r.changedSpecialists).toEqual(['sleep-tasks']);
  });

  it('merges model and effort on the same specialist', () => {
    const cfg = ok(setSleepConfigKey({}, 'specialists.sleep-state.model', 'claude-sonnet-5')).config;
    const r = ok(setSleepConfigKey(cfg, 'specialists.sleep-state.effort', 'low'));
    expect(r.config.specialists?.['sleep-state']).toEqual({ model: 'claude-sonnet-5', effort: 'low' });
  });

  it('leaves every OTHER specialist untouched', () => {
    const cfg = ok(setSleepConfigKey({}, 'specialists.sleep-tasks.model', 'claude-opus-5')).config;
    const r = ok(setSleepConfigKey(cfg, 'specialists.sleep-state.effort', 'low'));
    expect(r.config.specialists?.['sleep-tasks']).toEqual({ model: 'claude-opus-5' });
    expect(r.changedSpecialists).toEqual(['sleep-state']);
  });

  it('never mutates the config it was handed', () => {
    const cfg = { specialists: { 'sleep-tasks': { model: 'claude-opus-5' } } } as const;
    setSleepConfigKey(cfg as never, 'specialists.sleep-tasks.model', 'claude-haiku-4-5');
    expect(cfg.specialists['sleep-tasks'].model).toBe('claude-opus-5');
  });

  it('refuses an unknown specialist name', () => {
    const r = setSleepConfigKey({}, 'specialists.sleep-nonsense.model', 'claude-opus-5');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Unknown specialist');
  });

  it('refuses an UNKNOWN model without the flag, and accepts it with', () => {
    const refused = setSleepConfigKey({}, 'specialists.sleep-tasks.model', 'claude-opus-9');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain('not a model this build knows about');

    const allowed = ok(setSleepConfigKey({}, 'specialists.sleep-tasks.model', 'claude-opus-9', { allowUnknown: true }));
    expect(allowed.config.specialists?.['sleep-tasks']?.model).toBe('claude-opus-9');
  });

  it('refuses a shell-unsafe model even WITH --allow-unknown', () => {
    const r = setSleepConfigKey({}, 'specialists.sleep-tasks.model', 'opus; rm -rf /', { allowUnknown: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not a valid model id');
  });

  it.each(['xhigh', 'max', 'LOW', 'turbo'])('refuses effort %s', (v) => {
    const r = setSleepConfigKey({}, 'specialists.sleep-tasks.effort', v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('effort must be one of: low, medium, high');
  });

  it('every accepted alias is a known model', () => {
    for (const m of ['opus', 'sonnet', 'haiku', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']) {
      expect(isKnownSleepModel(m)).toBe(true);
    }
    expect(isKnownSleepModel('gpt-4')).toBe(false);
  });
});

describe('setSleepConfigKey — cap and unknown keys', () => {
  it('accepts 0 (file nothing) through the ceiling', () => {
    expect(ok(setSleepConfigKey({}, 'max-new-tasks', '0')).config.maxNewTasksPerCycle).toBe(0);
    expect(ok(setSleepConfigKey({}, 'max-new-tasks', '50')).config.maxNewTasksPerCycle).toBe(50);
  });

  it('refuses a negative cap or one past the ceiling', () => {
    expect(setSleepConfigKey({}, 'max-new-tasks', '-1').ok).toBe(false);
    expect(setSleepConfigKey({}, 'max-new-tasks', '51').ok).toBe(false);
  });

  it('refuses an unknown key and lists the valid ones', () => {
    const r = setSleepConfigKey({}, 'thresholds.exhausted', '5');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Valid keys');
  });

  it('resolveMaxNewTasksPerCycle falls back to the shipped default', () => {
    expect(resolveMaxNewTasksPerCycle(undefined)).toBe(DEFAULT_MAX_NEW_TASKS_PER_CYCLE);
    expect(resolveMaxNewTasksPerCycle({ maxNewTasksPerCycle: 0 })).toBe(0);
  });
});

describe('resetSleepConfigKey', () => {
  const full = {
    thresholds: { drowsy: 10, sleepy: 20, mustSleep: 30 },
    specialists: { 'sleep-tasks': { model: 'claude-opus-5', effort: 'medium' as const } },
    maxNewTasksPerCycle: 2,
  };

  it('with no key clears everything and re-injects every configured specialist', () => {
    const r = ok(resetSleepConfigKey(full));
    expect(r.config).toEqual({});
    expect(r.changedSpecialists).toEqual(['sleep-tasks']);
    expect(resolveSleepThresholds(r.config)).toEqual(DEFAULT_SLEEP_THRESHOLDS);
  });

  it('clears one specialist field, keeping the other', () => {
    const r = ok(resetSleepConfigKey(full, 'specialists.sleep-tasks.effort'));
    expect(r.config.specialists?.['sleep-tasks']).toEqual({ model: 'claude-opus-5' });
    expect(r.changedSpecialists).toEqual(['sleep-tasks']);
  });

  it('clearing a specialist entirely prunes the empty entry away', () => {
    const r = ok(resetSleepConfigKey(full, 'specialists.sleep-tasks'));
    expect(r.config.specialists).toBeUndefined();
  });

  it('clears the whole threshold block', () => {
    expect(ok(resetSleepConfigKey(full, 'thresholds')).config.thresholds).toBeUndefined();
  });

  it('REFUSES to clear one level when the survivors would invert the ladder', () => {
    // Dropping mustSleep=30 restores the default 60 — fine. Dropping sleepy=20
    // restores 40, which is ABOVE the still-set mustSleep 30.
    const r = resetSleepConfigKey(full, 'thresholds.sleepy');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('must be less than must-sleep (30)');
  });

  it('allows clearing a level whose default keeps the ladder sane', () => {
    const r = ok(resetSleepConfigKey(full, 'thresholds.must-sleep'));
    expect(r.config.thresholds).toEqual({ drowsy: 10, sleepy: 20 });
  });

  it('clears the cap', () => {
    expect(ok(resetSleepConfigKey(full, 'max-new-tasks')).config.maxNewTasksPerCycle).toBeUndefined();
  });
});

describe('validateThresholdLadder', () => {
  it('passes on an empty override (pure defaults)', () => {
    expect(validateThresholdLadder(undefined)).toBeNull();
  });
  it('names the FIRST rule broken', () => {
    expect(validateThresholdLadder({ drowsy: 50 })).toContain('drowsy (50) must be less than sleepy (40)');
  });
});

describe('applySleepConfigPatch — the Sleep line', () => {
  const okP = (r: ReturnType<typeof applySleepConfigPatch>) => {
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    return r;
  };
  const ALL = ['sleep-tasks', 'sleep-state', 'sleep-product', 'sleep-migration', 'sleep-learn'];

  it('sets the line and marks all five specialists for re-injection', () => {
    const r = okP(applySleepConfigPatch({}, { model: 'claude-sonnet-5-5', effort: 'medium' }));
    expect(r.config.model).toBe('claude-sonnet-5-5');
    expect(r.config.effort).toBe('medium');
    expect([...r.changedSpecialists].sort()).toEqual([...ALL].sort());
  });

  it('followers take the line; a pinned helper keeps its own; ↺ (null) returns it to the line', () => {
    let r = okP(applySleepConfigPatch({}, { model: 'claude-sonnet-5-5', effort: 'low' }));
    r = okP(applySleepConfigPatch(r.config, { specialists: { 'sleep-product': { model: 'claude-opus-5-5', effort: 'high' } } }));
    r = okP(applySleepConfigPatch(r.config, { model: 'claude-haiku-5-5' }));
    expect(effectiveSpecialist(r.config, 'sleep-tasks')).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(effectiveSpecialist(r.config, 'sleep-product')).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    r = okP(applySleepConfigPatch(r.config, { specialists: { 'sleep-product': null } }));
    expect(effectiveSpecialist(r.config, 'sleep-product')).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
  });

  it('with no line, a specialist keeps its packaged default (undefined)', () => {
    expect(effectiveSpecialist({}, 'sleep-tasks')).toBeUndefined();
    expect(effectiveSpecialist(undefined, 'sleep-tasks')).toBeUndefined();
  });

  it('legacy: the first line write clears five EQUAL pins (they were the old "line")', () => {
    const uniform = Object.fromEntries(ALL.map((n) => [n, { model: 'claude-opus-5-5', effort: 'medium' }]));
    const r = okP(applySleepConfigPatch({ specialists: uniform as never }, { model: 'claude-sonnet-5-5', effort: 'low' }));
    expect(r.config.specialists).toBeUndefined();
    expect(effectiveSpecialist(r.config, 'sleep-learn')).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' });
  });

  it('legacy: a first write of ONE half keeps the other half the five pins had', () => {
    const uniform = Object.fromEntries(ALL.map((n) => [n, { model: 'claude-opus-5-5', effort: 'high' }]));
    const effortOnly = okP(applySleepConfigPatch({ specialists: uniform as never }, { effort: 'medium' }));
    expect(effortOnly.config.specialists).toBeUndefined();
    expect(effectiveSpecialist(effortOnly.config, 'sleep-state')).toEqual({ model: 'claude-opus-5-5', effort: 'medium' });
    const modelOnly = okP(applySleepConfigPatch({ specialists: uniform as never }, { model: 'claude-sonnet-5-5' }));
    expect(effectiveSpecialist(modelOnly.config, 'sleep-tasks')).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' });
  });

  it('legacy: mixed pins stay pinned', () => {
    const mixed = Object.fromEntries(ALL.map((n, i) => [n, { model: 'claude-opus-5-5', effort: i === 0 ? 'high' : 'medium' }]));
    const r = okP(applySleepConfigPatch({ specialists: mixed as never }, { model: 'claude-sonnet-5-5' }));
    expect(Object.keys(r.config.specialists ?? {})).toHaveLength(5);
  });

  it('legacy clearing runs only on the FIRST line write', () => {
    const r1 = okP(applySleepConfigPatch({}, { model: 'claude-sonnet-5-5', effort: 'low' }));
    const uniform = Object.fromEntries(ALL.map((n) => [n, { model: 'claude-opus-5-5', effort: 'medium' }]));
    const r2 = okP(applySleepConfigPatch({ ...r1.config, specialists: uniform as never }, { model: 'claude-haiku-5-5' }));
    expect(Object.keys(r2.config.specialists ?? {})).toHaveLength(5);
  });

  it('refuses an unknown model or effort, and null resets the line', () => {
    expect(applySleepConfigPatch({}, { model: 'claude-opus5' }).ok).toBe(false);
    expect(applySleepConfigPatch({}, { effort: 'max' }).ok).toBe(false);
    const r = okP(applySleepConfigPatch({ model: 'claude-sonnet-5-5', effort: 'low' }, { model: null, effort: null }));
    expect(r.config.model).toBeUndefined();
    expect(r.config.effort).toBeUndefined();
  });

  it('the reader keeps what the writer accepted', () => {
    const r = okP(applySleepConfigPatch({}, { model: 'claude-sonnet-5-5', effort: 'high' }));
    expect(readSetupConfigSleep(r.config)).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' });
  });
});
