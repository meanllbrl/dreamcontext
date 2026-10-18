import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJournal } from '../task-journal.js';
import { listAudit } from '../task-audit.js';
import { sleepEvalRoot } from './types.js';

/**
 * Reasoned exemptions from the sleep-eval close gate (owner decision 2026-10-18,
 * scope card item 3): the eval runs only for the sub-tasks that change what
 * sleep files or learns; the others close through an exemption that names its
 * reason, recorded where the gate reads it, on the task's journal and in the
 * task audit.
 *
 * The store is NOT the source of trust. An entry opens the gate only when the
 * child's journal holds the matching `status: sleep eval exempt` entry with the
 * same reason AND the task audit holds an `exempt` record with the same journal
 * id. A hand-written `exemptions.json` line grants nothing: every other owner
 * override in the task system has a trail that can be checked, and so does
 * this one.
 */

export const EXEMPT_JOURNAL_LABEL = 'sleep eval exempt';

export interface Exemption {
  child: string;
  parent: string;
  reason: string;
  by: string;
  at: string;
  journalId: string;
}

export function exemptionsPath(contextRoot: string): string {
  return join(sleepEvalRoot(contextRoot), 'exemptions.json');
}

/** One line, whitespace collapsed: the form stored, journaled and compared. */
export function normalizeExemptReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim();
}

/** The journal body an exemption writes, and the one `exemptionFor` requires. */
export function exemptJournalBody(reason: string): string {
  return `- exempt from the sleep eval close gate: ${normalizeExemptReason(reason)}`;
}

function isExemption(e: unknown): e is Exemption {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return typeof x.child === 'string'
    && typeof x.parent === 'string'
    && typeof x.reason === 'string' && normalizeExemptReason(x.reason).length > 0
    && typeof x.by === 'string'
    && typeof x.at === 'string'
    && typeof x.journalId === 'string' && x.journalId.length > 0;
}

/** Every stored entry with a reason and a journal id. Missing or unreadable reads as none. */
export function readExemptions(contextRoot: string): Exemption[] {
  const p = exemptionsPath(contextRoot);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { exemptions?: unknown };
    return Array.isArray(parsed?.exemptions) ? parsed.exemptions.filter(isExemption) : [];
  } catch {
    return [];
  }
}

function writeAll(contextRoot: string, list: Exemption[]): void {
  const p = exemptionsPath(contextRoot);
  mkdirSync(sleepEvalRoot(contextRoot), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, exemptions: list }, null, 2) + '\n', 'utf-8');
  renameSync(tmp, p);
}

/** Store one exemption, replacing any earlier one for the same child. */
export function writeExemption(contextRoot: string, e: Exemption): void {
  writeAll(contextRoot, [...readExemptions(contextRoot).filter((x) => x.child !== e.child), e]);
}

/** Rollback only: drop the child's entry. */
export function removeExemption(contextRoot: string, child: string): void {
  const all = readExemptions(contextRoot);
  if (!all.some((x) => x.child === child)) return;
  writeAll(contextRoot, all.filter((x) => x.child !== child));
}

/**
 * The exemption that opens the gate for `child`, or null. All three must agree:
 * the stored entry, the child's journal entry (kind `status`, label
 * {@link EXEMPT_JOURNAL_LABEL}, the same reason) and an `exempt` audit record
 * for the child with the same journal id.
 */
export function exemptionFor(contextRoot: string, child: string): Exemption | null {
  const ex = readExemptions(contextRoot).find((x) => x.child === child);
  if (!ex) return null;
  let journaled = false;
  try {
    const entry = readJournal(join(contextRoot, 'state'), child).find((j) => j.id === ex.journalId);
    journaled = !!entry
      && entry.kind === 'status'
      && entry.label === EXEMPT_JOURNAL_LABEL
      && entry.body.trim() === exemptJournalBody(ex.reason);
  } catch {
    journaled = false;
  }
  if (!journaled) return null;
  const audited = listAudit(contextRoot, { kinds: ['exempt'] })
    .some((a) => a.slug === child && a.journalId === ex.journalId);
  return audited ? ex : null;
}
