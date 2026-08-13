/**
 * Automations — the dispatcher's tick. This is the ONE function the generated
 * launchd wrapper execs every 5 minutes (`dreamcontext automations tick --all`,
 * see the launchd.ts wrapper + the task's dispatcher-resolution design): it
 * must stay cheap when nothing is due, because a long-running tick eats the
 * NEXT `StartInterval` firing (macOS `man launchd.plist`: a job still running
 * at the next scheduled interval simply misses it — there is no queueing).
 * That is also why due automations run SEQUENTIALLY within a project: it
 * serializes everything, and correctness under a missed/coalesced interval is
 * entirely the watermark + `catchup_hours` model's job, not this file's.
 *
 * Two layers, deliberately split:
 *  - `tickProject` — ONE project's manifests → dueness → sequential runs.
 *    No registry, no heartbeat, no log rotation — a narrow, directly testable
 *    unit that only touches the project's own `_dream_context/automations/`.
 *  - `tickAll` — iterates every machine-registered project, wrapping the
 *    dispatcher heartbeat (`recordTickStarted`/`recordTickCompleted`) and log
 *    rotation around the whole pass. A project whose `_dream_context/` is
 *    missing (moved/deleted since it registered) is warned about and skipped
 *    — never abandons the rest of the loop.
 *
 * "Ships fully disabled" lives here as much as anywhere: an empty registry
 * (the fresh-machine state) must be a SILENT no-op that reads only the
 * registry file and manifest directories — no shell, no `claude`, spawned.
 *
 * THE DRAIN, BEFORE `isDue()` (D9). A fire that could not run while the
 * per-slug lock was held (`queue.ts`'s whole reason to exist) is drained and
 * attempted FIRST, before this pass asks `isDue()` a fresh question that has
 * nothing to do with what is already owed. Draining re-resolves the manifest
 * rather than trusting the queue entry's own copy of it: `manifest.enabled`
 * is otherwise checked ONLY inside the `isDue()` loop below, and firing a
 * drained entry without repeating that check would let a disabled automation
 * with a stale queue entry run anyway (A4). A disabled automation's queued
 * fire is KEPT — re-enqueued with its ORIGINAL `firedAt` — never dropped: the
 * user toggling something off for an hour must not destroy a fire it is owed
 * (R5); the queue's own 7-day TTL is what eventually bounds it. A fire whose
 * automation no longer exists at all IS dropped (the drain already cleared
 * its entry, so there is nothing left to keep). A slug the drain phase
 * actually ran is skipped by the `isDue()` loop below — it already has its
 * verdict for this pass, and firing it again would spawn a second `claude`
 * for the same owed fire in one tick.
 *
 * `killRunGroup` (runner.ts) is CLI-ONLY and is never imported here — there is
 * no automatic reaper (see the task's Constraints & Decisions on orphaned
 * runs). `tests/unit/automations-no-auto-reap.test.ts` source-scans this file
 * to enforce that by construction, not by convention.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDue, type DueVerdict } from './schedule.js';
import { getAutomation, listAutomations, readAutomationCache } from './store.js';
import { drainQueue, enqueueFire } from './queue.js';
import { listRegisteredProjects, recordTickCompleted, recordTickStarted } from './registry.js';
import { rotateLogIfLarge } from './launchd.js';
import { runAutomation, type RunOutcome } from './runner.js';
import { pollTelegram, type PollResult } from './telegram.js';

/** The real poller. Cheap when Telegram is off: `readTelegramConfig` returns
 *  null and it returns without a single network call, which is the state every
 *  machine is in until someone runs `automations telegram setup`. */
const defaultPollTelegram = (contextRoot: string, home?: string): Promise<PollResult> =>
  pollTelegram(contextRoot, home);

/** `_dream_context/` sits directly under a registered project root — the same
 *  literal join used throughout the CLI (`config.ts`, `update.ts`) for this
 *  exact registered-root → context-root derivation. */
const CONTEXT_DIR_NAME = '_dream_context';

export interface TickOptions {
  /** Business "now" for dueness math and both heartbeat timestamps — a single
   *  fixed value (not a clock function), so one tick sees one consistent time
   *  across every project and automation it considers. Defaults to `new Date()`. */
  now?: Date;
  /** Machine-local home for the registry + heartbeat file. Defaults to the
   *  real `homedir()` (via each downstream module's own default). */
  home?: string;
  /** Defaults to a no-op — the CLI wires a real logger/log-file writer through
   *  this, mirroring `runner.ts`'s own `log` convention. */
  log?: (line: string) => void;
  /** Injectable so tests never spawn a real `claude`. Defaults to the real
   *  `runAutomation`. */
  runImpl?: typeof runAutomation;
  /** Injectable so NO test in this repo can reach api.telegram.org. Defaults
   *  to the real poller, which is itself a no-op when Telegram is unconfigured
   *  (the overwhelmingly common case). */
  pollTelegram?: (contextRoot: string, home?: string) => Promise<PollResult>;
}

/** Per-manifest disposition for one `tickProject` pass — lets a caller log or
 *  inspect WHY each considered automation did or didn't run, without needing
 *  the full `RunOutcome` for the ones that never attempted a run at all.
 *
 *  `'blocked'`, `'orphaned'`, `'awaiting-review'` and `'awaiting-approval'` are
 *  `RunOutcome.status` values `isDue` cannot itself predict (approval state, a
 *  previous run's live orphan, a question nobody has answered yet) — surfaced
 *  here when the actual run outcome reaches them. Every OTHER non-`'due'`
 *  run outcome (`'ok'`, `'failed'`, `'timeout'`, `'deferred'`) has no
 *  dedicated slot in this literal union; those stay `'due'` (the automation
 *  WAS due and an attempt was made) — the full disposition is still available
 *  via `TickProjectResult.ran`. See this module's `verdictFor` for the exact
 *  mapping. */
export interface SlugVerdict {
  slug: string;
  verdict: DueVerdict['reason'] | 'blocked' | 'disabled' | 'orphaned' | 'awaiting-review' | 'awaiting-approval';
}

export interface TickProjectResult {
  projectRoot: string;
  contextRoot: string;
  /** Total manifests read from disk this pass (due or not, enabled or not). */
  considered: number;
  /** One entry per automation actually handed to `runImpl`, in run order —
   *  a slug drained off the queue and run counts here too, and runs FIRST
   *  (the drain phase precedes the `isDue()` loop), before any slug `isDue()`
   *  found due this same pass. */
  ran: RunOutcome[];
  /** One entry per considered manifest — always `considered.length` long.
   *  A drained-and-run slug contributes its ONE entry from the drain phase
   *  (mapped through the same `verdictFor` the `isDue()` loop uses); a
   *  drained-but-kept (disabled) or drained-but-outside-catch-up slug
   *  contributes none from the drain phase — it is still a manifest on disk,
   *  so the `isDue()` loop below evaluates it fresh and contributes the one
   *  entry itself. A drained slug whose automation no longer exists at all
   *  contributes nothing anywhere, which is correct: it is not in `considered`
   *  either, since it was never read back off disk this pass. */
  verdicts: SlugVerdict[];
}

export interface TickAllResult {
  projects: TickProjectResult[];
  /** Registered project roots whose `_dream_context/` no longer exists on
   *  disk — warned about, skipped, and the loop continues regardless. */
  missing: string[];
  startedAt: string;
  /** Real wall-clock elapsed time for this whole pass — `now` is a fixed
   *  business timestamp (so it can't itself measure elapsed time), but a tick
   *  that runs several automations sequentially genuinely takes real time,
   *  and that duration is diagnostic value worth keeping. */
  durationMs: number;
}

/** Map a `RunOutcome.status` onto the narrower `SlugVerdict` literal union —
 *  only `'blocked'` and `'orphaned'` get a dedicated slot (they are the two
 *  run-time-only gates `isDue` cannot foresee); every other status collapses
 *  to `'due'`, with the full status still available in `ran[]`. */
function verdictFor(status: RunOutcome['status']): SlugVerdict['verdict'] {
  // `awaiting-review` and `awaiting-approval` join the two run-time-only gates
  // for the same reason those are here: `isDue` cannot foresee either of them
  // (both depend on whether a human has answered a question since the last
  // pass), and a tick that reported them as a plain `due` would say an
  // automation ran when it deliberately stopped and asked instead. They stay
  // DISTINCT from each other because they are different questions: one asks
  // about a run's own work, the other asks whether to trust a changed manifest
  // at all — and only the second leaves the automation ungated until answered.
  if (
    status === 'blocked' ||
    status === 'orphaned' ||
    status === 'awaiting-review' ||
    status === 'awaiting-approval'
  ) {
    return status;
  }
  return 'due';
}

/**
 * Tick ONE project: drain the queue (D9), evaluate dueness for everything
 * else (skipping disabled automations without ever calling `isDue` for
 * them), and run every due one to completion, in order, before considering
 * the next. Reads nothing beyond `contextRoot`'s own manifest/cache files and
 * this machine's queue file — a project with zero due automations and zero
 * queued fires spawns nothing.
 */
export async function tickProject(projectRoot: string, opts: TickOptions = {}): Promise<TickProjectResult> {
  const now = opts.now ?? new Date();
  const logFn = opts.log ?? (() => {});
  const runImpl = opts.runImpl ?? runAutomation;
  const contextRoot = join(projectRoot, CONTEXT_DIR_NAME);

  const manifests = listAutomations(contextRoot);
  const verdicts: SlugVerdict[] = [];
  const ran: RunOutcome[] = [];
  // Slugs the drain phase already ran this pass — the `isDue()` loop below
  // must not hand them a second run for the same owed fire.
  const drainedAndRan = new Set<string>();

  // ── Drain, BEFORE isDue() (D9/A4/R5 — see this module's header) ──────────
  const drained = drainQueue(projectRoot, opts.home, now.getTime());
  for (const fire of drained) {
    // Re-resolve the manifest rather than trusting the queue entry: it may
    // have been removed, or disabled, since it was queued.
    const manifest = getAutomation(contextRoot, fire.slug);
    if (!manifest) {
      logFn(`[automations] queued fire for ${fire.slug} has no manifest — dropping`);
      continue;
    }
    if (!manifest.enabled) {
      // OWED, not lost: re-queue with the ORIGINAL firedAt so a later drain
      // still advances the watermark to the fire it answers for, never to
      // whenever it happened to be re-enqueued. The `isDue()` loop below
      // still gives this slug its normal 'disabled' verdict, so this branch
      // deliberately adds none — `verdicts[]` stays `considered.length` long.
      enqueueFire(projectRoot, fire.slug, fire.firedAt, opts.home, now.getTime());
      logFn(`[automations] ${fire.slug} is disabled — the queued fire from ${fire.firedAt} is kept for later`);
      continue;
    }

    // Catch-up bound: a queued fire this old is no more useful than a
    // schedule-derived one `isDue` would itself refuse as 'outside-catchup'.
    // `schedule.ts` doesn't export that check standalone (it only ever
    // applies it to a schedule-derived fire), so it is reproduced here with
    // the identical formula (`isDue`'s own `catchupHours * 60 * 60 * 1000`).
    const firedAtMs = Date.parse(fire.firedAt);
    const catchupMs = manifest.catchupHours * 60 * 60 * 1000;
    if (!Number.isFinite(firedAtMs) || now.getTime() - firedAtMs > catchupMs) {
      logFn(
        `[automations] queued fire for ${fire.slug} (fired ${fire.firedAt}) is outside its ${manifest.catchupHours}h catch-up window — dropping`,
      );
      continue;
    }

    logFn(`[automations] ${fire.slug} draining a queued fire (fired ${fire.firedAt}) — running`);
    const outcome = await runImpl(contextRoot, fire.slug, {
      now: () => now,
      fireAt: new Date(firedAtMs),
      home: opts.home,
      log: logFn,
    });
    ran.push(outcome);
    verdicts.push({ slug: fire.slug, verdict: verdictFor(outcome.status) });
    drainedAndRan.add(fire.slug);
    logFn(`[automations] ${fire.slug} finished (drained): ${outcome.status}`);
  }

  // ── isDue(), for everything the drain phase didn't already run ──────────
  for (const manifest of manifests) {
    if (drainedAndRan.has(manifest.slug)) continue;

    if (!manifest.enabled) {
      verdicts.push({ slug: manifest.slug, verdict: 'disabled' });
      continue;
    }

    const cache = readAutomationCache(contextRoot, manifest.slug);
    const due = isDue(manifest.schedule, cache?.lastFireAt ?? null, now, manifest.catchupHours);
    if (!due.due) {
      verdicts.push({ slug: manifest.slug, verdict: due.reason });
      continue;
    }

    logFn(`[automations] ${manifest.slug} is due (fire ${due.fireAt?.toISOString() ?? 'unknown'}) — running`);
    const outcome = await runImpl(contextRoot, manifest.slug, {
      now: () => now,
      fireAt: due.fireAt ?? now,
      home: opts.home,
      log: logFn,
    });
    ran.push(outcome);
    verdicts.push({ slug: manifest.slug, verdict: verdictFor(outcome.status) });
    logFn(`[automations] ${manifest.slug} finished: ${outcome.status}`);
  }

  // AFTER the runs, so a card a run just proposed is posted and answerable in
  // this same pass rather than waiting five minutes for the next one.
  //
  // This lives in the tick — not in the server, not in a daemon — because that
  // is the only process guaranteed to be alive when an automation fires. The
  // whole reason a person needs Telegram is that they are not at the Mac; a
  // channel that only drains while the app is open would work exactly when it
  // is least needed. A verdict therefore lands within one tick, which is the
  // right latency for a scheduler and the wrong one for a chat — the server
  // polls faster while it happens to be up.
  const poll = opts.pollTelegram ?? defaultPollTelegram;
  try {
    const result = await poll(contextRoot, opts.home);
    if (result.processed > 0) logFn(`[automations] telegram: ${result.processed} update(s) handled`);
    if (result.unauthorized > 0) {
      // Never acted on, always said: a bot being messaged by someone who is not
      // you is worth knowing about, even though the gate already dropped it.
      logFn(`[automations] telegram: ${result.unauthorized} update(s) dropped from an unauthorized chat`);
    }
  } catch (err) {
    // Telegram is a CHANNEL, not the gate. A broken token, a network blip or a
    // rate limit must never stop automations from running or cards from being
    // answerable everywhere else.
    logFn(`[automations] telegram polling failed (automations are unaffected): ${(err as Error).message}`);
  }

  return { projectRoot, contextRoot, considered: manifests.length, ran, verdicts };
}

/**
 * Tick every project registered on this machine, sequentially. An empty
 * registry is a SILENT no-op (no log lines beyond what the heartbeat write
 * itself requires, no automations dir ever read) — the "ships fully
 * disabled" guarantee for a fresh machine. Heartbeat timestamps are written
 * unconditionally, including for a no-op pass, so a dead/never-installed
 * dispatcher and a healthy-but-idle one stay distinguishable.
 */
export async function tickAll(opts: TickOptions = {}): Promise<TickAllResult> {
  const now = opts.now ?? new Date();
  const logFn = opts.log ?? (() => {});
  const home = opts.home;
  const wallStart = Date.now();

  recordTickStarted(now, home);
  rotateLogIfLarge(home);

  const projectRoots = listRegisteredProjects(home);
  const missing: string[] = [];
  const projects: TickProjectResult[] = [];

  for (const projectRoot of projectRoots) {
    const contextRoot = join(projectRoot, CONTEXT_DIR_NAME);
    if (!existsSync(contextRoot)) {
      missing.push(projectRoot);
      logFn(`[automations] registered project's _dream_context/ is missing, skipping: ${projectRoot}`);
      continue;
    }
    const result = await tickProject(projectRoot, { ...opts, now });
    projects.push(result);
  }

  const durationMs = Date.now() - wallStart;
  recordTickCompleted(now, durationMs, home);

  return { projects, missing, startedAt: now.toISOString(), durationMs };
}
