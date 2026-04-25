/**
 * Marketing learnings — per-day .md files in _dream_context/knowledge/marketing-learnings/
 * with a sidecar .index.json for hooks / queries.
 *
 * Performance Monitor agent is the only intended writer. The CLI gates writes
 * by requiring `agent=performance-monitor` (or an env override for tests).
 *
 * Entry types:
 *   - recommendation: pending → confirmed | rejected. Pruned eventually.
 *   - ledger:        evergreen. Never pruned, only archived quarterly.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { customAlphabet } from 'nanoid';
import { MARKETING_PATHS } from './paths.js';

const idgen = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

export type LearningType = 'recommendation' | 'ledger';
export type LearningStatus = 'pending' | 'confirmed' | 'rejected' | 'evergreen';

export interface LearningEntry {
  id: string;
  type: LearningType;
  cohort_id: string | null;
  status: LearningStatus;
  created_at: string;       // ISO
  updated_at: string;       // ISO
  date_file: string;        // YYYY-MM-DD
  summary: string;          // first ~140 chars of body, single-line
}

export interface LearningsIndex {
  version: 1;
  entries: LearningEntry[];
}

const INDEX_VERSION = 1 as const;

export class LearningsAgentError extends Error {
  constructor(agent: string) {
    super(
      `Only the performance-monitor agent may append marketing learnings (got agent="${agent}"). ` +
      `Set MARKETING_LEARNINGS_AGENT_OVERRIDE=1 to bypass for tests.`,
    );
    this.name = 'LearningsAgentError';
  }
}

export class LearningNotFoundError extends Error {
  constructor(id: string) {
    super(`Learning entry "${id}" not found.`);
    this.name = 'LearningNotFoundError';
  }
}

// ─── Atomic write ────────────────────────────────────────────────────────────

function atomicWriteFile(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

// ─── Id helpers ──────────────────────────────────────────────────────────────

export function newLearningId(type: LearningType): string {
  return type === 'ledger' ? `led_${idgen()}` : `rec_${idgen()}`;
}

export function todayDateString(now: Date = new Date()): string {
  // UTC YYYY-MM-DD so date_file is consistent across machines
  return now.toISOString().slice(0, 10);
}

// ─── Index I/O ───────────────────────────────────────────────────────────────

export function loadIndex(): LearningsIndex {
  const path = MARKETING_PATHS.learningsIndex();
  if (!existsSync(path)) {
    return { version: INDEX_VERSION, entries: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LearningsIndex>;
    if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.entries)) {
      return { version: INDEX_VERSION, entries: [] };
    }
    return parsed as LearningsIndex;
  } catch {
    return { version: INDEX_VERSION, entries: [] };
  }
}

function saveIndex(index: LearningsIndex): void {
  atomicWriteFile(MARKETING_PATHS.learningsIndex(), JSON.stringify(index, null, 2) + '\n');
}

// ─── Per-day .md I/O ─────────────────────────────────────────────────────────

export function loadByDate(date: string): string | null {
  const path = MARKETING_PATHS.learningsFile(date);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function renderEntryBlock(entry: LearningEntry, body: string): string {
  const time = entry.created_at.slice(11, 16); // HH:MM
  const titleType = entry.type === 'ledger' ? 'Hypothesis ledger' : 'Recommendation';
  const cohortTag = entry.cohort_id ? ` (${entry.cohort_id})` : '';
  const meta = [
    `id=${entry.id}`,
    `type=${entry.type}`,
    `cohort=${entry.cohort_id ?? ''}`,
    `status=${entry.status}`,
    `created_at=${entry.created_at}`,
    `updated_at=${entry.updated_at}`,
  ].join(' ');
  return [
    `<!-- entry ${meta} -->`,
    `## ${time} UTC — ${titleType}${cohortTag}`,
    '',
    body.trimEnd(),
    '',
    `<!-- /entry -->`,
    '',
  ].join('\n');
}

function ensureDailyHeader(date: string, existing: string | null): string {
  const header = `# Marketing learnings — ${date}\n\n`;
  if (!existing || !existing.startsWith('# Marketing learnings')) {
    return header;
  }
  return existing;
}

function appendToDayFile(entry: LearningEntry, body: string): void {
  const path = MARKETING_PATHS.learningsFile(entry.date_file);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const base = ensureDailyHeader(entry.date_file, existing);
  const block = renderEntryBlock(entry, body);
  const next = existing && existing.startsWith('# Marketing learnings')
    ? (existing.endsWith('\n') ? existing + block : existing + '\n' + block)
    : base + block;
  atomicWriteFile(path, next);
}

function rewriteDayFileForStatusUpdate(
  oldEntry: LearningEntry,
  newEntry: LearningEntry,
): void {
  const path = MARKETING_PATHS.learningsFile(oldEntry.date_file);
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  const re = new RegExp(
    `<!-- entry ([^>]*?id=${escapeRegExp(oldEntry.id)}[^>]*) -->`,
  );
  const m = text.match(re);
  if (!m) return;
  const oldMeta = m[1] ?? '';
  const newMeta = oldMeta
    .replace(/status=\S+/, `status=${newEntry.status}`)
    .replace(/updated_at=\S+/, `updated_at=${newEntry.updated_at}`);
  const updated = text.replace(m[0], `<!-- entry ${newMeta} -->`);
  atomicWriteFile(path, updated);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface AppendOpts {
  type: LearningType;
  cohort_id?: string | null;
  body: string;
  agent: string;
  /** Override clock for tests. */
  now?: Date;
}

export function appendLearning(opts: AppendOpts): LearningEntry {
  if (
    opts.agent !== 'performance-monitor' &&
    process.env.MARKETING_LEARNINGS_AGENT_OVERRIDE !== '1'
  ) {
    throw new LearningsAgentError(opts.agent);
  }
  if (!opts.body.trim()) {
    throw new Error('Learning body must be non-empty.');
  }
  const now = opts.now ?? new Date();
  const id = newLearningId(opts.type);
  const status: LearningStatus = opts.type === 'ledger' ? 'evergreen' : 'pending';
  const date_file = todayDateString(now);
  const iso = now.toISOString();
  const entry: LearningEntry = {
    id,
    type: opts.type,
    cohort_id: opts.cohort_id ?? null,
    status,
    created_at: iso,
    updated_at: iso,
    date_file,
    summary: makeSummary(opts.body),
  };

  // 1. Append to per-day .md (human source of truth)
  appendToDayFile(entry, opts.body);

  // 2. Update sidecar index
  const index = loadIndex();
  index.entries.push(entry);
  saveIndex(index);

  return entry;
}

export function setStatus(
  id: string,
  status: LearningStatus,
  now: Date = new Date(),
): LearningEntry {
  const index = loadIndex();
  const i = index.entries.findIndex((e) => e.id === id);
  if (i === -1) throw new LearningNotFoundError(id);
  const old = index.entries[i]!;
  if (old.type === 'ledger' && status !== 'evergreen') {
    throw new Error(`Ledger entries are evergreen; cannot set status=${status}.`);
  }
  if (old.type === 'recommendation' && status === 'evergreen') {
    throw new Error(`Recommendations cannot be set to status=evergreen.`);
  }
  const updated: LearningEntry = {
    ...old,
    status,
    updated_at: now.toISOString(),
  };
  index.entries[i] = updated;
  saveIndex(index);
  rewriteDayFileForStatusUpdate(old, updated);
  return updated;
}

export interface ListPendingOpts {
  /** Only return entries created at least this many milliseconds ago. */
  olderThanMs?: number;
  /** Override clock for tests. */
  now?: Date;
}

export function listPending(opts: ListPendingOpts = {}): LearningEntry[] {
  const now = opts.now ?? new Date();
  const threshold = opts.olderThanMs ?? 0;
  const index = loadIndex();
  return index.entries.filter((e) => {
    if (e.type !== 'recommendation') return false;
    if (e.status !== 'pending') return false;
    const ageMs = now.getTime() - new Date(e.created_at).getTime();
    return ageMs >= threshold;
  });
}

export function findEntry(id: string): LearningEntry | null {
  const index = loadIndex();
  return index.entries.find((e) => e.id === id) ?? null;
}

function makeSummary(body: string): string {
  const single = body.replace(/\s+/g, ' ').trim();
  return single.length > 140 ? single.slice(0, 137) + '...' : single;
}
