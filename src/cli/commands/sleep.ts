import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { promptInput } from '../../lib/prompt.js';
import { readJsonObject, writeJsonObject, readJsonArray, writeJsonArray } from '../../lib/json-file.js';
import { today } from '../../lib/id.js';
import { header, success, error, warn, info } from '../../lib/format.js';
import { migrateDataStructures, fenceExistingDataStructures } from '../../lib/data-structures-migration.js';
import { getTaskBackend } from '../../lib/task-backend/index.js';
import { ProgressBar } from '../../lib/progress.js';
import type { SyncOptions } from '../../lib/task-backend/types.js';
import { runMigrations } from '../../lib/migration-runner.js';
import { readSetupConfig, updateSetupConfig, readBrainLocal, writeBrainLocal, SLEEP_SPECIALISTS } from '../../lib/setup-config.js';
import {
  setSleepConfigKey,
  resetSleepConfigKey,
  readInstalledSpecialistDefaults,
  DEFAULT_MAX_NEW_TASKS_PER_CYCLE,
} from '../../lib/sleep-settings.js';
import { applySleepSpecialistOverrides } from '../../lib/install-packs.js';
import { resolveTombstone, readTombstones } from '../../lib/task-tombstones.js';
import {
  currentAutoSleepFingerprint,
  readAutoSleepSidecar,
  liveAutoSleepJob,
} from '../../lib/auto-sleep.js';
import { runAutoSleep, cancelAutoSleep } from '../../lib/auto-sleep-runner.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { acquireFileLock, releaseFileLock } from '../../lib/file-lock.js';
import { withSleepStateLock } from '../../lib/sleep-state-lock.js';
import { runBrainSync } from '../../lib/git-sync/sync-engine.js';
import { reconcileBrainSyncSuccess, reconcileBrainSyncFailure } from '../../lib/git-sync/auth-reconcile.js';
import { classifySyncError } from '../../lib/git-sync/failure.js';
import { resolveBrainSyncToken, resolveBrainSyncEnabled } from '../../lib/git-sync/brain-repo.js';
import { isPerProjectToken } from '../../lib/git-sync/token-fallback.js';
import { renderBrainSyncResult } from './brain.js';
import { buildCorpus } from '../../lib/recall.js';
import { refreshEmbeddings, embeddingCacheExists } from '../../lib/embeddings/store.js';
import { loadProjectVocabulary, auditCorpus } from '../../lib/taxonomy.js';
import {
  readSleepFlags,
  writeSleepFlags,
  reconcileFlags,
  escalations,
  renderEscalationAsks,
  bumpPriority,
  parseFlagOption,
  planCuratorTask,
  CURATOR_TASK_SLUG,
} from '../../lib/sleep-flags.js';
import { loadStatuses } from '../../lib/overrides.js';
import { readDedupDigest, renderDedupDigest } from '../../lib/embeddings/dedup-log.js';
import { scanDigests, planDigestGc, runDigestGc } from '../../lib/session-digest.js';
import { collectBrainDirty, renderBrainDirtyWarning } from '../../lib/brain-dirty.js';
import {
  pendingOutputsSince,
  readPrivateDerivationMarker,
  clearPrivateDerivationMarker,
} from '../../lib/automations/consumption.js';
import { listAutomations } from '../../lib/automations/store.js';
import {
  sleepinessLevel,
  sleepinessRange,
  applyConsolidation,
  buildHistoryEntry,
  finalizeSleepState,
  validateSleepAdd,
  consolidationDepth,
  catchupDebtSplit,
  inspectSleepLock,
  SLEEP_LOCK_STALE_MS,
  SLEEP_START_LOCK_STALE_MS,
  resolveSleepThresholds,
  hasInvalidSleepThresholds,
} from '../../lib/sleep-consolidation.js';

// ─── Types ─────────────────────────────────────────────────────────────────
// Data types live in sleep-consolidation.ts (a side-effect-free leaf module so
// they can be unit-tested in isolation). Re-exported here so all existing
// importers of these types from './sleep.js' keep compiling.

export type {
  SessionRecord,
  Bookmark,
  Trigger,
  KnowledgeAccessRecord,
  SleepHistoryEntry,
  CompactionRecord,
  FieldValue,
  FieldChange,
  DashboardChange,
  SleepState,
  ConsolidationDepth,
} from '../../lib/sleep-consolidation.js';

import type { SleepState, SleepHistoryEntry, CompactionRecord, KnowledgeAccessRecord, DashboardChange } from '../../lib/sleep-consolidation.js';

const DEFAULT_SLEEP_STATE: SleepState = {
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
  recall_mode: 'haiku',
  consolidation_depth: null,
  pendingMigrationNotices: [],
  cycle_tasks_filed: [],
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function getSleepPath(root: string): string {
  return join(root, 'state', '.sleep.json');
}

function getSleepHistoryPath(root: string): string {
  return join(root, 'state', '.sleep-history.json');
}

/** Path to the cross-process `sleep start` STAMP lock (see SLEEP_START_LOCK_STALE_MS). */
function getSleepStartLockPath(root: string): string {
  return join(root, 'state', '.sleep.start.lock');
}

/** Create a fresh default state with no shared references */
function freshDefaults(): SleepState {
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
    recall_mode: 'haiku',
    consolidation_depth: null,
    pendingMigrationNotices: [],
    cycle_tasks_filed: [],
  };
}

/**
 * Read sleep state from disk. Returns defaults if file is missing or malformed.
 * Exported for use by snapshot and hook.
 */
export function readSleepState(root: string): SleepState {
  const filePath = getSleepPath(root);
  if (!existsSync(filePath)) {
    return freshDefaults();
  }
  try {
    const parsed = readJsonObject<Partial<SleepState> & { sleep_history?: SleepHistoryEntry[]; compaction_log?: CompactionRecord[] }>(filePath);

    // Migration: move sleep_history from .sleep.json to .sleep-history.json
    if (Array.isArray(parsed.sleep_history) && parsed.sleep_history.length > 0) {
      const historyPath = getSleepHistoryPath(root);
      let existing: SleepHistoryEntry[] = [];
      try {
        if (existsSync(historyPath)) {
          existing = readJsonArray<SleepHistoryEntry>(historyPath);
        }
      } catch { /* ignore */ }
      const merged = [...parsed.sleep_history, ...existing];
      writeJsonArray(historyPath, merged);
      // Remove from .sleep.json
      delete parsed.sleep_history;
      writeJsonObject(filePath, parsed);
    }

    return {
      ...freshDefaults(),
      ...parsed,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
      triggers: Array.isArray(parsed.triggers) ? parsed.triggers : [],
      knowledge_access: (parsed.knowledge_access && typeof parsed.knowledge_access === 'object' && !Array.isArray(parsed.knowledge_access))
        ? parsed.knowledge_access as Record<string, KnowledgeAccessRecord>
        : {},
      dashboard_changes: Array.isArray(parsed.dashboard_changes) ? parsed.dashboard_changes as DashboardChange[] : [],
      compaction_log: Array.isArray(parsed.compaction_log) ? parsed.compaction_log as CompactionRecord[] : [],
      pendingMigrationNotices: Array.isArray(parsed.pendingMigrationNotices)
        ? (parsed.pendingMigrationNotices as unknown[]).filter((n): n is string => typeof n === 'string')
        : [],
      cycle_tasks_filed: Array.isArray(parsed.cycle_tasks_filed)
        ? (parsed.cycle_tasks_filed as unknown[]).filter((n): n is string => typeof n === 'string')
        : [],
    };
  } catch {
    return freshDefaults();
  }
}

/**
 * Read sleep history from its own file. Returns empty array if missing.
 */
export function readSleepHistory(root: string): SleepHistoryEntry[] {
  const filePath = getSleepHistoryPath(root);
  if (!existsSync(filePath)) return [];
  try {
    return readJsonArray<SleepHistoryEntry>(filePath);
  } catch {
    return [];
  }
}

/**
 * Write sleep history to its own file.
 */
export function writeSleepHistory(root: string, history: SleepHistoryEntry[]): void {
  writeJsonArray(getSleepHistoryPath(root), history);
}

export function writeSleepState(root: string, state: SleepState): void {
  const filePath = getSleepPath(root);
  writeJsonObject(filePath, state);
}

/**
 * Record an access to a knowledge file in `state.knowledge_access` (mutates the
 * passed state; caller persists). Creates the record if absent, then stamps
 * `last_accessed = today()` and increments `count`. Shared by `knowledge touch`
 * and the recall hook (recall hits bump access for `type === 'knowledge'` docs).
 */
export function bumpKnowledgeAccess(state: SleepState, slug: string): void {
  if (!state.knowledge_access[slug]) {
    state.knowledge_access[slug] = { last_accessed: today(), count: 0 };
  }
  state.knowledge_access[slug].last_accessed = today();
  state.knowledge_access[slug].count++;
}

/**
 * Migrate a `knowledge_access` decay record from `oldSlug` to `newSlug` after a
 * knowledge/feature file moves, so the moved file keeps its access history and
 * no key lingers pointing at a now-missing path. Best-effort: a failure here
 * must never undo an already-successful on-disk move (callers wrap in try/catch).
 *
 * When the target slug already has a record (move-back, or the target was
 * touched independently) the two are merged — higher count, more recent access —
 * and the old key is ALWAYS dropped. No-op when the source has no record.
 * Shared by `knowledge move` and `features move`.
 */
export function migrateKnowledgeAccessKey(
  root: string,
  oldSlug: string,
  newSlug: string,
): void {
  // Read-modify-write of the whole state file — locked like every other one.
  withSleepStateLock(root, () => {
  const state = readSleepState(root);
  const record = state.knowledge_access[oldSlug];
  if (!record) return;
  const existing = state.knowledge_access[newSlug];
  state.knowledge_access[newSlug] = existing
    ? {
        count: Math.max(existing.count, record.count),
        last_accessed:
          existing.last_accessed > record.last_accessed
            ? existing.last_accessed
            : record.last_accessed,
      }
    : record;
  delete state.knowledge_access[oldSlug];
  writeSleepState(root, state);
  });
}

// ─── Command Registration ──────────────────────────────────────────────────

export function registerSleepCommand(program: Command): void {
  const sleep = program
    .command('sleep')
    .description('Track sleep debt and consolidation state');

  // --- status ---
  sleep
    .command('status')
    .description('Show current sleep debt level and history')
    .action(() => {
      const root = ensureContextRoot();
      const state = readSleepState(root);
      const t = resolveSleepThresholds(readSetupConfig(dirname(root))?.sleep);
      const level = sleepinessLevel(state.debt, t);
      const range = sleepinessRange(state.debt, t);

      console.log(header('Sleep State'));
      console.log(`  Debt:       ${chalk.bold(String(state.debt))} ${chalk.dim(`(${range})`)} ${chalk.magentaBright(level)}`);
      console.log(`  Last sleep: ${state.last_sleep ? chalk.white(state.last_sleep) : chalk.dim('never')}`);
      if (state.last_sleep_summary) {
        console.log(`  Summary:    ${chalk.dim(state.last_sleep_summary)}`);
      }

      if (state.sessions.length > 0) {
        console.log(`\n  ${chalk.bold('Sessions since last sleep:')}`);
        for (const s of state.sessions) {
          const scoreStr = s.score !== null ? chalk.yellow(`+${s.score}`) : chalk.dim('pending');
          const changePart = s.change_count !== null ? `${s.change_count} changes` : '';
          const toolPart = s.tool_count != null ? `${s.tool_count} tools` : '';
          const changesStr = [changePart, toolPart].filter(Boolean).join(', ');
          const changesDisplay = changesStr ? chalk.dim(`[${changesStr}]`) : '';
          const timeStr = s.stopped_at ? chalk.dim(s.stopped_at) : chalk.dim('active');
          console.log(`  ${timeStr} ${scoreStr} ${changesDisplay}`);
          if (s.last_assistant_message) {
            const preview = s.last_assistant_message.length > 120
              ? s.last_assistant_message.slice(0, 120) + '...'
              : s.last_assistant_message;
            console.log(`    ${chalk.dim('"' + preview + '"')}`);
          }
        }
      } else {
        console.log(chalk.dim('\n  No sessions since last sleep.'));
      }
    });

  // --- add ---
  sleep
    .command('add')
    .argument('<score>', 'Debt score to add (1-3)')
    .argument('<description...>', 'Description of what happened')
    .description('Record a debt-accumulating action')
    .action((scoreStr: string, descParts: string[]) => {
      const description = descParts.join(' ');
      const valid = validateSleepAdd(scoreStr, description);
      if (!valid.ok) {
        error(valid.error);
        return;
      }
      const score = parseInt(scoreStr, 10);

      const root = ensureContextRoot();
      // D2 — read-modify-write under the state lock. Unlike the hooks this one
      // fails LOUDLY: a person running `sleep add` would rather be told to retry
      // than have their entry silently lost to an interleaved write.
      const addLock = withSleepStateLock(root, () => {
        const state = readSleepState(root);

        state.sessions.unshift({
          session_id: `manual-${Date.now()}`,
          transcript_path: null,
          stopped_at: new Date().toISOString(),
          last_assistant_message: description.trim(),
          change_count: null,
          tool_count: null,
          score,
          task_slugs: [],
        });
        state.debt += score;

        writeSleepState(root, state);
        return state;
      });
      if (!addLock.locked) {
        error('Sleep state is busy (a consolidation may be writing it) — nothing recorded. Retry in a moment.');
        process.exitCode = 1;
        return;
      }
      const state = addLock.value;

      const t = resolveSleepThresholds(readSetupConfig(dirname(root))?.sleep);
      const level = sleepinessLevel(state.debt, t);
      success(`Sleep debt: ${state.debt} (${level})`);

      if (state.debt >= t.mustSleep) {
        warn(`Must sleep! Debt is ${t.mustSleep}+. Consolidation needed.`);
      } else if (state.debt >= t.sleepy) {
        info('Getting sleepy. Consider consolidating soon.');
      }
    });

  // --- start ---
  sleep
    .command('start')
    .description('Mark beginning of consolidation (sets epoch for safe clearing)')
    .option('--deep', 'Force a deep consolidation (authorizes destructive knowledge ops)')
    .option('--force', 'Take over an in-progress consolidation lock (a stuck or parallel sleep)')
    .option('--json', 'Emit as JSON (suppresses the human-readable lines below)')
    .action((opts: { deep?: boolean; force?: boolean; json?: boolean }) => {
      const root = ensureContextRoot();
      // --json mirrors the `automations tick --json` convention elsewhere in
      // this CLI: suppress the human-readable success/info/warn lines below and
      // emit exactly one JSON object at the end, so a script parsing stdout
      // never has to pick a JSON blob out of interleaved chalk text. Refusal
      // paths (`error(...)`, below) are UNCHANGED regardless of --json — they
      // return before anything worth JSON-ifying has been computed.
      const asJson = !!opts.json;
      const say = {
        success: (m: string) => { if (!asJson) success(m); },
        info: (m: string) => { if (!asJson) info(m); },
        warn: (m: string) => { if (!asJson) warn(m); },
      };

      // STAMP MUTEX: `sleep start` reads state, runs migrations, then stamps the
      // epoch — a check-then-write that two simultaneous starts could both pass,
      // each winning the epoch (a proven cross-process race; `writeJsonObject`
      // is a plain non-atomic write). An atomic O_EXCL lock held only for this
      // short stamp serializes them: at most one process is inside the body at a
      // time, so a loser that gets in next sees the winner's epoch and refuses
      // below. The lock self-heals via SLEEP_START_LOCK_STALE_MS if a stamp ever
      // crashes. (The persisted `sleep_started_at` epoch — NOT this lock file —
      // guards the rest of the multi-process, minutes-long consolidation; the
      // stamp lock is released the instant `sleep start` exits.)
      const startLockPath = getSleepStartLockPath(root);
      if (!acquireFileLock(startLockPath, Date.now(), SLEEP_START_LOCK_STALE_MS)) {
        error(
          'Consolidation already in progress (another `sleep start` is stamping the epoch right now).',
          'Wait a moment and retry. To take over a genuinely stuck cycle, run `dreamcontext sleep start --force`.',
        );
        process.exitCode = 1;
        return;
      }

      try {
        // Read for the DECISIONS below (lock inspection, depth). Deliberately
        // unlocked: this read is only used to decide, and the mutation itself
        // re-reads under the lock a few lines down.
        const state = readSleepState(root);

        // Mutual exclusion: a consolidation rewrites the shared state/.sleep.json
        // and core files. Two at once corrupt the epoch boundary (`sleep done`
        // clears only post-epoch sessions) and stomp each other's edits. The epoch
        // IS the lock — refuse to start a second sleep while one is live. A stale
        // lock (owning session crashed before `sleep done`) is auto-reclaimed so a
        // crash never wedges the brain; `--force` overrides a live lock on purpose.
        const lock = inspectSleepLock(state, Date.now());
        if (lock.locked && !lock.stale && !opts.force) {
          const ageMin = Math.max(1, Math.round(lock.ageMs / 60000));
          error(
            `Consolidation already in progress (started ${lock.startedAt}, ~${ageMin}m ago).`,
            'Another session or the desktop Sleep button is consolidating this brain. ' +
              'Wait for it to finish before starting a new sleep — do NOT dispatch sleep ' +
              'agents now. To take over a stuck cycle, run `dreamcontext sleep start --force`.',
          );
          process.exitCode = 1;
          return;
        }
        if (lock.locked && lock.stale) {
          const ageMin = Math.round(lock.ageMs / 60000);
          say.warn(
            `Reclaiming a stale consolidation lock (started ${lock.startedAt}, ~${ageMin}m ago — ` +
              `exceeds the ${SLEEP_LOCK_STALE_MS / 60000}m TTL). The previous sleep likely crashed ` +
              `without \`sleep done\`. Taking over.`,
          );
        } else if (lock.locked && opts.force) {
          say.warn(`--force: taking over an in-progress consolidation lock (started ${lock.startedAt}).`);
        }

        // ALWAYS compute + persist the consolidation depth so it never holds a
        // stale prior value. With no --deep flag this stores the debt-base depth;
        // --deep forces it to 'deep' (user-requested). Reset to null by sleep done.
        // AC4: catchup carries the bulk-catch-up split so a debt spike from
        // lazily-flushed sessions can't auto-authorize destructive ops.
        const decision = consolidationDepth(state.debt, {
          userRequestedDeep: !!opts.deep,
          catchup: catchupDebtSplit(state.sessions),
        }, resolveSleepThresholds(readSetupConfig(dirname(root))?.sleep));
        state.consolidation_depth = decision.depth;

        // Clear any pending migration notices from the previous cycle so the
        // snapshot note is surfaced exactly once per sleep cycle.
        state.pendingMigrationNotices = [];

        // Run all pending structural migrations via the versioned registry.
        const projectRoot = dirname(root);
        const config = readSetupConfig(projectRoot);
        const fromVersion = config?.setupVersion ?? '0.0.0';
        const migResult = runMigrations(root, fromVersion, dreamcontextVersion());

        // Surface 'code' applied summaries to the user and store in state for
        // the snapshot note (read by generateSnapshot READ-ONLY).
        const codeNotices: string[] = [];
        for (const entry of migResult.applied) {
          if (entry.executor === 'code') {
            say.success(`Migration ${entry.version}/${entry.step}: ${entry.summary}`);
            codeNotices.push(`${entry.version} ${entry.step}: ${entry.summary}`);
          }
        }
        if (codeNotices.length > 0) {
          state.pendingMigrationNotices = codeNotices;
        }

        // Surface pending agent task instructions
        for (const pat of migResult.pendingAgentTasks) {
          say.info(
            `Migration ${pat.version} has a pending agent task (${pat.agentTask.id}). ` +
            `Run \`dreamcontext migrations pending\` for instructions.`,
          );
        }

        state.sleep_started_at = new Date().toISOString();

        // D2 — the actual mutation, under the state lock and NOTHING else: it
        // RE-READS so a session record a Stop hook landed while migrations ran
        // is not clobbered, then applies only the fields this command owns.
        // Deliberately narrow — migrations above can take longer than the
        // lock's stale TTL, and holding it across them would invite a reclaim.
        const startStateLock = withSleepStateLock(root, () => {
          const fresh = readSleepState(root);
          fresh.consolidation_depth = state.consolidation_depth;
          fresh.pendingMigrationNotices = state.pendingMigrationNotices;
          fresh.sleep_started_at = state.sleep_started_at;
          // A fresh epoch starts with a fresh filing budget. `sleep done` clears
          // it too; doing it at BOTH ends means a crashed cycle cannot leave a
          // stale count holding the next cycle's cap down.
          fresh.cycle_tasks_filed = [];
          writeSleepState(root, fresh);
        });
        if (!startStateLock.locked) {
          error('Sleep state is busy — refusing to stamp the epoch on a stale read. Retry in a moment.');
          process.exitCode = 1;
          return;
        }
        say.success(`Consolidation epoch set: ${state.sleep_started_at}`);
        say.info(`Consolidation depth: ${decision.depth} (source: ${decision.source}) — ${decision.reason}`);
        if (decision.cappedByCatchup) {
          say.info('Auto-deep prevented: most of this debt arrived in a catch-up batch. Re-run with `--deep` to authorize destructive ops anyway.');
        }
        if (decision.depth !== 'deep') {
          say.info('Light/standard consolidation: do NOT merge/summarize-replace/delete knowledge — flag candidates in the report instead.');
        }

        // Change C — a NEW cycle supersedes any previous cycle's pending
        // private-derivation disclosure. This is the one genuine wedge (a
        // marker stranded by a crashed cycle, with no `sleep done` ever
        // reaching the ack) closed WITHOUT a bypass flag: the disclosure it
        // guarded is superseded, not silently discarded, because a fresh
        // cycle is what makes it stale. Deliberately placed here (after the
        // epoch is durably stamped above), not on any refusal path above —
        // a REFUSED start means no new cycle actually began, so a prior
        // cycle's still-pending disclosure must survive to be acted on.
        clearPrivateDerivationMarker(root);

        // Change C — surface pending automation output as part of the SAME
        // dispatch signal the main agent's inline brief already reads, so
        // consolidating it costs no extra tool call. `pendingOutputsSince`
        // never reads manifests (see consumption.ts's module doc — it must
        // stay import-free of ./store.js to avoid a same-wave cross-import
        // during its own wave), so `shared` is attached HERE by
        // cross-referencing `listAutomations()`, now that the store module
        // has landed.
        const pending = pendingOutputsSince(root, state.last_consolidated_at);
        const sharedBySlug = new Map(listAutomations(root).map((m) => [m.slug, m.shared]));
        const automationOutputs = {
          outputs: pending.outputs.map((o) => ({ ...o, shared: sharedBySlug.get(o.slug) ?? false })),
          skipped: pending.skipped,
          totalBytes: pending.totalBytes,
        };
        if (automationOutputs.outputs.length > 0 || automationOutputs.skipped.length > 0) {
          const slugs = [...new Set(automationOutputs.outputs.map((o) => o.slug))].sort();
          const slugSuffix = slugs.length > 0 ? ` (${slugs.join(', ')})` : '';
          say.info(`Automation outputs pending consolidation: ${automationOutputs.outputs.length}${slugSuffix}.`);
          // No silent caps: every dropped file is named, never just absent.
          for (const s of automationOutputs.skipped) {
            say.warn(`  skipped ${s.slug} (${s.reason}): ${s.path}`);
          }
        }

        if (asJson) {
          console.log(JSON.stringify({
            epoch: state.sleep_started_at,
            depth: decision.depth,
            depthSource: decision.source,
            depthReason: decision.reason,
            cappedByCatchup: decision.cappedByCatchup,
            migrations: codeNotices,
            automationOutputs,
          }, null, 2));
        }
      } finally {
        // Release the stamp mutex the moment the stamp completes (success, refuse,
        // or throw). The durable epoch — not this file — carries the lock onward.
        releaseFileLock(startLockPath);
      }
    });

  // --- done ---
  sleep
    .command('done')
    .argument('<summary...>', 'Summary of what was consolidated')
    .description('Mark consolidation complete, reset debt')
    // Single-value + accumulator (NOT `<spec...>`): a variadic option would
    // greedily swallow the trailing variadic `<summary...>` argument whenever
    // --flag appears before it. This form is safe regardless of ordering and
    // still repeatable (`--flag a --flag b` accumulates both).
    .option(
      '--flag <spec>',
      'Recurring-problem flag observed this cycle: key::label[::task-slug] (repeatable)',
      (value: string, previous: string[]) => previous.concat([value]),
      [] as string[],
    )
    .option(
      '--ack-private-derivation',
      'Acknowledge that private automation output was distilled into synced knowledge this cycle (required to proceed while that disclosure is pending)',
    )
    .action(async (summaryParts: string[], opts: { flag: string[]; ackPrivateDerivation?: boolean }) => {
      const summary = summaryParts.join(' ');
      if (!summary.trim()) {
        error('Summary is required.');
        return;
      }

      const root = ensureContextRoot();
      const state = readSleepState(root);

      // Change C privacy gate — MUST run here, before ANY write (the next
      // statement, writeSleepHistory, is the first mutation `sleep done`
      // makes). A marker means sleep-product derived knowledge from a
      // PRIVATE automation's output this cycle: knowledge files are
      // brain-synced, so that derivation republishes private material
      // through a different door. Refusing BEFORE any mutation means a
      // refused `sleep done` leaves `sleep_started_at`/`last_consolidated_at`
      // untouched and creates no history entry and no commit — the cycle is
      // exactly as it was, safe to retry once acknowledged. A refusal placed
      // any later (e.g. after finalizeSleepState) would half-close the cycle
      // AND advance the very consumption boundary that would have
      // re-surfaced the material next time.
      //
      // Deliberately NO -y/--yes alias: acknowledging that a SPECIFIC
      // disclosure was seen and decided is not the same act as "yes to
      // everything", and folding it into a general flag is exactly the
      // reflexive-approval pattern this whole design argues against. There is
      // also no discard flag — the marker names every derived knowledge file,
      // so a user who does not want the material published edits or deletes
      // those files FIRST, then acks. A bare discard would be an unguarded
      // bypass wearing a different name.
      const privateDerivation = readPrivateDerivationMarker(root);
      if (privateDerivation && !opts.ackPrivateDerivation) {
        error(
          'Refusing to consolidate: private automation output was distilled into synced knowledge this cycle.',
          'Review the knowledge files below — private prompt/output content may now be published through them ' +
            'on the next brain sync. Edit or delete anything you do not want published, THEN re-run ' +
            '`dreamcontext sleep done` with --ack-private-derivation to proceed.',
        );
        for (const d of privateDerivation.derivedFrom) {
          warn(`  from private automation \`${d.slug}\` (${d.outputPath})`);
        }
        for (const k of privateDerivation.knowledgePaths) {
          warn(`    → ${k}`);
        }
        process.exitCode = 1;
        return;
      }
      // Acknowledged (or nothing pending — idempotent either way): clear so
      // the marker never outlives the decision point it exists to gate.
      clearPrivateDerivationMarker(root);

      // D2 — the consolidation read-modify-write, under the state lock.
      // `applyConsolidation` is pure, so the whole thing is: re-read inside the
      // lock, transform, write once. Re-reading matters — a Stop hook that
      // landed a session between this command starting and reaching here must
      // be consolidated too, not silently discarded by a stale snapshot.
      const doneLock = withSleepStateLock(root, () => {
        const fresh = readSleepState(root);
        const previousDebt = fresh.debt;
        const epoch = fresh.sleep_started_at;

        const result = applyConsolidation(fresh, epoch);
        const today_ = today();

        // Write sleep history entry to its own file (LIFO).
        const history = readSleepHistory(root);
        history.unshift(buildHistoryEntry(previousDebt, result, summary, today_));
        writeSleepHistory(root, history);

        // Finalize and persist the new state exactly once.
        const finalState = finalizeSleepState(result.state, summary, today_, new Date().toISOString());
        writeSleepState(root, finalState);
        return { previousDebt, epoch, today_, finalState };
      });
      if (!doneLock.locked) {
        error('Sleep state is busy — refusing to consolidate from a stale read. Retry in a moment.');
        process.exitCode = 1;
        return;
      }
      const { previousDebt, epoch, today_, finalState } = doneLock.value;

      if (epoch && finalState.sessions.length > 0) {
        success(`Consolidation complete. Debt reduced from ${previousDebt} to ${finalState.debt}. ${finalState.sessions.length} post-epoch session(s) preserved.`);
      } else {
        success(`Consolidation complete. Debt reset from ${previousDebt} to ${finalState.debt}.`);
      }

      // AC6 (1/2) — recidivism escalation: reconcile this cycle's --flag
      // observations against the persisted streak, surface a one-line ask for
      // any flag at/over the escalation threshold, and bump the linked task's
      // priority. Best-effort — a flag-tracking bug must never fail `sleep done`.
      try {
        const observed = opts.flag
          .map(parseFlagOption)
          .filter((f): f is NonNullable<ReturnType<typeof parseFlagOption>> => f !== null);
        const prevFlags = readSleepFlags(root);
        const nextFlags = reconcileFlags(prevFlags, observed, new Date().toISOString());
        writeSleepFlags(root, nextFlags);

        const escalated = escalations(nextFlags);
        if (escalated.length > 0) {
          for (const line of renderEscalationAsks(escalated)) warn(line);
          const backend = getTaskBackend(root);
          for (const flag of escalated) {
            if (!flag.task_slug) continue;
            try {
              const task = await backend.get(flag.task_slug);
              if (task) {
                await backend.updateFields(flag.task_slug, { priority: bumpPriority(task.priority) });
              }
            } catch (err) {
              warn(`Recidivism escalation: could not bump priority for ${flag.task_slug} — ${(err as Error).message ?? err}`);
            }
          }
        }
      } catch (err) {
        warn(`Recidivism tracking: skipped — ${(err as Error).message ?? err}`);
      }

      // AC6 (2/2) — orphan-tag curator trigger: >= ORPHAN_TAG_CURATOR_THRESHOLD
      // orphan tags across the corpus auto-creates (or refreshes) a standing
      // curator task, using the same doc-list pattern as `taxonomy audit`.
      // Best-effort — a taxonomy audit hiccup must never fail `sleep done`.
      try {
        const vocab = loadProjectVocabulary(root);
        const corpus = buildCorpus(root);
        const docs = corpus.map((d) => ({ slug: d.slug, tags: d.tags }));
        const buckets = auditCorpus(docs, vocab);

        const backend = getTaskBackend(root);
        const existingTask = await backend.get(CURATOR_TASK_SLUG);

        // If the chore's own file is gone, follow the tombstone chain: it may
        // have been MERGED into a task that is still open, in which case the
        // orphan count belongs there and re-filing would be the duplicate this
        // whole mechanism exists to stop.
        let absorbing: { slug: string; status: string } | null = null;
        if (!existingTask) {
          const resolved = resolveTombstone(root, CURATOR_TASK_SLUG);
          if (resolved.livingSlug) {
            const target = await backend.get(resolved.livingSlug).catch(() => null);
            if (target) absorbing = { slug: target.slug, status: target.status };
          }
        }

        const plan = planCuratorTask(
          buckets.orphan.length,
          existingTask ? { slug: existingTask.slug, status: existingTask.status } : null,
          absorbing,
          loadStatuses(root),
        );
        if (plan.action === 'create') {
          await backend.create({
            name: plan.name,
            // The chore is born WITH its justification. It used to be created
            // with an empty '(To be defined)' template — B0 found that made it
            // the only zero-justification task in 116 created since August.
            description: plan.description,
            why: plan.description,
            priority: 'medium',
            status: 'todo',
            tags: ['topic:taxonomy'],
            variant: 'cli',
          });
          info(`Curator task created: ${plan.slug} (${buckets.orphan.length} orphan tags).`);
        } else if (plan.action === 'refresh' || plan.action === 'refresh-absorbing') {
          await backend.addChangelog(
            plan.slug,
            `- ${today_}: ${buckets.orphan.length} orphan tag(s) still present — curator pass still needed.`,
            { fallbackAppend: true },
          );
          info(plan.action === 'refresh'
            ? `Curator task refreshed: ${plan.slug} (${buckets.orphan.length} orphan tags).`
            : `Curator chore was merged into ${plan.slug}; logged ${buckets.orphan.length} orphan tags there instead of re-filing it.`);
        }
      } catch (err) {
        warn(`Curator trigger: skipped — ${(err as Error).message ?? err}`);
      }

      // AC7 — semantic dedup digest: surface merge/review/create tallies since
      // the epoch in the cycle summary. Best-effort — a log-read hiccup must
      // never fail `sleep done`.
      try {
        const digest = readDedupDigest(root, epoch);
        if (digest.total > 0) {
          info(renderDedupDigest(digest));
        }
      } catch (err) {
        warn(`Dedup digest: skipped — ${(err as Error).message ?? err}`);
      }

      // AC9a — digest GC: keep the newest K plus every still-pending session's
      // digest. The protected set is the UNION of post-consolidation survivors
      // (`finalState.sessions`) AND pre-consolidation pending sessions
      // (`state.sessions` with score === null) — `applyConsolidation` drops
      // `stopped_at === null` sessions, so without the pending half a live
      // session's digest could be GC'd before its catch-up ever runs.
      // Best-effort — a GC hiccup must never fail `sleep done`.
      try {
        const protectedIds = new Set([
          ...finalState.sessions.map((s) => s.session_id),
          ...state.sessions.filter((s) => s.score === null).map((s) => s.session_id),
        ]);
        const entries = scanDigests(root);
        const plan = planDigestGc(entries, protectedIds);
        if (plan.deleteAbs.length > 0) {
          const deleted = runDigestGc(root, plan);
          if (deleted > 0) {
            info(chalk.dim(`Digest GC: removed ${deleted} stale session digest(s) (kept ${plan.keep.length}).`));
          }
        }
      } catch (err) {
        warn(`Digest GC: skipped — ${(err as Error).message ?? err}`);
      }

      // Post-sleep task sync (issue #11): push the consolidation's task updates,
      // then re-mirror. The consolidation touches EVERY reconciled task at once,
      // so this is the heaviest burst the backend ever sees — the adapter paces
      // itself under the rate ceiling (so one pass syncs everything) and retries
      // transient failures. Still best-effort: a sync failure must never fail
      // `sleep done` — but it must NEVER fail SILENTLY either.
      try {
        const backend = getTaskBackend(root);
        if (backend.name !== 'local') {
          // The consolidation touches every reconciled task, so this sync can
          // run for minutes — show live progress instead of going silent.
          const bar = new ProgressBar();
          const syncOpts: SyncOptions = {
            onProgress: (ev) => bar.update(`task sync (${ev.phase})`, ev.current, ev.total),
          };
          let report;
          try {
            report = await backend.sync('both', syncOpts);
            // Any task that still failed to push leaves the local→remote state
            // incomplete. Retry the whole sync ONCE — the failed tasks are still
            // drift-flagged, so they get re-selected, and the rate window has
            // advanced. One extra pass, not a loop.
            if (report.failedPushes.length > 0) {
              bar.done();
              warn(`Task sync: ${report.failedPushes.length} task(s) did not push — retrying once…`);
              report = await backend.sync('both', syncOpts);
            }
          } finally {
            bar.done();
          }
          if (report.conflicts.length > 0) {
            warn(`Task sync: ${report.conflicts.length} conflict(s) preserved under state/.conflicts/ — review them.`);
          }
          const pushedTotal = report.pushed + report.created;
          if (pushedTotal > 0 || report.pulled > 0) {
            info(chalk.dim(`Task sync: pushed ${pushedTotal}, pulled ${report.pulled}.`));
          }
          // LOUD on residual failure — never a dim one-liner. The mirror is
          // ahead of the remote; the user must know to re-run.
          if (report.failedPushes.length > 0) {
            error(`Task sync INCOMPLETE: ${report.failedPushes.length} task(s) failed to push after retry — the remote is stale for: ${report.failedPushes.join(', ')}`);
            for (const e of report.errors) warn(`  ${e}`);
            warn('Run `dreamcontext tasks sync` to finish, or check the ClickUp token / connectivity.');
          } else if (report.errors.length > 0) {
            // Non-push errors (pull/delete/field) — surface, don't bury.
            warn(`Task sync: completed with ${report.errors.length} non-fatal error(s):`);
            for (const e of report.errors) warn(`  ${e}`);
          }
          // Data-quality warnings (e.g. an unmapped assignee left unassigned).
          // The task synced, but assignment silently failing is exactly the
          // class of bug we refuse to bury — surface every one.
          if (report.warnings.length > 0) {
            warn(`Task sync: ${report.warnings.length} assignment warning(s):`);
            for (const w of report.warnings) warn(`  ${w}`);
          }
        }
      } catch (err) {
        // The sync engine itself threw (auth/lock/transport) — best-effort by
        // contract, but visible: a swallowed failure is what hid the last bug.
        warn(`Task sync: skipped — ${(err as Error).message ?? err}`);
      }

      // Post-sleep whole-project sync (github-cloud-collaboration-brain-repo-sync):
      // fetch/merge/commit/push the whole project (`full-repo`) when autoSync is
      // on. The engine resolves the mode internally, so this only checks the toggle.
      // Best-effort by the same discipline as task sync above — a sync failure
      // must never fail `sleep done`, but it must never fail SILENTLY either.
      try {
        const cfg = readSetupConfig(dirname(root));
        if (cfg?.brainRepo?.autoSync) {
          const result = await runBrainSync({ cwd: root, mode: 'auto' });
          // autoSync is a real git op — keep the global sign-in flag honest so a
          // clean post-sleep sync clears any stale desktop "reconnect" banner.
          reconcileBrainSyncSuccess(result.action);
          renderBrainSyncResult(result);
          if (result.action === 'awaiting-agent' || result.action === 'already-awaiting-agent') {
            warn('Brain sync paused on a team merge — run /dream-sync to reconcile (it will resume or continue as needed).');
          }
          // C2 (M3): react to EITHER signal — this run's OWN merge result, or a
          // PERSISTED flag a prior BACKGROUND pull (session-start's detached
          // spawn, a wholly separate process) already set and never got to
          // resolve. Without the OR, a quiet remote (nothing new to merge THIS
          // run) would leave an earlier background pull's flag stuck `true`
          // forever, even though `sleep done` is exactly the kind of
          // "task-backend sync actually ran" event that should clear it.
          if (result.needsTaskSync || readBrainLocal(dirname(root)).needsTaskSync) {
            const backend = getTaskBackend(root);
            if (backend.name !== 'local') {
              await backend.sync('both');
              writeBrainLocal(dirname(root), { needsTaskSync: false });
            }
          }
        }
      } catch (err) {
        const projectRoot = dirname(root);
        reconcileBrainSyncFailure((err as Error).message ?? String(err), projectRoot);
        warn(`Brain sync: skipped — ${(err as Error).message ?? err}`);
        // Tier-aware hint: a stale per-project token shadowing the signed-in
        // account is the usual cause of a persistent auth/permission failure.
        const perProjectToken = isPerProjectToken(resolveBrainSyncToken(projectRoot));
        const failure = classifySyncError((err as Error).message ?? String(err), undefined, { perProjectToken });
        if (perProjectToken && (failure.kind === 'auth' || failure.kind === 'permission')) {
          warn(failure.message);
        }
      }

      // Post-sleep embedding refresh (decision-embedding-layer: "eager during
      // sleep"). Sleep just rewrote the corpus — the moment the mtime pre-filter
      // is most likely to hide something — so run a FORCE refresh (content hash
      // fully authoritative). Gated on an EXISTING cache: a vault that never
      // enabled hybrid recall must never cold-start a 113 MB model download from
      // `sleep done`. Best-effort by the same discipline as the syncs above.
      try {
        if (embeddingCacheExists(root)) {
          const res = await refreshEmbeddings(root, buildCorpus(root), undefined, { force: true });
          if (res === null) {
            warn('Embedding refresh: skipped — model unavailable (hybrid recall will refresh lazily).');
          } else if (res.stats.embedded > 0 || res.stats.evicted > 0) {
            info(chalk.dim(`Embedding index refreshed: +${res.stats.embedded} embedded, −${res.stats.evicted} evicted (${res.index.chunks.length} chunks).`));
          }
        }
      } catch (err) {
        warn(`Embedding refresh: skipped — ${(err as Error).message ?? err}`);
      }

      // AC5 — post-sleep durability, LAST so it's the final thing the user
      // sees. When brain sync is OFF, warn LOUDLY about uncommitted
      // `_dream_context/**` output with a ready-to-run command — user decision
      // (2026-07-18): no auto-commit, no config flag, ever. Best-effort — a
      // warning-render hiccup must never fail `sleep done`.
      try {
        const projectRoot = dirname(root);
        const cfg = readSetupConfig(projectRoot);
        const syncOn = resolveBrainSyncEnabled(projectRoot, cfg).enabled && !!cfg?.brainRepo?.autoSync;
        if (!syncOn) {
          const report = collectBrainDirty(projectRoot);
          const lines = renderBrainDirtyWarning(report, { contextDirName: '_dream_context', today: today_ });
          for (const line of lines) warn(line);
        }
      } catch (err) {
        warn(`Brain durability check: skipped — ${(err as Error).message ?? err}`);
      }
    });

  // --- debt ---
  sleep
    .command('debt')
    .description('Output current debt number (for programmatic use)')
    .action(() => {
      const root = ensureContextRoot();
      const state = readSleepState(root);
      console.log(String(state.debt));
    });

  // --- history ---
  sleep
    .command('history')
    .description('Show consolidation history log')
    .option('-n, --limit <count>', 'Number of entries to show', '10')
    .action((opts: { limit: string }) => {
      const root = ensureContextRoot();
      const history = readSleepHistory(root);

      if (history.length === 0) {
        info('No consolidation history yet.');
        return;
      }

      const limit = parseInt(opts.limit, 10) || 10;
      const entries = history.slice(0, limit);

      console.log(header('Sleep History'));
      for (const entry of entries) {
        console.log(`  ${chalk.white(entry.date)} ${chalk.dim(`debt ${entry.debt_before} → ${entry.debt_after}`)}`);
        console.log(`    ${chalk.dim(`${entry.sessions_processed} session(s), ${entry.bookmarks_processed} bookmark(s)`)}`);
        console.log(`    ${entry.summary}`);
      }
      console.log(`\n  ${chalk.dim(`${history.length} total consolidation(s)`)}`);
    });

  // --- config ---
  const config = sleep
    .command('config')
    .description('Show this brain\'s sleep settings (debt thresholds, specialist models, task cap)')
    .action(() => {
      const root = ensureContextRoot();
      const projectRoot = dirname(root);
      const cfg = readSetupConfig(projectRoot)?.sleep;
      const t = resolveSleepThresholds(cfg);
      const overridden = (k: 'drowsy' | 'sleepy' | 'mustSleep') =>
        cfg?.thresholds?.[k] !== undefined ? chalk.yellow(' (overridden)') : chalk.dim(' (default)');

      console.log(header('Sleep Settings'));
      if (hasInvalidSleepThresholds(cfg)) {
        warn('The configured thresholds are not strictly increasing — ALL of them are being ignored.');
        warn('Showing the defaults that are actually in force. Fix with `dreamcontext sleep config set`.');
      }
      console.log(`\n  ${chalk.bold('Debt thresholds')}`);
      console.log(`    Drowsy:      ${chalk.bold(String(t.drowsy))}${overridden('drowsy')}`);
      console.log(`    Sleepy:      ${chalk.bold(String(t.sleepy))}${overridden('sleepy')}`);
      console.log(`    Must Sleep:  ${chalk.bold(String(t.mustSleep))}${overridden('mustSleep')}`);
      console.log(chalk.dim(`    Derived: deep-authority ${t.deepAuthority} (×1.5), cooldown-override ${t.cooldownOverride} (×2)`));

      console.log(`\n  ${chalk.bold('Specialists')}`);
      for (const name of SLEEP_SPECIALISTS) {
        const o = cfg?.specialists?.[name];
        const shipped = readInstalledSpecialistDefaults(projectRoot, name);
        const model = o?.model ?? shipped.model ?? chalk.dim('(package default)');
        const effort = o?.effort ?? shipped.effort ?? chalk.dim('(package default)');
        const mark = o?.model || o?.effort ? chalk.yellow(' *') : '  ';
        console.log(`   ${mark}${name.padEnd(17)} ${model}  ${chalk.dim('effort')} ${effort}`);
      }

      const cap = cfg?.maxNewTasksPerCycle ?? DEFAULT_MAX_NEW_TASKS_PER_CYCLE;
      const capMark = cfg?.maxNewTasksPerCycle !== undefined ? chalk.yellow(' (overridden)') : chalk.dim(' (default)');
      console.log(`\n  ${chalk.bold('Task filing')}`);
      console.log(`    Max new tasks per cycle: ${chalk.bold(String(cap))}${capMark}`);
      console.log(chalk.dim('    The curator self-healing chore is EXEMPT from this cap.'));
      console.log(chalk.dim('\n  Set with: dreamcontext sleep config set <key> <value>'));
      console.log(chalk.dim('  Keys: thresholds.drowsy|sleepy|must-sleep · specialists.<name>.model|effort · max-new-tasks'));
    });

  config
    .command('set <key> <value>')
    .description('Set a sleep setting (thresholds.*, specialists.<name>.model|effort, max-new-tasks)')
    .option('--allow-unknown', 'Accept a model id this build does not know (a newer model than this release)')
    .action((key: string, value: string, opts: { allowUnknown?: boolean }) => {
      const root = ensureContextRoot();
      const projectRoot = dirname(root);
      const current = readSetupConfig(projectRoot)?.sleep ?? {};
      const result = setSleepConfigKey(current, key, value, { allowUnknown: !!opts.allowUnknown });
      if (!result.ok) {
        error(result.error);
        process.exit(1);
      }
      updateSetupConfig(projectRoot, { sleep: result.config });
      success(`${key} = ${value}`);
      if (result.changedSpecialists.length > 0) {
        const applied = applySleepSpecialistOverrides(projectRoot, result.changedSpecialists);
        for (const rel of applied.updated) info(`Updated ${rel}`);
        for (const rel of applied.skipped) warn(`Could not update ${rel} — run \`dreamcontext update --core-only\`.`);
      }
    });

  config
    .command('reset [key]')
    .description('Clear one sleep setting, or all of them, back to the shipped defaults')
    .action((key: string | undefined) => {
      const root = ensureContextRoot();
      const projectRoot = dirname(root);
      const current = readSetupConfig(projectRoot)?.sleep ?? {};
      const result = resetSleepConfigKey(current, key);
      if (!result.ok) {
        error(result.error);
        process.exit(1);
      }
      updateSetupConfig(projectRoot, { sleep: result.config });
      success(key ? `${key} reset to default` : 'All sleep settings reset to defaults');
      if (result.changedSpecialists.length > 0) {
        const applied = applySleepSpecialistOverrides(projectRoot, result.changedSpecialists);
        for (const rel of applied.updated) info(`Updated ${rel}`);
      }
    });

  // --- auto (background consolidation, MACHINE-LOCAL) ---
  const auto = sleep
    .command('auto')
    .description('Background consolidation for THIS machine (off by default)');

  auto
    .command('on')
    .description('Let this machine consolidate the brain in the background when debt is high')
    .option('--trigger <level>', 'must-sleep (default) or sleepy', 'must-sleep')
    .action((opts: { trigger?: string }) => {
      const root = ensureContextRoot();
      const projectRoot = dirname(root);
      const trigger = opts.trigger === 'sleepy' ? 'sleepy' : 'must-sleep';
      if (opts.trigger && opts.trigger !== 'sleepy' && opts.trigger !== 'must-sleep') {
        error('--trigger must be "must-sleep" or "sleepy".');
        process.exitCode = 1;
        return;
      }
      const t = resolveSleepThresholds(readSetupConfig(projectRoot)?.sleep);
      const at = trigger === 'sleepy' ? t.sleepy : t.mustSleep;

      // Write the trigger FIRST: the fingerprint covers it, so a fingerprint
      // computed before it is stored would be stale the instant it is saved.
      const local = readBrainLocal(projectRoot) ?? {};
      writeBrainLocal(projectRoot, {
        ...local,
        autoSleep: { enabled: true, trigger, approvedAt: new Date().toISOString(), approvedFingerprint: 'pending' },
      });
      const fingerprint = currentAutoSleepFingerprint(projectRoot);
      writeBrainLocal(projectRoot, {
        ...(readBrainLocal(projectRoot) ?? {}),
        autoSleep: { enabled: true, trigger, approvedAt: new Date().toISOString(), approvedFingerprint: fingerprint },
      });

      success(`Auto sleep ON for this machine — triggers at debt ${at} (${trigger}).`);
      console.log(chalk.dim('  What you just approved: the specialist model/effort map, the per-cycle task cap,'));
      console.log(chalk.dim('  the trigger, and the current contents of the six sleep agent files.'));
      console.log(chalk.dim('  If any of those change, auto sleep PAUSES and asks you to re-approve.'));
      console.log(chalk.dim(`  With defaults this runs at most ~3 cycles on the busiest day; each runs six specialists.`));
      console.log(chalk.dim('  This setting is machine-local — it never rides to teammates.'));
    });

  auto
    .command('off')
    .description('Stop this machine from consolidating in the background')
    .action(() => {
      const root = ensureContextRoot();
      const projectRoot = dirname(root);
      const local = readBrainLocal(projectRoot) ?? {};
      if (!local.autoSleep?.enabled) {
        info('Auto sleep is already off for this machine.');
        return;
      }
      writeBrainLocal(projectRoot, { ...local, autoSleep: { ...local.autoSleep, enabled: false } });
      success('Auto sleep OFF — sleep directives return to normal.');
    });

  auto
    .command('status')
    .description('Show whether background sleep is armed, and any running job')
    .option('--json', 'Machine-readable output')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const projectRoot = dirname(root);
      const local = readBrainLocal(projectRoot);
      const cfg = local?.autoSleep;
      const fingerprint = currentAutoSleepFingerprint(projectRoot);
      const stale = !!cfg?.enabled && cfg.approvedFingerprint !== fingerprint;
      const job = readAutoSleepSidecar(root);
      const jobLive = !!liveAutoSleepJob(root);

      if (opts.json) {
        console.log(JSON.stringify({ enabled: !!cfg?.enabled, trigger: cfg?.trigger ?? null, consentStale: stale, job, jobLive }, null, 2));
        return;
      }

      console.log(header('Auto Sleep (this machine)'));
      if (!cfg?.enabled) {
        console.log(`  ${chalk.dim('Off.')} Turn it on with \`dreamcontext sleep auto on\`.`);
      } else if (stale) {
        warn('PAUSED — the sleep settings changed since you approved them.');
        console.log('  Review them with `dreamcontext sleep config`, then re-run `dreamcontext sleep auto on`.');
      } else {
        const t = resolveSleepThresholds(readSetupConfig(projectRoot)?.sleep);
        const at = cfg.trigger === 'sleepy' ? t.sleepy : t.mustSleep;
        console.log(`  ${chalk.green('Armed')} — starts at debt ${chalk.bold(String(at))} (${cfg.trigger}).`);
        console.log(chalk.dim(`  Approved ${cfg.approvedAt}`));
      }
      if (job) {
        const live = jobLive ? chalk.green('running') : chalk.dim(job.status);
        console.log(`\n  Last job: ${live} · started ${job.startedAt}${job.finishedAt ? ` · finished ${job.finishedAt}` : ''}`);
        if (job.summary) console.log(chalk.dim(`    ${job.summary.slice(0, 200)}`));
        if (job.error) console.log(chalk.red(`    ${job.error.slice(0, 200)}`));
        if (jobLive) console.log(chalk.dim(`    pid ${job.pid} — stop it with \`dreamcontext sleep auto cancel\``));
      }
    });

  auto
    .command('cancel')
    .description('Stop a running background consolidation (asks first)')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (opts: { yes?: boolean }) => {
      const root = ensureContextRoot();
      const job = readAutoSleepSidecar(root);
      if (!job || job.status !== 'running') {
        info('No background sleep is running.');
        return;
      }
      // A human confirms what they are about to kill — the same stance
      // `automations kill` takes, and the reason there is no automatic reaper.
      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          error('Refusing to kill a process group without --yes in a non-interactive session.');
          process.exitCode = 1;
          return;
        }
        console.log(`About to stop the background sleep: pid ${job.pid}, started ${job.startedAt}.`);
        const answer = (await promptInput({ message: 'Type "stop" to confirm:' })).trim();
        if (answer !== 'stop') {
          error('Confirmation did not match — nothing was stopped.');
          return;
        }
      }
      const res = cancelAutoSleep(root);
      if (res.killed) success(`Background sleep stopped (process group ${res.pgid}).`);
      else if (res.refusedReason) { error(res.refusedReason); process.exitCode = 1; }
      else info('No background sleep is running.');
    });


  // THE dispatcher entry point — the one and only. `spawnAutoSleep` in hook.ts
  // spawns exactly this; a second alias would be a trap, since a change to one
  // would silently diverge from the one that actually runs.
  sleep
    .command('auto-run', { hidden: true })
    .description('INTERNAL: run one background consolidation now (spawned detached by the Stop hook)')
    .action(async () => {
      const root = ensureContextRoot();
      const res = await runAutoSleep(root);
      if (!res.started) process.exitCode = 1;
    });
}

// ─── Recall Command ───────────────────────────────────────────────────────

export const RECALL_MODES = ['haiku', 'raw', 'hybrid', 'off'] as const;
export type RecallMode = typeof RECALL_MODES[number];

/**
 * The effective recall mode for a vault. Single source of truth for every
 * recall consumer (the always-on hook, `memory recall`, and the dashboard's
 * `/api/recall` route) so they never disagree: an env override wins (test /
 * per-invocation), else the persisted `.sleep.json` value the dashboard and
 * `dreamcontext recall <mode>` both write, else the default `haiku`.
 */
export function resolveRecallMode(root: string): RecallMode {
  const env = process.env.DREAMCONTEXT_RECALL_MODE;
  if (env && (RECALL_MODES as readonly string[]).includes(env)) return env as RecallMode;
  return readSleepState(root).recall_mode ?? 'haiku';
}

export function registerRecallCommand(program: Command): void {
  const recall = program
    .command('recall')
    .description('Control memory recall mode (haiku / raw / hybrid / off)');

  recall
    .command('status')
    .description('Show current recall mode')
    .action(() => {
      const root = ensureContextRoot();
      const state = readSleepState(root);
      const mode = state.recall_mode ?? 'haiku';
      const labels: Record<RecallMode, string> = {
        haiku: `${chalk.green('haiku')} — Haiku LLM picks relevant docs per prompt`,
        raw: `${chalk.yellow('raw')} — BM25 keyword search only (no LLM call)`,
        hybrid: `${chalk.cyan('hybrid')} — EXPERIMENTAL: BM25 + local dense embeddings via RRF (no LLM call)`,
        off: `${chalk.red('off')} — memory recall disabled`,
      };
      console.log(header('Memory Recall'));
      console.log(`  Mode: ${labels[mode]}`);
    });

  recall
    .command('on')
    .description('Enable Haiku-powered recall (default)')
    .action(() => {
      const root = ensureContextRoot();
      const state = readSleepState(root);
      state.recall_mode = 'haiku';
      writeSleepState(root, state);
      success('Recall mode set to haiku — Haiku LLM picks relevant docs per prompt');
    });

  recall
    .command('off')
    .description('Disable memory recall entirely')
    .action(() => {
      const root = ensureContextRoot();
      const state = readSleepState(root);
      state.recall_mode = 'off';
      writeSleepState(root, state);
      success('Recall mode set to off — no memory injection on prompts');
    });

  recall
    .command('raw')
    .description('Use BM25 keyword search only (no LLM call)')
    .action(() => {
      const root = ensureContextRoot();
      const state = readSleepState(root);
      state.recall_mode = 'raw';
      writeSleepState(root, state);
      success('Recall mode set to raw — BM25 keyword search, no Haiku call');
    });

  recall
    .command('hybrid')
    .description('EXPERIMENTAL: BM25 + local dense embeddings fused via RRF (no LLM call)')
    .action(() => {
      const root = ensureContextRoot();
      const state = readSleepState(root);
      state.recall_mode = 'hybrid';
      writeSleepState(root, state);
      success('Recall mode set to hybrid — BM25 + dense RRF fusion (experimental; falls back to BM25 if the embedding model is unavailable)');
    });
}
