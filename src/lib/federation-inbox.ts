import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { safeChildPath } from '../server/safe-path.js';

/**
 * Federation digest schema version. A digest entry whose MAJOR version exceeds
 * this is QUARANTINED on drain — left in place, reported, never applied — so a
 * future, incompatible sender can never corrupt an older receiver (P3.10). Only
 * the major component gates compatibility; minor/patch bumps stay applicable.
 */
export const DIGEST_SCHEMA_VERSION = 1;

/** The kinds of knowledge a digest entry can carry. */
export type DigestEntryKind = 'decision' | 'changelog' | 'knowledge' | 'conflict-note';

/**
 * Provenance for an ingested entry. Stamped into the receiving doc's frontmatter
 * as `origin{…}` so a federated doc always points back at where it came from
 * (and a third vault can recognise + EXCLUDE it from onward serving).
 */
export interface DigestOrigin {
  /** Registered name of the SENDER vault. */
  vault: string;
  /** Stable id of the source doc within the sender vault (`<type>/<slug>@<date>`). */
  entryId: string;
  /** The source doc's `updatedAt` (ISO-ish) at the time the digest was built. */
  sourceTimestamp: string | null;
}

/**
 * One unit of federated knowledge written into a peer's inbox directory as a
 * single JSON file. The file is the dedup key (see {@link inboxFilename}).
 */
export interface DigestEntry {
  /** Schema version of THIS entry (compared against DIGEST_SCHEMA_VERSION). */
  version: number;
  /** Globally-stable id: `<originVault>:<entryId>` — also drives the filename. */
  id: string;
  origin: DigestOrigin;
  kind: DigestEntryKind;
  title: string;
  summary: string;
  /** Sender-side recall/relevance score (informational; not re-ranked here). */
  recallScore: number;
  /** Relative paths into the SOURCE vault (pointers, never resolved by us). */
  links: string[];
}

const INBOX_REL = join('state', '.federation-inbox');
const CONSUMED_DIRNAME = 'consumed';

/** Absolute path to a context root's inbox directory. */
export function inboxDir(contextRoot: string): string {
  return join(contextRoot, INBOX_REL);
}

/** Absolute path to a context root's consumed/ sub-directory. */
export function consumedDir(contextRoot: string): string {
  return join(inboxDir(contextRoot), CONSUMED_DIRNAME);
}

/**
 * Create the inbox directory tree (`.federation-inbox/` + `consumed/`) if it is
 * absent. Idempotent — safe to call on every drain/sync/migration.
 */
export function ensureInbox(contextRoot: string): void {
  mkdirSync(consumedDir(contextRoot), { recursive: true });
}

/**
 * Sanitise one path component to the `[a-zA-Z0-9._-]` alphabet AND defeat any
 * `..` traversal: every disallowed char becomes `_`, and any run of dots of
 * length ≥ 2 is collapsed to a single dot so `..` / `...` can never survive as a
 * parent-directory token. Empty input → `_` (never an empty component).
 */
function sanitizeComponent(part: string): string {
  const cleaned = String(part)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    // Collapse any 2+ dot run to a single dot — defeats `..`, `...`, `a..b`.
    .replace(/\.{2,}/g, '.');
  return cleaned.length > 0 ? cleaned : '_';
}

/**
 * Build the inbox filename for an entry: `<origin>-<entryId>.json`, with BOTH
 * components sanitised to `[a-zA-Z0-9._-]` and `..` collapsed. The filename IS
 * the dedup key: re-sending the same (origin, entryId) targets the same file,
 * which the write-if-absent in {@link writeInboxEntry} then skips (P3.5/P3.6).
 */
export function inboxFilename(origin: string, entryId: string): string {
  return `${sanitizeComponent(origin)}-${sanitizeComponent(entryId)}.json`;
}

export interface WriteInboxResult {
  /** True iff a new file was created; false when an identical filename existed (dedup). */
  written: boolean;
  /** Absolute path of the target file (even when not written). */
  path: string | null;
}

/**
 * Write a digest entry into a PEER's inbox (the only inbox WRITE in the system).
 *
 * SECURITY (binding amendment 1): the target path is constructed via
 * {@link safeChildPath} rooted at the peer's `.federation-inbox/`, so a crafted
 * origin/entryId can never escape the inbox. If `safeChildPath` returns null the
 * write is ABORTED and logged (defence in depth on top of the sanitiser).
 *
 * Concurrency: the filename is a deterministic dedup key and the write is
 * "if-absent" (skip when the file already exists). Distinct entries get distinct
 * filenames, so N concurrent senders writing different entries never collide and
 * never lose data — no lockfile required (P3.6). Re-sending the SAME entry is a
 * no-op (`written:false`) — the cycle guard (P3.5).
 */
export function writeInboxEntry(peerContextRoot: string, entry: DigestEntry): WriteInboxResult {
  const baseDir = inboxDir(peerContextRoot);
  const filename = inboxFilename(entry.origin.vault, entry.origin.entryId);
  const target = safeChildPath(baseDir, filename);
  if (target === null) {
    console.error(
      `[dreamcontext] federation: refusing unsafe inbox path for entry "${entry.id}" ` +
        `(origin=${entry.origin.vault}, entryId=${entry.origin.entryId}) — aborted.`,
    );
    return { written: false, path: null };
  }

  ensureInbox(peerContextRoot);

  // Write-if-absent = filename dedup = concurrency-safe (unique names never race).
  if (existsSync(target)) {
    return { written: false, path: target };
  }
  writeFileSync(target, JSON.stringify(entry, null, 2) + '\n', 'utf-8');
  return { written: true, path: target };
}

/** A quarantined entry: its major version is incompatible (P3.10). */
export interface QuarantinedEntry {
  /** Filename (left in place, NOT consumed). */
  file: string;
  /** Absolute path (still in the inbox root). */
  path: string;
  version: number;
}

export interface DrainResult {
  /** Applicable entries, each tagged with its source filename (for consume). */
  entries: Array<{ file: string; path: string; entry: DigestEntry }>;
  /** Version-incompatible entries left in place for the user to inspect. */
  quarantined: QuarantinedEntry[];
}

/** Major component of a (possibly non-integer) version number. */
function majorOf(version: number): number {
  return Math.floor(Number.isFinite(version) ? version : 0);
}

function isDigestEntry(raw: unknown): raw is DigestEntry {
  if (raw === null || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.version === 'number' &&
    typeof o.id === 'string' &&
    typeof o.kind === 'string' &&
    typeof o.title === 'string' &&
    o.origin !== null &&
    typeof o.origin === 'object'
  );
}

/**
 * Read every pending entry from the inbox root (NOT consumed/). For each file:
 *   - malformed JSON / wrong shape → skipped + logged (never crashes the drain);
 *   - major version > DIGEST_SCHEMA_VERSION → QUARANTINED (left in place);
 *   - otherwise collected into `entries` for ingestion.
 *
 * The consumed/ sub-directory is excluded from the scan so re-draining never
 * re-reads already-applied entries.
 */
export function drainInbox(contextRoot: string): DrainResult {
  const dir = inboxDir(contextRoot);
  const result: DrainResult = { entries: [], quarantined: [] };
  if (!existsSync(dir)) return result;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    console.error(`[dreamcontext] federation: cannot read inbox at ${dir}: ${String(err)}`);
    return result;
  }

  for (const file of files) {
    const path = join(dir, file);
    let entry: DigestEntry;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      if (!isDigestEntry(parsed)) {
        console.error(`[dreamcontext] federation: skipping malformed inbox entry "${file}".`);
        continue;
      }
      entry = parsed;
    } catch (err) {
      console.error(
        `[dreamcontext] federation: skipping unreadable inbox entry "${file}": ${String(err)}`,
      );
      continue;
    }

    if (majorOf(entry.version) > DIGEST_SCHEMA_VERSION) {
      console.error(
        `[dreamcontext] federation: quarantining "${file}" — incompatible schema v${entry.version} ` +
          `(reader supports v${DIGEST_SCHEMA_VERSION}). Left in place, not applied.`,
      );
      result.quarantined.push({ file, path, version: entry.version });
      continue;
    }

    result.entries.push({ file, path, entry });
  }

  return result;
}

/**
 * Move a drained entry file into consumed/. Uses `renameSync` (atomic on the
 * same filesystem) so a consumed entry is never re-drained, and the consumed
 * copy preserves provenance for the inbox view (P3.8). Idempotent enough: a
 * missing source (already consumed) is logged, not thrown.
 */
export function consumeEntry(contextRoot: string, filename: string): void {
  ensureInbox(contextRoot);
  const from = join(inboxDir(contextRoot), filename);
  const to = join(consumedDir(contextRoot), filename);
  try {
    renameSync(from, to);
  } catch (err) {
    console.error(
      `[dreamcontext] federation: could not consume inbox entry "${filename}": ${String(err)}`,
    );
  }
}

/**
 * Cheap count of PENDING inbox entries (excludes consumed/). The ONLY inbox read
 * permitted on the snapshot hot path: a single local `readdirSync`, NO peer
 * resolution, NO corpus build. Returns 0 when the inbox does not exist.
 */
export function pendingInboxCount(contextRoot: string): number {
  const dir = inboxDir(contextRoot);
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(
      (d) => d.isFile() && d.name.endsWith('.json'),
    ).length;
  } catch {
    return 0;
  }
}

/** List consumed entries (for the dashboard inbox view, P3.8). Never throws. */
export function listConsumedEntries(contextRoot: string): DigestEntry[] {
  const dir = consumedDir(contextRoot);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: DigestEntry[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      if (isDigestEntry(parsed)) out.push(parsed);
    } catch {
      // skip unreadable
    }
  }
  return out;
}

/** List pending (un-consumed, applicable + quarantined) entries for the inbox view. */
export function listPendingEntries(contextRoot: string): DigestEntry[] {
  const { entries } = drainInbox(contextRoot);
  return entries.map((e) => e.entry);
}
