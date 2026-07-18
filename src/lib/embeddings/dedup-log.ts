/**
 * dedup-log — reads and summarizes `.embeddings/dedup-log.jsonl` for the sleep
 * cycle summary (AC7). Semantic dedup decisions land in this file (written by
 * `embed.ts`'s `logDedupDecision`, one JSON object per line) and nobody reads
 * them back today — this module is that read path. Report-only: never writes
 * the log.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DedupLogEntry {
  ts: string;
  title: string;
  verdict: 'merge' | 'review' | 'create';
  topDocKey?: string;
  topSim?: number;
}

export interface DedupDigest {
  merge: number;
  review: number;
  create: number;
  total: number;
  since: string | null;
}

const VALID_VERDICTS = new Set(['merge', 'review', 'create']);

/** Path to the dedup verdict log. `contextRoot` is the `_dream_context` root —
 *  the SAME root `embed.ts`'s writer joins against (verified: `join(root, '.embeddings')`). */
export function dedupLogPath(contextRoot: string): string {
  return join(contextRoot, '.embeddings', 'dedup-log.jsonl');
}

function zeroDigest(since: string | null): DedupDigest {
  return { merge: 0, review: 0, create: 0, total: 0, since };
}

/**
 * Tally verdicts from raw JSONL content. `since` is a strict lower bound
 * (`ts > since`, not `>=`) — an entry stamped exactly at the epoch does not
 * count as "since" it. `since: null` counts everything. Malformed/truncated
 * lines and unrecognized verdicts are skipped silently; this never throws.
 */
export function summarizeDedupLog(raw: string, since: string | null): DedupDigest {
  const digest = zeroDigest(since);

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;

    const entry = parsed as Record<string, unknown>;
    const verdict = typeof entry.verdict === 'string' ? entry.verdict : '';
    if (!VALID_VERDICTS.has(verdict)) continue;

    const ts = typeof entry.ts === 'string' ? entry.ts : '';
    if (since !== null && !(ts > since)) continue;

    digest[verdict as 'merge' | 'review' | 'create']++;
    digest.total++;
  }

  return digest;
}

/** Read + summarize the on-disk log. Missing file or unreadable → zeroed digest. */
export function readDedupDigest(contextRoot: string, since: string | null): DedupDigest {
  const filePath = dedupLogPath(contextRoot);
  if (!existsSync(filePath)) return zeroDigest(since);
  try {
    return summarizeDedupLog(readFileSync(filePath, 'utf-8'), since);
  } catch {
    return zeroDigest(since);
  }
}

/** One-line digest for the sleep cycle summary. */
export function renderDedupDigest(d: DedupDigest): string {
  return `Semantic dedup since epoch: ${d.merge} merge / ${d.review} review / ${d.create} create (${d.total} decisions).`;
}
