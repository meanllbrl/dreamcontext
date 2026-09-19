import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensureGitignoreEntries } from './gitignore.js';
import { defaultGitTrackedCheck, gitIgnoresPath, type GitTrackedCheck } from './git-tracked.js';

/**
 * The dotenv writer behind the Chat surface's `dream-view` SECRET card — the one path in
 * this codebase where a credential the user typed is written to disk WITHOUT passing
 * through the agent.
 *
 * Why it exists at all. The pinned checklist's `wants:'secret'` field submits its value as
 * markdown into the conversation, and says so on its face ("Sent to the agent and stored in
 * this conversation's transcript"). That was a deliberate, documented trade — the checklist
 * walks the user through a procedure in ANOTHER app and hands the result back as text. It
 * is the wrong trade for "paste your Firebase token": the value's destination is a file, the
 * agent never needs to read it, and a transcript the CLI persists under `~/.claude/projects`
 * is somewhere it can never be un-written. So this module takes the value from the request
 * body straight to the file, and the agent is told only a RECEIPT (see `secretReceipt`).
 *
 * Every refusal here is a `SecretWriteError` with a code the card can render as a sentence.
 * None of them ever carries the value, and neither does any log line in this file — there
 * are none, on purpose.
 *
 * ORDERING GUARANTEE (copied verbatim in intent from `task-backend/secrets.ts`, which has
 * carried it since issue #11): the ignore entry is in place BEFORE the file is written, and
 * a failure to place it aborts the write. A secret may never exist on disk without its
 * ignore entry, not even transiently.
 */

/** A dotenv KEY: the grammar every dotenv parser agrees on. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Where a secret may be written: a `.env`-family file, optionally inside a subdirectory of
 * the project (`functions/.env` is a real Firebase layout). The basename carries the whole
 * safety argument — anything named `.env`/`.env.<suffix>` is a file whose entire purpose is
 * to hold secrets and to be ignored by git, so writing one is never a surprise. A path with
 * `..` in it cannot match, and the realpath containment below is what actually enforces it.
 */
export const SECRET_FILE_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/){0,3}\.env(?:\.[A-Za-z0-9_-]{1,32})?$/;

export const DEFAULT_SECRET_FILE = '.env';

/** Longest value we will write. Generous for a JWT/service-account blob, bounded so the
 *  field is not a file-upload surface wearing a text input. */
export const MAX_SECRET_VALUE_CHARS = 8192;
/** Most keys one card may carry. A card asking for more than this is a form, not a hand-off. */
export const MAX_SECRET_FIELDS = 8;

export type SecretWriteCode =
  | 'bad_file'
  | 'bad_key'
  | 'empty_value'
  | 'value_too_long'
  | 'no_entries'
  | 'too_many_entries'
  | 'escapes_root'
  | 'symlink'
  | 'not_a_file'
  | 'tracked'
  | 'gitignore_failed'
  | 'write_failed';

export class SecretWriteError extends Error {
  constructor(readonly code: SecretWriteCode, message: string) {
    super(message);
    this.name = 'SecretWriteError';
  }
}

export interface SecretEntry {
  key: string;
  value: string;
}

export interface SecretWritten {
  key: string;
  /** Character count of the value, so the receipt can prove something real landed. */
  chars: number;
  /** First 8 hex of sha256(value) — enough to compare two pastes, useless to an attacker. */
  fingerprint: string;
  action: 'added' | 'updated';
  /** The key already appeared more than once in the file; the LAST (effective) line was the
   *  one rewritten and the earlier duplicates were left exactly where they were. */
  duplicate?: true;
}

export interface SecretWriteResult {
  /** Project-relative, as written (`.env`, `functions/.env`). */
  file: string;
  written: SecretWritten[];
  /** The `.gitignore` line this write added, when it had to add one. */
  gitignoreAdded?: string;
}

// ── dotenv serialization ────────────────────────────────────────────────────────────────

/** Values that need no quoting: no whitespace, no quote, no `#`, no shell-ish byte. */
const BARE_VALUE_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Render `value` as the right-hand side of a dotenv assignment. Bare when it is boring,
 * double-quoted with escapes otherwise — double quotes because that is the only dotenv
 * form that can carry a newline (`\n`), and a pasted PEM or service-account key has them.
 */
export function formatEnvValue(value: string): string {
  if (BARE_VALUE_RE.test(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/** An assignment line for `key`, with or without a leading `export`. */
function assignmentRe(key: string): RegExp {
  return new RegExp(`^(\\s*)(export\\s+)?${key}\\s*=`);
}

/**
 * Upsert `entries` into dotenv `content`, returning the new content plus what happened to
 * each key. PURE — no filesystem, so the interesting half is unit-testable without a repo.
 *
 * Replace-the-LAST-occurrence, never the first: dotenv parsers assign line by line, so when
 * a file holds the same key twice it is the last line that wins. Rewriting the first would
 * leave the user looking at their new value in an editor while their app kept reading the
 * old one — a silent wrong answer, which is the worst outcome available here. Earlier
 * duplicates are left untouched (this function edits, it does not tidy) and reported.
 *
 * A leading `export ` and the line's indentation are preserved: the file is the user's, and
 * a writer that reformats lines it did not have to touch is a writer people stop trusting.
 */
export function upsertEnvContent(
  content: string,
  entries: SecretEntry[],
): { content: string; written: SecretWritten[] } {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  // A trailing newline in the source leaves an empty last element; hold it aside so the
  // rewrite cannot quietly add or drop the file's final blank line.
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (hadTrailingNewline) lines.pop();

  const written: SecretWritten[] = [];
  for (const { key, value } of entries) {
    const re = assignmentRe(key);
    let lastHit = -1;
    let hits = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith('#')) continue; // a commented-out key is not an assignment
      if (re.test(line)) { lastHit = i; hits++; }
    }
    const rendered = formatEnvValue(value);
    const entryOut: SecretWritten = {
      key,
      chars: value.length,
      fingerprint: createHash('sha256').update(value, 'utf-8').digest('hex').slice(0, 8),
      action: lastHit >= 0 ? 'updated' : 'added',
    };
    if (hits > 1) entryOut.duplicate = true;
    if (lastHit >= 0) {
      const m = assignmentRe(key).exec(lines[lastHit]);
      const indent = m?.[1] ?? '';
      const exported = m?.[2] ? 'export ' : '';
      lines[lastHit] = `${indent}${exported}${key}=${rendered}`;
    } else {
      lines.push(`${key}=${rendered}`);
    }
    written.push(entryOut);
  }

  return { content: lines.join(eol) + eol, written };
}

// ── Validation ──────────────────────────────────────────────────────────────────────────

/** The project-relative secret file, validated. Throws `SecretWriteError('bad_file')`. */
export function normalizeSecretFile(raw: unknown): string {
  const file = typeof raw === 'string' ? raw.trim().replace(/^\.\//, '') : '';
  if (!file) return DEFAULT_SECRET_FILE;
  if (isAbsolute(file) || file.includes('..') || file.includes('\\') || !SECRET_FILE_RE.test(file)) {
    throw new SecretWriteError(
      'bad_file',
      'A secret can only be written to a .env-family file inside the project (".env", ".env.local", "functions/.env").',
    );
  }
  return file;
}

/** Validate the entries array as it arrived over the wire. Throws on anything unusable —
 *  a half-written card is worse than a refused one, so this is all-or-nothing. */
export function normalizeSecretEntries(raw: unknown): SecretEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SecretWriteError('no_entries', 'No secret was submitted.');
  }
  if (raw.length > MAX_SECRET_FIELDS) {
    throw new SecretWriteError('too_many_entries', `A secret card carries at most ${MAX_SECRET_FIELDS} keys.`);
  }
  const out: SecretEntry[] = [];
  for (const item of raw) {
    const key = typeof (item as { key?: unknown })?.key === 'string' ? (item as { key: string }).key.trim() : '';
    const value = typeof (item as { value?: unknown })?.value === 'string' ? (item as { value: string }).value : '';
    if (!ENV_KEY_RE.test(key)) {
      throw new SecretWriteError('bad_key', `"${key.slice(0, 40)}" is not a valid environment variable name.`);
    }
    // Trimmed, because a token pasted from a terminal almost always carries a trailing
    // newline and nobody means to store it — but only the ENDS, never the middle (a PEM's
    // internal newlines are load-bearing).
    const trimmed = value.trim();
    if (!trimmed) throw new SecretWriteError('empty_value', `${key} was left empty.`);
    if (trimmed.length > MAX_SECRET_VALUE_CHARS) {
      throw new SecretWriteError('value_too_long', `${key} is longer than ${MAX_SECRET_VALUE_CHARS} characters.`);
    }
    out.push({ key, value: trimmed });
  }
  return out;
}

// ── The write ───────────────────────────────────────────────────────────────────────────

/** Is `child` the same as, or inside, `parent`? Both must already be realpaths. */
function contains(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Write `entries` into `<projectRoot>/<file>`, creating the file when it does not exist.
 *
 * The guards, in the order they run and each for its own reason:
 *
 *  1. **Grammar** — the path is a `.env`-family file under the project (see
 *     {@link SECRET_FILE_RE}). Rejects `..` and absolute paths before any syscall.
 *  2. **Containment by REALPATH, and no symlinked leaf.** `realpath` the parent directory
 *     and require it inside the realpath'd project root, then `lstat` the file itself and
 *     refuse a symlink. This is the project's standing ★★★ rule for any path that reads or
 *     writes vault content, and it matters MORE here than on the read side: a planted
 *     `.env -> ~/.ssh/authorized_keys` would make this route an arbitrary-file OVERWRITE.
 *  3. **Not tracked by git.** A secret written into a tracked file is a secret one `git
 *     commit -a` away from being published, and this module cannot un-publish it.
 *  4. **Ignored by git — before the write, or the write does not happen.** Asked of git
 *     (`check-ignore`, so a parent `.gitignore` or a `.env*` pattern counts), and only when
 *     git cannot prove it do we append an exact entry ourselves.
 *
 * Returns the receipt data. Throws `SecretWriteError` for every refusal; the value never
 * appears in any message it produces.
 */
export function writeEnvSecrets(
  projectRoot: string,
  file: string,
  entries: SecretEntry[],
  opts: { gitTracked?: GitTrackedCheck } = {},
): SecretWriteResult {
  const rel = normalizeSecretFile(file);
  const target = resolve(projectRoot, rel);

  let rootReal: string;
  let parentReal: string;
  try {
    rootReal = realpathSync(projectRoot);
    parentReal = realpathSync(dirname(target));
  } catch {
    throw new SecretWriteError('bad_file', `The directory for "${rel}" does not exist.`);
  }
  if (!contains(rootReal, parentReal)) {
    throw new SecretWriteError('escapes_root', `"${rel}" resolves outside the project.`);
  }
  const realTarget = join(parentReal, rel.split('/').pop() as string);
  if (existsSync(realTarget)) {
    const st = lstatSync(realTarget);
    if (st.isSymbolicLink()) {
      throw new SecretWriteError('symlink', `"${rel}" is a symlink — refusing to write a secret through it.`);
    }
    if (!st.isFile()) {
      throw new SecretWriteError('not_a_file', `"${rel}" is not a regular file.`);
    }
  }

  const gitTracked = opts.gitTracked ?? defaultGitTrackedCheck;
  if (gitTracked(rootReal, [rel]).length > 0) {
    throw new SecretWriteError(
      'tracked',
      `"${rel}" is tracked by git — a secret written there would be committed. Untrack it first (git rm --cached ${rel}).`,
    );
  }

  let gitignoreAdded: string | undefined;
  if (!gitIgnoresPath(rootReal, rel)) {
    try {
      const added = ensureGitignoreEntries(rootReal, [rel], { comment: 'dreamcontext secrets (never commit)' });
      gitignoreAdded = added[0];
    } catch (err) {
      throw new SecretWriteError(
        'gitignore_failed',
        `Refusing to write the secret: .gitignore could not be updated (${(err as Error).message}).`,
      );
    }
  }

  let current = '';
  try {
    if (existsSync(realTarget)) current = readFileSync(realTarget, 'utf-8');
  } catch (err) {
    throw new SecretWriteError('write_failed', `Could not read "${rel}" (${(err as Error).message}).`);
  }

  const { content, written } = upsertEnvContent(current, entries);
  try {
    // 0600 at create AND on every write: a `.env` the user made by hand is often 0644, and
    // a file that now holds a freshly pasted token should not be world-readable because it
    // happened to exist first.
    writeFileSync(realTarget, content, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(realTarget, 0o600);
  } catch (err) {
    throw new SecretWriteError('write_failed', `Could not write "${rel}" (${(err as Error).message}).`);
  }

  return { file: rel, written, ...(gitignoreAdded ? { gitignoreAdded } : {}) };
}

/**
 * The message the CHAT sends the agent after a successful write — the entire contract of
 * this feature in one paragraph the model actually reads.
 *
 * It carries the key name, the file, a character count and a fingerprint (so the agent can
 * tell a re-paste from the same paste, and can prove to the user that something real
 * landed) and NOT the value. The closing sentence is the instruction half: do not go and
 * read the file back, because doing so would put in the transcript exactly what this whole
 * path exists to keep out of it.
 */
export function secretReceipt(result: SecretWriteResult, title?: string): string {
  const lines: string[] = [];
  lines.push(`[secret submitted${title ? ` · ${title}` : ''}]`);
  for (const w of result.written) {
    const dup = w.duplicate ? ', duplicate keys in the file — the last one was rewritten' : '';
    lines.push(`- ${w.key} → ${result.file} (${w.action}, ${w.chars} chars, sha256:${w.fingerprint}${dup})`);
  }
  if (result.gitignoreAdded) lines.push(`- ${result.gitignoreAdded} was added to .gitignore`);
  lines.push(
    'The value was written to disk by the app. It was NOT sent to you and is not in this transcript: '
    + 'use it by name (the environment / the file), never read the file back or echo the value, '
    + 'and tell the user plainly that you cannot see it.',
  );
  return lines.join('\n');
}

/** Where the file sits on disk, for a caller that needs to name it. Not exported for the
 *  route (which never shows an absolute path); kept for tests and future callers. */
export function secretFilePath(projectRoot: string, file: string): string {
  return resolve(projectRoot, normalizeSecretFile(file)) + (sep === '\\' ? '' : '');
}
