/**
 * dedup-log — the read AND write path for `.embeddings/dedup-log.jsonl`, the
 * append-only record of every semantic dedup decision (one JSON object per
 * line), summarized into the sleep cycle summary (AC7).
 *
 * WHY THE WRITER LIVES HERE NOW. It used to be a private `logDedupDecision`
 * inside `src/cli/commands/embed.ts`, and this module declared itself
 * "report-only: never writes". That held while `embed dedup` was the only
 * writer. The task-filing bar is a SECOND one — a sleep-filed task records its
 * nearest-neighbor verdict here so `sleep done`'s "Semantic dedup since epoch"
 * digest covers task creates too. Two writers of one JSONL format living in two
 * different files is exactly how a format drifts away from the reader that has
 * to keep parsing it, so the writer moved next to the reader.
 *
 * BOTH DIRECTIONS ARE BEST-EFFORT BY DESIGN. The caller has already made its
 * decision by the time it reaches here; a log line lost to an unwritable disk
 * must never fail a dedup check or a task create.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DedupVerdict } from './dedup.js';

/** Machine-local, credential-class directory the log shares with the vector cache. */
const LOG_DIR = '.embeddings';

export interface DedupLogEntry {
  ts: string;
  title: string;
  verdict: 'merge' | 'review' | 'create';
  topDocKey?: string;
  topSim?: number;
}

/**
 * One decision as a WRITER hands it over.
 *
 * `ts` is deliberately absent: {@link appendDedupLogEntry} stamps it, so two
 * writers can never disagree about the clock the `since` filter compares
 * against.
 *
 * Everything past `verdict` is optional and additive — {@link summarizeDedupLog}
 * keys only on `ts` + `verdict` and ignores unknown fields, so a new field never
 * forces a reader change and an older log stays readable.
 */
export interface DedupLogWrite {
  /** The candidate's identity anchor — a doc title, or a task name. */
  title: string;
  verdict: DedupVerdict;
  /** Corpus type the candidate was checked against; `task` for filing-bar writes. */
  type?: string;
  /** The slug that was created, when the decision led to one. */
  slug?: string;
  /** Which writer produced the line. */
  source?: 'embed-cli' | 'filing-bar';
  topDocKey?: string | null;
  topSim?: number | null;
  mergeThreshold?: number;
  reviewThreshold?: number;
  neighbors?: Array<{ docKey: string; sim: number }>;
  /** Set when a REVIEW band was cleared by naming the neighbor (`--neighbor-checked`). */
  neighborChecked?: string;
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
 *  the SAME root {@link appendDedupLogEntry} writes against, so the reader and
 *  the writer can never point at two different files. */
export function dedupLogPath(contextRoot: string): string {
  return join(contextRoot, LOG_DIR, 'dedup-log.jsonl');
}

/**
 * Append one decision to the log, stamping `ts` at write time.
 *
 * Creates the directory and its self-ignoring `.gitignore` first: the whole
 * `.embeddings/` tree is credential-class (vectors are partially invertible) and
 * must never reach a repo — project or brain. Same treatment `store.saveCache`
 * gives the vector cache beside it.
 *
 * NEVER THROWS — see the module note. The failure is still surfaced under
 * `DREAMCONTEXT_DEBUG` rather than vanishing silently.
 */
export function appendDedupLogEntry(contextRoot: string, entry: DedupLogWrite): void {
  try {
    const dir = join(contextRoot, LOG_DIR);
    mkdirSync(dir, { recursive: true });
    const ignorePath = join(dir, '.gitignore');
    if (!existsSync(ignorePath)) {
      appendFileSync(ignorePath, '*\n');
    }
    // `ts` first, so the on-disk line keeps the shape every earlier log already
    // has. `DedupLogWrite` carries no `ts` of its own, so the stamp always wins.
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(dedupLogPath(contextRoot), line + '\n');
  } catch (err) {
    if (process.env.DREAMCONTEXT_DEBUG) {
      console.error(`[dedup-log] append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
