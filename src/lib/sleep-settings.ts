import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KNOWN_SLEEP_MODELS,
  SLEEP_EFFORT_LEVELS,
  SLEEP_SPECIALISTS,
  isSleepSpecialist,
  type SleepConfig,
  type SleepEffort,
  type SleepSpecialist,
  type SleepSpecialistConfig,
} from './setup-config.js';
import { sanitizeModel } from './claude-args.js';
import { resolveSleepThresholds } from './sleep-consolidation.js';
import { readSpecialistFrontmatter } from './sleep-specialist-frontmatter.js';

/**
 * sleep-settings — the WRITE side of the per-brain sleep block, kept pure so the
 * CLI (`dreamcontext sleep config set`) and the dashboard (`PATCH /api/config`)
 * validate identically instead of each inventing its own rules.
 *
 * The asymmetry with `sanitizeSleep` is deliberate and is the whole design:
 *  - READ (sanitizeSleep) is defensive — a bad field is DROPPED so a garbage
 *    config can never break a Stop hook.
 *  - WRITE (here) is loud — a bad value is REFUSED with the rule it broke, so
 *    nobody sets Must Sleep to 30 and silently gets 60 back.
 */

/** How many NEW tasks one sleep cycle may file when a brain has not said otherwise. */
export const DEFAULT_MAX_NEW_TASKS_PER_CYCLE = 5;

/** Hard bounds shared by the CLI and the dashboard so their errors agree. */
export const THRESHOLD_MIN = 1;
export const THRESHOLD_MAX = 1000;
export const MAX_NEW_TASKS_CEILING = 50;

export interface SleepConfigWriteResult {
  ok: true;
  config: SleepConfig;
  /** Specialists whose model/effort just changed — the exact set to re-inject. */
  changedSpecialists: SleepSpecialist[];
}
export interface SleepConfigWriteError {
  ok: false;
  error: string;
}
export type SleepConfigWrite = SleepConfigWriteResult | SleepConfigWriteError;

const THRESHOLD_KEYS: Record<string, 'drowsy' | 'sleepy' | 'mustSleep'> = {
  'thresholds.drowsy': 'drowsy',
  'thresholds.sleepy': 'sleepy',
  'thresholds.must-sleep': 'mustSleep',
  'thresholds.mustSleep': 'mustSleep',
};

const LEVEL_LABEL: Record<'drowsy' | 'sleepy' | 'mustSleep', string> = {
  drowsy: 'drowsy',
  sleepy: 'sleepy',
  mustSleep: 'must-sleep',
};

function parseInteger(value: string): number | null {
  if (!/^-?\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

/**
 * Validate a candidate ladder and say WHICH rule it breaks.
 *
 * Checks the RESOLVED set (overrides merged over the defaults), because that is
 * what the brain will actually run on — setting only `must-sleep` to 30 while
 * `sleepy` is still the default 40 is exactly the trap this message exists for.
 */
export function validateThresholdLadder(thresholds: SleepConfig['thresholds']): string | null {
  const t = { drowsy: 24, sleepy: 40, mustSleep: 60, ...thresholds };
  if (!(t.drowsy < t.sleepy)) {
    return `drowsy (${t.drowsy}) must be less than sleepy (${t.sleepy}).`;
  }
  if (!(t.sleepy < t.mustSleep)) {
    return `sleepy (${t.sleepy}) must be less than must-sleep (${t.mustSleep}).`;
  }
  return null;
}

/** Is this a model id the current build knows about? */
export function isKnownSleepModel(model: string): boolean {
  return (KNOWN_SLEEP_MODELS as readonly string[]).includes(model);
}

/** Drop empty specialist entries / empty sections so `config` never grows noise. */
function prune(config: SleepConfig): SleepConfig {
  const out: SleepConfig = { ...config };
  if (out.thresholds && Object.keys(out.thresholds).length === 0) delete out.thresholds;
  if (out.specialists) {
    for (const [name, entry] of Object.entries(out.specialists)) {
      if (!entry || Object.keys(entry).length === 0) delete out.specialists[name as SleepSpecialist];
    }
    if (Object.keys(out.specialists).length === 0) delete out.specialists;
  }
  return out;
}

/**
 * Apply one `sleep config set <key> <value>`.
 *
 * Returns the NEW config (the caller persists it) plus the specialists whose
 * agent file now needs re-injecting. Never mutates its input.
 */
export function setSleepConfigKey(
  current: SleepConfig,
  key: string,
  value: string,
  opts: { allowUnknown?: boolean } = {},
): SleepConfigWrite {
  const config: SleepConfig = {
    ...current,
    thresholds: current.thresholds ? { ...current.thresholds } : undefined,
    specialists: current.specialists ? { ...current.specialists } : undefined,
  };

  // --- thresholds.<level> ---
  const level = THRESHOLD_KEYS[key];
  if (level) {
    const n = parseInteger(value);
    if (n === null || n < THRESHOLD_MIN || n > THRESHOLD_MAX) {
      return { ok: false, error: `${key} must be a whole number between ${THRESHOLD_MIN} and ${THRESHOLD_MAX} (got "${value}").` };
    }
    const thresholds = { ...(config.thresholds ?? {}), [level]: n };
    const violation = validateThresholdLadder(thresholds);
    if (violation) {
      return {
        ok: false,
        error: `${violation} Set the other levels too, or the whole ladder is ignored — `
          + `e.g. \`dreamcontext sleep config set thresholds.${LEVEL_LABEL[level]} <n>\` for each.`,
      };
    }
    config.thresholds = thresholds;
    return { ok: true, config: prune(config), changedSpecialists: [] };
  }

  // --- specialists.<name>.model|effort ---
  const spec = /^specialists\.([a-z-]+)\.(model|effort)$/.exec(key);
  if (spec) {
    const [, name, field] = spec;
    if (!isSleepSpecialist(name)) {
      return { ok: false, error: `Unknown specialist "${name}". Known: ${SLEEP_SPECIALISTS.join(', ')}.` };
    }
    const entry: SleepSpecialistConfig = { ...(config.specialists?.[name] ?? {}) };

    if (field === 'model') {
      const safe = sanitizeModel(value);
      if (!safe) {
        return { ok: false, error: `"${value}" is not a valid model id (letters, digits, dot, dash, underscore; max 64 chars).` };
      }
      if (!isKnownSleepModel(safe) && !opts.allowUnknown) {
        return {
          ok: false,
          error: `"${safe}" is not a model this build knows about. Known: ${KNOWN_SLEEP_MODELS.join(', ')}.\n`
            + '  If it is newer than this release, pass --allow-unknown. A model that does not exist at run time '
            + 'fails the specialist mid-cycle, so this is checked now rather than then.',
        };
      }
      entry.model = safe;
    } else {
      if (!(SLEEP_EFFORT_LEVELS as readonly string[]).includes(value)) {
        return { ok: false, error: `effort must be one of: ${SLEEP_EFFORT_LEVELS.join(', ')} (got "${value}").` };
      }
      entry.effort = value as SleepEffort;
    }

    config.specialists = { ...(config.specialists ?? {}), [name]: entry };
    return { ok: true, config: prune(config), changedSpecialists: [name] };
  }

  // --- max-new-tasks ---
  if (key === 'max-new-tasks' || key === 'maxNewTasksPerCycle') {
    const n = parseInteger(value);
    if (n === null || n < 0 || n > MAX_NEW_TASKS_CEILING) {
      return { ok: false, error: `${key} must be a whole number between 0 and ${MAX_NEW_TASKS_CEILING} (0 = file no tasks at all).` };
    }
    config.maxNewTasksPerCycle = n;
    return { ok: true, config: prune(config), changedSpecialists: [] };
  }

  return {
    ok: false,
    error: `Unknown key "${key}". Valid keys: thresholds.drowsy | thresholds.sleepy | thresholds.must-sleep | `
      + `specialists.<${SLEEP_SPECIALISTS.join('|')}>.model|effort | max-new-tasks`,
  };
}

/** Clear one key (or the whole block) back to the shipped defaults. */
export function resetSleepConfigKey(current: SleepConfig, key?: string): SleepConfigWrite {
  if (!key) {
    // Everything goes — every specialist may need re-injecting.
    const changed = Object.keys(current.specialists ?? {}).filter(isSleepSpecialist);
    return { ok: true, config: {}, changedSpecialists: changed };
  }

  const config: SleepConfig = {
    ...current,
    thresholds: current.thresholds ? { ...current.thresholds } : undefined,
    specialists: current.specialists ? { ...current.specialists } : undefined,
  };

  if (key === 'thresholds') {
    delete config.thresholds;
    return { ok: true, config: prune(config), changedSpecialists: [] };
  }
  const level = THRESHOLD_KEYS[key];
  if (level) {
    if (config.thresholds) delete config.thresholds[level];
    // Removing one level can leave the REST non-monotonic; refuse rather than
    // persist a set that the reader would silently discard whole.
    const violation = validateThresholdLadder(config.thresholds);
    if (violation) {
      return { ok: false, error: `${violation} Reset the other levels too (\`sleep config reset thresholds\`).` };
    }
    return { ok: true, config: prune(config), changedSpecialists: [] };
  }

  const spec = /^specialists\.([a-z-]+)(?:\.(model|effort))?$/.exec(key);
  if (spec) {
    const [, name, field] = spec;
    if (!isSleepSpecialist(name)) {
      return { ok: false, error: `Unknown specialist "${name}". Known: ${SLEEP_SPECIALISTS.join(', ')}.` };
    }
    if (config.specialists?.[name]) {
      if (field) delete config.specialists[name]![field as keyof SleepSpecialistConfig];
      else delete config.specialists[name];
    }
    return { ok: true, config: prune(config), changedSpecialists: [name] };
  }

  if (key === 'max-new-tasks' || key === 'maxNewTasksPerCycle') {
    delete config.maxNewTasksPerCycle;
    return { ok: true, config: prune(config), changedSpecialists: [] };
  }

  return { ok: false, error: `Unknown key "${key}".` };
}

/**
 * Apply a PARTIAL sleep block the way `PATCH /api/config` receives it, reusing
 * the exact same rules as `sleep config set` so the dashboard and the CLI can
 * never accept different things.
 *
 * MERGE semantics, not replace: only the fields present are touched, and an
 * explicit `null` means "reset this back to the default". That lets the Settings
 * form send just what the user changed instead of having to round-trip (and
 * risk clobbering) settings a teammate changed in the meantime.
 *
 * Returns the first violation as a human sentence — the UI shows it verbatim.
 */
export function applySleepConfigPatch(
  current: SleepConfig,
  patch: Record<string, unknown>,
): SleepConfigWrite {
  let config: SleepConfig = current;
  const changed = new Set<SleepSpecialist>();

  const step = (r: SleepConfigWrite): string | null => {
    if (!r.ok) return r.error;
    config = r.config;
    for (const n of r.changedSpecialists) changed.add(n);
    return null;
  };
  const fail = (error: string): SleepConfigWriteError => ({ ok: false, error });

  // --- thresholds ---
  if (patch.thresholds !== undefined) {
    if (patch.thresholds === null) {
      const err = step(resetSleepConfigKey(config, 'thresholds'));
      if (err) return fail(err);
    } else if (typeof patch.thresholds !== 'object' || Array.isArray(patch.thresholds)) {
      return fail('thresholds must be an object.');
    } else {
      const t = patch.thresholds as Record<string, unknown>;
      // Validate the WHOLE resulting ladder up front. Applying level by level
      // would reject a legitimate simultaneous edit (lowering all three at once)
      // just because an intermediate state is transiently inverted.
      const merged = { ...(config.thresholds ?? {}) };
      for (const [key, level] of [['drowsy', 'drowsy'], ['sleepy', 'sleepy'], ['mustSleep', 'mustSleep'], ['must-sleep', 'mustSleep']] as const) {
        if (t[key] === undefined) continue;
        if (t[key] === null) { delete merged[level]; continue; }
        if (typeof t[key] !== 'number' || !Number.isInteger(t[key]) || (t[key] as number) < THRESHOLD_MIN || (t[key] as number) > THRESHOLD_MAX) {
          return fail(`thresholds.${key} must be a whole number between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}.`);
        }
        merged[level] = t[key] as number;
      }
      const violation = validateThresholdLadder(merged);
      if (violation) return fail(violation);
      config = prune({ ...config, thresholds: merged });
    }
  }

  // --- specialists ---
  if (patch.specialists !== undefined) {
    if (patch.specialists === null) {
      for (const name of Object.keys(config.specialists ?? {})) {
        if (isSleepSpecialist(name)) {
          const err = step(resetSleepConfigKey(config, `specialists.${name}`));
          if (err) return fail(err);
        }
      }
    } else if (typeof patch.specialists !== 'object' || Array.isArray(patch.specialists)) {
      return fail('specialists must be an object.');
    } else {
      for (const [name, value] of Object.entries(patch.specialists as Record<string, unknown>)) {
        if (!isSleepSpecialist(name)) {
          return fail(`Unknown specialist "${name}". Known: ${SLEEP_SPECIALISTS.join(', ')}.`);
        }
        if (value === null) {
          const err = step(resetSleepConfigKey(config, `specialists.${name}`));
          if (err) return fail(err);
          continue;
        }
        if (typeof value !== 'object' || Array.isArray(value)) {
          return fail(`specialists.${name} must be an object.`);
        }
        for (const field of ['model', 'effort'] as const) {
          const v = (value as Record<string, unknown>)[field];
          if (v === undefined) continue;
          const err = v === null
            ? step(resetSleepConfigKey(config, `specialists.${name}.${field}`))
            // The UI only ever offers KNOWN models, so no --allow-unknown here:
            // an unknown id arriving over HTTP is a bug or a hand-rolled request.
            : typeof v === 'string'
              ? step(setSleepConfigKey(config, `specialists.${name}.${field}`, v))
              : `specialists.${name}.${field} must be a string.`;
          if (err) return fail(err);
        }
      }
    }
  }

  // --- cap ---
  if (patch.maxNewTasksPerCycle !== undefined) {
    if (patch.maxNewTasksPerCycle === null) {
      const err = step(resetSleepConfigKey(config, 'max-new-tasks'));
      if (err) return fail(err);
    } else if (typeof patch.maxNewTasksPerCycle !== 'number' || !Number.isInteger(patch.maxNewTasksPerCycle)) {
      return fail('maxNewTasksPerCycle must be a whole number.');
    } else {
      const err = step(setSleepConfigKey(config, 'max-new-tasks', String(patch.maxNewTasksPerCycle)));
      if (err) return fail(err);
    }
  }

  return { ok: true, config, changedSpecialists: [...changed] };
}

/** The per-cycle task cap actually in force. */
export function resolveMaxNewTasksPerCycle(config: SleepConfig | null | undefined): number {
  return config?.maxNewTasksPerCycle ?? DEFAULT_MAX_NEW_TASKS_PER_CYCLE;
}

/**
 * What the INSTALLED agent file currently declares — used by `sleep config` to
 * show the effective model when a brain has set no override, so the display is
 * what will actually run rather than a blank.
 */
export function readInstalledSpecialistDefaults(
  projectRoot: string,
  name: SleepSpecialist,
): SleepSpecialistConfig {
  const path = join(projectRoot, '.claude', 'agents', `${name}.md`);
  if (!existsSync(path)) return {};
  try {
    return readSpecialistFrontmatter(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

/** Re-export so callers reading settings have one import for the whole block. */
export { resolveSleepThresholds };
