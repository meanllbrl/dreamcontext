import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
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
export const MAX_ENTRIES = 5;
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_FIELD_BYTES = 4 * 1024;
const LOCK_NAME = '.super-handoff';
const TRUNCATED = ' …(kısaltıldı)';
const HEADING = '# Super Agent devri';
const ENTRY_RE = /^## .* — Handoff$/m;

export function superHandoffPath(contextRoot: string): string {
  return join(contextRoot, SUPER_HANDOFF_REL);
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
  const head = `---\ntype: super-handoff\nupdated: "${updated}"\n---\n\n${HEADING}\n\nThe Super Agent's handoff, newest first. A fresh super session reads the top entry first, then runs \`dreamcontext super state\`.\n`;
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
function ensureSuperDir(contextRoot: string): string {
  const stateDir = join(contextRoot, 'state');
  const dir = dirname(superHandoffPath(contextRoot));
  if (existsSync(stateDir) && !lstatSync(stateDir).isDirectory()) throw new Error('state is not a directory');
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) throw new Error('state/.super is not a directory');
  if (!existsSync(dir)) {
    const comment = 'dreamcontext: the Super Agent\'s machine-local handoff file';
    try { ensureGitignoreEntries(dirname(contextRoot), ['_dream_context/state/.super/'], { comment }); } catch { /* best effort */ }
    try { if (existsSync(join(contextRoot, '.gitignore'))) ensureGitignoreEntries(contextRoot, ['state/.super/'], { comment }); } catch { /* best effort */ }
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Read the file, or null when there is none (or it cannot be read). */
export function readSuperHandoff(contextRoot: string): string | null {
  try { return readFileSync(superHandoffPath(contextRoot), 'utf-8'); } catch { return null; }
}

/**
 * Prepend one entry (or several, oldest last, for the one-time migration) and write the file
 * under the lock. Returns the path written.
 */
export function writeSuperHandoff(contextRoot: string, newEntries: readonly string[], now: Date = new Date()): string {
  const path = superHandoffPath(contextRoot);
  const entries = newEntries.map((e) => e.replace(/\r\n?/g, '\n').trim());
  for (const e of entries) {
    if (parseSuperHandoffEntries(e).length !== 1 || !e.startsWith('## ')) {
      throw new Error('a handoff entry must be ONE "## <time> — Handoff" block (render it with renderSuperHandoffEntry)');
    }
  }
  return withTaskFileLock(contextRoot, LOCK_NAME, () => {
    ensureSuperDir(contextRoot);
    const existing = existsSync(path) ? parseSuperHandoffEntries(readFileSync(path, 'utf-8')) : [];
    const text = renderSuperHandoffFile([...entries, ...existing], now.toISOString());
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, text, 'utf-8');
    renameSync(tmp, path);
    return path;
  });
}
