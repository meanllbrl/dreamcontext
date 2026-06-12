/**
 * Setup version drift detection.
 *
 * Pure module — no I/O. All functions are deterministic given their inputs.
 * Drift is the state where the project's installed dreamcontext assets (skill,
 * agents, hooks) were installed by a DIFFERENT CLI version than the one
 * currently running. Running `dreamcontext update` resolves it.
 *
 * Order of resolution in resolveDriftState():
 *   1. DREAMCONTEXT_DRIFT_CHECK in {0,off,false} → 'disabled' (env kill-switch)
 *   2. cliVersion === '0.0.0' → 'current' (dev/broken build fail-safe, never nag)
 *   3. setupVersion === '0.0.0' → 'bootstrap' (project predates version tracking)
 *   4. compareVersions(cli, setup): >0 → 'stale', <0 → 'downgrade', =0 → 'current'
 */

import { compareVersions } from './version-check.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DriftState =
  | 'current'
  | 'stale'
  | 'bootstrap'
  | 'downgrade'
  | 'disabled';

export interface DriftInput {
  cliVersion: string;
  setupVersion: string;
  /** Value of process.env.DREAMCONTEXT_DRIFT_CHECK (pass undefined for default). */
  driftCheckEnv?: string;
}

// ─── State resolver ───────────────────────────────────────────────────────────

/**
 * Resolve the drift state from the given inputs.
 *
 * Resolution order is strict and documented above. compareVersions is reused
 * from version-check.ts — do NOT re-implement semver comparison here.
 */
export function resolveDriftState(input: DriftInput): DriftState {
  const { cliVersion, setupVersion, driftCheckEnv } = input;

  // 1. Kill-switch: DREAMCONTEXT_DRIFT_CHECK in {0, off, false}
  if (driftCheckEnv !== undefined) {
    const v = driftCheckEnv.trim().toLowerCase();
    if (v === '0' || v === 'off' || v === 'false') {
      return 'disabled';
    }
  }

  // 2. cliVersion === '0.0.0': unresolvable build (dev/broken) → fail-safe to current
  if (cliVersion === '0.0.0') {
    return 'current';
  }

  // 3. setupVersion === '0.0.0': project predates version tracking → bootstrap
  if (setupVersion === '0.0.0') {
    return 'bootstrap';
  }

  // 4. Semantic comparison
  const cmp = compareVersions(cliVersion, setupVersion);
  if (cmp > 0) return 'stale';
  if (cmp < 0) return 'downgrade';
  return 'current';
}

// ─── Directive builder ────────────────────────────────────────────────────────

/**
 * Build a snapshot directive string for the given drift state, or null when
 * no action is required (current / disabled).
 *
 * Stale: agent is instructed to run `dreamcontext update` immediately.
 * Bootstrap: same heading, softer body for projects that predate version tracking.
 * Downgrade: warn-only — CLI is older than the setup; NO update instruction.
 * Current/Disabled: null.
 *
 * Content-safety guarantee: `dreamcontext update` only refreshes skill/agents/hooks
 * and prunes version-tracked files. It never touches `_dream_context/` brain files.
 */
/**
 * Version values originate from package.json and `.config.json` (the latter is
 * editable / git-shareable). They are interpolated into the SessionStart snapshot
 * the agent obeys, so strip newlines and cap length to prevent a crafted value
 * (e.g. `0.0.0\n\n## DIRECTIVE …`) from injecting instructions into that context.
 */
function sanitizeForDirective(value: string): string {
  // Collapse newlines (no new markdown blocks), strip markdown-structural chars
  // (#, backtick, [], *, >) so the value can't become a heading/directive/link,
  // and cap length — a legitimate version string is short semver.
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[#`*>[\]]/g, '')
    .slice(0, 40)
    .trim();
}

export function buildDriftDirective(input: DriftInput): string | null {
  const state = resolveDriftState(input);
  const cliVersion = sanitizeForDirective(input.cliVersion);
  const setupVersion = sanitizeForDirective(input.setupVersion);

  switch (state) {
    case 'current':
    case 'disabled':
      return null;

    case 'stale':
      return [
        '## ⚠ Stale Project Assets\n',
        `This project's installed assets (skill, agents, hooks) were last refreshed at v${setupVersion},`,
        `but the CLI is now at v${cliVersion}. They are out of date.\n`,
        '**Action required:** Run `dreamcontext update` NOW and report the result.',
        'This command is content-safe — it only refreshes skill/agents/hooks and prunes',
        'version-tracked files. It never modifies anything inside `_dream_context/` brain.',
        'If you cannot run it yourself, tell the user: "or run `dreamcontext update` yourself"',
        '',
      ].join('\n');

    case 'bootstrap':
      return [
        '## ⚠ Stale Project Assets\n',
        `This project was set up before version tracking was introduced (CLI is now v${cliVersion}).`,
        'The installed assets (skill, agents, hooks) may be out of date.\n',
        '**Action required:** Run `dreamcontext update` NOW and report the result.',
        'This command is content-safe — it only refreshes skill/agents/hooks and prunes',
        'version-tracked files. It never modifies anything inside `_dream_context/` brain.',
        'If you cannot run it yourself, tell the user: "or run `dreamcontext update` yourself"',
        '',
      ].join('\n');

    case 'downgrade':
      return `**Note:** The CLI version (v${cliVersion}) is older than the last setup version (v${setupVersion}). This is unusual — consider upgrading the CLI.\n`;

    default:
      return null;
  }
}
