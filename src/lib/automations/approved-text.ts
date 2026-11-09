import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { AutomationManifest } from './types.js';

/**
 * THE LAST APPROVED TEXT of every run target, kept on this Mac (owner 2026-11-08): a teammate's
 * synced change, or risky text a background run wrote, no longer stops a member. It keeps running
 * on what the owner approved last; the new version waits for his card.
 *
 * Content-addressed by the approval hash (`manifestSha256`): one file per approved version,
 * `~/.dreamcontext/approved-texts/<sha256>.json`, holding exactly the manifest fields the hash is
 * computed over (`canonicalApprovalPayload`). Machine-local, never synced, mode 0600. It is never
 * trusted on its own: the registry re-hashes the overlaid manifest and uses it only when that hash
 * IS the stored approval (`approvedTarget`), so a tampered or stale file can only fail closed.
 *
 * A file for an entry written before this existed is absent: that member keeps the old rule (it
 * waits) until the owner approves it once.
 */

/** Every manifest field `canonicalApprovalPayload` reads. Absent values are stored as null, which
 *  hashes exactly as absent (each optional field is omitted when falsy or null). */
export const APPROVED_TEXT_KEYS = [
  'prompt', 'outputInstructions', 'model', 'effort', 'timeoutMinutes', 'outputDir', 'learning',
  'review', 'mode', 'flow', 'whiteboard', 'job', 'soul', 'autonomy', 'readTools', 'fallbackTools',
  'tool', 'app', 'boardOnly', 'appTools', 'target', 'reply',
] as const;

export type ApprovedText = Partial<Pick<AutomationManifest, (typeof APPROVED_TEXT_KEYS)[number]>>;

const HASH_RE = /^[0-9a-f]{64}$/;
/** Far above any real manifest; a bigger file is not ours. */
const MAX_BYTES = 2 * 1024 * 1024;

export function approvedTextsDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'approved-texts');
}

/** The hashed fields of `m`, exactly as they stand. */
export function approvedTextOf(m: AutomationManifest): ApprovedText {
  const out: Record<string, unknown> = {};
  const src = m as unknown as Record<string, unknown>;
  for (const k of APPROVED_TEXT_KEYS) out[k] = src[k] === undefined ? null : src[k];
  return out as ApprovedText;
}

/** Keep the approved text of `hash`. Best effort: a failed write leaves the old rule (wait). */
export function saveApprovedText(hash: string, m: AutomationManifest, home?: string): void {
  if (!HASH_RE.test(hash)) return;
  try {
    const dir = approvedTextsDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* best effort */ }
    const path = join(dir, `${hash}.json`);
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(approvedTextOf(m)), { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* the member then waits for its card, as before */ }
}

/** The approved text stored for `hash`, or null (absent, a symlink, too big, unreadable). */
export function readApprovedText(hash: string, home?: string): ApprovedText | null {
  if (!HASH_RE.test(hash)) return null;
  const path = join(approvedTextsDir(home), `${hash}.json`);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_BYTES) return null;
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out: Record<string, unknown> = {};
    for (const k of APPROVED_TEXT_KEYS) out[k] = (raw as Record<string, unknown>)[k] ?? null;
    return out as ApprovedText;
  } catch {
    return null;
  }
}

/** Overlay an approved text on the current manifest: everything unhashed (title, schedule,
 *  enabled, owner…) stays current; everything the approval covers is what was approved. */
export function overlayApprovedText(m: AutomationManifest, text: ApprovedText): AutomationManifest {
  const out = { ...m } as Record<string, unknown>;
  for (const k of APPROVED_TEXT_KEYS) {
    const v = (text as Record<string, unknown>)[k];
    // A field the manifest type keeps as `undefined` when absent reads back as null: both hash as absent.
    out[k] = v === null && (m as unknown as Record<string, unknown>)[k] === undefined ? undefined : v;
  }
  return out as unknown as AutomationManifest;
}

/** Drop every stored text no approval names any more (`keep`: the hashes still in the registry). */
export function pruneApprovedTexts(keep: ReadonlySet<string>, home?: string): void {
  let names: string[];
  try { names = readdirSync(approvedTextsDir(home)); } catch { return; }
  for (const name of names) {
    const hash = name.endsWith('.json') ? name.slice(0, -5) : '';
    // Only whole texts: a `.tmp` is another writer's file mid-rename.
    if (!HASH_RE.test(hash) || keep.has(hash)) continue;
    try { unlinkSync(join(approvedTextsDir(home), name)); } catch { /* next prune */ }
  }
}
