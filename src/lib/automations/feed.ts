import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { listAutomations, readAutomationCache, resolveAutomationPhoto } from './store.js';
import { extractNotificationSummary } from './runner.js';
import { allPendingQuestions } from './hitl.js';
import { readThread, threadReadWatermark } from './threads.js';
import type {
  AutomationManifest, AutomationQuestion, RunEvent, ThreadEntry, ThreadSummaryRow,
} from './types.js';

/**
 * The FEED — what `#agents` actually shows.
 *
 * A channel's storage is a flat, append-only list of entries (threads.ts); a
 * feed is one MESSAGE PER RUN. This module is the join between the two, plus
 * the run cache, which is the only place duration and cost live. It is kept
 * separate from `threads.ts` on purpose: that file is the store and must stay
 * total and dependency-light, while this one is presentation and is allowed to
 * read the cache, the manifest and (sparingly) the published document.
 *
 * ONE RULE DECIDES MOST OF THIS FILE: a run that posted nothing is a SUCCESS,
 * not a gap. The preamble tells every agent that zero posts is the right number
 * for an unremarkable run, so the feed cannot render a blank card for one —
 * it falls back to the run's own opening result line, the same sentence the
 * desktop notification already carries. See `bodyFor`.
 */

/** The STATUS WORD, not a badge (K26/K40). `needs-you` is a run that stopped to
 *  ask and is therefore neither finished nor still working; `skipped` is a fire
 *  that never became one at all. */
export type FeedStatus = 'running' | 'done' | 'failed' | 'timeout' | 'needs-you' | 'skipped';

export interface FeedFile {
  /** Brain-relative, always — an absolute path from the cache is normalised
   *  here so every consumer has one spelling to open. */
  path: string;
  name: string;
}

export interface FeedMessage {
  /** `<slug>::<runId>` — stable across polls, and the id the read watermark
   *  and the thread panel are addressed by. */
  key: string;
  slug: string;
  title: string;
  hasPhoto: boolean;
  /** `RunEvent.firedAt`. The thread's root key and the run's only identity. */
  runId: string;
  /** When the message happened: the run's `started` entry, falling back to the
   *  fire time for a run whose thread lost that entry. */
  at: string;
  status: FeedStatus;
  durationMs: number | null;
  costUsd: number | null;
  /** What the human typed to call this agent, when this run is an ASK rather
   *  than a scheduled fire — the `user` entry that OPENS the run.
   *
   *  It rides on the run's own message instead of being a message of its own:
   *  "you asked / it answered" is one exchange, and splitting it would give
   *  the channel two rows to sort, two to mark read and two to filter, for a
   *  pair that is always adjacent and always one-to-one. Later `user` entries
   *  are replies and stay in the thread. */
  ask: { text: string; at: string } | null;
  /** The body. Empty only when a run neither posted nor published. */
  text: string;
  /** Where `text` came from. `post` — the agent chose to say it. `result` —
   *  it said nothing, so this is its document's opening line. `error` — it
   *  failed, and this is why. `skipped` — it never ran, and this is why.
   *  Four different claims, and a reader deciding whether to open the thread
   *  is entitled to know which one they are reading. */
  textFrom: 'post' | 'result' | 'error' | 'skipped' | 'none';
  files: FeedFile[];
  /** The body post's key/value block, or null. Figures that moved, ≤6 rows. */
  summary: ThreadSummaryRow[] | null;
  /**
   * The open question this run is stopped on — a JOIN against `hitl.ts`, NOT a
   * thread field.
   *
   * Deliberately not stored on the entry: a question's state changes when it is
   * answered, and an entry is append-only and never rewritten. Reading it live
   * is the only way the block on screen can disappear the moment it is
   * answered rather than at the next write.
   */
  question: { id: string; text: string; choices: string[] } | null;
  /** Waiting on the READER: either the run stopped to ask, or it has an open
   *  question. What the "Needs you" chip counts. */
  needsYou: boolean;
  /** The rows the thread panel draws under its root: every authored entry
   *  (agent posts + user replies) except the root itself, plus the published
   *  document when there is one. `threadReplies` computes it, and the thread
   *  route returns the same number, so the feed row and the panel can never
   *  disagree. System rows are not replies — they are bookkeeping. */
  replyCount: number;
  lastReplyAt: string | null;
  /** The run's published document — the thread's report — kept OUT of
   *  `files`: a dated card in the feed repeated what the thread already shows,
   *  and the 4-file cap silently dropped it. The Files view lists it. */
  document: FeedFile | null;
  /** The run-cache row whose session this message's conversation lives in —
   *  what "Open session" resolves (by `firedAt`). For a run the runner recorded
   *  it is the run itself. For a RESUMED turn (an @mention or reply to an agent
   *  with a session) it is the earlier run whose session the turn continued:
   *  a resume writes no cache row of its own under its fresh run id. Null when
   *  no recorded session backs this message. */
  sessionRunId: string | null;
  /** Whether "Open session" can work: a session backs it (`sessionRunId`), and
   *  the message is neither still running nor a fire that never ran. */
  sessionOpenable: boolean;
  unread: boolean;
  /** Newest entry id in this run — what `markThreadRead` is given when the
   *  message has been on screen. */
  newestId: string | null;
}

export interface FeedResult {
  messages: FeedMessage[];
  /** Per slug, for the filter chips. Slugs with zero unread are omitted. */
  unreadBySlug: Record<string, number>;
  /** Project-wide, for the sidebar badge. */
  unreadTotal: number;
  /** Project-wide count of messages waiting on the reader — what the
   *  "Needs you" chip shows. Derived from the same pass as `unread`, so the
   *  chip and the rows can never disagree. */
  needsYouTotal: number;
  /** Every agent in the channel, for the chip row and the avatars — including
   *  those that have never run, so a new agent is visible before its first
   *  fire. */
  agents: { slug: string; title: string; hasPhoto: boolean }[];
}

/**
 * System events that END a message, and the word each becomes.
 *
 * `replied` is here and its ONLY producer is a reply turn's own settle: an
 * @mention of a scheduled agent opens a run id that no dispatcher ever fired,
 * so the run cache has no row for it and `statusFor`'s cache fallback has
 * nothing to fall back to. Without this the message would read "running" for
 * ever. A reply turn that did NOT succeed appends `failed` instead, so both
 * directions are covered by one entry.
 *
 * THE THIRD DIRECTION, which is the one a future edit will want to "fix":
 * `statusFor` returns the FIRST terminal it finds in id order, so an `ok` run
 * that was later replied to UNSUCCESSFULLY still reads `done`. That is
 * correct — the status word describes THE RUN, and the run did finish. The
 * reply turn's failure is not hidden: it is the text of its own `failed` entry
 * in the thread. Flipping a finished run to `failed` because a later
 * conversation failed would be the lie.
 */
const TERMINAL: Record<string, FeedStatus> = {
  ok: 'done', failed: 'failed', timeout: 'timeout', skipped: 'skipped', replied: 'done',
};
/** Four is what a message card can show without becoming a folder — the same
 *  ceiling `THREAD_FILES_MAX` puts on one post. */
const FILES_PER_MESSAGE = 4;
/** Only ever read to recover the opening line of a published document. */
const RESULT_READ_BYTES = 4096;
/**
 * How many DAY FILES per agent the feed opens. THE I/O BOUND, and the reason
 * it exists: this runs behind a route the dashboard polls every 15 seconds,
 * once per open tab, synchronously, for every automation in the vault. Without
 * a window the cost grows with `THREAD_RETENTION_DAYS` (90) × the day cap
 * (500 entries) × the number of agents — history nobody is looking at, re-read
 * and re-parsed four times a minute forever.
 *
 * Fourteen rather than the design's suggested two: two bounds the cost but
 * empties the channel of anything older than yesterday, and an agent that ran
 * last week would simply vanish from the feed. Two weeks keeps the channel
 * worth reading while capping the work at a constant that no longer grows with
 * retention. Older history stays on disk and stays reachable through
 * `automations thread <slug>`, which is a one-shot read and takes no window.
 *
 * WHAT THIS MEANS FOR "UNREAD", and it is not what the store means by it:
 * `unreadBySlug` / `unreadTotal` / `message.unread` below all count within
 * this window, so they mean "unread in the last 14 days", NOT "unread ever".
 * `threadUnread` in the store is unbounded and answers the second question —
 * which makes it the MORE generous one, and deliberately so (R3 fails toward
 * over-notifying). The divergence shows up in one case: a vault nobody has
 * opened for longer than the window, where the feed goes quiet about activity
 * the store would still badge. That is accepted rather than overlooked — the
 * alternative is an unbounded read behind a 15-second poll — and it is safe
 * only because NOTHING renders the two numbers side by side: every unread
 * count in the dashboard, the chips and the sidebar badge included, comes
 * from this function. Do not wire a badge to `threadUnread` without
 * revisiting this, or two screens will disagree about the same channel.
 */
const FEED_DAY_WINDOW = 14;

/** Absolute → brain-relative, so the card's path opens the same way a posted
 *  `files[]` path does. A path already relative is returned untouched. */
function toBrainRelative(contextRoot: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(contextRoot, path);
  return rel.startsWith('..') ? path : rel;
}

/**
 * The run's own opening sentence, for a run that posted nothing.
 *
 * Deliberately reads only the head of the file: the preamble requires that
 * sentence to come FIRST, and a feed poll must not read whole documents. A
 * missing or unreadable file degrades to no text, never to an exception — this
 * runs inside a render path.
 */
function resultLine(outputPath: string | null): string | null {
  if (!outputPath || !hasContent(outputPath)) return null;
  try {
    const head = readFileSync(outputPath, 'utf-8').slice(0, RESULT_READ_BYTES);
    return extractNotificationSummary(head);
  } catch {
    return null;
  }
}

/** A file with something in it. Never throws — this runs in a render path. */
function hasContent(path: string): boolean {
  try { return existsSync(path) && statSync(path).size > 0; } catch { return false; }
}

/** How much of a run's document the thread panel is handed. A report is a few
 *  KB; the cap only exists so a runaway document cannot become a runaway
 *  response. */
const ANSWER_READ_BYTES = 256 * 1024;

export interface RunAnswer {
  /** Brain-relative, so the panel can offer it as a file to open. */
  path: string;
  /** The document as markdown, frontmatter stripped. */
  text: string;
  truncated: boolean;
}

/**
 * THE FULL ANSWER of one run — its published document — for the thread panel.
 *
 * The feed shows a run's opening line on purpose: it is a channel, read at a
 * glance. But that line is a headline, and the reader who opens the thread is
 * asking for the rest of it — the whole report the run wrote, which until now
 * was one more click away in a file viewer. The thread is where Slack puts
 * "the detail", so the thread is where this goes.
 *
 * Read once per thread open, never per feed poll. The path comes from the run
 * cache (the runner's own record), and is still refused unless it is a plain
 * file inside the brain: a shared brain repo can carry a hostile symlink, and
 * this route would otherwise print whatever it points at.
 */
export function readRunAnswer(contextRoot: string, slug: string, runId: string): RunAnswer | null {
  let run: RunEvent | undefined;
  try {
    run = readAutomationCache(contextRoot, slug)?.history.find((e) => e.firedAt === runId);
  } catch {
    return null;
  }
  const outputPath = runDocumentPath(contextRoot, run ?? null);
  if (!outputPath) return null;
  try {
    const raw = readFileSync(realpathSync(outputPath), 'utf-8');
    const truncated = raw.length > ANSWER_READ_BYTES;
    const body = (truncated ? raw.slice(0, ANSWER_READ_BYTES) : raw)
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
      .trim();
    // An EMPTY body (a document that is only frontmatter) is still a document:
    // `runDocumentPath` said so, and the feed counted it as a reply on that
    // word. Returning null here would make the thread draw one row fewer than
    // the number printed above it.
    return { path: toBrainRelative(contextRoot, outputPath), text: body, truncated };
  } catch {
    return null;
  }
}

/**
 * The run's published document, when it is a plain, non-empty file inside the
 * brain — else null. ONE predicate for "this run has a document", shared by the
 * feed poll (which must stay cheap: an lstat and two realpaths, never a read)
 * and the thread route, so the reply count both print is the same number.
 *
 * Refuses a symlink and anything whose realpath leaves the brain: a shared
 * brain repo can carry a hostile link. Never throws — this runs in a render path.
 */
export function runDocumentPath(contextRoot: string, run: RunEvent | null): string | null {
  const outputPath = run?.outputPath;
  if (!outputPath) return null;
  try {
    const link = lstatSync(outputPath);
    if (link.isSymbolicLink() || !link.isFile() || link.size === 0) return null;
    const real = realpathSync(outputPath);
    const realRoot = realpathSync(contextRoot);
    return real.startsWith(realRoot + sep) ? outputPath : null;
  } catch {
    return null;
  }
}

/**
 * The entry a thread hangs off: the human's ask when the run opened with one
 * (the rule `buildFeedMessage` keys the exchange on), otherwise the agent's
 * first post. Null for a run with neither — a silent run, whose root in the
 * panel is the feed message itself and so repeats no entry. `ordered` must be
 * in id order.
 */
export function threadRootId(ordered: ThreadEntry[]): string | null {
  if (ordered[0]?.kind === 'user') return ordered[0].id;
  return ordered.find((e) => e.kind === 'agent')?.id ?? null;
}

/** Events that end a run; the document is placed before the first of them. */
const ANSWER_ANCHORS = new Set(['ok', 'replied', 'failed', 'timeout']);

/**
 * "N replies", and when the last one landed — THE count, printed by the feed
 * row and by the thread panel's divider alike.
 *
 * It is exactly the rows the panel draws under its root: every authored entry
 * except the root, plus the published document when there is one. The ask
 * never counts; the agent's posts and its report do. System rows never count.
 * `ordered` must be in id order.
 */
export function threadReplies(
  ordered: ThreadEntry[],
  hasDocument: boolean,
): { count: number; lastAt: string | null } {
  const rootId = threadRootId(ordered);
  const replies = ordered.filter((e) => (e.kind === 'agent' || e.kind === 'user') && e.id !== rootId);
  let lastAt = replies[replies.length - 1]?.at ?? null;
  if (hasDocument) {
    const anchor = ordered.find((e) => e.kind === 'system' && e.event && ANSWER_ANCHORS.has(e.event));
    if (anchor && (lastAt === null || anchor.at > lastAt)) lastAt = anchor.at;
  }
  return { count: replies.length + (hasDocument ? 1 : 0), lastAt };
}

function statusFor(entries: ThreadEntry[], run: RunEvent | null): FeedStatus {
  for (const e of entries) {
    if (e.kind === 'system' && e.event && TERMINAL[e.event]) return TERMINAL[e.event];
  }
  if (entries.some((e) => e.kind === 'system' && e.event === 'asked')) return 'needs-you';
  // A thread that lost its terminal entry (a best-effort write that failed, a
  // day file that rolled over at midnight mid-run) must not show "running"
  // forever — the cache is the record, and it knows.
  if (run && TERMINAL[run.status]) return TERMINAL[run.status];
  return 'running';
}

/**
 * Which recorded run's session backs this message — see `FeedMessage.sessionRunId`.
 *
 * A run the runner recorded carries its own `sessionId`. A RESUMED turn has no
 * cache row at all: `resumeWithMessage` continues the slug's latest bound
 * session under a fresh run id and records nothing, so the only trace of it is
 * the thread — no `started` entry (a resume spawns no run) and a `replied` or
 * `failed` close. Its session is the newest recorded run with a session that
 * fired no later than the turn, which is the one the resume picked up.
 */
function sessionRunFor(runId: string, ordered: ThreadEntry[], run: RunEvent | null, history: RunEvent[]): string | null {
  if (run) return run.sessionId ? run.firedAt : null;
  const resumed = !ordered.some((e) => e.kind === 'system' && e.event === 'started')
    && ordered.some((e) => e.kind === 'system' && (e.event === 'replied' || e.event === 'failed'));
  if (!resumed) return null;
  return history.find((e) => e.sessionId && e.firedAt <= runId)?.firedAt ?? null;
}

/** One run's message. Exported for the grouping fixture, which drives it with
 *  hand-built entries rather than a live vault. */
export function buildFeedMessage(
  contextRoot: string,
  manifest: Pick<AutomationManifest, 'slug' | 'title'>,
  hasPhoto: boolean,
  runId: string,
  entries: ThreadEntry[],
  run: RunEvent | null,
  watermark: string | null,
  /** The slug's pending question for THIS run, when it has one. Resolved by the
   *  caller so the whole feed costs one questions read, not one per run. */
  question: AutomationQuestion | null = null,
  /** The slug's run history, newest first (as `recordRun` stores it) — where a
   *  resumed turn's session is found. Already read by the caller. */
  history: RunEvent[] = [],
): FeedMessage {
  const ordered = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const started = ordered.find((e) => e.kind === 'system' && e.event === 'started');
  const posts = ordered.filter((e) => e.kind === 'agent');

  // THE ASK. A run a human started by typing in the channel opens with their
  // words — first entry, before the runner has written anything. It is the
  // question this whole message answers, so it is neither the body nor a
  // reply: `#agents` renders it above the agent, and it must not inflate
  // "N replies" for a run nobody has actually replied in.
  const ask = ordered[0]?.kind === 'user' ? ordered[0] : null;

  // The FIRST post is the message — that is the prototype's shape and it is
  // also the honest one: an agent's opening line is what it wanted the human
  // to read. What counts as a REPLY is `threadReplies`' business, below.
  const body = posts[0] ?? null;

  const files: FeedFile[] = [];
  const seen = new Set<string>();
  for (const e of posts) {
    for (const f of e.files ?? []) {
      if (!seen.has(f)) { seen.add(f); files.push({ path: f, name: basename(f) }); }
    }
  }
  // The published document is NOT a file card here. The thread draws it whole,
  // as the agent's report, and a dated card beside the post repeated that —
  // while the 4-file cap below silently dropped it whenever a post already
  // carried four. It rides on its own field, which the Files view reads.
  //
  // `runDocumentPath` checks CONTENT, not existence: the runner creates the
  // output file whether or not the run produced anything, so a failed run
  // leaves a zero-byte document behind, and a promise of a report is bytes,
  // not an inode. It also refuses a symlink or a path outside the brain.
  const documentPath = runDocumentPath(contextRoot, run);
  const document: FeedFile | null = documentPath
    ? { path: toBrainRelative(contextRoot, documentPath), name: basename(documentPath) }
    : null;
  const replies = threadReplies(ordered, document !== null);
  const sessionRunId = sessionRunFor(runId, ordered, run, history);

  // A run that failed and posted nothing still has something to say, and it is
  // the most important thing in the channel: WHY. Without this the message
  // read "Changelog scraper · failed" over "Nothing to report." — which is not
  // merely thin, it is wrong, because there was plenty to report.
  const failure = !body && run && (run.status === 'failed' || run.status === 'timeout') ? run.error : null;
  // A fire that never became a run has no post, no document and no error —
  // only the runner's own account of why it did not happen, which is the only
  // thing the person who asked for it wants to read.
  const skipped = !body && !failure
    ? ordered.find((e) => e.kind === 'system' && e.event === 'skipped')?.text ?? null
    : null;
  const fallback = body ? null : failure ?? skipped ?? resultLine(run?.outputPath ?? null);
  const newest = ordered[ordered.length - 1] ?? null;
  const status = statusFor(ordered, run);

  return {
    key: `${manifest.slug}::${runId}`,
    slug: manifest.slug,
    title: manifest.title,
    hasPhoto,
    runId,
    // An ASK is the first thing that happened, and it happened before the
    // runner wrote anything — so it, not `started`, is when this exchange
    // begins. Without this the row a person just typed is stamped with the
    // spawn a second or two later, or (until the spawn lands) with the raw
    // run id.
    at: ask?.at ?? started?.at ?? ordered[0]?.at ?? runId,
    status,
    durationMs: run?.durationMs ?? null,
    costUsd: run?.costUsd ?? null,
    ask: ask ? { text: ask.text, at: ask.at } : null,
    text: body?.text ?? fallback ?? '',
    textFrom: body ? 'post' : failure ? 'error' : skipped ? 'skipped' : fallback ? 'result' : 'none',
    files: files.slice(0, FILES_PER_MESSAGE),
    // The BODY's summary, not the run's: a later post's figures belong to that
    // post, and it is in the thread where its own rows are read with it.
    summary: body?.summary ?? null,
    question: question
      ? { id: question.id, text: question.question, choices: question.choices }
      : null,
    // Two independent ways to be waiting on someone. `needs-you` is the run
    // having stopped to ask; an open question is one nobody has answered yet —
    // and a run can be finished and still owe an answer, so neither implies
    // the other.
    needsYou: status === 'needs-you' || question !== null,
    replyCount: replies.count,
    lastReplyAt: replies.lastAt,
    document,
    sessionRunId,
    // Hidden only where opening cannot work: nothing recorded backs it, it is
    // still in flight, or the fire never ran.
    sessionOpenable: sessionRunId !== null && status !== 'running' && status !== 'skipped',
    // Your OWN replies never make a message unread — the same rule
    // `threadUnread` applies, kept identical here so the chip counts and the
    // per-message bar can never disagree.
    unread: ordered.some((e) => e.kind !== 'user' && (watermark === null || e.id > watermark)),
    newestId: newest?.id ?? null,
  };
}

/**
 * The whole channel, oldest message first — the reading order of a chat, with
 * the newest at the bottom where the eye lands.
 *
 * `limit` keeps the NEWEST n, then restores reading order. Never throws: a
 * slug whose cache or thread is unreadable contributes nothing rather than
 * taking down the feed.
 */
export function buildFeed(
  contextRoot: string,
  opts: { limit?: number; home?: string } = {},
): FeedResult {
  const home = opts.home ?? homedir();
  let manifests: AutomationManifest[] = [];
  try { manifests = listAutomations(contextRoot); } catch { manifests = []; }

  const messages: FeedMessage[] = [];
  const unreadBySlug: Record<string, number> = {};
  const agents: FeedResult['agents'] = [];

  // ONE questions read for the WHOLE feed, indexed by the run each question
  // belongs to. Per-run `pendingQuestion` calls would re-walk the same
  // directories once per message behind a 15-second poll — the same
  // grows-with-history cost `FEED_DAY_WINDOW` exists to cap on the other side.
  // `flow-hitl` only: an `approval` question is the manifest-diff ask raised
  // BEFORE a run, so it belongs to no run in this feed and answering it is a
  // different screen's job.
  const questionByRun = new Map<string, AutomationQuestion>();
  try {
    for (const q of allPendingQuestions(contextRoot)) {
      if (q.kind !== 'flow-hitl') continue;
      const key = `${q.slug}::${q.runFiredAt}`;
      if (!questionByRun.has(key)) questionByRun.set(key, q);
    }
  } catch {
    // A question store that cannot be read costs the chips, never the feed.
  }

  for (const manifest of manifests) {
    const hasPhoto = resolveAutomationPhoto(contextRoot, manifest.photo) !== null;
    agents.push({ slug: manifest.slug, title: manifest.title, hasPhoto });

    // ONE bounded read per agent, and everything else is derived from it.
    // Unread used to come from `threadUnread`, which re-read the same files a
    // second time — twice the I/O for an answer this loop already has, and two
    // places that could drift apart. Deriving it here makes the chip count and
    // the per-message bars the same computation by construction, which is the
    // property that matters more than the saving.
    const entries = readThread(contextRoot, manifest.slug, { days: FEED_DAY_WINDOW });
    if (entries.length === 0) continue;

    const watermark = threadReadWatermark(contextRoot, manifest.slug, home);
    // `kind: 'user'` excluded — you do not badge yourself for your own reply.
    // Same rule as the store's own `threadUnread`, kept identical on purpose.
    const count = entries.filter((e) => e.kind !== 'user' && (watermark === null || e.id > watermark)).length;
    if (count > 0) unreadBySlug[manifest.slug] = count;

    const cache = readAutomationCache(contextRoot, manifest.slug);
    const runsByFire = new Map((cache?.history ?? []).map((e) => [e.firedAt, e]));

    const byRun = new Map<string, ThreadEntry[]>();
    for (const e of entries) {
      const list = byRun.get(e.runId);
      if (list) list.push(e); else byRun.set(e.runId, [e]);
    }
    for (const [runId, runEntries] of byRun) {
      messages.push(
        buildFeedMessage(
          contextRoot, manifest, hasPhoto, runId, runEntries,
          runsByFire.get(runId) ?? null, watermark,
          questionByRun.get(`${manifest.slug}::${runId}`) ?? null,
          cache?.history ?? [],
        ),
      );
    }
  }

  // Sorted by the run's own entry ids, not by `at` — two machines' clocks
  // disagree and the ids are what survive that.
  messages.sort((a, b) => (a.newestId ?? '') < (b.newestId ?? '') ? -1 : (a.newestId ?? '') > (b.newestId ?? '') ? 1 : 0);
  const limited = opts.limit !== undefined && messages.length > opts.limit
    ? messages.slice(messages.length - opts.limit)
    : messages;

  return {
    messages: limited,
    unreadBySlug,
    unreadTotal: Object.values(unreadBySlug).reduce((n, v) => n + v, 0),
    // Counted over `limited`, the same list the chips filter — a total that
    // counted messages the window dropped would point at rows nobody can
    // reach. `unreadTotal` differs deliberately: it is a per-slug sum and the
    // sidebar badge reads it.
    needsYouTotal: limited.filter((m) => m.needsYou).length,
    agents,
  };
}
