import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { nanoid } from 'nanoid';
import { automationsDir, isSafeAutomationSlug, listAutomations } from './store.js';
import {
  AutomationError,
  THREAD_DAY_MAX_ENTRIES,
  THREAD_ENTRY_MARKER,
  THREAD_ENTRY_MAX_BYTES,
  THREAD_FILES_MAX,
  THREAD_RETENTION_DAYS,
  THREAD_TEXT_MAX_CHARS,
  type ThreadEntry,
  type ThreadEntryKind,
  type ThreadRunSummary,
  type ThreadSystemEvent,
  type ThreadVia,
} from './types.js';

/**
 * Automations — the thread store. An agent's channel, as append-only markdown
 * that two machines can both write to and git can merge.
 *
 * THE CONSTRAINT THAT SHAPES EVERYTHING: threads are brain-SYNCED, so two
 * machines append to one file and git resolves a both-added-at-EOF hunk as a
 * conflict. Every decision below follows from designing for that rather than
 * against it:
 *
 *  - Entries are APPEND-ONLY and ORDER-INDEPENDENT. Nothing is ever rewritten,
 *    so a merge has nothing to lose.
 *  - `id` is the sort key AND the merge key — time-prefixed and sortable (see
 *    `newThreadEntryId`), so plain string compare is time order across machines,
 *    and a duplicated entry after a merge is byte-identical and de-duplicable.
 *  - `readThread` TOLERATES CONFLICT MARKERS. A conflicted thread stays
 *    readable and correct before anyone resolves the file. This is the single
 *    most important robustness property of the format.
 *  - Writes are `appendFileSync` (`O_APPEND`), NOT the temp+rename this module's
 *    sibling `writeAutomationCache` uses. That is a deliberate divergence: a
 *    whole-file rewrite loses a concurrent append from another process while the
 *    runner is mid-run. A torn interleave is still possible in theory; every
 *    entry block opens with `THREAD_ENTRY_MARKER` and the reader re-syncs on it,
 *    so a torn block costs one skipped entry rather than a corrupt file.
 *
 * NEVER IMPORTS `runner.ts` OR `verdict.ts` — they import this.
 *
 * THE THREAD FILE IS NEVER INJECTED INTO A PROMPT. It is a teammate-writable
 * synced file; treating it as an instruction source would make "anyone who can
 * push to the brain can steer a bypassPermissions run" true. It is a record to
 * be READ by humans and rendered by the dashboard, nothing else.
 */

// ─── Paths ───────────────────────────────────────────────────────────────────

export function threadsDir(contextRoot: string): string {
  return join(automationsDir(contextRoot), 'threads');
}

/** Throws on an unsafe slug — the slug is a PATH SEGMENT here, the same rule
 *  and the same reason as `automationSessionsPath`. */
export function threadSlugDir(contextRoot: string, slug: string): string {
  if (!isSafeAutomationSlug(slug)) throw new AutomationError(`Invalid automation slug "${slug}".`);
  return join(threadsDir(contextRoot), slug);
}

/** `YYYY-MM-DD` in LOCAL time — schedules are machine-local wall-clock, so a
 *  UTC stamp would put an 18:00 run's entries in tomorrow's file for half the
 *  world. Mirrors the output archive's own date convention. */
export function threadDateStamp(d: Date = new Date()): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/** The date is DERIVED, never taken as a raw caller string — it is a filename. */
export function threadDayPath(contextRoot: string, slug: string, date: Date | string = new Date()): string {
  const stamp = typeof date === 'string' ? date : threadDateStamp(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) throw new AutomationError(`Invalid thread date "${stamp}".`);
  return join(threadSlugDir(contextRoot, slug), `${stamp}.md`);
}

// ─── Entry ids ───────────────────────────────────────────────────────────────

/**
 * A time-prefixed, sortable entry id.
 *
 * DELIBERATELY NOT `generateId` from `lib/id.ts`, which is `${prefix}_${nanoid(8)}`
 * — random, and therefore NOT sortable. Everything here rests on `id` string
 * compare being time order: the read path sorts by it, unread is computed as
 * `id > watermark` with no entry lookup at all, and a pruned-away watermark
 * still compares correctly against the survivors (see `threadUnread`).
 *
 * 9 base36 characters hold millisecond timestamps until roughly the year 5000,
 * so the prefix never changes width and plain `<` stays correct. The suffix is
 * a per-process sequence plus a nanoid: the sequence makes ids from THIS
 * process strictly increasing even inside one millisecond, and the nanoid
 * breaks ties between machines.
 *
 * Two machines with skewed clocks interleave by their own wall clocks. That is
 * DISPLAY order only and nothing depends on it: unread is computed per machine
 * against that machine's own watermark, and a run's entries group by `runId`,
 * never by position.
 */
/** Last millisecond this process issued an id for, and how many it issued in
 *  it. See `newThreadEntryId` for why a per-process sequence is not optional. */
let lastIdMs = -1;
let lastIdSeq = 0;
/** 2 base36 chars ⇒ 1296 entries per millisecond before rolling to the next. */
const SEQ_MAX = 36 * 36;

export function newThreadEntryId(now: number = Date.now()): string {
  const ms = Math.floor(now);
  // WITHIN ONE MILLISECOND a random suffix orders entries RANDOMLY, which
  // showed up immediately as a run's `system:started` sorting after its own
  // first post. A per-process sequence fixes that: ids issued by THIS process
  // for the SAME millisecond are strictly increasing.
  //
  // It deliberately does NOT clamp `ms` upward when the caller supplies an
  // earlier time. An explicit timestamp is a fact (a catch-up write answering
  // for an earlier fire, a test fixing the clock), and rewriting it would make
  // the id lie about when the entry happened — it would sort into the wrong
  // day and, worse, push a read watermark past entries nobody has seen.
  if (ms === lastIdMs) {
    lastIdSeq = (lastIdSeq + 1) % SEQ_MAX;
  } else {
    lastIdMs = ms;
    lastIdSeq = 0;
  }
  // Across PROCESSES a same-millisecond tie is still broken by the nanoid, and
  // that is fine: nothing depends on cross-machine order — unread is computed
  // against this machine's own watermark, and entries group by `runId`, never
  // by position.
  const seq = lastIdSeq.toString(36).padStart(2, '0');
  return `${ms.toString(36).padStart(9, '0')}_${seq}${nanoid(4)}`;
}

// ─── Read ────────────────────────────────────────────────────────────────────

/** Git's conflict hunk markers. A thread mid-conflict must stay READABLE. */
const CONFLICT_MARKER = /^(<{7}|={7}|>{7}|\|{7})/;

function parseEntry(json: string): ThreadEntry | null {
  try {
    const raw: unknown = JSON.parse(json);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id) return null;
    if (typeof r.runId !== 'string' || !r.runId) return null;
    if (r.kind !== 'system' && r.kind !== 'agent' && r.kind !== 'user') return null;
    if (typeof r.at !== 'string' || !r.at) return null;
    const files = Array.isArray(r.files)
      ? r.files.filter((f): f is string => typeof f === 'string' && f.length > 0).slice(0, THREAD_FILES_MAX)
      : undefined;
    return {
      id: r.id,
      runId: r.runId,
      kind: r.kind as ThreadEntryKind,
      ...(typeof r.event === 'string' ? { event: r.event as ThreadSystemEvent } : {}),
      at: r.at,
      text: typeof r.text === 'string' ? r.text : '',
      ...(files && files.length > 0 ? { files } : {}),
      via: (r.via === 'runner' || r.via === 'cli' || r.via === 'dashboard' || r.via === 'chat')
        ? (r.via as ThreadVia)
        : 'runner',
    };
  } catch {
    return null;
  }
}

/**
 * Pull every entry out of one day file's raw text.
 *
 * TOTAL. Skips conflict markers, re-syncs on `THREAD_ENTRY_MARKER`, and drops a
 * block that will not parse rather than throwing — a single bad entry (a torn
 * interleave, a hand edit, half a merge) must never cost the reader the rest of
 * the thread.
 */
function parseDayFile(raw: string): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== THREAD_ENTRY_MARKER) { i++; continue; }
    // Walk to the opening fence, skipping blank lines and conflict markers.
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || CONFLICT_MARKER.test(lines[j]))) j++;
    if (j >= lines.length || !lines[j].trimStart().startsWith('```')) { i++; continue; }
    const body: string[] = [];
    let k = j + 1;
    let closed = false;
    while (k < lines.length) {
      const line = lines[k];
      // Another marker before the fence closed ⇒ this block was torn. Abandon
      // it and RESYNC there rather than swallowing the next entry with it.
      if (line.trimEnd() === THREAD_ENTRY_MARKER) break;
      if (line.trimStart().startsWith('```')) { closed = true; break; }
      if (!CONFLICT_MARKER.test(line)) body.push(line);
      k++;
    }
    if (closed) {
      const entry = parseEntry(body.join('\n'));
      if (entry) out.push(entry);
      i = k + 1;
    } else {
      i = k;
    }
  }
  return out;
}

export interface ReadThreadOptions {
  /** Keep only the newest N, AFTER sorting. */
  limit?: number;
  /** Keep only entries strictly newer than this id. */
  sinceId?: string;
  /** Keep only this run's entries. */
  runId?: string;
  /**
   * Read only the newest N DAY FILES — the I/O bound, not a display filter.
   *
   * `limit` trims what is RETURNED and does nothing for cost: without this a
   * polled caller re-reads and re-parses the slug's whole retained history
   * (up to `THREAD_RETENTION_DAYS` files × `THREAD_DAY_MAX_ENTRIES` entries)
   * on every tick, synchronously, for every automation in the vault. That is
   * the badge-cost risk the design plan names, and this is its cap.
   *
   * Omitted ⇒ everything, which is what a one-shot CLI read or an explicit
   * per-run read should do.
   */
  days?: number;
}

/**
 * Every entry for a slug, de-duplicated by `id` and sorted by `id`.
 *
 * NEVER THROWS. A missing directory, an unreadable file, a conflicted file, a
 * hand-mangled entry — all degrade to "fewer entries", never to an exception.
 * This function is called from render paths and from the runner's best-effort
 * writes; a throw here would take down a screen or change a run's disposition.
 */
export function readThread(contextRoot: string, slug: string, opts: ReadThreadOptions = {}): ThreadEntry[] {
  let dir: string;
  try { dir = threadSlugDir(contextRoot, slug); } catch { return []; }
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  } catch { return []; }
  // Names are ISO dates, so lexical order IS chronological order and the
  // newest N are simply the last N. Sliced BEFORE any file is opened — the
  // whole point is to not read them.
  if (opts.days !== undefined && opts.days >= 0 && files.length > opts.days) {
    files = files.slice(files.length - opts.days);
  }

  const byId = new Map<string, ThreadEntry>();
  for (const name of files) {
    let raw: string;
    try { raw = readFileSync(join(dir, name), 'utf-8'); } catch { continue; }
    for (const entry of parseDayFile(raw)) {
      // First writer wins on a duplicate id: a merged duplicate is byte
      // identical, so which copy survives cannot matter.
      if (!byId.has(entry.id)) byId.set(entry.id, entry);
    }
  }

  let entries = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (opts.runId) entries = entries.filter((e) => e.runId === opts.runId);
  if (opts.sinceId) entries = entries.filter((e) => e.id > opts.sinceId!);
  if (opts.limit !== undefined && opts.limit >= 0 && entries.length > opts.limit) {
    entries = entries.slice(entries.length - opts.limit);
  }
  return entries;
}

/** One run's thread. */
export function readThreadRun(contextRoot: string, slug: string, runId: string): ThreadEntry[] {
  return readThread(contextRoot, slug, { runId });
}

/** Terminal system events, in the order a run can reach them. `skipped` is one
 *  of them: a fire that never became a run is finished, not still working. */
const TERMINAL_EVENTS: ReadonlySet<string> = new Set(['ok', 'failed', 'timeout', 'skipped']);

/** Root + counts + last entry per run, NEWEST FIRST — what a channel list
 *  renders without reading every entry twice. */
export function listThreadRuns(contextRoot: string, slug: string, limit?: number): ThreadRunSummary[] {
  const entries = readThread(contextRoot, slug);
  const byRun = new Map<string, ThreadEntry[]>();
  for (const e of entries) {
    const list = byRun.get(e.runId);
    if (list) list.push(e);
    else byRun.set(e.runId, [e]);
  }
  const runs: ThreadRunSummary[] = [...byRun.entries()].map(([runId, list]) => ({
    runId,
    startedAt: list.find((e) => e.kind === 'system' && e.event === 'started')?.at ?? null,
    status: (list.filter((e) => e.kind === 'system' && e.event && TERMINAL_EVENTS.has(e.event)).pop()?.event ?? null) as ThreadSystemEvent | null,
    entryCount: list.length,
    lastEntry: list[list.length - 1] ?? null,
  }));
  // By runId — it is `firedAt`, an ISO string, so lexical IS chronological.
  runs.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
  return limit !== undefined ? runs.slice(0, limit) : runs;
}

// ─── Write ───────────────────────────────────────────────────────────────────

export interface AppendThreadEntryInput {
  runId: string;
  kind: ThreadEntryKind;
  event?: ThreadSystemEvent;
  text: string;
  files?: string[];
  via: ThreadVia;
  /** Injected for tests and for a catch-up write that answers for an earlier
   *  fire — never read from the clock inside this module. */
  now?: Date;
}

/**
 * Containment for a `files[]` path. Brain-relative, inside the brain, never the
 * brain root itself — the same rule `resolveOutputDir` enforces for output.
 * PURE: no I/O, so a path is refused for its SHAPE, whether or not the file
 * happens to exist yet (a run posts the document it is still writing).
 */
function isContainedBrainRel(contextRoot: string, raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) return false;
  const absRoot = resolve(contextRoot);
  const abs = resolve(absRoot, normalize(trimmed));
  return abs.startsWith(absRoot + sep);
}

/**
 * THE ONLY WRITER. Validates, assigns `id` and `at`, and appends.
 *
 * Refuses loudly rather than dropping: an over-cap day, an unsafe slug, an
 * escaping file path and an empty run id all throw `AutomationError`. A post
 * the agent believes it made is worse than one it knows it could not make —
 * which is why the CLI verb reports a non-zero exit on every one of these.
 */
export function appendThreadEntry(contextRoot: string, slug: string, input: AppendThreadEntryInput): ThreadEntry {
  const dir = threadSlugDir(contextRoot, slug); // throws on an unsafe slug
  if (!input.runId || !input.runId.trim()) {
    throw new AutomationError('A thread entry needs a run to belong to.');
  }
  if (input.kind !== 'system' && input.kind !== 'agent' && input.kind !== 'user') {
    throw new AutomationError(`Invalid thread entry kind "${input.kind}".`);
  }
  if (input.kind !== 'system' && input.event !== undefined) {
    throw new AutomationError('Only a system entry carries an event.');
  }

  const files = (input.files ?? []).map((f) => f.trim()).filter(Boolean);
  if (files.length > THREAD_FILES_MAX) {
    throw new AutomationError(`A post carries at most ${THREAD_FILES_MAX} files.`);
  }
  for (const f of files) {
    if (!isContainedBrainRel(contextRoot, f)) {
      throw new AutomationError(`Refusing a file outside the brain: "${f}"`);
    }
  }

  const now = input.now ?? new Date();
  const dayPath = threadDayPath(contextRoot, slug, now);

  // Counted from THIS day file only — the cap bounds one file, which is what
  // bounds a git conflict.
  if (existsSync(dayPath)) {
    let existing = 0;
    try { existing = parseDayFile(readFileSync(dayPath, 'utf-8')).length; } catch { existing = 0; }
    if (existing >= THREAD_DAY_MAX_ENTRIES) {
      throw new AutomationError(
        `${slug}'s thread already holds ${THREAD_DAY_MAX_ENTRIES} entries for ${threadDateStamp(now)} — refusing to append.`,
      );
    }
  }

  // NULs stripped and length capped, the same discipline `resumeWithMessage`
  // applies: this text ends up in a synced file and in a rendered surface.
  const text = input.text.replace(/\0/g, '').slice(0, THREAD_TEXT_MAX_CHARS);

  const entry: ThreadEntry = {
    id: newThreadEntryId(now.getTime()),
    runId: input.runId.trim(),
    kind: input.kind,
    ...(input.event ? { event: input.event } : {}),
    at: now.toISOString(),
    text,
    ...(files.length > 0 ? { files } : {}),
    via: input.via,
  };

  const block = `${THREAD_ENTRY_MARKER}\n\`\`\`json\n${JSON.stringify(entry)}\n\`\`\`\n\n`;
  if (Buffer.byteLength(block, 'utf-8') > THREAD_ENTRY_MAX_BYTES) {
    throw new AutomationError('That entry is too large to append.');
  }

  mkdirSync(dir, { recursive: true });
  if (!existsSync(dayPath)) {
    // Frontmatter first, so a human reading the synced brain sees what this
    // file is. Written with `writeFileSync` only when absent — every other
    // write in this module is an append.
    const header = `---\nslug: ${slug}\ndate: ${threadDateStamp(now)}\nversion: 1\n---\n\n`;
    try { writeFileSync(dayPath, header, { encoding: 'utf-8', flag: 'wx' }); } catch { /* raced: another process created it first */ }
  }
  appendFileSync(dayPath, block, 'utf-8');
  return entry;
}

/** Delete day files older than `keepDays`. Returns how many went. Announced by
 *  the caller, never silent — mirrors `pruneAnsweredQuestions`. */
export function pruneThreads(contextRoot: string, slug: string, keepDays: number = THREAD_RETENTION_DAYS): number {
  let dir: string;
  try { dir = threadSlugDir(contextRoot, slug); } catch { return 0; }
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    const m = name.match(/^(\d{4})-(\d{2})-(\d{2})\.md$/);
    if (!m) continue;
    const when = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (!Number.isFinite(when) || when >= cutoff) continue;
    try { rmSync(join(dir, name)); removed++; } catch { /* locked or already gone */ }
  }
  return removed;
}

// ─── Unread (per machine, never synced) ──────────────────────────────────────
//
// Modelled on `attention.ts`'s watermark file, including its fail-safe rule: a
// corrupt file degrades to "nothing has been read". Per-machine and never
// synced, for the reason that module's doc states — a synced watermark makes
// another machine's badges wrong.

interface ThreadWatermarkFile {
  /** `{ <projectRoot>: { <slug>: <entry id> } }` — the last READ entry id. */
  [projectRoot: string]: Record<string, string>;
}

const WATERMARK_TTL_MS = THREAD_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export function threadWatermarkPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'automations-threads-read.json');
}

/** Never throws: an unreadable file degrades to "nothing has been read", which
 *  costs a badge you have already seen. The opposite — reading a corrupt file
 *  as "everything has been read" — swallows the message this exists to surface. */
function readAll(home: string): ThreadWatermarkFile {
  const path = threadWatermarkPath(home);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: ThreadWatermarkFile = {};
    for (const [projectRoot, slugs] of Object.entries(raw as Record<string, unknown>)) {
      if (!projectRoot || !slugs || typeof slugs !== 'object' || Array.isArray(slugs)) continue;
      const kept: Record<string, string> = {};
      for (const [slug, id] of Object.entries(slugs as Record<string, unknown>)) {
        if (typeof id === 'string' && id) kept[slug] = id;
      }
      out[projectRoot] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

/** Atomic write at mode 0600, TTL-pruning rows whose id is older than the
 *  retention window — the id's own time prefix is what dates it. */
function writeAll(home: string, all: ThreadWatermarkFile, nowMs: number): void {
  const path = threadWatermarkPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const cutoff = nowMs - WATERMARK_TTL_MS;
  const kept: ThreadWatermarkFile = {};
  for (const [projectRoot, slugs] of Object.entries(all)) {
    const keptSlugs: Record<string, string> = {};
    for (const [slug, id] of Object.entries(slugs)) {
      const t = Number.parseInt(id.slice(0, 9), 36);
      if (Number.isFinite(t) && t < cutoff) continue;
      keptSlugs[slug] = id;
    }
    if (Object.keys(keptSlugs).length > 0) kept[projectRoot] = keptSlugs;
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
}

export interface ThreadUnread {
  count: number;
  /** Newest entry id in the thread, read or not — what `markThreadRead` takes. */
  lastId: string | null;
  lastAt: string | null;
}

/**
 * How much of this thread this machine has not seen.
 *
 * `id > watermark`, with NO ENTRY LOOKUP — which is only sound because
 * `newThreadEntryId` makes ids comparable. That matters for the three cases
 * where the watermark id is no longer on disk at all (R3):
 *
 *  - watermark BELOW every surviving id ⇒ everything surviving is unread. The
 *    laptop that was away for four months: the pruned past was read, the
 *    survivors are newer. Over-notifies, which is `attention.ts`'s fail-safe
 *    direction.
 *  - watermark ABOVE every surviving id ⇒ nothing unread. The thread was pruned
 *    entirely after being read; a rebuilt future entry sorts after and badges
 *    normally.
 *  - corrupt or absent file ⇒ treated as absent ⇒ everything unread.
 *
 * `kind: 'user'` is EXCLUDED: you do not badge yourself for your own reply.
 */
export function threadUnread(
  contextRoot: string,
  slug: string,
  home: string = homedir(),
  /** Bound the read for polled callers — see `ReadThreadOptions.days`. */
  days?: number,
): ThreadUnread {
  const entries = readThread(contextRoot, slug, days === undefined ? {} : { days });
  const last = entries[entries.length - 1] ?? null;
  const watermark = readAll(home)[dirname(contextRoot)]?.[slug] ?? null;
  const unread = entries.filter((e) => e.kind !== 'user' && (watermark === null || e.id > watermark));
  return { count: unread.length, lastId: last?.id ?? null, lastAt: last?.at ?? null };
}

/** This machine's last-read entry id for one slug, or null when it has read
 *  nothing. Exported so the FEED can mark one message unread using exactly the
 *  id `threadUnread` counts against — a second derivation of "where the line
 *  is" would eventually disagree with the badge, and a chip that says 3 over a
 *  list with 2 accent bars is worse than either number alone. */
export function threadReadWatermark(contextRoot: string, slug: string, home: string = homedir()): string | null {
  return readAll(home)[dirname(contextRoot)]?.[slug] ?? null;
}

/**
 * Advance this machine's watermark. MONOTONIC — an older id than the one on
 * disk is ignored rather than written, so a slow response arriving after a
 * newer one cannot rewind the mark and re-badge messages already dealt with.
 * Exactly `ackAttention`'s refusal to rewind.
 */
export function markThreadRead(
  contextRoot: string,
  slug: string,
  upToId: string,
  home: string = homedir(),
  nowMs: number = Date.now(),
): void {
  if (!upToId) return;
  const projectRoot = dirname(contextRoot);
  const all = readAll(home);
  const existing = all[projectRoot]?.[slug];
  if (existing !== undefined && existing >= upToId) return;
  writeAll(home, { ...all, [projectRoot]: { ...(all[projectRoot] ?? {}), [slug]: upToId } }, nowMs);
}

/** Project-wide unread, per slug — one pass for the sidebar badge. Slugs with
 *  zero unread are omitted, so a caller can sum values without filtering. */
export function allThreadUnread(
  contextRoot: string,
  home: string = homedir(),
  days?: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  let slugs: string[] = [];
  try { slugs = listAutomations(contextRoot).map((m) => m.slug); } catch { return out; }
  for (const slug of slugs) {
    const { count } = threadUnread(contextRoot, slug, home, days);
    if (count > 0) out[slug] = count;
  }
  return out;
}
