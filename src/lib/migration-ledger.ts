import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single entry in the per-clone migration ledger.
 * executor 'code'     — deterministic step ran and wrote files.
 * executor 'detected' — step found content already in final state (no writes).
 * executor 'agent'    — written by `dreamcontext migrations record` after an
 *                       agent completed the agentTask for this version.
 */
export interface LedgerEntry {
  version: string;
  step: string;
  executor: 'code' | 'agent' | 'detected';
  timestamp: string; // ISO 8601
  filesTouched: string[];
  summary: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LEDGER_REL_PATH = 'state/.migrations.json';

function ledgerPath(contextRoot: string): string {
  return join(contextRoot, LEDGER_REL_PATH);
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read the migration ledger from disk.
 * Returns [] on any error (missing file, malformed JSON, non-array).
 * Never throws.
 */
export function readLedger(contextRoot: string): LedgerEntry[] {
  const path = ledgerPath(contextRoot);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as LedgerEntry[];
  } catch {
    return [];
  }
}

// ─── Write (ATOMIC) ───────────────────────────────────────────────────────────

/**
 * Write the ledger ATOMICALLY: write to a tmp file alongside the ledger,
 * then rename into place. Protects against partial writes from power/crash.
 */
export function writeLedger(contextRoot: string, entries: LedgerEntry[]): void {
  const path = ledgerPath(contextRoot);
  const tmp = path + '.tmp';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

/**
 * Append a single entry to the ledger (atomic write).
 */
export function appendLedger(contextRoot: string, entry: LedgerEntry): void {
  const entries = readLedger(contextRoot);
  // Deduplicate by (version, step): guards against concurrent runners (e.g. a
  // SessionStart hook firing while `update` runs) both reading a stale ledger
  // and appending the same entry, and against accidental re-records.
  if (isApplied(entries, entry.version, entry.step)) return;
  entries.push(entry);
  writeLedger(contextRoot, entries);
}

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Returns true if the given (version, step) pair already has an entry in the
 * provided ledger array (regardless of executor).
 */
export function isApplied(
  ledger: LedgerEntry[],
  version: string,
  step: string,
): boolean {
  return ledger.some((e) => e.version === version && e.step === step);
}
