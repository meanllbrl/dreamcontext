/**
 * context-watch — the measurement and state layer behind the OPT-IN context handoff.
 *
 * WHY THIS EXISTS (the measured case, so nobody tunes it by feel). Across 120 real
 * sessions of this vault (10,917 API calls), `cache_read` is 97.4% of billed input
 * tokens and context routinely climbs to 500–775k. Replaying the same work with a
 * 200k reset bills 2.2–2.6× fewer input tokens than growing to 1M. The THRESHOLD
 * dominates (150–250k is a flat optimum); compact-vs-restart at an equal threshold
 * is a ~20% effect. Nothing told the agent it was past the knee, so a long build
 * session silently paid 2–3× for the same task. Artifacts:
 * `_dream_context/inbox/context-ceiling-research/`.
 *
 * WHAT IT IS NOT. It is a NUDGE, never a rule. Nothing here forces a compaction, a
 * restart, or a ceiling — the agent reads its own number and decides whether moving
 * its state is worth it. The whole feature is off unless someone opts in.
 *
 * TWO DIRS, BOTH MACHINE-LOCAL AND GITIGNORED, both under `<contextRoot>/state/`:
 *   `.context-watch/<session_id>.json`  the nudge ladder, keyed by CONVERSATION
 *   `.context-watch/tab-<tab>.json`     the per-pane toggle, keyed by PANE
 *   `.handoff-requests/<key>.json`      a recorded handoff awaiting the fresh session
 *
 * The ladder is keyed by session and the toggle by pane ON PURPOSE: a `/clear`
 * rotation must keep the pane's switch while restarting the nudge ladder, because
 * the fresh session starts at near-zero context and should be allowed to climb again.
 */

import { existsSync, lstatSync, mkdirSync, openSync, readSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ensureGitignoreEntries } from './gitignore.js';
import { isSafeSessionId } from './transcript-locate.js';
import { readSetupConfig, resolveContextHandoff, type ResolvedContextHandoff } from './setup-config.js';
import { HANDOFF_FIELDS } from './handoff-readiness.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

const WATCH_DIR_REL = 'state/.context-watch';
const HANDOFF_DIR_REL = 'state/.handoff-requests';

/** Nudge-ladder + tab-toggle files live here. */
export function contextWatchDir(contextRoot: string): string {
  return join(contextRoot, WATCH_DIR_REL);
}

/** Recorded handoffs awaiting a fresh session live here. */
export function handoffDir(contextRoot: string): string {
  return join(contextRoot, HANDOFF_DIR_REL);
}

/**
 * Resolve a state dir for WRITING, or null when it must not be written through.
 *
 * Symlink guard, same hazard class `ensureGitignoreEntries` and `agent-session-map`'s
 * `ensureMapDir` defend against: a malicious cloned vault could COMMIT `state` or one
 * of these dirs as a symlink (gitignore only stops UNTRACKED files), redirecting our
 * writes outside the vault. Refuse to write through anything that is not a real dir.
 *
 * The ignore entry is ensured ONCE, on first creation — re-reading `.gitignore` on
 * every Edit/Write hook would be pure repeated I/O for a line that only needs to
 * exist once.
 */
function ensureStateDir(contextRoot: string, rel: string, comment: string): string | null {
  try {
    const stateDir = join(contextRoot, 'state');
    if (existsSync(stateDir) && !lstatSync(stateDir).isDirectory()) return null;
    const dir = join(contextRoot, rel);
    if (existsSync(dir) && !lstatSync(dir).isDirectory()) return null;
    if (!existsSync(dir)) {
      try {
        ensureGitignoreEntries(dirname(contextRoot), [`_dream_context/${rel}/`], { comment });
      } catch { /* best-effort: a gitignore failure must not block persistence */ }
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  } catch {
    return null;
  }
}

function ensureWatchDir(contextRoot: string): string | null {
  return ensureStateDir(contextRoot, WATCH_DIR_REL, 'dreamcontext: machine-local context-handoff nudge state + per-pane toggles');
}

function ensureHandoffDir(contextRoot: string): string | null {
  return ensureStateDir(contextRoot, HANDOFF_DIR_REL, 'dreamcontext: machine-local context-handoff requests');
}

/** Atomic temp-file + rename so a crash / concurrent reader can't see a half write.
 *  Same pattern as `agent-session-map.ts`'s `writeEntryAtomic` — these files are read
 *  by a hook process that may fire at any instant, so a torn read is a live hazard. */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

// ─── The one context formula ──────────────────────────────────────────────────

/**
 * The context window a turn carried = everything the model was handed plus what it
 * produced. THE SINGLE DEFINITION — `computeSessionStats` (agent-terminal.ts) imports
 * this rather than keeping its own copy, so the number the composer's ring shows and
 * the number the nudge fires on can never drift apart. A second spelling of this sum
 * is a second thing to keep in sync, and the copy that drifts is the one that lies.
 */
export function contextTokensFromUsage(u: Record<string, unknown> | null | undefined): number {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  if (!u || typeof u !== 'object') return 0;
  return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) + n(u.output_tokens);
}

// ─── Reading the transcript TAIL (never the whole file) ───────────────────────

/** How much of the transcript's end to read. A long session's jsonl runs to tens of
 *  MB; this hook fires on every Edit/Write, so reading the whole file would add real
 *  latency to every tool call. The last turn is always within the final few hundred KB. */
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

interface TranscriptRecord {
  isSidechain?: unknown;
  message?: { usage?: Record<string, unknown> };
}

/**
 * Parse the last `tailBytes` of a JSONL transcript into records, oldest-first.
 *
 * Reads ONLY the tail via a positioned read — no `readFileSync` on a multi-MB file.
 * When the window does not start at byte 0 the first line is almost certainly a
 * fragment, so it is dropped. Malformed lines are skipped, never thrown on: this
 * runs inside a hook whose failure would surface as a broken tool call.
 */
export function tailRecords(transcriptPath: string, tailBytes: number = TRANSCRIPT_TAIL_BYTES): TranscriptRecord[] {
  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines.shift(); // partial first line
    const out: TranscriptRecord[] = [];
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s) as TranscriptRecord); } catch { /* torn / not our shape */ }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * The context footprint of the most recent MAIN-CHAIN turn, or null when unknown
 * (missing file, unparseable, or no usage record in the tail).
 *
 * Walks BACKWARDS and takes the first usage record that is not a sidechain. Skipping
 * `isSidechain === true` is load-bearing, not hygiene: the STEP 0 spike confirmed that
 * on Claude Code 2.1.261 a sub-agent's records land in the PARENT's transcript file,
 * and a sub-agent's footprint lives in its own window. Counting one would report a
 * number that belongs to nobody.
 */
export function lastMainChainContext(transcriptPath: string, tailBytes: number = TRANSCRIPT_TAIL_BYTES): number | null {
  const records = tailRecords(transcriptPath, tailBytes);
  return lastMainChainContextFrom(records);
}

/** Pure half of {@link lastMainChainContext}, over already-parsed records. */
export function lastMainChainContextFrom(records: TranscriptRecord[]): number | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (r?.isSidechain === true) continue;
    const u = r?.message?.usage;
    if (u && typeof u === 'object') return contextTokensFromUsage(u);
  }
  return null;
}

// ─── Is this hook payload the MAIN agent, or a sub-agent? ─────────────────────

/** The subset of a hook payload this module reads. */
export interface HookInputLike {
  transcript_path?: unknown;
  session_id?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
}

/**
 * True only for the MAIN chain. A sub-agent must never see the nudge: it cannot hand
 * anything off (it has no task, no session to rotate, and its parent owns the window),
 * and telling it to would be pure noise in somebody else's context.
 *
 * THREE INDEPENDENT CHECKS, in cost order — verified against a real payload in the
 * STEP 0 spike (`tmp/spike-sub`), which is what makes their ranking honest:
 *   1. `agent_id` / `agent_type` on the payload — PRIMARY. Both are present on the
 *      sub-agent's PostToolUse and ABSENT on the parent's. Measured, not assumed.
 *   2. `/subagents/` in `transcript_path` — belt-and-braces. On 2.1.261 the sub-agent
 *      shares the PARENT's transcript_path, so this catches nothing TODAY; it is here
 *      for the dir-layout the CLI also writes and could start routing through.
 *   3. the tail's newest record being a sidechain — the last line of defence, for a
 *      CLI version that drops both fields.
 */
export function isMainChainHookInput(input: HookInputLike, records?: TranscriptRecord[]): boolean {
  const path = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (path.includes('/subagents/')) return false;
  if (typeof input.agent_id === 'string' && input.agent_id) return false;
  if (typeof input.agent_type === 'string' && input.agent_type) return false;
  const tail = records ?? (path ? tailRecords(path) : []);
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const r = tail[i];
    // Only USAGE-bearing records answer the question — the newest line is often a
    // tool_result with no chain marker at all, and reading that as "main chain" would
    // make the check answer a question it wasn't asked.
    if (!r?.message?.usage) continue;
    return r.isSidechain !== true;
  }
  return true; // nothing to contradict the payload's own (sub-agent-free) shape
}

// ─── The nudge ladder (per CONVERSATION) ──────────────────────────────────────

/** Per-session nudge state. Keyed by `session_id`, so a `/clear` restarts the ladder. */
/**
 * How loudly the nudge speaks. The register is a function of WHICH BAND the reading
 * sits in, never of how many times we have asked — a session that ignores three firm
 * nudges inside the middle band still gets a firm one, and a session that jumps
 * straight past `hardAt` on its first nudge gets the severe one immediately.
 */
export type NudgeTone = 'firm' | 'severe';

export interface NudgeState {
  /** Context tokens at the moment of the last nudge — the rung the ladder is on. */
  lastNudgedAt: number;
  /** How many nudges this conversation has seen. Diagnostics only. */
  nudges: number;
  /**
   * The register the last nudge spoke in. Load-bearing, not diagnostics: crossing
   * into the severe band must be ANNOUNCED at the crossing rather than waiting out
   * the remaining `remindEvery`, so this is what tells an escalation apart from a
   * repeat. Absent on state written before two-tone shipped ⇒ read as 'firm', which
   * is the safe reading: the worst it can do is speak the severe nudge once more.
   */
  lastTone?: NudgeTone;
}

function nudgeStatePath(contextRoot: string, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  return join(contextWatchDir(contextRoot), `${sessionId}.json`);
}

/** Read the ladder state for a conversation. Missing / corrupt ⇒ null (never nudged). */
export function readNudgeState(contextRoot: string, sessionId: string): NudgeState | null {
  const path = nudgeStatePath(contextRoot, sessionId);
  if (!path || !existsSync(path)) return null;
  const parsed = readJson<Partial<NudgeState>>(path);
  if (!parsed || typeof parsed.lastNudgedAt !== 'number' || !Number.isFinite(parsed.lastNudgedAt)) return null;
  return {
    lastNudgedAt: parsed.lastNudgedAt,
    nudges: typeof parsed.nudges === 'number' && Number.isFinite(parsed.nudges) ? parsed.nudges : 1,
    lastTone: parsed.lastTone === 'severe' ? 'severe' : 'firm',
  };
}

/** Record that we just nudged this conversation at `contextTokens`, in `tone`. Best-effort. */
export function writeNudgeState(contextRoot: string, sessionId: string, contextTokens: number, tone: NudgeTone = 'firm'): void {
  const dir = ensureWatchDir(contextRoot);
  const path = nudgeStatePath(contextRoot, sessionId);
  if (!dir || !path) return;
  const prev = readNudgeState(contextRoot, sessionId);
  try {
    writeJsonAtomic(path, {
      lastNudgedAt: contextTokens,
      nudges: (prev?.nudges ?? 0) + 1,
      lastTone: tone,
    } satisfies NudgeState);
  } catch { /* the ladder is an optimization, never a gate */ }
}

/**
 * Should this turn carry a nudge? First rung at `nudgeAt`, then one every
 * `remindEvery` tokens of FURTHER growth — measured from where we last nudged, not
 * from the threshold, so a session that ignores the nudge is reminded on a steady
 * cadence rather than on every single turn.
 */
export function shouldNudge(state: NudgeState | null, contextTokens: number, cfg: ResolvedContextHandoff): boolean {
  if (!cfg.enabled) return false;
  if (contextTokens < cfg.nudgeAt) return false;
  if (state === null) return true;
  // ESCALATION OUTRANKS THE CADENCE. Without this clause a session nudged at 640k
  // would not hear the severe register until 740k — it would cross the edge that
  // changes the advice and be told nothing at the crossing, which is the one moment
  // the message is actually new. A de-escalation is impossible (context only grows),
  // so this can fire at most once per conversation.
  if (nudgeTone(contextTokens, cfg) === 'severe' && (state.lastTone ?? 'firm') !== 'severe') return true;
  return contextTokens >= state.lastNudgedAt + cfg.remindEvery;
}

/** Which register a reading earns. `hardAt` is clamped `>= nudgeAt` by the resolver. */
export function nudgeTone(contextTokens: number, cfg: ResolvedContextHandoff): NudgeTone {
  return contextTokens >= cfg.hardAt ? 'severe' : 'firm';
}

/** Round to the "300k" the user sees everywhere else in this feature. */
function k(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

/**
 * The nudge itself — injected as `additionalContext`, so it is addressed to the AGENT,
 * not the user.
 *
 * TWO REGISTERS, and the split is the whole point of this function. The first version
 * had one, and it ended on "keep going and ignore this. It is a nudge, not an
 * instruction." Measured against six real sessions of this vault that were nudged
 * between 204k and 458k: ZERO handoffs were requested. The mechanism worked end to
 * end — hook, threshold, ladder, rotation — and was never reached, because declining
 * was written as the cheap default and the cost of continuing is abstract at the
 * moment of reading while the cost of stopping is concrete.
 *
 * So the register now tracks the band:
 *   FIRM   (`nudgeAt`..`hardAt`) — the recommendation is stated AS a recommendation,
 *          and declining is still free but must be FOR one of two named reasons.
 *          "I am mid-task" is explicitly disqualified, because that is the state the
 *          log exists to carry and it is true of every session that ever ignored this.
 *   SEVERE (`hardAt`+)          — imperative, and the decline clause grows the only
 *          tooth that does not break "agent-decided, never forced": if you continue,
 *          you must SAY SO TO THE USER and say why. It converts a silent default into
 *          a visible choice, which is the thing the user actually lost.
 *
 * Unchanged in both, because all three were argued for in the original review: the
 * NUMBERS (so the agent can judge rather than obey), the re-read cost (cache_read is
 * 97.4% of the bill and it is paid again every turn), and the COMMAND spelled
 * out (an agent that has to guess the syntax will skip it).
 *
 * NOT escalated: the cadence. `remindEvery` is the same in both bands on purpose — a
 * message that repeats twice as often reads as broken rather than as urgent, and the
 * severe band already gets an extra nudge at the crossing (see `shouldNudge`).
 */
export function renderNudge(
  contextTokens: number,
  cfg: ResolvedContextHandoff,
  activeSlug: string | null,
  tone: NudgeTone = nudgeTone(contextTokens, cfg),
): string {
  const slug = activeSlug || '<task-slug>';
  const next = Math.max(contextTokens, cfg.nudgeAt) + cfg.remindEvery;
  // ONE command carrying every part. It refuses while any part is missing (see
  // lib/handoff-readiness.ts) — the old two-step `log` then `handoff` let a session pin
  // the task having skipped the log.
  const steps = [
    `  dreamcontext tasks handoff ${slug} ${HANDOFF_FIELDS.map((f) => `${f.flag} "<${f.hint}>"`).join(' ')}`,
    activeSlug
      ? ''
      : '  (no task is in progress — `dreamcontext tasks create` one first, or skip the handoff)',
  ];

  const lines = tone === 'severe'
    ? [
      `[context handoff — HAND OFF NOW] This session is carrying ~${k(contextTokens)} context tokens: past ${k(cfg.hardAt)}, the last band of the window. Every turn re-reads all of it, so you are paying roughly 2–3× for work a fresh session would do at full speed.`,
      '',
      'Finish the turn you are in, then hand off before starting anything new:',
      ...steps,
      'It writes all of that into the task as one changelog entry and refuses while any part is missing; a fresh session picks the task up from that entry, with the handoff pinned.',
      '',
      'This is still your call, but it is no longer a quiet one: if you are continuing in this session anyway, TELL THE USER in your next message and say why. Do not continue silently.',
      `(Next reminder at ~${k(next)}.)`,
    ]
    : [
      `[context handoff] This session is carrying ~${k(contextTokens)} context tokens, past the ${k(cfg.nudgeAt)} handoff threshold. Every further turn re-reads all of it, so the same remaining work costs roughly 2–3× more from here than it would in a fresh session.`,
      '',
      'Hand off unless you have a reason not to — write your whole state into the task in one command:',
      ...steps,
      'It writes all of that into the task as one changelog entry and refuses while any part is missing; a fresh session picks the task up from that entry, with the handoff pinned.',
      '',
      `There are two good reasons to keep going: the task is nearly done, or the state genuinely cannot be written down. "I am in the middle of something" is not one of them — that is what --done and --next are for. Past ${k(cfg.hardAt)} this gets blunter.`,
      `(Next reminder at ~${k(next)}.)`,
    ];
  return lines.filter((l) => l !== '').join('\n');
}

/**
 * The task the nudge should name, or null. Most recently updated `in_progress` /
 * `active` task, by frontmatter — a sibling of `federation-peer-summary.ts`'s
 * `readActiveTask`, which answers the same question for a PEER vault and returns only
 * a title. This one needs the SLUG (the nudge prints two runnable commands, and an
 * agent that has to guess the slug will skip the handoff), so it returns both.
 *
 * Deliberately NOT `state/.active-task`: an edge-case review removed that pointer
 * because it raced across tabs and broke auto-sleep's hands-off union. The task files
 * are the truth; a scan of a few dozen small frontmatters is cheap enough for a hook
 * that only reaches this line once past the threshold.
 */
export function activeTaskForNudge(contextRoot: string): { slug: string; title: string } | null {
  const stateDir = join(contextRoot, 'state');
  let files: string[];
  try {
    files = readdirSync(stateDir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  let best: { slug: string; title: string } | null = null;
  let bestDate = '';
  for (const file of files) {
    try {
      const raw = readFileSync(join(stateDir, file), 'utf-8');
      const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
      if (!fm) continue;
      const field = (name: string): string => {
        const m = new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(fm[1]);
        return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
      };
      const status = field('status');
      if (status !== 'in_progress' && status !== 'active') continue;
      const slug = file.slice(0, -'.md'.length);
      const updated = field('updated_at') || field('created_at');
      if (!best || updated.localeCompare(bestDate) > 0) {
        // A folded YAML name (`name: >-`) leaves the value on the next lines; the
        // slug is always a usable address, so fall back to it rather than to ''.
        best = { slug, title: field('name') || slug };
        bestDate = updated;
      }
    } catch { /* an unreadable task file is not an active one */ }
  }
  return best;
}

// ─── The per-PANE toggle (tab file) ───────────────────────────────────────────

/**
 * On-disk shape of `state/.context-watch/tab-<pane>.json`.
 *
 * THE TAB FILE IS A SWITCH, NOT A LADDER. The ladder fields are still written — they
 * make the file readable on its own and any older build keeps parsing it — but
 * `resolveHandoffFor` takes ONLY `enabled` from here and reads the thresholds from
 * `.config.json`. There is no surface anywhere that lets a human set a PER-PANE
 * threshold: the popover has one control and it is the on/off lamp, so every ladder
 * ever written into one of these files is just whatever the default was on the day
 * the pane was born. Treating that as a per-pane CHOICE is what froze ten live panes
 * at a 200k threshold nobody picked when the bands moved to 300k/650k. Reading the
 * ladder centrally re-points them all with no migration.
 */
export interface TabHandoffState {
  enabled: boolean;
  nudgeAt: number;
  hardAt: number;
  remindEvery: number;
  updatedAt: string;
}

/** Pane ids are the same UUID-ish shape as session ids; reuse the one safe test. */
function tabFilePath(contextRoot: string, tab: string): string | null {
  if (!isSafeSessionId(tab)) return null;
  return join(contextWatchDir(contextRoot), `tab-${tab}.json`);
}

/** Read a pane's toggle. Missing / corrupt ⇒ null (fall through to the vault default). */
export function readTabHandoff(contextRoot: string, tab: string): TabHandoffState | null {
  const path = tabFilePath(contextRoot, tab);
  if (!path || !existsSync(path)) return null;
  const parsed = readJson<Partial<TabHandoffState>>(path);
  if (!parsed || typeof parsed.enabled !== 'boolean') return null;
  const r = resolveContextHandoff({ enabled: parsed.enabled, nudgeAt: parsed.nudgeAt, hardAt: parsed.hardAt, remindEvery: parsed.remindEvery });
  return {
    enabled: r.enabled,
    nudgeAt: r.nudgeAt,
    hardAt: r.hardAt,
    remindEvery: r.remindEvery,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
  };
}

/** Write a pane's toggle. Returns what was written, or null if the dir is unwritable. */
export function writeTabHandoff(
  contextRoot: string,
  tab: string,
  cfg: { enabled: boolean; nudgeAt?: number; hardAt?: number; remindEvery?: number },
): TabHandoffState | null {
  const dir = ensureWatchDir(contextRoot);
  const path = tabFilePath(contextRoot, tab);
  if (!dir || !path) return null;
  const r = resolveContextHandoff({ enabled: cfg.enabled, nudgeAt: cfg.nudgeAt, hardAt: cfg.hardAt, remindEvery: cfg.remindEvery });
  const entry: TabHandoffState = {
    enabled: r.enabled,
    nudgeAt: r.nudgeAt,
    hardAt: r.hardAt,
    remindEvery: r.remindEvery,
    updatedAt: new Date().toISOString(),
  };
  try {
    writeJsonAtomic(path, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * THE resolution order, in one place — and it is TWO orders, not one, because the
 * switch and the ladder answer to different owners:
 *
 *   enabled  : per-pane tab file > `.config.json` > off
 *   ladder   : `.config.json` > shipped defaults        (the tab file is not consulted)
 *
 * A pane that has been toggled owns its own ANSWER — including toggled OFF in a vault
 * whose `.config.json` says on; that is a real per-pane choice someone clicked. The
 * thresholds are not: nothing lets a human set them per pane, so a pane must not be
 * able to pin a stale ladder against the vault (see {@link TabHandoffState}). A
 * terminal/CLI session has no pane and gets the vault answer for both.
 */
export function resolveHandoffFor(contextRoot: string, projectRoot: string, tab: string | null | undefined): ResolvedContextHandoff {
  const vault = resolveContextHandoff(readSetupConfig(projectRoot)?.contextHandoff);
  if (tab) {
    const tabState = readTabHandoff(contextRoot, tab);
    if (tabState) return { ...vault, enabled: tabState.enabled };
  }
  return vault;
}

/**
 * What a NEW pane's tab file should be seeded with, at spawn, before the child starts:
 * brain-local (this machine, this vault — the last toggle) > `.config.json` (the team
 * default) > off.
 *
 * Deliberately NOT app-global: `agent-ui.json` is ONE machine-wide file, so a default
 * stored there would switch the nudge on in every vault on the machine and override a
 * team that opted out in `.config.json`. A pragmatist review blocked exactly that.
 */
export function resolveTabSeed(
  brainLocalDefault: boolean | undefined,
  configHandoff: { enabled?: boolean; nudgeAt?: number; hardAt?: number; remindEvery?: number } | null | undefined,
): ResolvedContextHandoff {
  const base = resolveContextHandoff(configHandoff);
  return { ...base, enabled: brainLocalDefault ?? base.enabled };
}

// ─── The one entry point the hooks call ───────────────────────────────────────

/**
 * Decide whether THIS hook payload earns a nudge, and return its text (or null).
 *
 * ORDER IS THE CONTRACT, not a style choice. `enabled` is read FIRST, from two small
 * JSON reads, and a disabled vault returns before any transcript is opened — that is
 * what makes "off ⇒ zero output and zero extra work" literally true rather than
 * merely quiet. The transcript tail is read ONCE and shared between the sub-agent
 * check and the context reading, so an enabled vault pays one positioned read per
 * Edit/Write, not two.
 *
 * Never throws: every caller is a hook whose failure would surface to the user as a
 * broken tool call, so the callers wrap this too — belt and braces on the one path
 * that must not be able to break editing.
 */
export function maybeNudge(
  contextRoot: string,
  input: HookInputLike,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    const projectRoot = dirname(contextRoot);
    const tab = typeof env.DREAMCONTEXT_TAB_SESSION === 'string' ? env.DREAMCONTEXT_TAB_SESSION : null;
    const cfg = resolveHandoffFor(contextRoot, projectRoot, tab);
    if (!cfg.enabled) return null;

    const path = typeof input.transcript_path === 'string' ? input.transcript_path : '';
    if (!path) return null;
    const records = tailRecords(path);
    if (!isMainChainHookInput(input, records)) return null;

    const ctx = lastMainChainContextFrom(records);
    if (ctx === null) return null;

    const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
    if (!sessionId) return null;
    const state = readNudgeState(contextRoot, sessionId);
    if (!shouldNudge(state, ctx, cfg)) return null;

    const tone = nudgeTone(ctx, cfg);
    writeNudgeState(contextRoot, sessionId, ctx, tone);
    const active = activeTaskForNudge(contextRoot);
    return renderNudge(ctx, cfg, active?.slug ?? null, tone);
  } catch {
    return null;
  }
}

// ─── The handoff record ───────────────────────────────────────────────────────

/**
 * A recorded handoff, awaiting the fresh session that will consume it.
 *
 * OWNERSHIP OF THE TWO TIMESTAMPS IS THE WHOLE DESIGN, so it is written down here
 * rather than rediscovered from three call sites:
 *   `actedAt`    — written ONLY by `agent-chat.ts`, when it has sent `/clear`. Its
 *                  presence is what stops the pane rotating twice on one record.
 *   `consumedAt` — written ONLY by the SessionStart hook, when the banner has been
 *                  printed. Its presence is what stops the banner reprinting forever.
 * A terminal handoff has no server to stamp `actedAt`, and that is correct: it is
 * consumed by whatever `/clear` the human runs.
 */
export interface HandoffRecord {
  task: string;
  title: string;
  at: string;
  contextTokens: number | null;
  fromSession: string;
  tab: string | null;
  actedAt?: string;
  consumedAt?: string;
}

/** The record key: the PANE if there is one, else the conversation, else a manual stamp. */
export function handoffKey(env: NodeJS.ProcessEnv = process.env): string {
  const tab = env.DREAMCONTEXT_TAB_SESSION;
  if (isSafeSessionId(tab)) return tab;
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (isSafeSessionId(session)) return session;
  return `manual-${Date.now()}`;
}

function handoffRecordPath(contextRoot: string, key: string): string | null {
  if (!isSafeSessionId(key)) return null;
  return join(handoffDir(contextRoot), `${key}.json`);
}

/** Write (or OVERWRITE) the handoff record for `key`. Second call wins: a pane that
 *  hands off twice wants the newer state, not a stale one it already moved past. */
export function writeHandoffRecord(contextRoot: string, key: string, record: HandoffRecord): boolean {
  const dir = ensureHandoffDir(contextRoot);
  const path = handoffRecordPath(contextRoot, key);
  if (!dir || !path) return false;
  try {
    writeJsonAtomic(path, record);
    return true;
  } catch {
    return false;
  }
}

/** Read one record by key. Missing / corrupt / wrong shape ⇒ null. */
export function readHandoffRecord(contextRoot: string, key: string): HandoffRecord | null {
  const path = handoffRecordPath(contextRoot, key);
  if (!path || !existsSync(path)) return null;
  const parsed = readJson<Partial<HandoffRecord>>(path);
  if (!parsed || typeof parsed.task !== 'string' || !parsed.task || typeof parsed.at !== 'string') return null;
  return {
    task: parsed.task,
    title: typeof parsed.title === 'string' ? parsed.title : parsed.task,
    at: parsed.at,
    contextTokens: typeof parsed.contextTokens === 'number' ? parsed.contextTokens : null,
    fromSession: typeof parsed.fromSession === 'string' ? parsed.fromSession : '',
    tab: typeof parsed.tab === 'string' && parsed.tab ? parsed.tab : null,
    ...(typeof parsed.actedAt === 'string' ? { actedAt: parsed.actedAt } : {}),
    ...(typeof parsed.consumedAt === 'string' ? { consumedAt: parsed.consumedAt } : {}),
  };
}

/** Merge one field into an existing record (the `actedAt` / `consumedAt` stamps). */
export function stampHandoffRecord(contextRoot: string, key: string, patch: Partial<HandoffRecord>): boolean {
  const existing = readHandoffRecord(contextRoot, key);
  if (!existing) return false;
  return writeHandoffRecord(contextRoot, key, { ...existing, ...patch });
}

/**
 * Should the Chat server rotate this pane for `record`?
 *
 * BOTH stamps are disqualifying, and the second one was learned the hard way on a real
 * machine rather than reasoned out: `actedAt` means WE already rotated (the latch against
 * a /clear loop), but `consumedAt` means the handoff was already DELIVERED by some other
 * route — the SessionStart banner fired on a manual `/clear`, or on a resume after the app
 * was restarted. The work has moved on; the fresh session is already sitting in the task.
 * Rotating again there would `/clear` a session the user is actively working in and replay
 * a continue-prompt for a task they already picked up.
 *
 * Observed: a handoff recorded under an OLD server process was consumed by the banner at
 * resume, and when the rebuilt server came up it still saw `actedAt` missing and queued a
 * second, pointless rotation.
 */
export function shouldRotateForHandoff(record: HandoffRecord | null | undefined): boolean {
  return !!record && !record.actedAt && !record.consumedAt;
}

/** Every readable record, with its key. Used by the tab-less `source=clear` fallback. */
export function listHandoffRecords(contextRoot: string): Array<{ key: string; record: HandoffRecord }> {
  const dir = handoffDir(contextRoot);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ key: string; record: HandoffRecord }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const key = name.slice(0, -'.json'.length);
    const record = readHandoffRecord(contextRoot, key);
    if (record) out.push({ key, record });
  }
  return out;
}

/**
 * How stale a TAB-LESS handoff may be and still be claimed by a `source=clear`
 * session. Short on purpose: without a pane id the only evidence tying the record to
 * this session is "it happened moments ago", and a wide window would let a fresh
 * `/clear` half an hour later inherit somebody else's handoff.
 */
export const TABLESS_HANDOFF_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Pick the record a SessionStart should print, or null.
 *
 * THE AUTOMATION-HIJACK GUARD IS THE POINT OF THIS FUNCTION. A headless automation
 * run starts with `source=startup` and no pane id. If the tab-less fallback accepted
 * any source, that run would silently consume a human's pending handoff — printing
 * the banner into a transcript nobody reads and marking the record used, so the real
 * fresh session never sees it. So a session WITHOUT a tab id qualifies only on
 * `source === 'clear'`, which an automation's first session can never be.
 *
 *  • with a tab → that pane's record, on any source but `compact` (a compaction is
 *    the same conversation continuing; the banner would be a lie).
 *  • without a tab → only on `source === 'clear'`, the newest unconsumed record
 *    younger than {@link TABLESS_HANDOFF_MAX_AGE_MS}.
 * Already-consumed records never qualify, which is what makes the banner print once.
 */
export function selectHandoffForSessionStart(
  contextRoot: string,
  source: string | null | undefined,
  tab: string | null | undefined,
  now: number = Date.now(),
): { key: string; record: HandoffRecord } | null {
  if (source === 'compact') return null;
  if (tab) {
    const record = readHandoffRecord(contextRoot, tab);
    if (record && !record.consumedAt) return { key: tab, record };
    return null;
  }
  if (source !== 'clear') return null;
  const fresh = listHandoffRecords(contextRoot)
    .filter(({ record }) => !record.consumedAt)
    .filter(({ record }) => {
      const t = Date.parse(record.at);
      return Number.isFinite(t) && now - t <= TABLESS_HANDOFF_MAX_AGE_MS && now - t >= 0;
    })
    .sort((a, b) => Date.parse(b.record.at) - Date.parse(a.record.at));
  return fresh[0] ?? null;
}

/** The SessionStart banner. Printed BEFORE the snapshot so it is the first thing read. */
export function renderHandoffBanner(record: HandoffRecord): string {
  const size = record.contextTokens ? ` that reached ${k(record.contextTokens)} tokens` : '';
  return [
    `>> HANDOFF: continuing task ${record.title} (${record.task}) from a session${size}.`,
    `Read _dream_context/state/${record.task}.md — its latest changelog entry is the handoff — before anything else.`,
  ].join('\n');
}

// ─── Pruning ──────────────────────────────────────────────────────────────────

/** Nudge ladders and handoff records are worthless once their session is long gone. */
export const CONTEXT_WATCH_PRUNE_DAYS = 7;
/** A pane's toggle is a PREFERENCE and outlives its conversations — kept far longer. */
export const TAB_HANDOFF_PRUNE_DAYS = 30;

function pruneDir(dir: string, maxAgeMs: number, keep: (name: string) => boolean = () => false): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of names) {
    if (keep(name)) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).mtimeMs >= cutoff) continue;
      rmSync(p, { force: true });
      removed += 1;
    } catch { /* a file that vanished under us is already pruned */ }
  }
  return removed;
}

/**
 * Sweep both state dirs. Called from SessionStart ONLY — once per session is the
 * right cadence for housekeeping, and doing it on the Edit/Write path would put a
 * directory scan in front of every tool call for no benefit.
 *
 * Tab files are swept on their OWN, much longer clock: they hold a preference a
 * person set, and expiring that in 7 days would silently flip a pane back off.
 */
export function pruneContextWatch(contextRoot: string): { watch: number; handoffs: number; tabs: number } {
  const day = 24 * 60 * 60 * 1000;
  const isTab = (name: string) => name.startsWith('tab-');
  const watchDir = contextWatchDir(contextRoot);
  return {
    watch: pruneDir(watchDir, CONTEXT_WATCH_PRUNE_DAYS * day, isTab),
    handoffs: pruneDir(handoffDir(contextRoot), CONTEXT_WATCH_PRUNE_DAYS * day),
    tabs: pruneDir(watchDir, TAB_HANDOFF_PRUNE_DAYS * day, (n) => !isTab(n)),
  };
}
