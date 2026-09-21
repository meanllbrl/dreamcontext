import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { listAutomations, readAutomationCache, resolveAutomationPhoto } from './store.js';
import { extractNotificationSummary } from './runner.js';
import { readThread, threadReadWatermark } from './threads.js';
import type { AutomationManifest, RunEvent, ThreadEntry } from './types.js';

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
  /** AUTHORED entries beyond the body (agent posts + user replies). System
   *  rows are not replies — they are bookkeeping, and counting them would say
   *  "2 replies" about a run nobody has spoken in. */
  replyCount: number;
  lastReplyAt: string | null;
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
  /** Every agent in the channel, for the chip row and the avatars — including
   *  those that have never run, so a new agent is visible before its first
   *  fire. */
  agents: { slug: string; title: string; hasPhoto: boolean }[];
}

const TERMINAL: Record<string, FeedStatus> = { ok: 'done', failed: 'failed', timeout: 'timeout', skipped: 'skipped' };
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
  const authored = ordered.filter((e) => (e.kind === 'agent' || e.kind === 'user') && e.id !== ask?.id);

  // The FIRST post is the message; everything authored after it is in the
  // thread. That is the prototype's shape and it is also the honest one — an
  // agent's opening line is what it wanted the human to read.
  const body = posts[0] ?? null;
  const rest = authored.filter((e) => e.id !== body?.id);

  const files: FeedFile[] = [];
  const seen = new Set<string>();
  for (const e of posts) {
    for (const f of e.files ?? []) {
      if (!seen.has(f)) { seen.add(f); files.push({ path: f, name: basename(f) }); }
    }
  }
  // The published document is a file card even when no post attached it —
  // "the run wrote something and here it is" is the one attachment every
  // successful run has.
  //
  // CONTENT is checked, not existence. `RunEvent.outputPath` is the path the
  // run WOULD have published to, and the runner creates that file whether or
  // not the run produced anything — a failed run leaves a ZERO-BYTE document
  // behind. So `existsSync` is true for a file there is nothing to read in,
  // and the card it offered opened on a blank page. A card is a promise that
  // there is something there; the promise is bytes, not an inode.
  if (run?.outputPath && hasContent(run.outputPath)) {
    const rel = toBrainRelative(contextRoot, run.outputPath);
    if (!seen.has(rel)) { seen.add(rel); files.push({ path: rel, name: basename(rel) }); }
  }

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
    status: statusFor(ordered, run),
    durationMs: run?.durationMs ?? null,
    costUsd: run?.costUsd ?? null,
    ask: ask ? { text: ask.text, at: ask.at } : null,
    text: body?.text ?? fallback ?? '',
    textFrom: body ? 'post' : failure ? 'error' : skipped ? 'skipped' : fallback ? 'result' : 'none',
    files: files.slice(0, FILES_PER_MESSAGE),
    replyCount: rest.length,
    lastReplyAt: rest[rest.length - 1]?.at ?? null,
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
        buildFeedMessage(contextRoot, manifest, hasPhoto, runId, runEntries, runsByFire.get(runId) ?? null, watermark),
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
    agents,
  };
}
