import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { customAlphabet } from 'nanoid';

/**
 * The task JOURNAL — a task's history, split off its card.
 *
 * A task file `state/<slug>.md` is the CARD: what the work is and how it is
 * proven (Why, criteria, decisions). Everything that HAPPENED to it — session
 * logs, status moves, evidence, approvals, remote comments — lives in
 * `state/journal/<slug>.md`, newest entry on top. Keeping the card short is what
 * lets every surface load it whole.
 *
 * Entry heading: `### YYYY-MM-DD HH:MM - <kind>[: <label>] [je_<id>]`.
 * The id is stable for life: sync uses it to know what it already posted
 * (`posted_journal_ids`), the git merge driver unions by it, and an evidence
 * ref `cmd:<je_id>` names it. Entries migrated from an old `## Changelog` keep
 * their text byte-for-byte and carry NO id in the file; their id is derived
 * from the text (`je_h<sha1>`), counting identical texts from the OLDEST end so
 * prepending new entries never shifts an old entry's identity.
 */

export const JOURNAL_DIR = 'journal';
/** Where the journal of a deleted task goes (the card's tombstone has the why). */
export const JOURNAL_DELETED_DIR = '.deleted';

export type JournalKind = 'created' | 'log' | 'evidence' | 'status' | 'approval' | 'sleep' | 'remote';
export const JOURNAL_KINDS: readonly JournalKind[] = [
  'created', 'log', 'evidence', 'status', 'approval', 'sleep', 'remote',
];

export interface JournalEntry {
  /** Explicit `[je_…]` id, or the derived `je_h…` id of an id-less (legacy) entry. */
  id: string;
  explicitId: boolean;
  /** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`; '' for a heading-less fragment. */
  date: string;
  kind: JournalKind;
  /** Free text after the kind (`status: Completed` → `Completed`); legacy label verbatim. */
  label: string;
  /** Who wrote it, when recorded (`(by <actor>)`). */
  actor: string | null;
  /** Body under the heading, trimmed. */
  body: string;
  /** The whole entry as stored (heading + body), trailing whitespace trimmed. */
  text: string;
}

export class JournalPathError extends Error {}

const entryIdAlphabet = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 10);

export function newJournalEntryId(): string {
  return `je_${entryIdAlphabet()}`;
}

const HEADING_RE =
  /^###\s+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)\s+-\s+(.*?)(?:\s+\[(je_[A-Za-z0-9_-]{4,})\])?(?:\s+\(by ([^)]+)\))?\s*$/;
const ANY_HEADING_RE = /^###\s/;
const ID_SUFFIX_RE = /\s+\[je_[A-Za-z0-9_-]{4,}\]/g;
const MARKER_RE = /<!--\s*je:[A-Za-z0-9_-]+\s*-->/g;

/** Map a heading label to its kind. New entries name the kind first; legacy labels are mapped. */
export function kindOfLabel(label: string): { kind: JournalKind; rest: string } {
  const m = /^([a-z]+)(?::\s*(.*))?$/.exec(label.trim());
  if (m && (JOURNAL_KINDS as readonly string[]).includes(m[1])) {
    return { kind: m[1] as JournalKind, rest: (m[2] ?? '').trim() };
  }
  const l = label.trim();
  if (/^created$/i.test(l)) return { kind: 'created', rest: l };
  if (/^(completed|cancelled|status\b)/i.test(l)) return { kind: 'status', rest: l };
  if (/^approv/i.test(l)) return { kind: 'approval', rest: l };
  if (/^sleep/i.test(l)) return { kind: 'sleep', rest: l };
  return { kind: 'log', rest: l };
}

/**
 * The comparison form of an entry: `[je_…]` heading suffix and `<!-- je:… -->`
 * markers removed, whitespace collapsed. Two entries with the same normalised
 * text are the same history line, however they travelled.
 */
export function normalizeEntryText(text: string): string {
  return text.replace(ID_SUFFIX_RE, '').replace(MARKER_RE, '').replace(/\s+/g, ' ').trim();
}

function derivedId(norm: string, ordinal: number): string {
  return `je_h${createHash('sha1').update(`${norm}\0${ordinal}`).digest('hex').slice(0, 10)}`;
}

/** Split raw entry text (journal file or an old Changelog section body) into entry texts, newest first. */
export function splitEntryTexts(content: string): string[] {
  const lines = content.split('\n');
  const out: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = cur.join('\n').trim();
    if (text && !/^<!--[\s\S]*-->$/.test(text)) out.push(text);
    cur = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && ANY_HEADING_RE.test(line)) flush();
    cur.push(line);
  }
  flush();
  return out;
}

function parseOne(text: string): Omit<JournalEntry, 'id' | 'explicitId'> & { explicit: string | null } {
  const nl = text.indexOf('\n');
  const head = nl === -1 ? text : text.slice(0, nl);
  const body = nl === -1 ? '' : text.slice(nl + 1).trim();
  const m = HEADING_RE.exec(head);
  if (!m) {
    // A heading-less fragment (e.g. an old bare `- date: …` line): kept as a log.
    return { date: '', kind: 'log', label: '', actor: null, body: text.trim(), text, explicit: null };
  }
  const { kind, rest } = kindOfLabel(m[2]);
  return { date: m[1], kind, label: rest, actor: m[4] ?? null, body, text, explicit: m[3] ?? null };
}

/** Parse entry texts (newest first) into entries with ids. */
export function parseEntries(texts: string[]): JournalEntry[] {
  const parsed = texts.map(parseOne);
  // Derived ids count identical texts from the OLDEST end (the file's bottom).
  const seen = new Map<string, number>();
  const ids: string[] = new Array(parsed.length);
  for (let i = parsed.length - 1; i >= 0; i--) {
    const p = parsed[i];
    if (p.explicit) { ids[i] = p.explicit; continue; }
    const norm = normalizeEntryText(p.text);
    const ord = seen.get(norm) ?? 0;
    seen.set(norm, ord + 1);
    ids[i] = derivedId(norm, ord);
  }
  return parsed.map(({ explicit, ...p }, i) => ({ ...p, id: ids[i], explicitId: explicit !== null }));
}

export function parseJournal(content: string): JournalEntry[] {
  return parseEntries(splitEntryTexts(content));
}

// ─── Paths (containment: no symlinked journal dir or file) ─────────────────

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeSlug(slug: string): boolean {
  return !!slug && !slug.includes('\0') && !slug.includes('/') && !slug.includes('\\') && slug !== '.' && slug !== '..';
}

export function journalDir(stateDir: string): string {
  return join(stateDir, JOURNAL_DIR);
}

/** `state/journal/<slug>.md`. Throws on an unsafe slug or a symlinked journal dir/file. */
export function journalPath(stateDir: string, slug: string): string {
  if (!safeSlug(slug)) throw new JournalPathError(`Invalid task slug for a journal: ${slug}`);
  const dir = journalDir(stateDir);
  if (isSymlink(dir)) throw new JournalPathError(`Refusing a symlinked journal directory: ${dir}`);
  const path = join(dir, `${slug}.md`);
  if (isSymlink(path)) throw new JournalPathError(`Refusing a symlinked journal file: ${path}`);
  return path;
}

/** The journal of the task file at `taskFile` (`<dir>/journal/<slug>.md`). */
export function journalPathForTaskFile(taskFile: string): string {
  return journalPath(dirname(taskFile), basename(taskFile, '.md'));
}

export function readJournalRaw(stateDir: string, slug: string): string {
  try {
    const path = journalPath(stateDir, slug);
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
  } catch {
    return '';
  }
}

export function readJournal(stateDir: string, slug: string): JournalEntry[] {
  return parseJournal(readJournalRaw(stateDir, slug));
}

/** Write a journal atomically (temp + rename). */
export function writeJournalRaw(stateDir: string, slug: string, content: string): void {
  const path = journalPath(stateDir, slug);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${slug}.md.tmp-${process.pid}`);
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

function prependTexts(existing: string, texts: string[]): string {
  if (texts.length === 0) return existing;
  const block = texts.map((t) => t.trimEnd()).join('\n\n');
  const rest = existing.replace(/^\s+/, '');
  return rest ? `${block}\n\n${rest}` : `${block}\n`;
}

// ─── Writing entries ────────────────────────────────────────────────────────

export interface NewJournalEntry {
  kind: JournalKind;
  /** Body text (already formatted, e.g. `- did the thing`). */
  body: string;
  /** Free label after the kind (`status: Completed`). */
  label?: string;
  actor?: string | null;
  /** Explicit id (a pulled remote comment, a test). Fresh when absent. */
  id?: string;
  now?: Date;
}

export function journalStamp(now: Date = new Date()): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * A body can never start a new entry: a `###` line outside a fence is demoted
 * to `####` (else `tasks log "…\n### … - evidence [je_x]"` would write a forged
 * evidence entry that `cmd:` then accepts), and a body whose fences do not
 * close has every fence line escaped (an open fence would swallow the entries
 * below it). Fences toggle exactly as `splitEntryTexts` toggles them.
 */
export function safeEntryBody(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').trim().split('\n');
  const isFence = (l: string) => /^\s*(```|~~~)/.test(l);
  let inFence = false;
  for (const l of lines) if (isFence(l)) inFence = !inFence;
  const unbalanced = inFence;
  inFence = false;
  return lines
    .map((l) => {
      if (isFence(l)) {
        if (unbalanced) return `\\${l}`;
        inFence = !inFence;
        return l;
      }
      return !inFence && /^\s*###\s/.test(l) ? `#${l.trimStart()}` : l;
    })
    .join('\n');
}

export function formatEntry(e: NewJournalEntry & { id: string }): string {
  const label = e.label ? `${e.kind}: ${e.label.replace(/\s+/g, ' ').trim()}` : e.kind;
  const actor = e.actor ? ` (by ${e.actor.replace(/[()\n]/g, '').trim()})` : '';
  const head = `### ${journalStamp(e.now)} - ${label} [${e.id}]${actor}`;
  const body = safeEntryBody(e.body);
  return body ? `${head}\n${body}` : head;
}

/**
 * Prepend one entry. The CALLER holds the task's file lock (every backend path
 * does) — this is a read-modify-write of the journal file.
 */
export function appendJournalEntry(stateDir: string, slug: string, entry: NewJournalEntry): JournalEntry {
  const id = entry.id ?? newJournalEntryId();
  const text = formatEntry({ ...entry, id });
  writeJournalRaw(stateDir, slug, prependTexts(readJournalRaw(stateDir, slug), [text]));
  return parseEntries([text])[0];
}

/**
 * Fold incoming entry texts (newest first) into a journal with COPY COUNTING:
 * an incoming text is added only for the copies the journal does not already
 * hold. Folding the same Changelog twice adds nothing the second time; two
 * genuinely repeated entries ("- tests green" logged twice) both survive.
 * Added entries keep their order and go on top. Returns the count added.
 */
export function foldEntryTexts(stateDir: string, slug: string, incoming: string[]): number {
  if (incoming.length === 0) return 0;
  const existingRaw = readJournalRaw(stateDir, slug);
  const have = new Map<string, number>();
  for (const t of splitEntryTexts(existingRaw)) {
    const n = normalizeEntryText(t);
    have.set(n, (have.get(n) ?? 0) + 1);
  }
  const want = new Map<string, number>();
  for (const t of incoming) {
    const n = normalizeEntryText(t);
    want.set(n, (want.get(n) ?? 0) + 1);
  }
  const need = new Map<string, number>();
  for (const [n, c] of want) need.set(n, Math.max(0, c - (have.get(n) ?? 0)));
  const added: string[] = [];
  for (const t of incoming) {
    const n = normalizeEntryText(t);
    const left = need.get(n) ?? 0;
    if (left > 0) {
      added.push(t);
      need.set(n, left - 1);
    }
  }
  if (added.length > 0) writeJournalRaw(stateDir, slug, prependTexts(existingRaw, added));
  return added.length;
}

// ─── Carry with the card ────────────────────────────────────────────────────

/** Rename: the journal follows the card. A journal already at the new slug is folded into, never clobbered. */
export function moveJournal(stateDir: string, fromSlug: string, toSlug: string): void {
  const from = journalPath(stateDir, fromSlug);
  if (!existsSync(from)) return;
  const to = journalPath(stateDir, toSlug);
  if (existsSync(to)) {
    foldEntryTexts(stateDir, toSlug, splitEntryTexts(readFileSync(from, 'utf-8')));
    rmSync(from);
    return;
  }
  renameSync(from, to);
}

/** Delete: the journal is kept beside the tombstone, never destroyed. */
export function retireJournal(stateDir: string, slug: string, stamp: string = new Date().toISOString()): string | null {
  const from = journalPath(stateDir, slug);
  if (!existsSync(from)) return null;
  const dir = join(journalDir(stateDir), JOURNAL_DELETED_DIR);
  if (isSymlink(dir)) throw new JournalPathError(`Refusing a symlinked journal directory: ${dir}`);
  mkdirSync(dir, { recursive: true });
  const to = join(dir, `${slug}--${stamp.replace(/[:.]/g, '-')}.md`);
  renameSync(from, to);
  return to;
}
