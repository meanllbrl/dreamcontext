import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listAutomations, readAutomationCache, readRunSidecar } from './store.js';
import { checkApproval } from './registry.js';
import { pendingReviewCard } from './review.js';
import { pendingOutputsSince } from './consumption.js';

/**
 * Automations snapshot renderer — the pure aggregation behind the session
 * snapshot's `## Automations` section. Reads cache + the approval registry +
 * the run sidecar; imports NEITHER `./runner.js` NOR `./tick.js` (this module
 * has no business spawning or ticking anything, and pulling either in would
 * make a session-start read depend on the runner's much larger surface).
 *
 * Four signals, deliberately kept SEPARATE rather than derived from one
 * another, because each answers a different question:
 *   - cache history      → "what happened recently" (ok/failed/timeout/deferred)
 *   - `checkApproval`     → "is this slug currently blocked from running" — the
 *                           ONLY signal that can fire with NO cache record at
 *                           all (a synced-in automation that has never been
 *                           ticked yet still needs surfacing NOW, before its
 *                           first due fire)
 *   - the run sidecar     → "is a PREVIOUS run's child group still alive right
 *                           now" — independent of whatever the last recorded
 *                           cache event says (an `ok`-terminated run's cache
 *                           entry says nothing about a LATER run's orphan)
 *   - `pendingOutputsSince` → "is there automation output waiting for the next
 *                           sleep cycle to read" (Change C) — computed against
 *                           the persisted `last_consolidated_at` boundary, read
 *                           directly here rather than via `readSleepState`
 *                           (`cli/commands/sleep.ts`): this is a lib module and
 *                           must not import a CLI command file, and `sleep.ts`
 *                           itself already imports FROM `lib/automations/*`, so
 *                           the reverse import would invert that direction with
 *                           no compensating need — a tiny local lenient read of
 *                           the one field is cheaper and keeps the layering intact.
 *
 * PLAIN TEXT ONLY — no chalk/ANSI/prompts. This feeds the SessionStart hook
 * programmatically, not a human terminal. Returns `[]` when there is nothing
 * to say, so a clean brain's snapshot stays byte-identical — the mechanical
 * enforcement of "ships fully disabled".
 */

export interface AutomationsSnapshot {
  lines: string[];
  hasBlocked: boolean;
  hasFailure: boolean;
  hasOrphan: boolean;
  hasPendingOutputs: boolean;
  /** A proposal is waiting for a human verdict. Distinct from every other
   *  signal here: the others report something that HAPPENED, this one reports
   *  something the human OWES — and until they pay it, that automation is not
   *  running again. */
  hasPendingReview: boolean;
}

export interface AutomationsSnapshotOptions {
  now?: Date;
  home?: string;
  windowHours?: number;
}

const DEFAULT_WINDOW_HOURS = 24;

/** Signal-0 liveness probe, same semantics as `file-lock.ts`'s
 *  `verifyPidLiveness` check: no throw, or a throw that ISN'T `ESRCH`
 *  (e.g. `EPERM` — exists, just not ours to signal), means alive; `ESRCH`
 *  means dead. Not injectable — tests spy on `process.kill` directly, mirroring
 *  `tests/unit/file-lock.test.ts`'s own convention, so this module's public
 *  contract stays exactly the `{ now, home, windowHours }` shape the plan
 *  specifies. Safe to call unconditionally here: both PIDs it is ever handed
 *  come from `readRunSidecar`, which already validates each is a plain
 *  integer > 1 before returning a non-null sidecar. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

/** `12m ago` / `3h ago` / `2d ago` — coarse enough for a session snapshot,
 *  never negative (a clock skew or a future-dated record reads as "just now"
 *  rather than a confusing negative age). */
function relativeAge(fromIso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Direct, lenient read of just the persisted consolidation boundary
 * (`state/.sleep.json`'s `last_consolidated_at`) — never throws, missing or
 * malformed reads as `null`, matching `SleepState.last_consolidated_at`'s own
 * "no cycle has ever completed" semantics. Deliberately NOT
 * `readSleepState()` from `cli/commands/sleep.ts` — see the module doc.
 */
function readLastConsolidatedAt(contextRoot: string): string | null {
  const path = join(contextRoot, 'state', '.sleep.json');
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const v = (parsed as Record<string, unknown>).last_consolidated_at;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Build the automations snapshot data by walking every manifest once and
 * checking the first three signals above, then a fourth pass for pending
 * automation output. Aggregation only — no I/O beyond the store/registry/
 * boundary reads those signals require.
 */
export function buildAutomationsSnapshot(
  contextRoot: string,
  opts: AutomationsSnapshotOptions = {},
): AutomationsSnapshot {
  const now = opts.now ?? new Date();
  const windowMs = (opts.windowHours ?? DEFAULT_WINDOW_HOURS) * 60 * 60 * 1000;
  const projectRoot = dirname(contextRoot);

  const recentLines: string[] = [];
  const blockedLines: string[] = [];
  const reviewLines: string[] = [];
  const orphanLines: string[] = [];
  const okRuns = new Map<string, number>();
  let hasFailure = false;

  for (const manifest of listAutomations(contextRoot)) {
    // ─── Last-24h runs / failures (cache history within the window) ────────
    const cache = readAutomationCache(contextRoot, manifest.slug);
    if (cache) {
      for (const event of cache.history) {
        // 'blocked' gets its own line below, driven by `checkApproval` (which
        // ALSO covers an automation that has never run at all); 'orphaned'
        // gets its own line below too, driven by the LIVE sidecar probe, not
        // this historical record — rendering either here would just repeat
        // the same fact from a staler signal.
        if (event.status === 'blocked' || event.status === 'orphaned') continue;
        const finishedMs = Date.parse(event.finishedAt);
        if (!Number.isFinite(finishedMs) || now.getTime() - finishedMs > windowMs) continue;

        if (event.status === 'ok') {
          // Routine success aggregates to ONE line below (owner decision
          // 2026-07-30): only failures earn per-run detail.
          okRuns.set(manifest.slug, (okRuns.get(manifest.slug) ?? 0) + 1);
        } else {
          if (event.status === 'failed' || event.status === 'timeout') hasFailure = true;
          const age = relativeAge(event.finishedAt, now);
          const reason = event.error ? ` — ${event.error}` : '';
          recentLines.push(`- ${manifest.slug}: ${event.status.toUpperCase()} — ${age}${reason}`);
        }
      }
    }

    // ─── Blocked pending approval — independent of any cache record ────────
    const verdict = checkApproval(projectRoot, manifest, opts.home);
    if (!verdict.approved) {
      blockedLines.push(
        `- ${manifest.slug}: blocked pending approval (${verdict.reason}) — run \`dreamcontext automations approve ${manifest.slug}\``,
      );
    }

    // ─── A proposal awaiting a verdict — the automation is HELD, not broken ─
    // Read from the card store rather than from the last cache event, for the
    // same reason `blocked` is read from the registry: the run that created the
    // card may have been days ago and long since fallen out of the 24h window,
    // but the card is still open and the automation is still not firing. A
    // signal about something OWED cannot expire on a clock.
    const card = pendingReviewCard(contextRoot, manifest.slug);
    if (card) {
      reviewLines.push(
        `- ${manifest.slug}: waiting for your verdict — "${card.title}" (${relativeAge(card.createdAt, now)}); ` +
        `it will not run again until you answer — \`dreamcontext automations review ${manifest.slug}\``,
      );
    }

    // ─── Live orphan — independent of the last recorded cache event ────────
    const sidecar = readRunSidecar(contextRoot, manifest.slug);
    if (sidecar && !isAlive(sidecar.runnerPid) && isAlive(sidecar.childPgid)) {
      orphanLines.push(
        `- automation ${manifest.slug} may have an orphaned run — run \`dreamcontext automations kill ${manifest.slug}\``,
      );
    }
  }

  // ─── Pending automation output (Change C) — ONE combined line, not one per
  // slug: this is a nudge that consolidation has material waiting, not a
  // diagnostic list (that detail lives in `sleep start`'s own output). `[]`
  // on a clean brain (no `.sleep.json`, no `automations/output/`), which is
  // exactly what keeps a fresh project's snapshot byte-identical.
  const pendingLines: string[] = [];
  const pending = pendingOutputsSince(contextRoot, readLastConsolidatedAt(contextRoot));
  if (pending.outputs.length > 0) {
    const slugs = [...new Set(pending.outputs.map((o) => o.slug))].sort();
    pendingLines.push(
      `- ${pending.outputs.length} automation output(s) pending consolidation (${slugs.join(', ')})`,
    );
  }

  // One line for all routine success — actionable states keep their detail
  // and render first.
  const okLines: string[] = [];
  if (okRuns.size > 0) {
    const total = [...okRuns.values()].reduce((a, b) => a + b, 0);
    const listed = [...okRuns.entries()]
      .map(([slug, n]) => (n > 1 ? `${slug} x${n}` : slug))
      .join(', ');
    okLines.push(`- ${total} ok run(s) in the last 24h: ${listed} — \`dreamcontext automations list\``);
  }

  return {
    // Review sits directly after failures and before everything else that is
    // merely informational: it is the only line here that names something the
    // reader has to DO before that automation works again.
    lines: [...recentLines, ...reviewLines, ...blockedLines, ...orphanLines, ...pendingLines, ...okLines],
    hasBlocked: blockedLines.length > 0,
    hasFailure,
    hasOrphan: orphanLines.length > 0,
    hasPendingOutputs: pendingLines.length > 0,
    hasPendingReview: reviewLines.length > 0,
  };
}

/**
 * Plain-text lines for the session snapshot's `## Automations` section.
 * `[]` when there is nothing to say. The caller (`src/cli/commands/snapshot.ts`,
 * a later task) is responsible for the `## Automations` heading and for
 * deciding demotion/eviction under budget — this function only ever returns
 * the body bullets.
 *
 * Deliberately does NOT render a heartbeat/staleness warning: a healthy tick
 * can legitimately run for hours (multiple same-fire-time automations, each
 * up to the 60-minute timeout cap), so any flat staleness threshold here would
 * false-alarm during the busiest correct operation. Raw heartbeat timestamps
 * are surfaced only by `automations install --check`, not here.
 */
export function renderAutomationsSection(contextRoot: string, opts: AutomationsSnapshotOptions = {}): string[] {
  return buildAutomationsSnapshot(contextRoot, opts).lines;
}
