import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { readJsonObject, writeJsonObject, readJsonArray, writeJsonArray } from '../../lib/json-file.js';
import { today } from '../../lib/id.js';
import { header, success, error, warn, info } from '../../lib/format.js';
import { migrateDataStructures, fenceExistingDataStructures } from '../../lib/data-structures-migration.js';
import { getTaskBackend } from '../../lib/task-backend/index.js';
import { runMigrations } from '../../lib/migration-runner.js';
import { readSetupConfig, readBrainLocal, writeBrainLocal } from '../../lib/setup-config.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { acquireFileLock, releaseFileLock } from '../../lib/file-lock.js';
import { runBrainSync } from '../../lib/git-sync/sync-engine.js';
import { renderBrainSyncResult } from './brain.js';
import { buildCorpus } from '../../lib/recall.js';
import { refreshEmbeddings, embeddingCacheExists } from '../../lib/embeddings/store.js';
import {
  sleepinessLevel,
  sleepinessRange,
  applyConsolidation,
  buildHistoryEntry,
  finalizeSleepState,
  validateSleepAdd,
  consolidationDepth,
  inspectSleepLock,
  SLEEP_LOCK_STALE_MS,
  SLEEP_START_LOCK_STALE_MS,
  DEBT_SLEEPY,
  DEBT_MUST_SLEEP,
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
      const level = sleepinessLevel(state.debt);
      const range = sleepinessRange(state.debt);

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

      const level = sleepinessLevel(state.debt);
      success(`Sleep debt: ${state.debt} (${level})`);

      if (state.debt >= DEBT_MUST_SLEEP) {
        warn(`Must sleep! Debt is ${DEBT_MUST_SLEEP}+. Consolidation needed.`);
      } else if (state.debt >= DEBT_SLEEPY) {
        info('Getting sleepy. Consider consolidating soon.');
      }
    });

  // --- start ---
  sleep
    .command('start')
    .description('Mark beginning of consolidation (sets epoch for safe clearing)')
    .option('--deep', 'Force a deep consolidation (authorizes destructive knowledge ops)')
    .option('--force', 'Take over an in-progress consolidation lock (a stuck or parallel sleep)')
    .action((opts: { deep?: boolean; force?: boolean }) => {
      const root = ensureContextRoot();

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
          warn(
            `Reclaiming a stale consolidation lock (started ${lock.startedAt}, ~${ageMin}m ago — ` +
              `exceeds the ${SLEEP_LOCK_STALE_MS / 60000}m TTL). The previous sleep likely crashed ` +
              `without \`sleep done\`. Taking over.`,
          );
        } else if (lock.locked && opts.force) {
          warn(`--force: taking over an in-progress consolidation lock (started ${lock.startedAt}).`);
        }

        // ALWAYS compute + persist the consolidation depth so it never holds a
        // stale prior value. With no --deep flag this stores the debt-base depth;
        // --deep forces it to 'deep' (user-requested). Reset to null by sleep done.
        const decision = consolidationDepth(state.debt, { userRequestedDeep: !!opts.deep });
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
            success(`Migration ${entry.version}/${entry.step}: ${entry.summary}`);
            codeNotices.push(`${entry.version} ${entry.step}: ${entry.summary}`);
          }
        }
        if (codeNotices.length > 0) {
          state.pendingMigrationNotices = codeNotices;
        }

        // Surface pending agent task instructions
        for (const pat of migResult.pendingAgentTasks) {
          info(
            `Migration ${pat.version} has a pending agent task (${pat.agentTask.id}). ` +
            `Run \`dreamcontext migrations pending\` for instructions.`,
          );
        }

        state.sleep_started_at = new Date().toISOString();
        writeSleepState(root, state);
        success(`Consolidation epoch set: ${state.sleep_started_at}`);
        info(`Consolidation depth: ${decision.depth} (source: ${decision.source}) — ${decision.reason}`);
        if (decision.depth !== 'deep') {
          info('Light/standard consolidation: do NOT merge/summarize-replace/delete knowledge — flag candidates in the report instead.');
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
    .action(async (summaryParts: string[]) => {
      const summary = summaryParts.join(' ');
      if (!summary.trim()) {
        error('Summary is required.');
        return;
      }

      const root = ensureContextRoot();
      const state = readSleepState(root);
      // Capture previousDebt BEFORE consolidating; feed it to buildHistoryEntry.
      // applyConsolidation is pure (works on a clone), so the read-modify-write
      // happens exactly ONCE below — no two-write pattern that could clobber a
      // concurrent `hook stop`.
      const previousDebt = state.debt;
      const epoch = state.sleep_started_at;

      const result = applyConsolidation(state, epoch);
      const today_ = today();

      // Write sleep history entry to its own file (LIFO).
      const history = readSleepHistory(root);
      history.unshift(buildHistoryEntry(previousDebt, result, summary, today_));
      writeSleepHistory(root, history);

      // Finalize and persist the new state exactly once.
      const finalState = finalizeSleepState(result.state, summary, today_);
      writeSleepState(root, finalState);

      if (epoch && finalState.sessions.length > 0) {
        success(`Consolidation complete. Debt reduced from ${previousDebt} to ${finalState.debt}. ${finalState.sessions.length} post-epoch session(s) preserved.`);
      } else {
        success(`Consolidation complete. Debt reset from ${previousDebt} to ${finalState.debt}.`);
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
          let report = await backend.sync('both');
          // Any task that still failed to push leaves the local→remote state
          // incomplete. Retry the whole sync ONCE — the failed tasks are still
          // drift-flagged, so they get re-selected, and the rate window has
          // advanced. One extra pass, not a loop.
          if (report.failedPushes.length > 0) {
            warn(`Task sync: ${report.failedPushes.length} task(s) did not push — retrying once…`);
            report = await backend.sync('both');
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

      // Post-sleep brain-repo sync (github-cloud-collaboration-brain-repo-sync,
      // M1): fetch/merge/commit/push when the project has opted into autoSync —
      // `separate` (brain repo) or `full-repo` (whole project → origin). The
      // engine resolves the mode internally, so this only checks the toggle.
      // Best-effort by the same discipline as task sync above — a sync failure
      // must never fail `sleep done`, but it must never fail SILENTLY either.
      try {
        const cfg = readSetupConfig(dirname(root));
        if (cfg?.brainRepo?.autoSync) {
          const result = await runBrainSync({ cwd: root, mode: 'auto' });
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
        warn(`Brain sync: skipped — ${(err as Error).message ?? err}`);
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
