import type { SleepyMood } from './SleepyMascot';
import type { TermStatus, SessionKind } from './agentSession';

/**
 * The single source of truth for "what state is this agent session in?" — the user's
 * #1 need ("I can't tell if it's working or not"). Pure + framework-free so it drives
 * BOTH the expanded session-list rail and the collapsed status bubbles identically, and
 * is unit-testable in isolation.
 *
 * Six mutually exclusive kinds, each with a distinct label, mascot mood, and a
 * `data-kind` hook the CSS colours from design tokens (no hardcoded hues here):
 *   - saved    — a restored roster entry with NO live session (Resume to spawn). Indigo.
 *   - starting — the PTY/WebSocket is connecting. Amber.
 *   - working  — open AND mid-turn (Claude is busy). Green, pulsing.
 *   - asking   — open AND a question is on screen (Claude is blocked on YOUR answer:
 *                a permission prompt, AskUserQuestion, plan approval). Magenta, urgent.
 *   - ready    — open AND idle (waiting for a new prompt). Accent.
 *   - ended    — the session closed (PTY exited). Red.
 */
export type SessionStatusKind = 'saved' | 'starting' | 'working' | 'asking' | 'ready' | 'ended';

/**
 * Urgency order — drives the worst-of rollup on the collapsed anchor chip AND the
 * "questions jump the queue" sort in the dock. A blocked question outranks everything:
 * a working agent doesn't need you, an asking one literally can't continue without you.
 */
export const KIND_RANK: Record<SessionStatusKind, number> = {
  asking: 6, working: 5, starting: 4, ready: 3, saved: 2, ended: 1,
};

export interface SessionStatusInfo {
  kind: SessionStatusKind;
  /** One human word, shown on the tab and in the collapsed dock chip. */
  label: string;
  /** Which Sleepy face encodes this state. */
  mood: SleepyMood;
}

/**
 * One session as a status-bearing row view-model — the shape the collapsed dock chips
 * (and, derived further, the top-bar tabs) are built from. Pure data, framework-free, so
 * it lives here with the status taxonomy rather than in any one component.
 */
export interface SessionRow {
  id: string;
  title: string;
  /** agent (a Claude session) vs shell (a plain terminal) — decides whether the Sleepy
   *  mascot rides on the chip. The figure is Claude's face; a terminal has no agent, so
   *  it gets the bare status dot only. */
  kind: SessionKind;
  info: SessionStatusInfo;
  /** A backgrounded session finished / rang the bell since you last looked at it. */
  attention: boolean;
  /** The session's Claude conversation id (agents only) — lets the dock chip poll
   *  per-conversation live state (goal-skill run badge). Absent for shells/dormant. */
  claudeId?: string;
}

export interface SessionStatusInput {
  /** A restored tab with no live Session yet — always reads as "saved". */
  dormant?: boolean;
  /** The live Session's status, or undefined when there is no live session. */
  status?: TermStatus;
  /** Whether the live session is actively streaming output. */
  busy?: boolean;
  /** Whether the quiet screen ends in a question waiting on the user's answer. */
  asking?: boolean;
}

/**
 * Derive the presentation state for one session. `dormant` wins over everything (a
 * restored tab is "saved" even if a stale status leaked in); otherwise the live PTY
 * status decides, splitting `open` into asking/working/ready. `asking` wins over `busy`:
 * a question on screen means Claude is blocked on the user no matter what bytes still
 * dribble in (dialog redraws, keystroke echo).
 */
export function deriveSessionStatus({ dormant, status, busy, asking }: SessionStatusInput): SessionStatusInfo {
  if (dormant) return { kind: 'saved', label: 'saved', mood: 'sleeps' };
  switch (status) {
    case 'open':
      if (asking) return { kind: 'asking', label: 'needs you', mood: 'asking' };
      return busy
        ? { kind: 'working', label: 'working', mood: 'working' }
        : { kind: 'ready', label: 'ready', mood: 'waving' };
    case 'closed':
      return { kind: 'ended', label: 'ended', mood: 'sleeps' };
    case 'connecting':
    default:
      // No live session yet (undefined) reads the same as connecting — a session is
      // about to attach. Never leaves a row blank.
      return { kind: 'starting', label: 'starting', mood: 'thinking' };
  }
}

/**
 * Worst-of rollup for a set of rows — the dock's collapsed anchor chip surfaces the
 * most urgent state across every session at a glance (asking ▸ working ▸ starting ▸
 * ready ▸ saved ▸ ended). Empty input reads as 'ended' (the calmest state).
 */
export function rollupKind(rows: SessionRow[]): SessionStatusKind {
  return rows.reduce<SessionStatusKind>(
    (worst, r) => (KIND_RANK[r.info.kind] > KIND_RANK[worst] ? r.info.kind : worst),
    'ended',
  );
}

/**
 * Dock ordering: questions jump the queue — a blocked agent must be seen (and answered)
 * first, so every `asking` row floats to the top, keeping their relative order. Every
 * other tile keeps its roster order ON PURPOSE: a full urgency sort would make tiles
 * churn on every working↔ready flip, which reads as chaos, not liveliness.
 */
export function orderRows(rows: SessionRow[]): SessionRow[] {
  const asking = rows.filter((r) => r.info.kind === 'asking');
  return asking.length ? [...asking, ...rows.filter((r) => r.info.kind !== 'asking')] : rows;
}

/**
 * The one table that says which chip bubble a session's LIVE STATUS is counted in — and,
 * by the same entry, whether it holds a session at all (`null` = it does not).
 *
 * ATOMIC ON PURPOSE. `rollupProject` used to re-derive this three separate times — once for
 * `holdsSession`, once for `live`, once for the bucket `if/else` chain — and the bucket chain
 * was the one that drifted: it tested `attention` FIRST, so a chat that had merely finished a
 * turn while you weren't looking was counted as `asking` for as long as the flag lasted, and a
 * chat that then STARTED WORKING AGAIN stayed in the magenta bucket because the sticky flag
 * still won. The chip said "needs you" about a session the dock, three inches below, was
 * correctly drawing as `working` — one status, two answers.
 *
 * A `Record` over `SessionStatusKind` rather than a `switch` so a seventh kind added to the
 * union is a COMPILE error here instead of a session that silently lands in no bucket and
 * quietly stops being counted.
 */
export type StatusBucket = 'asking' | 'working' | 'idle';

export const BUCKET_BY_KIND: Record<SessionStatusKind, StatusBucket | null> = {
  /** Genuinely blocked on the user: a permission prompt, a question, a plan to approve. */
  asking: 'asking',
  /** Mid-turn, and `starting` with it — attaching a PTY is a session doing something. */
  working: 'working',
  starting: 'working',
  /** Open, connected, waiting for a new prompt. */
  ready: 'idle',
  /** Not a conversation you have: a restored roster entry with no session, and a dead PTY. */
  saved: null,
  ended: null,
};

/**
 * "Something happened here you have not seen yet" — the SECOND, independent channel, and the
 * exact condition the dock tile draws its badge dot from (`AgentDock`) so the two surfaces
 * cannot disagree about it.
 *
 * It is deliberately NOT a status. `attention` is sticky until the user looks at the session,
 * while `info.kind` tracks the live turn from one second to the next; folding a sticky flag
 * into a live status is what froze the chip's colour. Excludes `asking` because a session
 * blocked on a question already says so in the loudest way the strip has — badging it a second
 * time is one interruption drawn twice.
 */
export function wantsALook(row: SessionRow): boolean {
  return row.attention && row.info.kind !== 'asking';
}

/**
 * One project's worth of session rows, rolled up into what the chip strip needs to draw a
 * single chip: a colour, a live-count badge, and whether it should bounce. This is the
 * project-level counterpart to the collapsed dock's `rollupKind` — same worst-of urgency
 * signal, but a chip in a background project also needs to say HOW MANY conversations are
 * actually live and whether any of them are stuck waiting on the user, which a single kind
 * can't carry on its own.
 *
 * `live` and `alive` look redundant and are NOT — do not collapse them. `live` is a
 * PRESENTATION count (chats/agents only, shells excluded) for the chip badge. `alive` is a
 * SAFETY count (every kind, shells included) for the ceiling-eviction decision: a project
 * whose only live thing is a running shell (a dev server, a build watch) has `live: 0` but
 * must never read as idle, or the eviction rule kills its PTY mid-process. Only `alive` may
 * ever gate a teardown decision.
 */
export interface ProjectRollup {
  /** Dot + badge colour: the worst-of across every session in this project. */
  worst: SessionStatusKind;
  /** The badge NUMBER — how many chats/agents in this project are actually alive. Excludes
   *  shells: a plain terminal has no agent behind it and isn't an "active chat". */
  live: number;
  /** Drives the chip's one-shot bounce: sessions blocked on the user or flagged since
   *  you last looked. */
  waiting: number;
  /*
   * ── The chip's status bubbles ────────────────────────────────────────────────────
   *
   * Three counts that PARTITION `live`: `asking + working + idle === live`, always. The chip
   * draws one bubble per non-zero count, so a project with ten chats still shows at most
   * three bubbles instead of ten dots — which is the whole point of counting them here rather
   * than handing the strip a row of per-session states to render.
   *
   * FLAT, NOT A NESTED OBJECT, deliberately: `AgentSurface` publishes this rollup through a
   * dependency array of primitives, and a `{ asking, working, idle }` object would get a new
   * identity every render and republish several times a second while a turn streams.
   */
  /** Blocked on the user RIGHT NOW — a permission prompt, a question, a plan. The magenta
   *  bubble, and strictly `info.kind === 'asking'`.
   *
   *  NOT "anything that wants you": a chat that merely finished a turn unseen is `flagged`
   *  below, never this. Folding the two was the bug that made a WORKING chat sit magenta on
   *  the strip while the dock drew it green — see `BUCKET_BY_KIND`.
   *
   *  Also not the same as `waiting`: this one excludes shells, so the three counts still sum
   *  to `live`. A shell that rings its bell moves `waiting` without moving a bubble — the same
   *  split `live`/`alive` already makes, for the same reason. */
  asking: number;
  /** Mid-turn or still connecting. The green bubble, and the one that carries the ring.
   *  `starting` folds in here on purpose: a session attaching its PTY is a session doing
   *  something, and a fourth bubble for it would spend a third of the row on a state that
   *  lasts under a second. */
  working: number;
  /** Open and idle. The grey bubble. `saved` and `ended` are NOT counted anywhere — a
   *  restored roster entry with no session and a dead PTY are not chats you "have". */
  idle: number;
  /**
   * Live chats carrying an unseen "something happened" flag ({@link wantsALook}) — drawn as
   * ONE small dot beside the bubbles, exactly like the dock tile's badge.
   *
   * ORTHOGONAL TO THE THREE COUNTS ABOVE, and that is the whole point: it rides ALONGSIDE a
   * row's live bucket instead of replacing it, so a chat that finished unseen and then started
   * a new turn shows green-working AND the dot, which is both true things at once. Counting it
   * as a fourth bucket would put it back in the partition and re-break the invariant.
   */
  flagged: number;
  /** Eviction safety: how many sessions of ANY kind still hold a live PTY/WebSocket — agent,
   *  chat AND shell. This is the ONLY field the ceiling rule may consult; `live` must never
   *  decide whether an instance can be torn down. */
  alive: number;
}

/**
 * Roll a project's session rows up into its chip state. `worst` reuses `rollupKind` rather
 * than re-deriving the urgency order a second time — one source of truth for "what's the
 * worst thing happening here". `live` deliberately excludes `saved` (a restored roster
 * entry with no live session — the dormant "Resume" row) and `ended` (a dead PTY): neither
 * is a conversation actually happening right now, so counting them would badge a chip for a
 * project that isn't doing anything. A `shell` row is excluded outright — it's a plain
 * terminal with no agent behind it (see `SessionRow.kind` above), so it can never ask a
 * question and never belongs in an "active chat" count. `alive` counts the same `saved`/
 * `ended` exclusion but WITHOUT the shell exclusion — a shell still holds a real PTY/
 * WebSocket the ceiling rule must not tear down. `waiting` counts a row once even when it
 * is both `asking` and flagged for `attention` — one row, one interruption.
 *
 * Every "is this row live, and which bubble is it?" question is answered by ONE lookup in
 * {@link BUCKET_BY_KIND}, and the unseen-since-you-looked flag by ONE call to
 * {@link wantsALook} — the same call the dock tile makes. Nothing in this function re-states
 * the status taxonomy in its own words, because the two times it did, they drifted.
 */
export function rollupProject(rows: SessionRow[]): ProjectRollup {
  let live = 0;
  let waiting = 0;
  let alive = 0;
  let flagged = 0;
  const bucket: Record<StatusBucket, number> = { asking: 0, working: 0, idle: 0 };
  for (const r of rows) {
    // ONE read of the status, for all three decisions it drives — `null` means the row holds
    // no session at all, which is the same question `holdsSession` used to answer separately.
    const b = BUCKET_BY_KIND[r.info.kind];
    if (b && r.kind !== 'shell') {
      live++;
      // The bucket comes from the LIVE STATUS ALONE. `attention` gets no vote here — it is a
      // separate, sticky "you haven't seen this" fact, counted in `flagged` beside the bucket
      // rather than on top of it, so a chat that finished unseen and then started working
      // again turns green the moment it does.
      bucket[b]++;
      if (wantsALook(r)) flagged++;
    }
    if (b) alive++;
    // `waiting` keeps the union — it is the bounce trigger, and a background SHELL that rings
    // its bell (a build finishing) is worth a jump even though it draws no bubble.
    if (r.info.kind === 'asking' || r.attention) waiting++;
  }
  return { worst: rollupKind(rows), live, waiting, alive, flagged, ...bucket };
}
