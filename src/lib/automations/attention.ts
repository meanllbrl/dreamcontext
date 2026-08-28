/**
 * Runs that need a human, and the machine-local watermark that stops them
 * arriving twice (D7 / D-I).
 *
 * THE PROBLEM THIS SOLVES. An automation runs while nobody is at the keyboard.
 * When it stops to ask a question, or crashes, the only trace is a card on a
 * board the user has to think to visit and a notification that has long since
 * been dismissed. D7's answer is that a run needing a human opens as a chat
 * tab — the surface where it can actually be answered — the next time the app
 * is looking. This module decides WHICH runs qualify and remembers which ones
 * have already been shown.
 *
 * ONLY RUNS THAT NEED SOMEONE. Deliberately not "every completed run": twelve
 * automations firing overnight would greet the user with twelve tabs, of which
 * eleven say "done, here is your digest" and want nothing. A tab is an
 * interruption; spending one on a run that finished cleanly teaches the user
 * to close them without reading, which costs exactly the run that did need
 * them. Clean runs keep the notification and the card's own "open chat".
 *
 * MACHINE-LOCAL, NEVER THE BRAIN (D-I). The watermark lives beside the queue in
 * `~/.dreamcontext/`, for a sharper reason than the queue's: a synced watermark
 * would make ANOTHER machine's app burst-open tabs — and each of those tabs is
 * a `--resume` of a `bypassPermissions` conversation. Same threat class as a
 * synced queue entry, one door further in.
 *
 * A READ NEVER CONSUMES. `attentionRuns` is pure over the stores; the watermark
 * advances only through `ackAttention`, called by the client once the tabs are
 * actually open. A read that consumed would lose every run in the window
 * whenever the app was closed mid-open, which is the one moment this feature
 * exists to cover.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { listAutomations, readAutomationCache, isSafeAutomationSlug } from './store.js';
import { pendingQuestion } from './hitl.js';
import { readAutomationSession } from './session-registry.js';
import { findTranscriptBySessionId } from '../transcript-locate.js';
import type { RunStatus } from './types.js';

/** A watermark older than this is pruned on write. A project the user stopped
 *  opening should not keep a row forever; re-arriving with no watermark simply
 *  means the first look after that shows whatever currently needs attention,
 *  which is the correct behaviour for a fresh start. */
const WATERMARK_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Why this run wants a human.
 *
 *  - `question` — it stopped mid-flight and asked. The conversation is live in
 *    the sense that matters: answering it resumes the run.
 *  - `failed` — it crashed or timed out. Nothing is waiting on the human, but
 *    the transcript is the only place the cause is legible, and an automation
 *    that fails silently on a schedule fails forever.
 */
export type AttentionReason = 'question' | 'failed';

export interface AttentionRun {
  slug: string;
  /** The automation's display title — the tab and header need it, and neither
   *  the cache nor the question store carries it. */
  automationTitle: string;
  reason: AttentionReason;
  /** The conversation to resume. Never null: a run with no session is filtered
   *  out here rather than handed on to fail at the resume (`--resume` against a
   *  uuid with no transcript does not error — it fresh-pins an empty chat under
   *  that id, which would claim to be the run and not be). */
  sessionId: string;
  /** The scheduled fire this run answered for. */
  firedAt: string;
  /** When this became worth surfacing — the question's creation, or the run's
   *  finish. THE FIELD THE WATERMARK COMPARES AGAINST. */
  at: string;
  status: RunStatus;
  error: string | null;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  outputPath: string | null;
}

interface WatermarkFile {
  /** ISO of the newest `AttentionRun.at` this machine has already opened, per
   *  project root. */
  [projectRoot: string]: string;
}

export function attentionWatermarkPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'automations-tabs.json');
}

/** Never throws: an unreadable file degrades to "nothing has been shown", which
 *  costs at most a re-opened tab. The opposite failure — treating a corrupt
 *  file as "everything has been shown" — would silently swallow the question
 *  this whole module exists to surface. */
function readAll(home: string): WatermarkFile {
  const path = attentionWatermarkPath(home);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: WatermarkFile = {};
    for (const [projectRoot, at] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof projectRoot !== 'string' || !projectRoot) continue;
      if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) continue;
      out[projectRoot] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/** Atomic write at mode 0600, pruning stale project rows — the same discipline
 *  `queue.ts` and `card-registry.ts` use. */
function writeAll(home: string, all: WatermarkFile, nowMs: number): void {
  const path = attentionWatermarkPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const kept: WatermarkFile = {};
  for (const [projectRoot, at] of Object.entries(all)) {
    const t = Date.parse(at);
    if (Number.isFinite(t) && nowMs - t > WATERMARK_TTL_MS) continue;
    kept[projectRoot] = at;
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
}

/** The newest `at` this project has already opened tabs for, or null. */
export function attentionWatermark(projectRoot: string, home: string = homedir()): string | null {
  return readAll(home)[projectRoot] ?? null;
}

/**
 * Advance the watermark. MONOTONIC: an older `upTo` than the one on disk is
 * ignored rather than written, so a slow response arriving after a newer one
 * cannot rewind the mark and re-open tabs the user has already dealt with.
 */
export function ackAttention(projectRoot: string, upTo: string, home: string = homedir(), nowMs: number = Date.now()): void {
  const t = Date.parse(upTo);
  if (!Number.isFinite(t)) return;
  const all = readAll(home);
  const existing = all[projectRoot] ? Date.parse(all[projectRoot]) : NaN;
  if (Number.isFinite(existing) && existing >= t) return;
  writeAll(home, { ...all, [projectRoot]: new Date(t).toISOString() }, nowMs);
}

/**
 * Did THIS machine's own runner produce this session?
 *
 * THE LEAK THIS CLOSES. A question record lives at
 * `automations/hitl/<slug>/<id>.json` — inside the brain, kept out of git only
 * by a `.gitignore` line the runner re-ensures best-effort on every run. The
 * runner's own comment at that call site says what a miss costs: the file
 * "holds a live, resumable session id, and `sleep done` auto-commits and
 * pushes, so the miss publishes a bypassPermissions capability to every
 * teammate who pulls." The window is real — a project whose `.gitignore` was
 * committed before HITL existed gets no coverage until the first run adds it.
 *
 * The WS resume gate (`shouldRejectAutomationResume`) does NOT cover this
 * source: it decides "claimed by an automation" by scanning
 * `automations/cache/*.json` history only, so a uuid that reaches a client
 * solely through the question store is invisible to it and the resume proceeds.
 * That blind spot was harmless while a question's session could only be reached
 * by a human clicking a specific run; auto-open is the first thing that would
 * turn a pulled-in question file into an unattended `--resume`.
 *
 * So the machine-local binding is checked HERE, before the uuid is ever
 * surfaced — the same authority `resumeWithAnswer` and the WS gate already
 * treat as final. A genuine local question always passes: the runner binds
 * every parsed run's session (`recordAutomationSession`, right after
 * `backfillQuestionSession`). One that arrived over sync never does.
 *
 * PER-SLUG (`readAutomationSession`), NOT the WS gate's slug-agnostic
 * `isAutomationBoundSession`. That difference is the whole point and it is easy
 * to get wrong: the gate is handed a bare uuid off a query string and has no
 * slug to check against, so slug-agnostic is correct THERE. Here the slug is
 * right in hand — and discarding it admits a confused-deputy. A uuid bound to a
 * REAL, already-approved automation is also visible in that automation's
 * brain-synced cache; anyone who can write the shared brain could plant a
 * second automation whose question record claims the same uuid with
 * attacker-authored text. Slug-agnostic, that passes: the uuid genuinely IS
 * bound — just to something else. The human would then answer what they believe
 * is the planted automation's question straight into the real automation's live
 * `bypassPermissions` session. Binding must mean "bound to THIS automation".
 */
function locallyBound(slug: string, sessionId: string, home: string): boolean {
  return readAutomationSession(slug, sessionId, home) !== null;
}

/**
 * Is there actually a conversation on disk to resume?
 *
 * A SESSION ID IS NOT A TRANSCRIPT, and the difference is not benign here.
 * `--resume` against a uuid with no transcript does NOT fail: the chat route
 * falls back to `--session-id` and FRESH-PINS a brand-new, empty conversation
 * under that same uuid (`agent-chat.ts`'s `freshPin`). The user would be looking
 * at a blank chat that claims to be their run — with no error, no toast, and no
 * inline question card, because the turns that would render it do not exist.
 *
 * `runChatUnavailableReason` already refuses this for the history-row route.
 * Auto-open and the card's "Answer in chat" reach a conversation WITHOUT going
 * through that check — and a question is precisely the case where the gap
 * bites, because this feature is built to tolerate a question sitting for days
 * while nothing owns the transcript's lifetime (Claude Code prunes it; so does
 * any disk cleanup). So the same question is answered here, at the only point
 * both surfaces pass through.
 */
function hasTranscript(sessionId: string, home: string): boolean {
  return findTranscriptBySessionId([sessionId], home) !== null;
}

/** Statuses that mean the run itself went wrong. `blocked`/`deferred`/
 *  `orphaned`/`awaiting-*` are all deliberate refusals that never reached a
 *  process — they have no transcript to open, and they are already stated on
 *  the card. */
const FAILED_STATUSES = new Set<RunStatus>(['failed', 'timeout']);

/**
 * Every run in this project that wants a human and became so AFTER `since`,
 * oldest first.
 *
 * Oldest first because the caller opens them in order and the newest should
 * end up the focused tab — the same rule a mail client applies to a batch that
 * arrived while you were away.
 *
 * The question path reads `pendingQuestion`, NOT `cache.history`. That is the
 * whole point: a gate refusing a fire re-records on every tick, so the asking
 * run gets pushed off the end of the bounded history well before a human
 * looks. The question record is the only thing that still knows its uuid.
 */
export function attentionRuns(
  contextRoot: string,
  since: string | null,
  opts: { limit?: number; home?: string } = {},
): AttentionRun[] {
  const home = opts.home ?? homedir();
  const sinceMs = since ? Date.parse(since) : NaN;
  const after = (at: string): boolean => {
    if (!Number.isFinite(sinceMs)) return true;
    const t = Date.parse(at);
    // An UNPARSEABLE timestamp shows the run rather than hiding it. These are
    // JSON files a human or an agent can hand-edit, and the two failure
    // directions are not symmetric: re-showing a run costs a tab the user
    // closes, while hiding one costs exactly the question this module exists to
    // surface — silently, and forever, since no later poll would reconsider it.
    return Number.isFinite(t) ? t > sinceMs : true;
  };

  const out: AttentionRun[] = [];
  const seenFailure = new Set<string>();
  for (const manifest of listAutomations(contextRoot)) {
    const slug = manifest.slug;
    if (!isSafeAutomationSlug(slug)) continue;
    const cache = readAutomationCache(contextRoot, slug);

    // 1. An open question. At most one per automation by construction (the
    //    review gate refuses a second fire while one is outstanding), and an
    //    `'approval'` question is skipped: `hitl.ts` forces its `sessionId`
    //    null because that read-only session is discarded either way, so there
    //    is nothing to resume. It is answered on the card instead.
    const q = pendingQuestion(contextRoot, slug);
    if (
      q && q.sessionId
      && locallyBound(slug, q.sessionId, home)
      && hasTranscript(q.sessionId, home)
      && after(q.createdAt)
    ) {
      out.push({
        slug,
        automationTitle: manifest.title,
        reason: 'question',
        sessionId: q.sessionId,
        firedAt: q.runFiredAt,
        at: q.createdAt,
        status: 'awaiting-review',
        error: null,
        // The question record is not a run summary and carries no telemetry.
        // Null is honest; a zero would read as "cost nothing, took no turns".
        costUsd: null,
        numTurns: null,
        durationMs: null,
        // A run that stopped to ask published nothing — that IS the gate.
        outputPath: null,
      });
    }

    // 2. Failures with a transcript. `finishedAt`, not `firedAt`: a catch-up
    //    run can answer for a fire two days old, and comparing the SCHEDULE
    //    against a watermark that tracks when things were shown would silently
    //    drop it.
    for (const e of cache?.history ?? []) {
      if (!FAILED_STATUSES.has(e.status)) continue;
      if (!e.sessionId) continue;
      // The failed path needs the SAME per-slug binding as the question path.
      // The WS gate covers this source for provenance, but it is slug-agnostic,
      // so a planted cache claiming another automation's real uuid would pass it
      // exactly as a planted question record would — same confused-deputy, one
      // file over. `recordAutomationSession` binds every parsed run, so a
      // genuine local failure always passes.
      if (!locallyBound(slug, e.sessionId, home)) continue;
      if (!hasTranscript(e.sessionId, home)) continue;
      if (!after(e.finishedAt)) continue;
      // At most ONE failure per automation. A job whose manifest broke fails on
      // every tick, and a global cap applied to the flat list would let that one
      // automation's twenty repeats push a DIFFERENT automation's single failure
      // out of the window — and, because the ack then advances past everything
      // returned, push it out permanently. Its older failures are still in the
      // run history, where old failures belong; what must never be lost is the
      // fact that some OTHER automation needs a look. History is newest-first,
      // so the first one reached is the newest.
      if (seenFailure.has(slug)) continue;
      seenFailure.add(slug);
      out.push({
        slug,
        automationTitle: manifest.title,
        reason: 'failed',
        sessionId: e.sessionId,
        firedAt: e.firedAt,
        at: e.finishedAt,
        status: e.status,
        error: e.error,
        costUsd: e.costUsd,
        numTurns: e.numTurns,
        durationMs: e.durationMs,
        outputPath: e.outputPath,
      });
    }
  }

  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // A hard ceiling on how many tabs one look can open — each one is a spawned
  // CLI process, and a machine closed for a fortnight must not open eighty
  // conversations at once.
  //
  // THE OLDEST ARE KEPT, NOT THE NEWEST, and that is the correctness half rather
  // than a preference. The client acks the newest run it actually opened, and
  // the watermark is monotonic — so anything the cap withheld that was OLDER
  // than something transmitted would be stepped over and never offered again.
  // Keeping the tail did exactly that: with nine distinct automations needing
  // attention in one unseen window, the oldest went to no one and the ack
  // advanced past it, losing precisely the "an automation that fails silently on
  // a schedule fails forever" case this module exists to prevent.
  //
  // Taking the head instead makes the cap a PACE, not a filter: this look opens
  // the oldest N, acks up to them, and the next poll (30s) picks up where it
  // stopped, until the backlog is drained. Nothing is ever skipped. With at most
  // one failure per automation above, a realistic backlog is bounded by the
  // number of automations, so this is one or two extra polls — not a queue.
  const limit = opts.limit ?? 8;
  return out.length > limit ? out.slice(0, limit) : out;
}
