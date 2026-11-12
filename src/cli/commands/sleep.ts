import { closeSleepRun, openSleepRun } from '../../lib/usage-records.js';
import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { listApps } from '../../lib/apps/registry.js';
import { countFindings } from '../../lib/apps/learn-queue.js';
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
import { readSetupConfig, updateSetupConfig, readBrainLocal, writeBrainLocal, SLEEP_SPECIALISTS, effectiveSpecialist } from '../../lib/setup-config.js';
import {
  setSleepConfigKey,
  resetSleepConfigKey,
  readInstalledSpecialistDefaults,
  DEFAULT_MAX_NEW_TASKS_PER_CYCLE,
} from '../../lib/sleep-settings.js';
import { applySleepSpecialistOverrides } from '../../lib/install-agents.js';
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
import { buildCorpusCached } from '../../lib/recall-corpus-cache.js';
import { embeddingCacheUsable } from '../../lib/embeddings/store.js';
import { recallCloudStatus } from '../../lib/recall-cloud-config.js';
import { spawnCloudIndexRefresh } from '../../lib/recall-cloud-index-spawn.js';
import { registerRecallCloudCommands } from './recall-cloud.js';
import { loadProjectVocabulary, auditCorpus, ensureTaxonomyFile } from '../../lib/taxonomy.js';
import { runTaxonomyFix, isFixExcluded } from './taxonomy.js';
import {
  specialistDispatchTable,
  renderDispatchTable,
  createPhaseTimer,
  spawnEmbeddingRefresh,
  readTaskQueueDepth,
  isSyncAuthFailure,
  isTokenRefused,
  renderStaleRemoteLine,
} from '../../lib/sleep-cycle-tools.js';
import {
  readSleepFlags,
  writeSleepFlags,
  reconcileFlags,
  escalations,
  renderEscalationAsks,
  renderTaskCandidateLine,
  bumpPriority,
  parseFlagOption,
  planCuratorTask,
  CURATOR_TASK_SLUG,
} from '../../lib/sleep-flags.js';
import { loadStatuses } from '../../lib/overrides.js';
import { learnedThisSleep } from '../../lib/sleep-learns.js';
import { pruneOwnerWords } from '../../lib/owner-words.js';
import { buildSleepPacket, renderSleepPacket, renderSleepBoard, writeSleepPacket, PACKET_MD_REL, PACKET_BOARD_REL, type SleepPacket } from '../../lib/sleep-packet.js';
import { getActivePlanningVersion } from '../../lib/active-version.js';
import { getExistingReleases } from '../../lib/release-discovery.js';
import { resolveLinkedRepos } from '../../lib/linked-repos.js';
import { listPeople } from '../../lib/people-store.js';
import { isLearningEnabled } from '../../lib/setup-config.js';
import type { TaskData } from '../../lib/task-backend/types.js';
import {
  readCycleReport,
  recordCycleFlag,
  recordNoFlags,
  recordCycleAsks,
  consumeCycleReport,
  CYCLE_REPORT_REL,
} from '../../lib/sleep-cycle-report.js';
import { auditFeatureLinks } from '../../lib/feature-links.js';
import { buildRoadmapModel } from '../../lib/roadmap-model.js';
import { writeRoadmapBoard } from './roadmap.js';
import { runRemSleep } from '../../lib/marketing/rem-sleep.js';
import { withLock as withMarketingLock } from '../../lib/marketing/store.js';
import { loadCouncilIndex } from '../../lib/council.js';
import { compactFeature, cutoffDate, oversizedPrds } from '../../lib/feature-compact.js';
import { featuresDir, featureSlug } from '../../lib/features-path.js';
import fg from '../../lib/glob.js';
import { sortByOrder } from '../../lib/task-status.js';
import { RULES_REL_PATH, readRules, unlearnedIds } from '../../lib/task-filing-rules.js';
import { appliedObjectionIds, readObjectionsStrict, type ObjectionRecord } from '../../lib/task-objection.js';
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
  outputsBoundary,
  nextOutputsBoundary,
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

/**
 * `--asks criterion=a,subtask=b,task=c,unplaced=d` → the line `sleep done` prints and appends to
 * the cycle's history summary. Every key optional (0), every value a non-negative integer.
 */
export function parseAsks(raw: string): { ok: true; counts: Record<'criterion' | 'subtask' | 'task' | 'unplaced', number>; line: string } | { ok: false } {
  const counts = { criterion: 0, subtask: 0, task: 0, unplaced: 0 };
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: false };
  for (const part of parts) {
    const m = /^(criterion|subtask|task|unplaced)\s*=\s*(\d+)$/.exec(part);
    if (!m) return { ok: false };
    counts[m[1] as keyof typeof counts] = Number(m[2]);
  }
  const n = counts.criterion + counts.subtask + counts.task + counts.unplaced;
  return {
    ok: true,
    counts,
    line: `Owner asks: ${n} → criterion ${counts.criterion} · subtask ${counts.subtask} · new task ${counts.task} · not placed ${counts.unplaced}`,
  };
}

/** The filing-rules part of the `sleep start` brief. Lines starting with `!` are warnings. */
export function filingRulesBrief(root: string): { lines: string[]; json: Record<string, unknown> } {
  const lines: string[] = [];
  const read = readRules(root);
  let records: ObjectionRecord[] = [];
  let ledgerError: string | null = null;
  try {
    records = readObjectionsStrict(root);
  } catch (err) {
    ledgerError = (err as Error).message;
  }
  if (read.state === 'unreadable') {
    lines.push(`!Task filing rules could NOT be read: ${read.reason}. File as if unsure, and say so in the report.`);
  } else if (read.doc.rules.length > 0) {
    lines.push(`Task filing rules (${RULES_REL_PATH}):`);
    for (const r of read.doc.rules) lines.push(`  ${r.id} · ${r.title} — Don't: ${r.dont} Do: ${r.do}`);
  }
  if (ledgerError) lines.push(`!Objections could NOT be read: ${ledgerError}`);
  const unlearned = read.state === 'unreadable' ? [] : unlearnedIds(read.doc, appliedObjectionIds(records));
  if (unlearned.length > 0) {
    lines.push(`Objections to learn from (${unlearned.length}): dreamcontext tasks objections --unlearned`);
  }
  return {
    lines,
    json: {
      state: read.state,
      ...(read.state === 'unreadable' ? { reason: read.reason } : { rules: read.doc.rules }),
      ...(ledgerError ? { objectionsError: ledgerError } : {}),
      unlearned,
    },
  };
}

/** True when `dir` is a checkout of dreamcontext itself (its package.json names the package). */
function isDreamcontextCheckout(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { name?: unknown };
    return pkg.name === 'dreamcontext';
  } catch {
    return false;
  }
}

/** The pending automation outputs and the apps with findings, as `sleep start` reports them. */
function pendingSignals(root: string, state: SleepState): { outputs: number; appFindings: Array<{ slug: string; count: number }> } {
  let outputs = 0;
  try { outputs = pendingOutputsSince(root, outputsBoundary(state)).outputs.length; } catch { outputs = 0; }
  let appFindings: Array<{ slug: string; count: number }> = [];
  try {
    appFindings = listApps(homedir(), dirname(root))
      .map((a) => ({ slug: a.slug, count: countFindings(homedir(), a.hash) }))
      .filter((a) => a.count > 0);
  } catch { appFindings = []; }
  return { outputs, appFindings };
}

/**
 * SL-1 — gather everything the sleep packet needs and build it. Read-only. The review-kind
 * tasks are read in full (criteria and changelog); every other task only as its listing row.
 */
export async function collectSleepPacket(root: string, opts: { filingRules?: string[]; outputs?: number; appFindings?: number } = {}): Promise<SleepPacket> {
  const state = readSleepState(root);
  const projectRoot = dirname(root);
  const backend = getTaskBackend(root);
  const statuses = loadStatuses(root);
  const tasks = await backend.list({ all: true, statuses });
  const reviewKeys = new Set(statuses.filter((d) => d.kind === 'review').map((d) => d.key));
  const reviewTasks: TaskData[] = [];
  for (const t of tasks) {
    if (!reviewKeys.has(t.status)) continue;
    const full = await backend.get(basename(t.file, '.md')).catch(() => null);
    if (full) reviewTasks.push(full);
  }
  const repos: Array<{ name: string; path: string }> = [{ name: 'project', path: projectRoot }];
  try {
    for (const r of resolveLinkedRepos(projectRoot)) if (r.present && r.path) repos.push({ name: r.name, path: r.path });
  } catch { /* the project alone */ }
  let people = 0;
  try { people = listPeople(root).length; } catch { people = 0; }
  const signals = opts.outputs === undefined || opts.appFindings === undefined ? pendingSignals(root, state) : null;
  return buildSleepPacket({
    contextRoot: root,
    state,
    history: readSleepHistory(root),
    tasks,
    reviewTasks,
    statuses,
    releases: getExistingReleases(root).map((r) => ({ version: r.version, status: r.status ?? 'released' })),
    // "Installed" means at or below the running CLI, which is only true of dreamcontext's own
    // brain: any other project's 0.2.0 is not shipped because the CLI is 0.41. Elsewhere only a
    // released entry in RELEASES.json counts.
    runningVersion: repos.some((r) => isDreamcontextCheckout(r.path)) ? dreamcontextVersion() : null,
    activeVersion: getActivePlanningVersion(root),
    filingRules: opts.filingRules ?? filingRulesBrief(root).lines,
    repos,
    people,
    automationOutputs: opts.outputs ?? signals!.outputs,
    appFindings: opts.appFindings ?? signals!.appFindings.reduce((a, b) => a + b.count, 0),
    learning: isLearningEnabled(readSetupConfig(projectRoot)),
  });
}

/** SL-4: what `sleep done` compacts — PRDs over this size, entries older than this, newest kept. */
export const PRD_COMPACT_MIN_CHARS = 20_000;
export const PRD_COMPACT_DAYS = 30;
export const PRD_COMPACT_KEEP = 5;

/** The steps after the specialists that need judgment, printed by `sleep start` (SL-3). */
export function remainingChecklist(): string[] {
  return [
    'After the specialists (their reports record flags and asks themselves: `sleep flag add|none`, `sleep asks set`):',
    '  1. `dreamcontext reflect`: promote a candidate only when it is load-bearing.',
    '  2. `dreamcontext sleep done "<summary>"` (+ `--product-ran` when sleep-product ran). It runs the roadmap refresh, the feature-link audit, PRD compaction, `mk rem-sleep` and the council count itself.',
    '  3. Report: relay what `sleep done` printed (escalations, ready-to-close, link drift, slipping objectives, unpromoted debates).',
  ];
}

/**
 * SL-3/SL-4 — the deterministic steps of the flow's tail, run by `sleep done` itself instead of left
 * to an orchestrator that skipped them in most runs. Each is best-effort and says what it did.
 * The feature-link step only AUDITS: its heal drops `related_tasks` entries whose task file is
 * absent, and a delete is never inferred from absence inside an unattended step
 * (knowledge/patterns/a-delete-is-never-inferred-from-absence.md). It prints the command instead.
 */
export async function runSleepTail(root: string, say: { info: (m: string) => void; warn: (m: string) => void }): Promise<void> {
  try {
    const objectivesDir = join(root, 'core', 'objectives');
    if (existsSync(objectivesDir) && readdirSync(objectivesDir).some((f) => f.endsWith('.md'))) {
      const model = buildRoadmapModel(root);
      writeRoadmapBoard(root, model);
      const slipping = model.objectives.filter((o) => o.slipping === true).map((o) => o.slug);
      say.info(`Roadmap refreshed: ${model.objectives.length} objective(s)${slipping.length ? `, SLIPPING: ${slipping.join(', ')}` : ', none slipping'}.`);
    }
  } catch (err) {
    say.warn(`Roadmap refresh: skipped — ${(err as Error).message ?? err}`);
  }
  try {
    const a = auditFeatureLinks(root);
    const fixable = a.nonCanonicalFeatureRefs.length + a.missingBackRefs.length + a.missingMemberships.length;
    const drops = a.ghostTaskRefs.length + a.foreignClaims.length;
    const human = a.ghostFeatureRefs.length + a.conflictingClaims.length;
    if (fixable + drops + human > 0) {
      say.warn(
        `Feature links: ${fixable} to add or canonicalize, ${drops} to drop (a task file missing or claimed by another feature), ${human} for a human. ` +
        'Review and fix with `dreamcontext doctor --heal-links` (sleep does not drop links on its own).',
      );
    }
  } catch (err) {
    say.warn(`Feature-link audit: skipped — ${(err as Error).message ?? err}`);
  }
  try {
    if (existsSync(join(root, 'marketing'))) {
      const r = await withMarketingLock(async () => runRemSleep({}));
      if (r.marketingPresent) {
        say.info(
          `Marketing rem-sleep: runs kept ${r.runs.kept}, removed ${r.runs.deleted}; insights kept ${r.insights.kept}, removed ${r.insights.deleted}; ` +
          `learnings merged ${r.learnings.merged}; redacted ${r.redaction.rewritten}.`,
        );
        for (const f of [...r.runs.deletedFiles, ...r.insights.deletedFiles].slice(0, 20)) say.info(`  removed ${f}`);
      }
    }
  } catch (err) {
    say.warn(`Marketing rem-sleep: skipped — ${(err as Error).message ?? err}`);
  }
  // SL-4 — PRDs over 20K chars move their Changelog entries older than 30 days (the newest 5
  // always stay) into knowledge/archive/features/, archive written and read back first.
  try {
    const dir = featuresDir(root);
    const files = existsSync(dir) ? fg.sync('**/*.md', { cwd: dir, absolute: true, followSymbolicLinks: false }) : [];
    const big = oversizedPrds(files.map((f) => ({ feature: featureSlug(dir, f), path: f })), PRD_COMPACT_MIN_CHARS);
    const cutoff = cutoffDate(new Date(), PRD_COMPACT_DAYS);
    let moved = 0;
    for (const t of big) {
      try {
        const r = compactFeature(root, t.feature, t.path, { cutoff, keepNewest: PRD_COMPACT_KEEP, today: today() });
        if (r.moved > 0) {
          moved += r.moved;
          say.info(`PRD compacted: ${t.feature} moved ${r.moved} changelog entr${r.moved === 1 ? 'y' : 'ies'} (${r.movedChars} chars) → ${r.archives.map((a) => a.slice(root.length + 1)).join(', ')}`);
        }
      } catch (err) {
        say.warn(`PRD compaction: ${t.feature} left as it was — ${(err as Error).message ?? err}`);
      }
    }
    if (big.length > 0 && moved === 0) say.info(`PRDs over ${PRD_COMPACT_MIN_CHARS} chars: ${big.length}, none with changelog entries older than ${PRD_COMPACT_DAYS} days to move.`);
  } catch (err) {
    say.warn(`PRD compaction: skipped — ${(err as Error).message ?? err}`);
  }
  try {
    const unpromoted = loadCouncilIndex().filter((e) => e.status === 'complete' && !e.promoted_to_knowledge);
    if (unpromoted.length > 0) {
      say.info(`Council: ${unpromoted.length} finished debate(s) not promoted to knowledge (\`dreamcontext council list --unpromoted\`): promote one only if the owner engaged with it.`);
    }
  } catch (err) {
    say.warn(`Council check: skipped — ${(err as Error).message ?? err}`);
  }
}

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
    .action(async (opts: { deep?: boolean; force?: boolean; json?: boolean }) => {
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
        openSleepRun(root, state.debt);
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
        const pending = pendingOutputsSince(root, outputsBoundary(state));
        const sharedBySlug = new Map(listAutomations(root).map((m) => [m.slug, m.shared]));
        const automationOutputs = {
          outputs: pending.outputs.map((o) => ({ ...o, shared: sharedBySlug.get(o.slug) ?? false })),
          skipped: pending.skipped,
          totalBytes: pending.totalBytes,
        };
        if (automationOutputs.outputs.length > 0 || automationOutputs.skipped.length > 0) {
          const slugs = [...new Set(automationOutputs.outputs.map((o) => o.slug))].sort();
          const slugSuffix = slugs.length > 0 ? ` (${slugs.join(', ')})` : '';
          say.info(`Automation outputs pending consolidation: ${automationOutputs.outputs.length}${slugSuffix}. Fire sleep-product, then close with \`sleep done --product-ran\` (without it these outputs stay pending for the next cycle).`);
          // No silent caps: every dropped file is named, never just absent.
          for (const s of automationOutputs.skipped) {
            say.warn(`  skipped ${s.slug} (${s.reason}): ${s.path}`);
          }
        }

        // What this project's apps learned (plan-veri K4): a COUNT per app, never the text. A
        // non-empty list fires sleep-product, which alone reads the text (`apps learn-list`).
        let appFindings: Array<{ slug: string; count: number }> = [];
        try {
          appFindings = listApps(homedir(), dirname(root))
            .map((a) => ({ slug: a.slug, count: countFindings(homedir(), a.hash) }))
            .filter((a) => a.count > 0);
        } catch { appFindings = []; }
        if (appFindings.length) {
          say.info(`App findings waiting: app_findings=${appFindings.map((a) => a.slug).join(',')} (${appFindings.map((a) => `${a.slug}: ${a.count}`).join(', ')}). Fire sleep-product.`);
        }

        // The task-filing rules learned from the owner's objections, and the objections no
        // rule rests on yet: sleep-tasks reads the first before it files anything and distils
        // the second into rules. An unreadable rules file or ledger is SAID, never read as
        // "no rules".
        const filingRules = filingRulesBrief(root);
        for (const line of filingRules.lines) {
          if (line.startsWith('!')) say.warn(line.slice(1)); else say.info(line);
        }

        // SL-6 — the taxonomy pass is deterministic, so it runs HERE at zero tokens
        // instead of as specialist turns at peak context: scaffold the vocabulary,
        // apply the safe alias rewrites (never inside knowledge/archive/), and hand
        // sleep-product only what needs judgment, the orphan tags. Best-effort.
        let taxonomy: { created: boolean; rewrites: number; files: number; orphans: Array<{ tag: string; count: number }> } | null = null;
        try {
          const created = ensureTaxonomyFile(root);
          const vocab = loadProjectVocabulary(root);
          // The mtime-validated cache: a warm brain pays milliseconds, not a full parse.
          const corpus = buildCorpusCached(root);
          const fix = runTaxonomyFix(root, vocab, true, corpus);
          // Re-read after the rewrite so the orphan count is what is left now.
          const after = fix.files.length > 0 ? buildCorpusCached(root) : corpus;
          // Archives are frozen, so their tags are nobody's decision: left out of the list.
          const live = after.filter((d) => !isFixExcluded(d.relPath));
          const buckets = auditCorpus(live.map((d) => ({ slug: d.slug, tags: d.tags })), loadProjectVocabulary(root));
          const counts = new Map<string, number>();
          for (const t of buckets.orphan) counts.set(t, (counts.get(t) ?? 0) + 1);
          const orphans = [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
          taxonomy = { created, rewrites: fix.totalRewrites, files: fix.files.length, orphans };
          const head = orphans.slice(0, 12).map((o) => `${o.tag} (${o.count})`).join(', ');
          say.info(
            `Taxonomy done${created ? ' (core/taxonomy.json created)' : ''}: ${fix.totalRewrites} tag(s) normalized in ${fix.files.length} file(s). ` +
            (orphans.length > 0
              ? `${orphans.length} orphan tag(s) need a vocab decision; pass this list to sleep-product: ${head}${orphans.length > 12 ? ', …' : ''}.`
              : 'No orphan tags.'),
          );
        } catch (err) {
          say.warn(`Taxonomy pass: skipped — ${(err as Error).message ?? err}`);
        }

        // SL-12 — what each specialist runs on. The dispatcher passes exactly
        // this; a habit of passing one model to every sub-agent would otherwise
        // override the pins the brain chose in Settings › Sleep.
        const dispatch = specialistDispatchTable(projectRoot);
        for (const line of renderDispatchTable(dispatch)) say.info(line);

        // SL-3 — an unfinished cycle's report is carried, never wiped: its observations are
        // still observations. Then the steps left after the specialists.
        const carried = readCycleReport(root);
        if (carried.reported_by.length > 0 || carried.asks) {
          say.info(`Carried from an unfinished cycle: ${carried.flags.length} flag(s) recorded by ${carried.reported_by.join(', ') || 'nobody'} (${CYCLE_REPORT_REL}); sleep done reads them with this cycle's.`);
        }
        for (const line of remainingChecklist()) say.info(line);

        // SL-1 — the packet: what every specialist used to rebuild by hand (sessions oldest →
        // newest with every owner-typed turn, the open board, ready-to-close, git, flags, and
        // the facts that switch prompt sections off). Best-effort: without it the specialists
        // fall back to building their input themselves, and the line says so.
        let packetPath: string | null = null;
        try {
          const packet = await collectSleepPacket(root, {
            filingRules: filingRules.lines,
            outputs: automationOutputs.outputs.length,
            appFindings: appFindings.reduce((a, b) => a + b.count, 0),
          });
          packetPath = writeSleepPacket(root, packet).md;
          say.info(
            `Sleep packet: _dream_context/${PACKET_MD_REL} (${packet.sessions.length} session(s) oldest to newest with the owner's turns, git, flags) ` +
            `and _dream_context/${PACKET_BOARD_REL} (${packet.board.open.length} open task(s), ${packet.ready_to_close.length} ready to close). ` +
            'Give both paths to every specialist (the board matters to sleep-tasks); they read them instead of rebuilding them.',
          );
        } catch (err) {
          say.warn(`Sleep packet: not written — ${(err as Error).message ?? err}. Specialists build their input by hand this cycle.`);
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
            appFindings,
            filingRules: filingRules.json,
            taxonomy,
            dispatch,
            packet: packetPath,
          }, null, 2));
        }
      } finally {
        // Release the stamp mutex the moment the stamp completes (success, refuse,
        // or throw). The durable epoch — not this file — carries the lock onward.
        releaseFileLock(startLockPath);
      }
    });

  // --- flag (SL-3: specialists record their own observations) ---
  const flag = sleep
    .command('flag')
    .description('Record a recurring problem this cycle observed (specialists run this themselves; sleep done reads it)');
  flag
    .command('add')
    .argument('<key>', 'Stable key, byte-identical every cycle: recurring-task:<slug>, ceiling-blocked:<file>, task-candidate:<topic>, …')
    .argument('<label...>', 'One line: what recurred and the evidence')
    .option('--task <slug>', 'The task this flag escalates (none for a task-candidate)')
    .option('--by <specialist>', 'Who observed it (sleep-tasks, sleep-state, sleep-product, …)', 'agent')
    .action((key: string, labelParts: string[], opts: { task?: string; by: string }) => {
      const root = ensureContextRoot();
      const parsed = parseFlagOption(`${key}::${labelParts.join(' ')}${opts.task ? `::${opts.task}` : ''}`);
      if (!parsed || /\s/.test(parsed.key)) {
        error('A flag needs a key without spaces and a label.', 'Example: dreamcontext sleep flag add recurring-task:fix-x "still todo after 3 cycles" --task fix-x --by sleep-tasks');
        process.exitCode = 1;
        return;
      }
      const r = recordCycleFlag(root, parsed, opts.by);
      success(`Flag recorded: ${parsed.key} (${r.flags.length} this cycle). sleep done tracks the streak.`);
    });
  flag
    .command('none')
    .description('Say you looked and nothing recurred (so a cycle with no flags still counts as reported)')
    .option('--by <specialist>', 'Who looked', 'agent')
    .action((opts: { by: string }) => {
      const root = ensureContextRoot();
      recordNoFlags(root, opts.by);
      success(`Recorded: ${opts.by} reported no recurring problem this cycle.`);
    });
  flag
    .command('list')
    .description('This cycle\'s recorded flags and the streaks kept so far')
    .option('--json', 'Emit as JSON')
    .action((opts: { json?: boolean }) => {
      const root = ensureContextRoot();
      const cycle = readCycleReport(root);
      const kept = readSleepFlags(root);
      if (opts.json) { console.log(JSON.stringify({ cycle, kept }, null, 2)); return; }
      console.log(header('This cycle'));
      console.log(`  reported by: ${cycle.reported_by.join(', ') || 'nobody yet'}`);
      for (const f of cycle.flags) console.log(`  ${f.key} · ${f.label}${f.task_slug ? ` · ${f.task_slug}` : ''} (${f.by})`);
      console.log(header('Streaks'));
      if (kept.length === 0) console.log(chalk.dim('  none'));
      for (const f of kept) console.log(`  ${f.key} · ${f.consecutive_cycles} cycle(s) · ${f.label}`);
    });

  // --- asks (SL-3: sleep-tasks records where the owner's asks landed) ---
  sleep
    .command('asks')
    .description('Record where the owner\'s asks landed this cycle (sleep-tasks)')
    .command('set')
    .argument('<counts>', 'criterion=a,subtask=b,task=c,unplaced=d')
    .option('--by <specialist>', 'Who placed them', 'sleep-tasks')
    .action((raw: string, opts: { by: string }) => {
      const root = ensureContextRoot();
      const parsed = parseAsks(raw);
      if (!parsed.ok) {
        error(`"${raw}" is not criterion=a,subtask=b,task=c,unplaced=d.`, 'Example: dreamcontext sleep asks set criterion=3,subtask=0,task=1,unplaced=2');
        process.exitCode = 1;
        return;
      }
      recordCycleAsks(root, parsed.counts, opts.by);
      success(`${parsed.line} — recorded; sleep done writes it into the cycle's history.`);
    });

  // --- packet ---
  sleep
    .command('packet')
    .description('Print the sleep packet: sessions oldest to newest with every owner-typed turn, git since the last sleep, flags; --board for the open board and the tasks ready to close (sleep start writes both to tmp/sleep/)')
    .option('--json', 'Emit the packet as JSON')
    .option('--board', 'Print the board half (open board, ready to close, stale reviews) instead of the sessions half')
    .option('--write', 'Also write it to _dream_context/tmp/sleep/ (packet.md, board.md, packet.json)')
    .action(async (opts: { json?: boolean; board?: boolean; write?: boolean }) => {
      const root = ensureContextRoot();
      const packet = await collectSleepPacket(root);
      if (opts.write) {
        const paths = writeSleepPacket(root, packet);
        if (!opts.json) info(`Written: ${paths.md} and ${paths.board}`);
      }
      console.log(opts.json ? JSON.stringify(packet, null, 2) : opts.board ? renderSleepBoard(packet) : renderSleepPacket(packet));
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
    .option(
      '--asks <counts>',
      'Where the owner\'s asks landed this cycle (sleep-tasks report): criterion=a,subtask=b,task=c,unplaced=d',
    )
    .option(
      '--product-ran',
      'sleep-product ran this cycle, so pending automation output counts as consumed (without it, that output stays pending)',
    )
    .action(async (summaryParts: string[], opts: { flag: string[]; ackPrivateDerivation?: boolean; asks?: string; productRan?: boolean }) => {
      const timer = createPhaseTimer();
      let summary = summaryParts.join(' ');
      if (!summary.trim()) {
        error('Summary is required.');
        return;
      }
      // SL-3 — what the specialists recorded themselves this cycle (flags, ask counts).
      const cycleReport = readCycleReport(ensureContextRoot());
      if (opts.asks === undefined && cycleReport.asks) {
        const c = cycleReport.asks.counts;
        opts.asks = `criterion=${c.criterion},subtask=${c.subtask},task=${c.task},unplaced=${c.unplaced}`;
      }
      // Parsed BEFORE any write, and never a refusal: a malformed value is kept raw with a
      // warning, because refusing this late would leave the cycle half closed.
      if (opts.asks !== undefined) {
        const asks = parseAsks(opts.asks);
        if (asks.ok) {
          info(asks.line);
          summary = `${summary.trim()} · ${asks.line}`;
        } else {
          warn(`--asks "${opts.asks}" is not criterion=a,subtask=b,task=c,unplaced=d; kept as written.`);
          summary = `${summary.trim()} · Owner asks (unparsed): ${opts.asks}`;
        }
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

        // SL-9 — automation output counts as consumed only when sleep-product
        // ran (or nothing was pending). Counted BEFORE the boundary moves.
        const previousBoundary = outputsBoundary(fresh);
        const pendingOutputs = previousBoundary ? pendingOutputsSince(root, previousBoundary).outputs.length : 0;
        const nowISO = new Date().toISOString();

        // Finalize and persist the new state exactly once.
        const finalState = finalizeSleepState(result.state, summary, today_, nowISO);
        finalState.outputs_consumed_at = nextOutputsBoundary({
          previous: previousBoundary,
          pendingCount: pendingOutputs,
          productRan: !!opts.productRan,
          epoch,
          nowISO,
        });
        writeSleepState(root, finalState);
        return { previousDebt, epoch, today_, finalState, pendingOutputs };
      });
      if (!doneLock.locked) {
        error('Sleep state is busy — refusing to consolidate from a stale read. Retry in a moment.');
        process.exitCode = 1;
        return;
      }
      const { previousDebt, epoch, today_, finalState, pendingOutputs } = doneLock.value;
      closeSleepRun(root, finalState.debt);

      if (epoch && finalState.sessions.length > 0) {
        success(`Consolidation complete. Debt reduced from ${previousDebt} to ${finalState.debt}. ${finalState.sessions.length} post-epoch session(s) preserved.`);
      } else {
        success(`Consolidation complete. Debt reset from ${previousDebt} to ${finalState.debt}.`);
      }
      if (pendingOutputs > 0 && !opts.productRan) {
        warn(`${pendingOutputs} automation output(s) were not consolidated this cycle (no --product-ran), so they stay pending for the next sleep.`);
      }
      // What this sleep learned (learning loop C5, C9): learned, proposed, repeated and escalated
      // rules with their ids, the ones waiting for his word, and the week's repeat count. Then the
      // owner-words ledger's month files past their age go. Best-effort, like every tail step.
      try { for (const line of learnedThisSleep(root, epoch ?? null)) info(line); } catch (err) {
        warn(`Learned this sleep: not listed (${(err as Error).message ?? err}).`);
      }
      try { pruneOwnerWords(); } catch { /* the next sleep prunes */ }
      timer.lap('state');

      // AC6 (1/2) — recidivism escalation: reconcile this cycle's --flag
      // observations against the persisted streak, surface a one-line ask for
      // any flag at/over the escalation threshold, and bump the linked task's
      // priority. Best-effort — a flag-tracking bug must never fail `sleep done`.
      try {
        const passed = opts.flag
          .map(parseFlagOption)
          .filter((f): f is NonNullable<ReturnType<typeof parseFlagOption>> => f !== null);
        // The specialists' own records plus anything passed by hand; one entry per key.
        const byKey = new Map<string, { key: string; label: string; task_slug: string | null }>();
        for (const f of cycleReport.flags) byKey.set(f.key, { key: f.key, label: f.label, task_slug: f.task_slug ?? null });
        for (const f of passed) byKey.set(f.key, f);
        const observed = [...byKey.values()];
        const reported = cycleReport.reported_by.length > 0 || opts.flag.length > 0;
        const prevFlags = readSleepFlags(root);
        const nextFlags = reconcileFlags(prevFlags, observed, new Date().toISOString(), { reported });
        writeSleepFlags(root, nextFlags);
        if (!reported && prevFlags.length > 0) {
          info(`No specialist reported flags this cycle: ${prevFlags.length} flag(s) kept as they were (streaks not advanced).`);
        } else if (observed.length > 0) {
          info(`Recidivism flags: ${observed.length} observed this cycle (${nextFlags.filter((f) => f.consecutive_cycles >= 2).length} recurring).`);
        }
        consumeCycleReport(root);

        // Deferred task candidates get a summary line, not an ask: `escalations`
        // excludes the `task-candidate:` family because such a candidate was
        // deliberately never filed, so there is no task to bump and nothing to
        // hand the user a decision about. Reporting the count is what keeps a
        // deferred idea visible until a later cycle re-observes and files it.
        const deferredCandidates = renderTaskCandidateLine(nextFlags);
        if (deferredCandidates) info(deferredCandidates);

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
      timer.lap('flags');

      // AC6 (2/2) — orphan-tag curator trigger: >= ORPHAN_TAG_CURATOR_THRESHOLD
      // orphan tags across the corpus auto-creates (or refreshes) a standing
      // curator task, using the same doc-list pattern as `taxonomy audit`.
      // Best-effort — a taxonomy audit hiccup must never fail `sleep done`.
      try {
        const vocab = loadProjectVocabulary(root);
        // The only corpus build left in `sleep done` (the embedding refresh is a
        // detached child now), served from the mtime-validated cache.
        const corpus = buildCorpusCached(root);
        // Archives are frozen (never retagged), so their tags cannot count toward the chore.
        const docs = corpus.filter((d) => !isFixExcluded(d.relPath)).map((d) => ({ slug: d.slug, tags: d.tags }));
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

        const statuses = loadStatuses(root);
        const plan = planCuratorTask(
          buckets.orphan.length,
          existingTask ? { slug: existingTask.slug, status: existingTask.status } : null,
          absorbing,
          statuses,
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
            // Sleep opened it, on a measured count rather than an owner ask.
            local_fields: {
              filed_by: 'sleep',
              filing_basis: { kind: 'change', quote: `${buckets.orphan.length} orphan tags`, at: today_, verified: true },
            },
            variant: 'cli',
          });
          info(`Curator task created: ${plan.slug} (${buckets.orphan.length} orphan tags).`);
        } else if (plan.action === 'reopen') {
          // The chore shipped once and the orphans came back: reopen the same
          // task (a create would collide on its fixed slug), with the reason.
          const openKey = sortByOrder(statuses).find((d) => d.kind === 'open')?.key ?? 'todo';
          await backend.updateFields(plan.slug, { status: openKey });
          await backend.addChangelog(
            plan.slug,
            `- ${today_}: reopened by sleep: ${buckets.orphan.length} orphan tag(s) came back after the last curator pass.`,
            { createIfMissing: true },
          );
          info(`Curator task reopened: ${plan.slug} (${buckets.orphan.length} orphan tags).`);
        } else if (plan.skippedCancelled) {
          info(`Curator task ${plan.slug} is cancelled, so sleep left it closed (${buckets.orphan.length} orphan tags). Reopen it yourself if you want the pass.`);
        } else if (plan.action === 'refresh' || plan.action === 'refresh-absorbing') {
          await backend.addChangelog(
            plan.slug,
            `- ${today_}: ${buckets.orphan.length} orphan tag(s) still present — curator pass still needed.`,
            { createIfMissing: true },
          );
          info(plan.action === 'refresh'
            ? `Curator task refreshed: ${plan.slug} (${buckets.orphan.length} orphan tags).`
            : `Curator chore was merged into ${plan.slug}; logged ${buckets.orphan.length} orphan tags there instead of re-filing it.`);
        }
      } catch (err) {
        warn(`Curator trigger: skipped — ${(err as Error).message ?? err}`);
      }
      timer.lap('curator');

      // SL-3 — the flow's deterministic tail (roadmap, link audit, mk rem-sleep, council count).
      await runSleepTail(root, { info, warn });
      timer.lap('tail');

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
      timer.lap('digests');

      // Post-sleep task sync (issue #11): push the consolidation's task updates,
      // then re-mirror. The consolidation touches EVERY reconciled task at once,
      // so this is the heaviest burst the backend ever sees — the adapter paces
      // itself under the rate ceiling (so one pass syncs everything) and retries
      // transient failures. Still best-effort: a sync failure must never fail
      // `sleep done` — but it must NEVER fail SILENTLY either.
      let taskSyncAuthFailed = false;
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
            // SL-7 — a token the remote refused OUTRIGHT (nothing moved, every
            // error a credential refusal) will be refused again: no retry, no
            // wording that reads as a completion. One task's 403 (a GitHub rate
            // limit answers 403 too) is NOT that: it keeps the retry below.
            taskSyncAuthFailed = isTokenRefused(report);
            // Any task that still failed to push leaves the local→remote state
            // incomplete. Retry the whole sync ONCE — the failed tasks are still
            // drift-flagged, so they get re-selected, and the rate window has
            // advanced. One extra pass, not a loop.
            if (report.failedPushes.length > 0 && !taskSyncAuthFailed) {
              bar.done();
              warn(`Task sync: ${report.failedPushes.length} task(s) did not push — retrying once…`);
              report = await backend.sync('both', syncOpts);
            }
          } finally {
            bar.done();
          }
          if (taskSyncAuthFailed) {
            for (const e of report.errors.slice(0, 3)) warn(`  ${e}`);
            warn(renderStaleRemoteLine(readTaskQueueDepth(root)));
          } else {
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
        }
      } catch (err) {
        // The sync engine itself threw (auth/lock/transport) — best-effort by
        // contract, but visible: a swallowed failure is what hid the last bug.
        // A thrown refusal stopped the whole sync, so it IS a refused token.
        const message = (err as Error).message ?? String(err);
        warn(`Task sync: skipped — ${message}`);
        if (isSyncAuthFailure(message)) {
          taskSyncAuthFailed = true;
          warn(renderStaleRemoteLine(readTaskQueueDepth(root)));
        }
      }
      timer.lap('task-sync');

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
          if (!taskSyncAuthFailed && (result.needsTaskSync || readBrainLocal(dirname(root)).needsTaskSync)) {
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
      timer.lap('brain-sync');

      // Post-sleep embedding refresh (decision-embedding-layer: "eager during
      // sleep"). Sleep just rewrote the corpus — the moment the mtime pre-filter
      // is most likely to hide something — so run a FORCE refresh (content hash
      // fully authoritative). Gated on an EXISTING cache: a vault that never
      // enabled hybrid recall must never cold-start a 113 MB model download from
      // `sleep done`. Best-effort by the same discipline as the syncs above.
      //
      // SL-11 — DETACHED, like the cloud refresh below: `sleep done` used to wait
      // seconds on model load and embedding. The child runs the same forced
      // refresh (`embed refresh --force --if-present`) and waits for the cache
      // lock itself; recall refreshes lazily per query in the meantime.
      try {
        if (embeddingCacheUsable(root) && spawnEmbeddingRefresh(dirname(root))) {
          info(chalk.dim('Embedding index refresh started in the background.'));
        }
      } catch (err) {
        warn(`Embedding refresh: skipped — ${(err as Error).message ?? err}`);
      }
      timer.lap('embeddings');

      // Cloud index refresh: only for a vault that consented to a cloud tier, detached and never
      // awaited (the child enforces throttle, churn guard and the rolling spend cap itself).
      try {
        const spawned = spawnCloudIndexRefresh(root, 'sleep');
        if (spawned.spawned) info(chalk.dim('Cloud recall index refresh started in the background.'));
      } catch (err) {
        warn(`Cloud index refresh: skipped — ${(err as Error).message ?? err}`);
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
      timer.lap('durability');
      const phases = timer.line();
      if (phases) info(chalk.dim(phases));
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
        const pinned = cfg?.specialists?.[name];
        const o = effectiveSpecialist(cfg, name);
        const shipped = readInstalledSpecialistDefaults(projectRoot, name);
        const model = o?.model ?? shipped.model ?? chalk.dim('(package default)');
        const effort = o?.effort ?? shipped.effort ?? chalk.dim('(package default)');
        const mark = pinned?.model || pinned?.effort ? chalk.yellow(' *') : '  ';
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
      console.log(chalk.dim('  the trigger, and the current contents of the sleep agent files.'));
      console.log(chalk.dim('  If any of those change, auto sleep PAUSES and asks you to re-approve.'));
      console.log(chalk.dim(`  With defaults this runs at most ~3 cycles on the busiest day; each runs up to five specialists.`));
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
    .option('--tool <tool>', 'codex or antigravity: run the cycle on that tool (docs/tool-parity.md)')
    .action(async (o: { tool?: string }) => {
      const root = ensureContextRoot();
      const res = await runAutoSleep(root, o.tool === 'codex' || o.tool === 'antigravity' ? { tool: o.tool } : {});
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
      if (mode === 'hybrid') {
        const cloud = recallCloudStatus(root);
        const flag = cloud.consentSurface === 'dashboard' ? ' — granted from the dashboard' : '';
        const stale = cloud.consent === 're-consent-required' ? ' — re-consent required' : '';
        console.log(`  Tier: ${cloud.tier}${flag}${stale} (see \`dreamcontext recall cloud status\`)`);
      }
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

  registerRecallCloudCommands(recall, {
    setHybrid: (root) => {
      const state = readSleepState(root);
      state.recall_mode = 'hybrid';
      writeSleepState(root, state);
    },
  });
}
