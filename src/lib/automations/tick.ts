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
 * `killRunGroup` (runner.ts) is CLI-ONLY and is never imported here — there is
 * no automatic reaper (see the task's Constraints & Decisions on orphaned
 * runs). `tests/unit/automations-no-auto-reap.test.ts` source-scans this file
 * to enforce that by construction, not by convention.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDue, type DueVerdict } from './schedule.js';
import { listAutomations, readAutomationCache } from './store.js';
import { listRegisteredProjects, recordTickCompleted, recordTickStarted } from './registry.js';
import { rotateLogIfLarge } from './launchd.js';
import { runAutomation, type RunOutcome } from './runner.js';

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
}

/** Per-manifest disposition for one `tickProject` pass — lets a caller log or
 *  inspect WHY each considered automation did or didn't run, without needing
 *  the full `RunOutcome` for the ones that never attempted a run at all.
 *
 *  `'blocked'` and `'orphaned'` are `RunOutcome.status` values `isDue` cannot
 *  itself predict (approval state, a previous run's live orphan) — surfaced
 *  here when the actual run outcome reaches them. Every OTHER non-`'due'`
 *  run outcome (`'ok'`, `'failed'`, `'timeout'`, `'deferred'`) has no
 *  dedicated slot in this literal union; those stay `'due'` (the automation
 *  WAS due and an attempt was made) — the full disposition is still available
 *  via `TickProjectResult.ran`. See this module's `verdictFor` for the exact
 *  mapping. */
export interface SlugVerdict {
  slug: string;
  verdict: DueVerdict['reason'] | 'blocked' | 'disabled' | 'orphaned';
}

export interface TickProjectResult {
  projectRoot: string;
  contextRoot: string;
  /** Total manifests read from disk this pass (due or not, enabled or not). */
  considered: number;
  /** One entry per automation actually handed to `runImpl`, in run order. */
  ran: RunOutcome[];
  /** One entry per considered manifest — always `considered.length` long. */
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
  if (status === 'blocked' || status === 'orphaned') return status;
  return 'due';
}

/**
 * Tick ONE project: list its manifests, evaluate dueness (skipping disabled
 * automations without ever calling `isDue` for them), and run every due one
 * to completion, in order, before considering the next. Reads nothing beyond
 * `contextRoot`'s own manifest/cache files — a project with zero due
 * automations spawns nothing.
 */
export async function tickProject(projectRoot: string, opts: TickOptions = {}): Promise<TickProjectResult> {
  const now = opts.now ?? new Date();
  const logFn = opts.log ?? (() => {});
  const runImpl = opts.runImpl ?? runAutomation;
  const contextRoot = join(projectRoot, CONTEXT_DIR_NAME);

  const manifests = listAutomations(contextRoot);
  const verdicts: SlugVerdict[] = [];
  const ran: RunOutcome[] = [];

  for (const manifest of manifests) {
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
