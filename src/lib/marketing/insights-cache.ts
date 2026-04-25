/**
 * Insights snapshot cache — 15-min TTL per task contract (PR 2 line 596).
 *
 * Layout under _dream_context/marketing/insights/:
 *   <campaign_id>__<YYYY-MM-DD-HH>.json   ← hour-bucketed snapshot
 *   _index.json                            ← latest-snapshot pointer per entity
 *
 * Read path: getCachedInsights(entity_id) — returns snapshot if <15min old.
 * Write path: saveInsightsSnapshot(entity_id, data) — atomic write + index update.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MARKETING_PATHS } from './paths.js';

export const INSIGHTS_TTL_MS = 15 * 60 * 1000;

export interface InsightsSnapshot {
  entity_id: string;
  level: 'campaign' | 'adset' | 'ad';
  pulled_at: string;          // ISO timestamp
  since: string;              // window e.g. 'last_7d', '24h', 'today'
  data: unknown;              // raw Meta /insights response
}

export interface SnapshotIndex {
  // entity_id → last snapshot filename
  latest: Record<string, string>;
  updated_at: string;
}

// ─── Filename helpers ────────────────────────────────────────────────────────

function snapshotFilename(entityId: string, pulledAt: Date): string {
  const yyyy = pulledAt.getUTCFullYear();
  const mm = String(pulledAt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(pulledAt.getUTCDate()).padStart(2, '0');
  const hh = String(pulledAt.getUTCHours()).padStart(2, '0');
  // Sanitize entity_id (Meta IDs can have only digits + underscores; safe enough).
  const safe = entityId.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safe}__${yyyy}-${mm}-${dd}-${hh}.json`;
}

function indexPath(): string {
  return join(MARKETING_PATHS.insightsDir(), '_index.json');
}

function readIndex(): SnapshotIndex {
  const p = indexPath();
  if (!existsSync(p)) return { latest: {}, updated_at: '1970-01-01T00:00:00Z' };
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SnapshotIndex;
  } catch {
    return { latest: {}, updated_at: '1970-01-01T00:00:00Z' };
  }
}

function writeIndex(idx: SnapshotIndex): void {
  const p = indexPath();
  mkdirSync(MARKETING_PATHS.insightsDir(), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(idx, null, 2) + '\n', 'utf8');
  // atomic rename
  require('node:fs').renameSync(tmp, p);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function saveInsightsSnapshot(snap: InsightsSnapshot): string {
  mkdirSync(MARKETING_PATHS.insightsDir(), { recursive: true });
  const filename = snapshotFilename(snap.entity_id, new Date(snap.pulled_at));
  const fullPath = join(MARKETING_PATHS.insightsDir(), filename);
  const tmp = `${fullPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(snap, null, 2) + '\n', 'utf8');
  require('node:fs').renameSync(tmp, fullPath);

  // Update index
  const idx = readIndex();
  idx.latest[snap.entity_id] = filename;
  idx.updated_at = new Date().toISOString();
  writeIndex(idx);

  return fullPath;
}

export function getCachedInsights(entityId: string): InsightsSnapshot | null {
  const idx = readIndex();
  const filename = idx.latest[entityId];
  if (!filename) return null;
  const fullPath = join(MARKETING_PATHS.insightsDir(), filename);
  if (!existsSync(fullPath)) return null;
  try {
    const snap = JSON.parse(readFileSync(fullPath, 'utf8')) as InsightsSnapshot;
    const ageMs = Date.now() - new Date(snap.pulled_at).getTime();
    if (ageMs > INSIGHTS_TTL_MS) return null;
    return snap;
  } catch {
    return null;
  }
}

/**
 * Return the latest snapshot regardless of TTL (for `mk insights show` and
 * `mk diff` which need to compare across time windows).
 */
export function getLatestSnapshot(entityId: string): InsightsSnapshot | null {
  const idx = readIndex();
  const filename = idx.latest[entityId];
  if (!filename) return null;
  const fullPath = join(MARKETING_PATHS.insightsDir(), filename);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(readFileSync(fullPath, 'utf8')) as InsightsSnapshot;
  } catch {
    return null;
  }
}

/**
 * Return the snapshot N positions before the latest, for diff comparisons.
 * Used by `mk diff --since 24h`.
 */
export function getPriorSnapshot(entityId: string, beforeMs: number): InsightsSnapshot | null {
  const dir = MARKETING_PATHS.insightsDir();
  if (!existsSync(dir)) return null;
  const safe = entityId.replace(/[^A-Za-z0-9_-]/g, '_');
  const candidates = readdirSync(dir)
    .filter((f) => f.startsWith(`${safe}__`) && f.endsWith('.json'))
    .map((f) => {
      const p = join(dir, f);
      const stat = statSync(p);
      return { f, p, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Find the most recent snapshot strictly older than (now - beforeMs)
  const cutoff = Date.now() - beforeMs;
  for (const c of candidates) {
    if (c.mtimeMs <= cutoff) {
      try {
        return JSON.parse(readFileSync(c.p, 'utf8')) as InsightsSnapshot;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** List entities with at least one cached snapshot. */
export function listEntitiesWithSnapshots(): string[] {
  const idx = readIndex();
  return Object.keys(idx.latest);
}
