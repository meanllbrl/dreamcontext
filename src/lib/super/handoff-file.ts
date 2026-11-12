import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, sep } from 'node:path';
import { HANDOFF_FIELDS, type HandoffFields } from '../handoff-readiness.js';
import { withTaskFileLock } from '../task-file-lock.js';
import { ensureGitignoreEntries } from '../gitignore.js';

/**
 * The Super Agent's own handoff record — ONE file, never a task (owner 2026-10-22: "Super
 * agent'a task açılmamalı; o başka bir dosya olmalı"). The super's state used to land in a
 * "coordination task" the nudge found by regex, which put the coordinator's notes on the task
 * board beside the work it coordinates.
 *
 * `state/.super/handoff.md` lives in a DIRECTORY under `state/` on purpose: every scanner that
 * treats `state/*.md` as tasks (the task backend, hard-refresh, recall's task index) reads the
 * top level only, so the file can never show up as a task. It is machine-local like
 * `state/.super-agent.json` (it names this machine's sessions and worktrees): both lists in
 * `git-sync/brain-repo.ts` carry `state/.super/`.
 *
 * Newest entry first, at most {@link MAX_ENTRIES} entries and {@link MAX_FILE_BYTES}; each field
 * is capped at {@link MAX_FIELD_BYTES} UTF-8 bytes (never splitting a character), so one entry
 * always fits and the cap is always reached by dropping the OLDEST entries — the newest is never
 * dropped. Every entry written must read back as exactly one entry (a block the parser would drop
 * on the next write is refused, never silently lost). Writes hold a per-file lock (the task-file
 * lock, keyed by a name no task slug can take), refuse a symlinked `state/` or `state/.super/`, and
 * land by temp file + rename.
 */

export const SUPER_HANDOFF_REL = join('state', '.super', 'handoff.md');
/** The record's `task` value: a path stem, so an older reader's generic "read state/<task>.md"
 *  still sends the fresh session to the right file. */
export const SUPER_HANDOFF_TASK = '.super/handoff';

/** A member Super's handoff record `task` (plan-r10 1): its own file's path stem under `state/`. */
export const MEMBER_HANDOFF_TASK_RE = /^\.super\/members\/([a-z0-9][a-z0-9-]{0,99})\.handoff$/;

/** The record `task` of a super's handoff: main's `.super/handoff`, a member's
 *  `.super/members/<slug>.handoff` (so `state/<task>.md` is always that super's own file). */
export function superHandoffTask(superId: string = 'main'): string {
  return superId.startsWith('m:') ? `.super/members/${superId.slice(2)}.handoff` : SUPER_HANDOFF_TASK;
}

/** The file a super handoff record names, project-relative with `/` (main's for anything else). */
export function superHandoffFileOf(task: string): string {
  const own = MEMBER_HANDOFF_TASK_RE.test(task) ? `state/${task}.md` : SUPER_HANDOFF_REL.split('\\').join('/');
  return `_dream_context/${own}`;
}
export const MAX_ENTRIES = 5;
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_FIELD_BYTES = 4 * 1024;
const LOCK_NAME = '.super-handoff';
const TRUNCATED = ' …(kısaltıldı)';
const HEADING = '# Super Agent devri';
const ENTRY_RE = /^## .* — Handoff$/m;

/** Main's file (SUPER_HANDOFF_REL), or a member Super's beside its record (plan-r10 1):
 *  `state/.super/members/<slug>.handoff.md`. `superId` is `main` or `m:<slug>` (the slug checked
 *  by whoever resolved the super). */
export function superHandoffPath(contextRoot: string, superId: string = 'main'): string {
  if (superId === 'main' || !superId.startsWith('m:')) return join(contextRoot, SUPER_HANDOFF_REL);
  return join(contextRoot, 'state', '.super', 'members', `${superId.slice(2)}.handoff.md`);
}

const clean = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

function capField(s: string): string {
  if (Buffer.byteLength(s, 'utf-8') <= MAX_FIELD_BYTES) return s;
  const budget = MAX_FIELD_BYTES - Buffer.byteLength(TRUNCATED, 'utf-8');
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf-8');
    if (bytes + n > budget) break;
    out += ch;
    bytes += n;
  }
  return out + TRUNCATED;
}

/** One entry: the six handoff parts, each capped. `at` is an ISO timestamp. */
export function renderSuperHandoffEntry(at: string, fields: HandoffFields, note?: string): string {
  const lines = [`## ${at} — Handoff`];
  for (const f of HANDOFF_FIELDS) lines.push(`- **${f.label}:** ${capField(clean(fields[f.key]))}`);
  const extra = clean(note);
  if (extra) lines.push(`- **Note:** ${capField(extra)}`);
  return lines.join('\n');
}

/** The entries of an existing file, newest first (each a `## … — Handoff` block). */
export function parseSuperHandoffEntries(text: string): string[] {
  const body = text.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '');
  const starts: number[] = [];
  const re = new RegExp(ENTRY_RE.source, 'gm');
  for (let m = re.exec(body); m; m = re.exec(body)) starts.push(m.index);
  return starts.map((s, i) => body.slice(s, i + 1 < starts.length ? starts[i + 1] : undefined).trim()).filter(Boolean);
}

/** The whole file for `entries` (newest first), trimmed to the caps by dropping the oldest. */
export function renderSuperHandoffFile(entries: readonly string[], updated: string): string {
  const head = `---\ntype: super-handoff\nupdated: "${updated}"\n---\n\n${HEADING}\n\nThe Super Agent's handoff, newest first. A fresh super session reads the top entry first, then runs \`dreamcontext super state --brief\` (children and queue; plain \`super state\` adds cards and machine facts).\n`;
  let kept = entries.slice(0, MAX_ENTRIES);
  const render = () => `${head}\n${kept.join('\n\n')}\n`;
  let out = render();
  while (kept.length > 1 && Buffer.byteLength(out, 'utf-8') > MAX_FILE_BYTES) {
    kept = kept.slice(0, -1);
    out = render();
  }
  return out;
}

/**
 * `state/.super/` for writing. A committed symlink (gitignore stops only UNTRACKED files) must not
 * redirect the write outside the vault: a `state` or `.super` that is not a real directory is
 * refused. On first creation the local-only line is ensured where the vault's ignore file lives
 * (best-effort): the project's `.gitignore`, and the brain repo's own `_dream_context/.gitignore`
 * when it has one, so a vault set up before this file existed never commits it.
 */
function ensureSuperDir(contextRoot: string, superId: string = 'main'): string {
  const stateDir = join(contextRoot, 'state');
  const dir = dirname(superHandoffPath(contextRoot));
  const own = dirname(superHandoffPath(contextRoot, superId));
  if (existsSync(stateDir) && !lstatSync(stateDir).isDirectory()) throw new Error('state is not a directory');
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) throw new Error('state/.super is not a directory');
  if (!existsSync(dir)) {
    const comment = 'dreamcontext: the Super Agent\'s machine-local handoff file';
    try { ensureGitignoreEntries(dirname(contextRoot), ['_dream_context/state/.super/'], { comment }); } catch { /* best effort */ }
    try { if (existsSync(join(contextRoot, '.gitignore'))) ensureGitignoreEntries(contextRoot, ['state/.super/'], { comment }); } catch { /* best effort */ }
    mkdirSync(dir, { recursive: true });
  }
  // A member's file lives one folder down: never through a link.
  if (own !== dir) {
    if (existsSync(own) && !lstatSync(own).isDirectory()) throw new Error('state/.super/members is not a directory');
    if (!existsSync(own)) mkdirSync(own, { recursive: true, mode: 0o700 });
  }
  return own;
}

// ─── Approved texts that have not gone out (learning-loop plan C10, D16c) ──────────────────

/**
 * A text the owner approved and that has not gone out yet (a message, a post, a release note) is
 * saved by the Super as one file here when he approves it, and removed once the send is
 * confirmed. A handoff once carried only the id of such a message, and the next session spent 7
 * tool calls digging its text out of old transcripts; so every entry the handoff writes lists the
 * folder by itself, not by the Super remembering to.
 *
 * A file can be stale (the session ended between the send and the removal, or he sent the text
 * himself), so a line never says "waiting to be sent": it says the send is not confirmed. A file
 * older than {@link APPROVED_EXPIRE_MS} moves to `approved/expired/` and is no longer listed.
 * The folder is main's: a member Super's handoff lists nothing from it.
 * Machine-local like the rest of `state/.super/`; a symlinked `state`, `.super`, `approved` or
 * file is refused (listed as nothing), and the folder must resolve inside the vault.
 */
export const SUPER_APPROVED_REL = join('state', '.super', 'approved');
export const APPROVED_EXPIRED_DIR = 'expired';
export const APPROVED_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many files are named; the rest are counted on one line. */
export const MAX_APPROVED_LINES = 8;
/** A file's first line is shown up to this many characters. */
export const APPROVED_FIRST_LINE_CHARS = 120;
/** How much of a file is read to find its first line. */
const APPROVED_HEAD_BYTES = 4 * 1024;
const APPROVED_LABEL = 'Onaylı metin';

const isRealDir = (p: string): boolean => {
  const st = lstatSync(p, { throwIfNoEntry: false });
  return !!st && !st.isSymbolicLink() && st.isDirectory();
};

/** The first non-empty line of a file, read from its head only, one line, capped. */
function firstLineOf(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(APPROVED_HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n).toString('utf-8').replace(/�+$/, '');
    const line = head.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').replace(/`/g, "'").trim()).find(Boolean) ?? '';
    const chars = Array.from(line);
    return chars.length > APPROVED_FIRST_LINE_CHARS ? `${chars.slice(0, APPROVED_FIRST_LINE_CHARS).join('')}…` : line;
  } finally {
    closeSync(fd);
  }
}

/** Move one expired file out of the listing; a failed move only means it is not listed. */
function expireApproved(dir: string, name: string, now: Date): void {
  try {
    const expired = join(dir, APPROVED_EXPIRED_DIR);
    if (!existsSync(expired)) mkdirSync(expired, { mode: 0o700 });
    if (!isRealDir(expired)) return;
    const target = existsSync(join(expired, name)) ? `${name}.${now.getTime()}` : name;
    renameSync(join(dir, name), join(expired, target));
  } catch { /* left in place, still not listed */ }
}

/**
 * The handoff lines for `state/.super/approved/`, newest first: path, first line, and that the
 * send is not confirmed. Expired files are moved to `approved/expired/`. Empty when the folder is
 * missing, empty, or refused. Never throws: a handoff is never lost to this folder.
 */
export function approvedTextLines(contextRoot: string, now: Date = new Date()): string[] {
  try {
    const stateDir = join(contextRoot, 'state');
    const superDir = join(stateDir, '.super');
    const dir = join(contextRoot, SUPER_APPROVED_REL);
    if (!isRealDir(stateDir) || !isRealDir(superDir) || !isRealDir(dir)) return [];
    const root = realpathSync(contextRoot);
    if (!realpathSync(dir).startsWith(root + sep)) return [];

    const files: { name: string; mtimeMs: number }[] = [];
    for (const name of readdirSync(dir)) {
      if (name === APPROVED_EXPIRED_DIR || name.startsWith('.')) continue;
      const st = lstatSync(join(dir, name), { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink() || !st.isFile()) continue;
      if (now.getTime() - st.mtimeMs > APPROVED_EXPIRE_MS) { expireApproved(dir, name, now); continue; }
      files.push({ name, mtimeMs: st.mtimeMs });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));

    const lines: string[] = [];
    let bytes = 0;
    const reserve = 200; // room for the "more" line
    for (const f of files) {
      if (lines.length >= MAX_APPROVED_LINES) break;
      const shown = f.name.replace(/[\r\n`]/g, '_');
      let first = '';
      try { first = firstLineOf(join(dir, f.name)); } catch { continue; }
      const date = new Date(f.mtimeMs).toISOString().slice(0, 10);
      const line = `- **${APPROVED_LABEL}:** \`_dream_context/state/.super/approved/${shown}\`${first ? `: "${first}"` : ''} (onaylandı ${date}, gönderildiği doğrulanmadı: göndermeden önce kanala bak)`;
      const n = Buffer.byteLength(line, 'utf-8') + 1;
      if (bytes + n > MAX_FIELD_BYTES - reserve) break;
      lines.push(line);
      bytes += n;
    }
    const more = files.length - lines.length;
    if (more > 0) lines.push(`- **${APPROVED_LABEL}:** ${more} dosya daha, \`_dream_context/state/.super/approved/\` içinde (gönderildiği doğrulanmadı)`);
    return lines;
  } catch {
    return [];
  }
}

/** Read the file, or null when there is none (or it cannot be read). */
export function readSuperHandoff(contextRoot: string, superId: string = 'main'): string | null {
  try {
    const path = superHandoffPath(contextRoot, superId);
    if (lstatSync(path).isSymbolicLink()) return null;
    return readFileSync(path, 'utf-8');
  } catch { return null; }
}

/**
 * Prepend one entry (or several, oldest last, for the one-time migration) and write the file
 * under the lock. Returns the path written.
 */
export function writeSuperHandoff(contextRoot: string, newEntries: readonly string[], now: Date = new Date(), superId: string = 'main'): string {
  const path = superHandoffPath(contextRoot, superId);
  const entries = newEntries.map((e) => e.replace(/\r\n?/g, '\n').trim());
  for (const e of entries) {
    if (parseSuperHandoffEntries(e).length !== 1 || !e.startsWith('## ')) {
      throw new Error('a handoff entry must be ONE "## <time> — Handoff" block (render it with renderSuperHandoffEntry)');
    }
  }
  return withTaskFileLock(contextRoot, LOCK_NAME, () => {
    ensureSuperDir(contextRoot, superId);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('the handoff file is a symlink');
    const existing = existsSync(path) ? parseSuperHandoffEntries(readFileSync(path, 'utf-8')) : [];
    // Derived, never remembered: every entry written names the approved texts not confirmed sent.
    // The folder is main's: a member Super's handoff lists nothing from it.
    const approved = superId.startsWith('m:') ? [] : approvedTextLines(contextRoot, now);
    const written = approved.length ? entries.map((e) => `${e}\n${approved.join('\n')}`) : entries;
    const text = renderSuperHandoffFile([...written, ...existing], now.toISOString());
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, text, 'utf-8');
    renameSync(tmp, path);
    return path;
  });
}
