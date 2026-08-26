import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { safeChildPath } from '../server/safe-path.js';

/**
 * PEER MAIL — the write half of federation.
 *
 * Federation's read half (`federation-recall.ts`) lets a vault SEARCH a connected
 * peer's corpus. This is the other direction: one vault ADDRESSES another — a
 * note, a question, or a command — and the peer answers with its OWN brain, from
 * its OWN directory, even while that project is otherwise asleep.
 *
 * Deliberately NOT the parked digest inbox (`federation-inbox.ts`). That carries
 * *derived knowledge copies* (the thing that broke SSoT and got retired); this
 * carries *addressed messages*, which are correspondence — they are supposed to
 * be duplicated on both ends of a conversation, and they never materialise as
 * knowledge files. Same disk neighbourhood, different contract, separate dir.
 *
 * STORE: `<contextRoot>/state/.peer-mail/<id>.json`, one file per message, with
 * `archive/` underneath for closed threads. A message file lives in the vault it
 * was addressed TO — sending is a write into the PEER's mail dir — and a reply is
 * a second message written back into the original sender's mail dir, carrying the
 * same `thread`. Both sides therefore hold the full thread locally, which is what
 * makes `peer thread <id>` work offline and makes a sleeping vault's inbox
 * readable without touching the sender.
 *
 * Unlike the digest inbox, a message is mutated IN PLACE (status transitions)
 * rather than moved to `consumed/` on read: a thread has to stay addressable by
 * id for its whole life, and `answered` is a state, not a disposal.
 */

/**
 * Peer-mail schema version. A message whose MAJOR version exceeds this is
 * QUARANTINED on read — surfaced, never applied — so a newer sender can never
 * feed an older receiver a shape it will misread (same rule as the digest inbox).
 */
export const PEER_MAIL_SCHEMA_VERSION = 1;

/**
 * What the sender wants of the receiver. The kind is not decoration — it decides
 * delivery (see `peer-delivery.ts`) and how the receiving agent is briefed:
 *
 * - `note`     — FYI. Deferred by default: it waits in the inbox and surfaces in
 *                the peer's next SessionStart snapshot. No spawn, no token cost.
 * - `question` — Wants an answer. Delivered LIVE by default: spawns a headless
 *                run in the peer's root, and the answer comes back as a reply.
 * - `command`  — Wants work done. Live, and the ONLY kind that may modify the
 *                peer's repo — always under `auto` permissions, never bypass.
 */
export type PeerMessageKind = 'note' | 'question' | 'command';

/**
 * - `pending`  — delivered into the mailbox, not yet looked at.
 * - `read`     — the receiving agent has seen it (a note's terminal-ish state).
 * - `answered` — a reply was sent back on this thread.
 * - `done`     — closed by either side; eligible for archiving.
 */
export type PeerMessageStatus = 'pending' | 'read' | 'answered' | 'done';

/** How the message reached (or will reach) the receiving agent. */
export type PeerDeliveryMode = 'deferred' | 'live';

export interface PeerMessage {
  /** Schema version of THIS message (compared against PEER_MAIL_SCHEMA_VERSION). */
  version: number;
  /** Sortable unique id: `<epochMillis>-<8 hex>`. Also the filename stem. */
  id: string;
  /** Root message id of the conversation. A root message's thread === its own id. */
  thread: string;
  /** Registered vault name of the sender. */
  from: string;
  /** Registered vault name of the receiver (the vault this file lives in). */
  to: string;
  kind: PeerMessageKind;
  /** The message text, control-stripped and length-capped by {@link sanitizeBody}. */
  body: string;
  createdAt: string;
  /** Id of the message this replies to; `null` for a thread root. */
  replyTo: string | null;
  status: PeerMessageStatus;
  delivery: PeerDeliveryMode;
  /**
   * Claude conversation id of the headless run that handled this message, once
   * one exists. This is what lets the UI re-attach to a peer session — and what
   * lets the user keep typing into the session that answered them.
   */
  sessionId: string | null;
}

const MAIL_REL = join('state', '.peer-mail');
const ARCHIVE_DIRNAME = 'archive';

/**
 * Hard cap on a message body, matching the chat spawn's `MAX_PROMPT_CHARS`. A
 * message becomes the initial prompt of a headless run, so the two limits must
 * agree or a message that stores fine would fail to deliver.
 */
export const MAX_BODY_CHARS = 8000;

/** Absolute path to a context root's peer-mail directory. */
export function mailDir(contextRoot: string): string {
  return join(contextRoot, MAIL_REL);
}

/** Absolute path to a context root's archived-mail sub-directory. */
export function mailArchiveDir(contextRoot: string): string {
  return join(mailDir(contextRoot), ARCHIVE_DIRNAME);
}

/** Create the mail directory tree if absent. Idempotent. */
export function ensureMail(contextRoot: string): void {
  mkdirSync(mailArchiveDir(contextRoot), { recursive: true });
}

/**
 * Strip anything that would corrupt the message downstream and cap the length.
 *
 * The body is eventually passed to `claude` as a positional argv element, so the
 * same rules as `sanitizePrompt` apply and for the same reasons: a NUL truncates
 * a C argument, and a bare CR/LF would submit a partial line in the readline
 * paths. Everything else — quotes, backticks, `$(…)` — is inert, because the
 * value is a real execve argument and is never interpolated into a shell string.
 */
export function sanitizeBody(raw: string): string {
  return String(raw ?? '')
    // Collapse first: a bare strip would FUSE the words around a newline/tab.
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, MAX_BODY_CHARS)
    .trim();
}

/**
 * Mint a message id. Time-prefixed so a plain filename sort is chronological
 * (the inbox listing depends on this), with random suffix so two messages minted
 * in the same millisecond — a fan-out to several peers — never collide.
 */
export function newMessageId(now: number = Date.now()): string {
  return `${now}-${randomBytes(4).toString('hex')}`;
}

/** True iff `id` is a well-formed message id — the only shape allowed in a path. */
export function isMessageId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]{10,17}-[0-9a-f]{8}$/.test(v);
}

function isPeerMessage(raw: unknown): raw is PeerMessage {
  if (raw === null || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.version === 'number' &&
    isMessageId(o.id) &&
    typeof o.thread === 'string' &&
    typeof o.from === 'string' &&
    typeof o.to === 'string' &&
    typeof o.kind === 'string' &&
    typeof o.body === 'string'
  );
}

/** Major component of a (possibly non-integer) version number. */
function majorOf(version: number): number {
  return Math.floor(Number.isFinite(version) ? version : 0);
}

export interface ComposeInput {
  from: string;
  to: string;
  kind: PeerMessageKind;
  body: string;
  /** Thread to continue. Omit for a new thread (the message becomes its own root). */
  thread?: string | null;
  replyTo?: string | null;
  delivery?: PeerDeliveryMode;
}

/**
 * Build a well-formed message. Pure — mints the id and stamps the clock but
 * touches no disk, so the delivery layer can decide where (or whether) it lands.
 */
export function composeMessage(input: ComposeInput, now: Date = new Date()): PeerMessage {
  const id = newMessageId(now.getTime());
  return {
    version: PEER_MAIL_SCHEMA_VERSION,
    id,
    thread: input.thread ?? id,
    from: input.from,
    to: input.to,
    kind: input.kind,
    body: sanitizeBody(input.body),
    createdAt: now.toISOString(),
    replyTo: input.replyTo ?? null,
    status: 'pending',
    delivery: input.delivery ?? (input.kind === 'note' ? 'deferred' : 'live'),
    sessionId: null,
  };
}

export interface WriteMailResult {
  written: boolean;
  path: string | null;
  /** Populated when the write was refused, for the caller to report verbatim. */
  reason?: string;
}

/**
 * Write a message into a mailbox — the ONE mail write that crosses a vault
 * boundary (the sender writes into the RECEIVER's `.peer-mail/`).
 *
 * SECURITY: the filename derives from a machine-minted id validated by
 * {@link isMessageId} and is resolved through {@link safeChildPath}, so nothing
 * a caller supplies can steer the write out of the mail directory. A malformed
 * id aborts the write rather than falling back to a sanitised guess — an id we
 * did not mint means the message did not come from this code path.
 *
 * Ids are unique by construction, so distinct concurrent senders never target
 * the same file and no lock is required. An existing target means a genuine
 * id collision or a re-delivery, and is refused rather than overwritten.
 */
export function writeMessage(mailboxContextRoot: string, msg: PeerMessage): WriteMailResult {
  if (!isMessageId(msg.id)) {
    return { written: false, path: null, reason: `refusing to write malformed message id "${msg.id}"` };
  }
  const target = safeChildPath(mailDir(mailboxContextRoot), `${msg.id}.json`);
  if (target === null) {
    return { written: false, path: null, reason: 'refusing unsafe mail path' };
  }
  ensureMail(mailboxContextRoot);
  if (existsSync(target)) {
    return { written: false, path: target, reason: 'a message with this id already exists' };
  }
  writeFileSync(target, JSON.stringify(msg, null, 2) + '\n', 'utf-8');
  return { written: true, path: target };
}

/** Absolute path of a message file in a mailbox, or null if the id is unusable. */
export function messagePath(contextRoot: string, id: string, archived = false): string | null {
  if (!isMessageId(id)) return null;
  const base = archived ? mailArchiveDir(contextRoot) : mailDir(contextRoot);
  return safeChildPath(base, `${id}.json`);
}

/**
 * Read one message by id, searching live mail then the archive. Returns null for
 * an unknown, malformed, or unreadable message — never throws.
 */
export function readMessage(contextRoot: string, id: string): PeerMessage | null {
  for (const archived of [false, true]) {
    const path = messagePath(contextRoot, id, archived);
    if (!path || !existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      if (isPeerMessage(parsed)) return parsed;
    } catch {
      // fall through — an unreadable file is reported as absent
    }
  }
  return null;
}

export interface ListMailOptions {
  /** Restrict to these statuses (default: all non-archived). */
  status?: PeerMessageStatus[];
  /** Restrict to one thread. */
  thread?: string;
  /** Restrict to correspondence with one peer, in either direction. */
  peer?: string;
  /** Include the archive in the scan (default false). */
  includeArchived?: boolean;
}

/**
 * List messages in a mailbox, newest LAST (chronological — a thread reads top to
 * bottom). Version-incompatible and malformed files are skipped and reported by
 * {@link quarantinedMail} rather than silently dropped here. Never throws.
 */
export function listMessages(contextRoot: string, opts: ListMailOptions = {}): PeerMessage[] {
  const dirs = [mailDir(contextRoot)];
  if (opts.includeArchived) dirs.push(mailArchiveDir(contextRoot));

  const out: PeerMessage[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.json'))
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      let msg: PeerMessage;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
        if (!isPeerMessage(parsed)) continue;
        msg = parsed;
      } catch {
        continue;
      }
      if (majorOf(msg.version) > PEER_MAIL_SCHEMA_VERSION) continue;
      if (opts.status && !opts.status.includes(msg.status)) continue;
      if (opts.thread && msg.thread !== opts.thread) continue;
      if (opts.peer && msg.from !== opts.peer && msg.to !== opts.peer) continue;
      out.push(msg);
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Messages this vault has not yet looked at. The inbox, in the ordinary sense. */
export function listPending(contextRoot: string): PeerMessage[] {
  return listMessages(contextRoot, { status: ['pending'] });
}

/**
 * Every message on a thread, chronological. Includes the archive, because a
 * thread stays readable after it is closed.
 */
export function readThread(contextRoot: string, thread: string): PeerMessage[] {
  return listMessages(contextRoot, { thread, includeArchived: true });
}

/**
 * Cheap count of PENDING messages. The only mail read permitted on the snapshot
 * hot path: one `readdirSync` plus a parse per file, no peer resolution, no
 * corpus build. Returns 0 when the mailbox does not exist.
 */
export function pendingMailCount(contextRoot: string): number {
  return listPending(contextRoot).length;
}

/**
 * Files in the mailbox this reader cannot apply — a future major schema, or a
 * shape that failed validation. Surfaced by `peer inbox` so an incompatible
 * message is visible rather than mysteriously missing.
 */
export function quarantinedMail(contextRoot: string): Array<{ file: string; reason: string }> {
  const dir = mailDir(contextRoot);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: Array<{ file: string; reason: string }> = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      if (!isPeerMessage(parsed)) {
        out.push({ file, reason: 'unrecognised message shape' });
      } else if (majorOf(parsed.version) > PEER_MAIL_SCHEMA_VERSION) {
        out.push({
          file,
          reason: `schema v${parsed.version} (this vault reads v${PEER_MAIL_SCHEMA_VERSION})`,
        });
      }
    } catch {
      out.push({ file, reason: 'unreadable JSON' });
    }
  }
  return out;
}

/**
 * Patch a message in place. Only the mutable lifecycle fields are patchable —
 * identity, addressing, and body are immutable once written, so a status update
 * can never quietly rewrite what was said. Returns the updated message, or null
 * if it does not exist.
 */
export function updateMessage(
  contextRoot: string,
  id: string,
  patch: Partial<Pick<PeerMessage, 'status' | 'sessionId' | 'delivery'>>,
): PeerMessage | null {
  const existing = readMessage(contextRoot, id);
  if (!existing) return null;
  const archived = !existsSync(messagePath(contextRoot, id) ?? '');
  const path = messagePath(contextRoot, id, archived);
  if (!path) return null;

  const next: PeerMessage = {
    ...existing,
    status: patch.status ?? existing.status,
    sessionId: patch.sessionId !== undefined ? patch.sessionId : existing.sessionId,
    delivery: patch.delivery ?? existing.delivery,
  };
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return next;
}

/**
 * Move a closed message into `archive/`. Atomic via `renameSync` (same
 * filesystem), so an archived message is never seen twice. A missing source
 * (already archived) is reported false, not thrown.
 */
export function archiveMessage(contextRoot: string, id: string): boolean {
  const from = messagePath(contextRoot, id);
  const to = messagePath(contextRoot, id, true);
  if (!from || !to || !existsSync(from)) return false;
  ensureMail(contextRoot);
  try {
    renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}
