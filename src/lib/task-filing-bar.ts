import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dedupCandidate, type DedupVerdict } from './embeddings/dedup.js';
import { isEmbedModelDownloaded } from './embeddings/embedder.js';
import { embeddingCacheCoversType, embeddingCacheUsable } from './embeddings/store.js';
import { slugify } from './id.js';
import { inspectSleepLock, type SleepState } from './sleep-consolidation.js';
import { readSetupConfig } from './setup-config.js';
import { resolveMaxNewTasksPerCycle } from './sleep-settings.js';
import {
  declinedMatchThreshold,
  findDeclined,
  matchDeclinedSemantically,
  type DeclinedIdea,
} from './task-declined.js';
import { resolveTombstone } from './task-tombstones.js';

/**
 * task-filing-bar — the ONE gate every writer passes before a sleep cycle is
 * allowed to open a new task.
 *
 * WHY A DETERMINISTIC GATE AT ALL. `agents/sleep-tasks.md` describes the bar in
 * prose, and prose is necessary — judging whether a task is worth filing is a
 * judgement. But prose is not SUFFICIENT: a specialist that forgets the rule,
 * or a future one that never read it, still writes to disk. So the rule that
 * can be checked mechanically is checked mechanically.
 *
 * WHAT THE NUMBERS MEAN. B0 audited all 116 tasks this brain created since
 * 2026-08-01: the thinnest REAL task carries 146 characters of justification,
 * the median 2,532, and exactly ONE task had none at all — the auto-filed
 * curator chore, born from an empty template and resurrected every cycle. So
 * the 40-character floor here is deliberately far below the observed floor of
 * real work: it is a guard against the EMPTY TEMPLATE, not a quality judge.
 * Quality is the prompt's job; this is the thing prose cannot guarantee.
 *
 * ONE CHOKE POINT, BY CONSTRUCTION. Both `dreamcontext tasks create` and the
 * dashboard's `POST /api/tasks` call this. `LocalTaskBackend.create` stays
 * actor-free — it is the storage layer. A THIRD caller that files tasks must
 * call this too; there is no other enforcement point.
 *
 * ── WHY TWO SEMANTIC GATES, AND WHY THEY MAY BE OFF ─────────────────────────
 *
 * The owner's three real failure cases were: a sub-slice of an existing task
 * filed as its own task, an idea cancelled in a later session filed anyway, and
 * work belonging to another project. The first two are mechanically checkable,
 * so they are checked here — gate 5 refuses a candidate whose nearest TASK
 * neighbor is a near-twin, gates 4 and 6 refuse one that matches an idea a human
 * already declined. The third is judgement and stays in `agents/sleep-tasks.md`.
 *
 * THEY ARE A FLOOR UNDER PROSE, NOT A REPLACEMENT. Both need the embedding
 * layer, and it is legitimately absent on most vaults, so they run ONLY when all
 * three of these hold (see {@link semanticSkipReason}):
 *   1. the model is already on disk — this path must NEVER trigger the 113 MB
 *      first-time download from inside a `tasks create`;
 *   2. the cache is usable for the current model/version — no cold FULL rebuild;
 *   3. the cache already covers the TASK corpus. Clause 3 is not redundant: a
 *      cache holding only knowledge+feature vectors is "usable", and dedup'ing
 *      the task corpus against it would embed that whole corpus INLINE —
 *      measured on this brain, 3,501 chunks at ~89 ms ≈ 310 s inside ONE create,
 *      past the Bash timeout of the sleep sub-agent that ran it.
 * `DREAMCONTEXT_FILING_BAR_SEMANTIC=0` turns them off outright.
 *
 * WHEN THEY ARE OFF, THE BAR PASSES AND SAYS SO. The verdict carries
 * `neighbor: { state: 'unavailable' }` plus a notice the caller MUST print:
 * silence would read as a clean check, and the specialist would skip the keyword
 * recall that is then its only dedup.
 */

/** Minimum justification for a task filed by a sleep cycle. See the note above. */
export const MIN_SLEEP_WHY_CHARS = 40;

export type FilingActor = 'human' | 'sleep' | 'unknown';

/**
 * Passage embedder shape — matches `embedPassages`. Injectable for TESTS only
 * (the same extension-point idiom `DedupOptions.embed` uses); production leaves
 * it unset and gets the real model.
 */
export type FilingBarEmbedder = (
  texts: string[],
  onProgress?: (done: number, total: number) => void,
) => Promise<Float32Array[] | null>;

export interface FilingBarInput {
  /** The brain root (`_dream_context/`). */
  contextRoot: string;
  /** Who is filing. `unknown` is treated as sleep WHEN a cycle is live. */
  actor: FilingActor;
  /** The justification prose (`--why`). */
  why?: string | null;
  /** The slug this task would land on, when it is already known. */
  slug?: string;
  /** The task NAME — the dedup candidate's identity anchor (its title). */
  name?: string;
  /** The one-line scope (`--description`), when the caller has one. */
  description?: string;
  /**
   * `--neighbor-checked <slug>`: the nearest task the specialist actually looked
   * at and judged a separate concern. Lifts a REVIEW-band refusal, and only when
   * it names exactly that neighbor — naming it IS the proof of having looked.
   * Never lifts the merge band.
   */
  neighborChecked?: string;
  /**
   * `--declined-checked <key>`: the declined idea the specialist read and judged
   * different from this task. Lifts a SEMANTIC declined match (those bands
   * overlap — see `task-declined.ts`), never the exact-key match.
   */
  declinedChecked?: string;
  /**
   * Force the semantic gates on/off. Tests and the kill switch only; when unset,
   * the three-clause availability check decides.
   */
  semantic?: boolean;
  /**
   * Injectable passage embedder (tests). Supplying one IS an assertion that the
   * embedding layer is available, so it also turns the semantic gates on.
   */
  embed?: FilingBarEmbedder;
  /** Injected for tests; defaults to now. */
  nowMs?: number;
}

/**
 * What the neighbor gate managed to find out. `unavailable` is a first-class
 * outcome, not an error: the caller prints the notice and falls back to keyword
 * recall.
 */
export type FilingBarNeighbor =
  | { state: 'unavailable'; why: 'disabled' | 'no-index' | 'model-unavailable' }
  | {
      state: 'checked';
      verdict: DedupVerdict;
      top: { slug: string; docKey: string; title: string; relPath: string; sim: number } | null;
      neighbors: Array<{ docKey: string; sim: number }>;
      mergeThreshold: number;
      reviewThreshold: number;
    };

export interface FilingBarVerdict {
  allowed: boolean;
  /** Present when `allowed` is false — a message that names the rule AND the escape hatch. */
  reason?: string;
  /** True when the bar actually applied (a cycle is live / the env flag is set). */
  underBar: boolean;
  /** Present once the candidate reached the neighbor gate — refused or not. */
  neighbor?: FilingBarNeighbor;
  /**
   * The declined idea this candidate matched. Set on a REFUSAL and on a
   * `--declined-checked` lift alike, so the caller can log either.
   */
  declined?: {
    key: string;
    topic: string;
    declinedAt: string;
    reason: string;
    match: 'slug' | 'semantic';
    sim?: number;
  };
  /** Dim lines the caller MUST print — e.g. "neighbor check skipped …". */
  notices?: string[];
}

function readSleepStateSafe(contextRoot: string): SleepState | null {
  const path = join(contextRoot, 'state', '.sleep.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as SleepState;
  } catch {
    return null;
  }
}

/**
 * Is a sleep cycle running right now?
 *
 * Liveness-aware: a STALE epoch (the owning sleep crashed before `sleep done`)
 * does not count, or a crash would leave the bar switched on forever.
 */
export function isSleepCycleLive(contextRoot: string, nowMs = Date.now()): boolean {
  if (process.env.DREAMCONTEXT_AUTO_SLEEP === '1') return true;
  const state = readSleepStateSafe(contextRoot);
  if (!state) return false;
  const lock = inspectSleepLock(state, nowMs);
  return lock.locked && !lock.stale;
}

/** How many tasks THIS cycle has already filed under the bar. */
export function cycleTasksFiled(contextRoot: string): string[] {
  const state = readSleepStateSafe(contextRoot) as (SleepState & { cycle_tasks_filed?: unknown }) | null;
  const filed = state?.cycle_tasks_filed;
  return Array.isArray(filed) ? filed.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * Decide whether this task may be filed.
 *
 * The bar applies when a sleep cycle is LIVE (or `DREAMCONTEXT_AUTO_SLEEP=1`)
 * UNLESS the caller is an explicit human. That deliberately catches a
 * specialist that forgot to pass `--by sleep` — the lock is the evidence, not
 * the flag — while a person working during a cycle gets ONE clear refusal
 * naming the escape hatch rather than a silent block.
 *
 * ASYNC because the semantic gates embed text. The two early returns below stay
 * ahead of every read: an explicit human — the dashboard's Add-Task form is one —
 * must never pay a model load to file their own task.
 */
export async function assertTaskFilingBar(input: FilingBarInput): Promise<FilingBarVerdict> {
  const { contextRoot, actor } = input;
  const nowMs = input.nowMs ?? Date.now();

  // An explicit human is never under the bar, cycle or not.
  if (actor === 'human') return { allowed: true, underBar: false };
  if (!isSleepCycleLive(contextRoot, nowMs) && actor !== 'sleep') {
    return { allowed: true, underBar: false };
  }

  // Either a live cycle, or `--by sleep` outside one: hold the bar. A specialist
  // that names itself is taken at its word.
  return checkContent({
    contextRoot,
    why: input.why,
    slug: input.slug,
    name: input.name,
    description: input.description,
    neighborChecked: input.neighborChecked,
    declinedChecked: input.declinedChecked,
    semantic: input.semantic,
    embed: input.embed,
    cap: capFor(contextRoot),
    filed: cycleTasksFiled(contextRoot),
    actor,
  });
}

function capFor(contextRoot: string): number {
  // contextRoot is `<project>/_dream_context`; the config lives under it.
  return resolveMaxNewTasksPerCycle(readSetupConfig(join(contextRoot, '..'))?.sleep);
}

// ─── Semantic availability ──────────────────────────────────────────────────

type SemanticSkip = 'disabled' | 'no-index' | 'model-unavailable';

/** Why the semantic gates cannot run here, or null when they can. The module
 *  docstring explains what each clause prevents; the ORDER is cheapest-first. */
function semanticSkipReason(contextRoot: string): SemanticSkip | null {
  if (process.env.DREAMCONTEXT_FILING_BAR_SEMANTIC === '0') return 'disabled';
  if (!isEmbedModelDownloaded()) return 'model-unavailable';
  if (!embeddingCacheUsable(contextRoot)) return 'no-index';
  if (!embeddingCacheCoversType(contextRoot, 'task')) return 'no-index';
  return null;
}

const SKIP_DETAIL: Record<SemanticSkip, string> = {
  disabled: 'semantic gates off',
  'no-index': 'task corpus not indexed',
  'model-unavailable': 'embedding model unavailable',
};

/**
 * ONE notice covering BOTH skipped gates. A specialist that read "neighbor check
 * skipped" and nothing about the declined ledger would assume the second gate
 * ran, so the line names both things it must now do by hand.
 */
function skipNotice(why: SemanticSkip): string {
  return `neighbor check skipped (${SKIP_DETAIL[why]}) — keyword recall is your only dedup, `
    + 'and declined ideas were matched by exact slug only (`dreamcontext tasks declined`).';
}

// ─── Gate messages (frozen — asserted by unit, e2e and marker tests) ────────

function declinedFields(idea: DeclinedIdea): { key: string; topic: string; declinedAt: string; reason: string } {
  return { key: idea.key, topic: idea.topic, declinedAt: idea.declinedAt, reason: idea.reason };
}

function declinedSlugReason(idea: DeclinedIdea): string {
  return `Declined on ${idea.declinedAt.slice(0, 10)}: "${idea.topic}" — ${idea.reason}. Not re-filed. `
    + `If the decision changed: dreamcontext tasks undecline ${idea.key} (awake), then file.`;
}

function declinedSemanticReason(
  idea: DeclinedIdea,
  sim: number,
  threshold: number,
  named?: string,
): string {
  const mismatch = named
    ? ` (--declined-checked named "${named}", which is not the idea this matched.)`
    : '';
  return `Looks like a declined idea (cosine ${sim.toFixed(2)} ≥ ${threshold}): "${idea.topic}" `
    + `declined ${idea.declinedAt.slice(0, 10)} — ${idea.reason}. `
    + `If this is a different task, re-run with --declined-checked ${idea.key}; `
    + `if it is the same idea, do not file it (lift it awake with dreamcontext tasks undecline ${idea.key}).`
    + mismatch;
}

/** `--neighbor-checked task/foo` and `--neighbor-checked "Foo"` both mean `foo`. */
function normalizeNeighborRef(raw: string | undefined): string {
  if (!raw) return '';
  return slugify(raw.trim().replace(/^task\//, ''));
}

// ─── The gates ──────────────────────────────────────────────────────────────

interface ContentArgs {
  contextRoot: string;
  why?: string | null;
  slug?: string;
  name?: string;
  description?: string;
  neighborChecked?: string;
  declinedChecked?: string;
  semantic?: boolean;
  embed?: FilingBarEmbedder;
  cap: number;
  filed: string[];
  actor: FilingActor;
}

async function checkContent(args: ContentArgs): Promise<FilingBarVerdict> {
  const { contextRoot, why, slug, cap, filed, actor } = args;
  const hatch = actor === 'unknown'
    ? ' If this is your OWN task and not the cycle\'s, pass `--by human`.'
    : '';

  // 1. The cap. Checked FIRST so a cycle at its limit gets the cap message
  //    rather than being told to write a better Why for a task it cannot file.
  if (filed.length >= cap) {
    return {
      allowed: false,
      underBar: true,
      reason: cap === 0
        ? 'This brain files no tasks during sleep (max new tasks per cycle = 0). '
          + 'List the candidate in your report instead.' + hatch
        : `Cap reached — this cycle has already filed ${filed.length}/${cap} tasks. `
          + 'List the candidate in your report under "Candidates NOT filed (cap)" rather than dropping it. '
          + 'Raise the cap with `dreamcontext sleep config set max-new-tasks <n>`.' + hatch,
    };
  }

  // 2. A justification that is actually there.
  const trimmed = (why ?? '').trim();
  if (trimmed.length < MIN_SLEEP_WHY_CHARS) {
    return {
      allowed: false,
      underBar: true,
      reason: `A task filed during a sleep cycle needs a --why of at least ${MIN_SLEEP_WHY_CHARS} characters `
        + `naming the user, the friction and the cost (got ${trimmed.length}). `
        + 'A task nobody can justify is one nobody will do — record it as a bookmark or a memory instead.' + hatch,
    };
  }

  // 3. Nothing that was deliberately consolidated away.
  if (slug) {
    const resolved = resolveTombstone(contextRoot, slug);
    if (resolved.tombstone && resolved.livingSlug) {
      return {
        allowed: false,
        underBar: true,
        reason: `"${slug}" was retired and its work absorbed by "${resolved.livingSlug}" `
          + `(${resolved.chain.join(' → ')}). Log there instead of re-filing it. `
          + 'See `dreamcontext tasks tombstones`.' + hatch,
      };
    }
  }

  // 4. An idea a human already declined, matched EXACTLY. A pure file read, so
  //    it runs before anything that can load a model: a candidate refused here
  //    never pays for one. This is the ONLY declined match with no escape.
  const title = args.name ?? slug ?? '';
  const exactKey = slugify(title);
  if (exactKey) {
    const idea = findDeclined(contextRoot, exactKey);
    if (idea) {
      return {
        allowed: false,
        underBar: true,
        reason: declinedSlugReason(idea) + hatch,
        declined: { ...declinedFields(idea), match: 'slug' },
      };
    }
  }

  // 5 + 6. The semantic gates — or an honest statement that they did not run.
  //
  // An injected embedder IS the availability answer (tests): it bypasses the
  // on-disk model/cache clauses, which a temp vault can never satisfy.
  const skip: SemanticSkip | null =
    args.semantic === false ? 'disabled'
      : args.semantic === true ? null
        : args.embed !== undefined ? null
          : semanticSkipReason(contextRoot);

  if (skip !== null) {
    return {
      allowed: true,
      underBar: true,
      neighbor: { state: 'unavailable', why: skip },
      notices: [skipNotice(skip)],
    };
  }

  const gateArgs: GateArgs = { ...args, title, body: trimmed, hatch };

  const neighborOutcome = await runNeighborGate(gateArgs);
  if (neighborOutcome.refusal !== undefined) {
    return {
      allowed: false,
      underBar: true,
      reason: neighborOutcome.refusal,
      neighbor: neighborOutcome.neighbor,
    };
  }
  // The embedding layer failed mid-flight: gate 6 would fail the same way, so
  // report the skip once and pass, exactly as an up-front skip does.
  if (neighborOutcome.neighbor.state === 'unavailable') {
    return {
      allowed: true,
      underBar: true,
      neighbor: neighborOutcome.neighbor,
      notices: [skipNotice(neighborOutcome.neighbor.why)],
    };
  }

  const declinedOutcome = await runDeclinedSemanticGate(gateArgs);
  if (declinedOutcome.refusal !== undefined) {
    return {
      allowed: false,
      underBar: true,
      reason: declinedOutcome.refusal,
      neighbor: neighborOutcome.neighbor,
      ...(declinedOutcome.declined ? { declined: declinedOutcome.declined } : {}),
    };
  }

  return {
    allowed: true,
    underBar: true,
    neighbor: neighborOutcome.neighbor,
    ...(declinedOutcome.declined ? { declined: declinedOutcome.declined } : {}),
  };
}

interface GateArgs extends ContentArgs {
  /** The candidate's title — `name`, falling back to the slug. */
  title: string;
  /** The trimmed `--why`, already past the length floor. */
  body: string;
  hatch: string;
}

/**
 * Gate 5 — the nearest existing TASK.
 *
 * MERGE (a near-verbatim twin) is refused outright: at that similarity there is
 * no judgement left to make, and `--by human` remains the way through. REVIEW is
 * refused UNLESS `--neighbor-checked` names exactly that neighbor — for short
 * candidates the bands overlap, so a bare refusal would block legitimate work;
 * naming the neighbor is what proves the specialist looked at it.
 */
async function runNeighborGate(
  args: GateArgs,
): Promise<{ neighbor: FilingBarNeighbor; refusal?: string }> {
  const { contextRoot, title, body, hatch } = args;

  let result: Awaited<ReturnType<typeof dedupCandidate>>;
  try {
    result = await dedupCandidate(
      contextRoot,
      { title, description: args.description, body },
      { types: ['task'], topK: 5, excludeCapture: true, ...(args.embed ? { embed: args.embed } : {}) },
    );
  } catch (err) {
    // `dedupCandidate` throws only on programmer error (a blank candidate, an
    // incompatible injected embedder). Neither is worth aborting an unattended
    // `tasks create` for — degrade to the same "unavailable" the operational
    // path uses, and say why when debugging rather than into the void.
    if (process.env.DREAMCONTEXT_DEBUG) {
      console.error(`[filing-bar] neighbor check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { neighbor: { state: 'unavailable', why: 'model-unavailable' } };
  }
  if (result === null) return { neighbor: { state: 'unavailable', why: 'model-unavailable' } };

  const top = result.top;
  const neighbor: FilingBarNeighbor = {
    state: 'checked',
    verdict: result.verdict,
    top: top
      ? { slug: top.slug, docKey: top.docKey, title: top.title, relPath: top.relPath, sim: top.sim }
      : null,
    neighbors: result.neighbors.map((n) => ({ docKey: n.docKey, sim: n.sim })),
    mergeThreshold: result.mergeThreshold,
    reviewThreshold: result.reviewThreshold,
  };

  if (top === null || result.verdict === 'create') return { neighbor };

  if (result.verdict === 'merge') {
    const archived = top.relPath.includes('/archive/') ? ' This neighbor lives in state/archive/.' : '';
    return {
      neighbor,
      refusal: `\`${top.slug}\` already covers this (cosine ${top.sim.toFixed(2)}, ≥ ${result.mergeThreshold}). `
        + `Fold it in: dreamcontext tasks insert ${top.slug} acceptance_criteria "…"`
        + archived + hatch,
    };
  }

  // REVIEW: lifted only by naming this exact neighbor.
  const named = normalizeNeighborRef(args.neighborChecked);
  if (named === top.slug) return { neighbor };
  const mismatch = named
    ? ` (--neighbor-checked named "${args.neighborChecked}", which is not the nearest task.)`
    : '';
  return {
    neighbor,
    refusal: `Nearest task is \`${top.slug}\` (cosine ${top.sim.toFixed(2)} ≥ ${result.reviewThreshold} review). `
      + 'If this is a slice of it, fold it in; if it is genuinely separate, '
      + `re-run with --neighbor-checked ${top.slug}.` + mismatch + hatch,
  };
}

/**
 * Gate 6 — an idea a human declined, matched SEMANTICALLY.
 *
 * A proof-of-looking gate, not a decision boundary: the short-vs-short bands
 * overlap (measured — see `task-declined.ts`), so a hit asks the specialist to
 * read the declined reason and then either drop the candidate or name the key.
 * Only gate 4 (exact key) refuses unconditionally.
 */
async function runDeclinedSemanticGate(
  args: GateArgs,
): Promise<{ refusal?: string; declined?: FilingBarVerdict['declined'] }> {
  const match = await matchDeclinedSemantically(
    args.contextRoot,
    { title: args.title, why: args.body },
    args.embed ? { embed: args.embed } : {},
  );
  if (match === null) return {};

  const declined: FilingBarVerdict['declined'] = {
    ...declinedFields(match.idea),
    match: 'semantic',
    sim: match.sim,
  };

  const named = args.declinedChecked ? slugify(args.declinedChecked.trim()) : '';
  if (named === match.idea.key) return { declined };

  return {
    refusal: declinedSemanticReason(
      match.idea,
      match.sim,
      declinedMatchThreshold(),
      args.declinedChecked?.trim() || undefined,
    ) + args.hatch,
    declined,
  };
}

/**
 * Record that a task was filed UNDER THE BAR, so the cap counts it.
 *
 * Written into `.sleep.json` `cycle_tasks_filed` — the same file the cycle's
 * epoch lives in, so the counter and the lock are cleared together by
 * `sleep done` and can never disagree about which cycle is current.
 *
 * Best-effort: the task is already on disk, and failing to count it must not
 * fail the create. Workstream D wraps this in the sleep-state lock.
 */
export function recordCycleTaskFiled(contextRoot: string, slug: string): void {
  const path = join(contextRoot, 'state', '.sleep.json');
  if (!existsSync(path)) return;
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const filed = Array.isArray(state.cycle_tasks_filed)
      ? (state.cycle_tasks_filed as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    if (filed.includes(slug)) return;
    state.cycle_tasks_filed = [...filed, slug];
    writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch {
    /* counting is not worth losing the task that was already written */
  }
}
