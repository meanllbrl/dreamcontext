import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { readJsonObject, writeJsonObject, readJsonArray, writeJsonArray } from '../../lib/json-file.js';
import { today } from '../../lib/id.js';
import { header, success, error, warn, info } from '../../lib/format.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SessionRecord {
  session_id: string;
  transcript_path: string | null;
  stopped_at: string | null;
  last_assistant_message: string | null;
  change_count: number | null;
  tool_count: number | null;
  score: number | null;
  task_slugs: string[];
}

export interface Bookmark {
  id: string;
  message: string;
  salience: 1 | 2 | 3;
  created_at: string;
  session_id: string | null;
  task_slug: string | null;
}

export interface Trigger {
  id: string;
  when: string;
  remind: string;
  source: string | null;
  created_at: string;
  fired_count: number;
  max_fires: number;
}

export interface KnowledgeAccessRecord {
  last_accessed: string;
  count: number;
}

export interface SleepHistoryEntry {
  date: string;
  consolidated_at: string;
  summary: string;
  debt_before: number;
  debt_after: number;
  sessions_processed: number;
  bookmarks_processed: number;
  session_ids: string[];
}

export interface CompactionRecord {
  timestamp: string;
  trigger: string;
  debt_at_compaction: number;
  sessions_count: number;
  bookmarks_count: number;
}

export interface FieldChange {
  field: string;
  from: string | number | boolean | string[] | null;
  to: string | number | boolean | string[] | null;
}

export interface DashboardChange {
  timestamp: string;
  entity: 'task' | 'core' | 'knowledge' | 'feature' | 'sleep';
  action: 'create' | 'update' | 'delete';
  target: string;
  field?: string;
  fields?: FieldChange[];
  summary: string;
}

export interface SleepState {
  debt: number;
  last_sleep: string | null;
  last_sleep_summary: string | null;
  sleep_started_at: string | null;
  sessions_since_last_sleep: number;
  sessions: SessionRecord[];
  bookmarks: Bookmark[];
  triggers: Trigger[];
  knowledge_access: Record<string, KnowledgeAccessRecord>;
  dashboard_changes: DashboardChange[];
  compaction_log: CompactionRecord[];
}

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
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function getSleepPath(root: string): string {
  return join(root, 'state', '.sleep.json');
}

function getSleepHistoryPath(root: string): string {
  return join(root, 'state', '.sleep-history.json');
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

function getSleepinessLevel(debt: number): string {
  if (debt <= 3) return 'Alert';
  if (debt <= 6) return 'Drowsy';
  if (debt <= 9) return 'Sleepy';
  return 'Must Sleep';
}

function getSleepinessRange(debt: number): string {
  if (debt <= 3) return '0-3';
  if (debt <= 6) return '4-6';
  if (debt <= 9) return '7-9';
  return '10+';
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
      const level = getSleepinessLevel(state.debt);
      const range = getSleepinessRange(state.debt);

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
      const score = parseInt(scoreStr, 10);
      if (isNaN(score) || score < 1 || score > 3) {
        error('Score must be 1, 2, or 3.');
        return;
      }

      const description = descParts.join(' ');
      if (!description.trim()) {
        error('Description is required.');
        return;
      }

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
      });
      state.debt += score;

      writeSleepState(root, state);

      const level = getSleepinessLevel(state.debt);
      success(`Sleep debt: ${state.debt} (${level})`);

      if (state.debt >= 10) {
        warn('Must sleep! Debt is 10+. Consolidation needed.');
      } else if (state.debt >= 7) {
        info('Getting sleepy. Consider consolidating soon.');
      }
    });

  // --- start ---
  sleep
    .command('start')
    .description('Mark beginning of consolidation (sets epoch for safe clearing)')
    .action(() => {
      const root = ensureContextRoot();
      const state = readSleepState(root);

      if (state.sleep_started_at) {
        warn(`Consolidation already in progress (started ${state.sleep_started_at}). Overwriting epoch.`);
      }

      state.sleep_started_at = new Date().toISOString();
      writeSleepState(root, state);
      success(`Consolidation epoch set: ${state.sleep_started_at}`);
    });

  // --- done ---
  sleep
    .command('done')
    .argument('<summary...>', 'Summary of what was consolidated')
    .description('Mark consolidation complete, reset debt')
    .action((summaryParts: string[]) => {
      const summary = summaryParts.join(' ');
      if (!summary.trim()) {
        error('Summary is required.');
        return;
      }

      const root = ensureContextRoot();
      const state = readSleepState(root);
      const previousDebt = state.debt;
      const epoch = state.sleep_started_at;

      // Collect sessions and bookmarks processed for history
      let sessionsProcessed = 0;
      let bookmarksProcessed = 0;
      let processedSessionIds: string[] = [];

      if (epoch) {
        // Epoch-based: only clear sessions/changes/bookmarks from before sleep started
        const processedSessions = state.sessions.filter(s => !s.stopped_at || s.stopped_at <= epoch);
        sessionsProcessed = processedSessions.length;
        processedSessionIds = processedSessions.map(s => s.session_id);
        bookmarksProcessed = state.bookmarks.filter(b => b.created_at <= epoch).length;

        state.sessions = state.sessions.filter(s => {
          if (!s.stopped_at) return false;
          return s.stopped_at > epoch;
        });
        state.bookmarks = state.bookmarks.filter(b => b.created_at > epoch);
        state.dashboard_changes = state.dashboard_changes.filter(c => c.timestamp > epoch);
        state.debt = state.sessions.reduce((sum, s) => sum + (s.score ?? 0), 0);
      } else {
        // Backward compat: no epoch, clear everything
        sessionsProcessed = state.sessions.length;
        processedSessionIds = state.sessions.map(s => s.session_id);
        bookmarksProcessed = state.bookmarks.length;
        state.sessions = [];
        state.bookmarks = [];
        state.dashboard_changes = [];
        state.debt = 0;
      }

      // Expire triggers past max_fires
      state.triggers = state.triggers.filter(t => t.fired_count < t.max_fires);

      // Write sleep history entry to separate file (LIFO)
      const history = readSleepHistory(root);
      history.unshift({
        date: today(),
        consolidated_at: new Date().toISOString(),
        summary: summary.trim(),
        debt_before: previousDebt,
        debt_after: state.debt,
        sessions_processed: sessionsProcessed,
        bookmarks_processed: bookmarksProcessed,
        session_ids: processedSessionIds,
      });
      writeSleepHistory(root, history);

      state.last_sleep = today();
      state.last_sleep_summary = summary.trim();
      state.sleep_started_at = null;
      state.sessions_since_last_sleep = 0;

      writeSleepState(root, state);

      if (epoch && state.sessions.length > 0) {
        success(`Consolidation complete. Debt reduced from ${previousDebt} to ${state.debt}. ${state.sessions.length} post-epoch session(s) preserved.`);
      } else {
        success(`Consolidation complete. Debt reset from ${previousDebt} to ${state.debt}.`);
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
