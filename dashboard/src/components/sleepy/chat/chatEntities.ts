import { useEffect, useState, type RefObject } from 'react';
import { agentFileUrl } from '../../../api/client';

/**
 * Pure, framework-light logic shared by the Agent Chat (beta) redesign's card
 * components (task T1 of the 12-state redesign plan). Zero dependency on
 * `chatSession.ts`/`chatProtocol.ts` — every export here is a pure function (or, for
 * {@link useCopyableCodeBlocks}, a small self-contained DOM effect) so this module is
 * unit-testable with no WS/session/DOM fixture in the loop beyond the one hook.
 */

// ─── Tool glyphs (state 2/9 tool cards) ────────────────────────────────────────────

/**
 * Mono glyph shown next to a tool card's name. `Agent` and `Task` are aliased to the
 * same glyph: the sub-agent-spawning tool streams as `Agent` on the empirically
 * verified CLI 2.1.218 protocol, but `Task` is kept as a synonym in case an older/
 * newer CLI build (or a differently-named custom tool) uses it instead.
 */
export const TOOL_GLYPHS: Record<string, string> = {
  Read: '📄',
  Bash: '▶',
  Edit: '✎',
  Write: '✎',
  MultiEdit: '✎',
  Grep: '🔎',
  Glob: '📁',
  LS: '📁',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Agent: '⚡',
  Task: '⚡',
  AskUserQuestion: '❓',
};

/** Fallback glyph for a tool name not in {@link TOOL_GLYPHS}. */
export const DEFAULT_TOOL_GLYPH = '✦';

export function toolGlyph(name: string): string {
  return TOOL_GLYPHS[name] ?? DEFAULT_TOOL_GLYPH;
}

// ─── Reference classification (state 3/4 — file/entity chips) ─────────────────────

export type RefKind = 'file' | 'task' | 'knowledge' | 'core' | 'inbox' | 'board' | 'image';

export interface Reference {
  /** The raw path/reference string as it appeared in the tool card / mention. */
  raw: string;
  kind: RefKind;
  /** Display label — the basename, for a compact chip. */
  label: string;
  isImage: boolean;
  /** Present only for dreamcontext entities with a real dashboard page to open into
   *  (task/knowledge/core) — the SlideOver's "Open in app ↗" action is gated on this. */
  appNav?: { page: 'tasks' | 'knowledge' | 'core'; id: string };
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
const BOARD_RE = /\.excalidraw(\.md)?$/i;

function basename(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return i === -1 ? clean : clean.slice(i + 1);
}

/**
 * Classify a path referenced from chat (a tool card's file argument, an inline
 * mention) into a {@link Reference}. Recognizes dreamcontext entities under
 * `_dream_context/` (task/knowledge/core/inbox/board) and images by extension;
 * anything else is a plain project `file`. Purely string-based — no filesystem
 * access, no network — so it's safe to call on every render.
 */
export function classifyReference(path: string): Reference {
  const raw = path;
  const normalized = path.replace(/^\.\//, '').replace(/\\/g, '/');
  const label = basename(normalized);
  const isImage = IMAGE_EXT_RE.test(normalized);

  if (BOARD_RE.test(normalized) && normalized.includes('_dream_context')) {
    return { raw, kind: 'board', label, isImage: false };
  }
  if (isImage) {
    return { raw, kind: 'image', label, isImage: true };
  }

  const taskMatch = normalized.match(/^_dream_context\/state\/([^/]+)\.md$/i);
  if (taskMatch) {
    return { raw, kind: 'task', label, isImage: false, appNav: { page: 'tasks', id: taskMatch[1] } };
  }

  const knowledgeMatch = normalized.match(/^_dream_context\/knowledge\/(.+)\.md$/i);
  if (knowledgeMatch) {
    return { raw, kind: 'knowledge', label, isImage: false, appNav: { page: 'knowledge', id: knowledgeMatch[1] } };
  }

  const coreMatch = normalized.match(/^_dream_context\/core\/([^/]+)$/i);
  if (coreMatch) {
    return { raw, kind: 'core', label, isImage: false, appNav: { page: 'core', id: coreMatch[1] } };
  }

  if (/^_dream_context\/inbox\//i.test(normalized)) {
    return { raw, kind: 'inbox', label, isImage: false };
  }

  return { raw, kind: 'file', label, isImage: false };
}

// ─── Edit/Write diff parsing (state 2 — Edit card mini-diff) ──────────────────────

export interface EditDiff {
  removed: string[];
  added: string[];
  addedN: number;
  removedN: number;
}

/**
 * The 1-based line number the edited hunk starts at, recovered from an `Edit` tool
 * RESULT (the CLI echoes a `cat -n`-style numbered snippet of the edited file). Returns
 * `undefined` whenever it can't be proven — a `Write`, a still-running edit, a snippet
 * that doesn't contain the new text — and the diff gutter then falls back to `−`/`+`
 * signs. Numbers are never invented: a wrong line number is worse than none.
 */
const NUMBERED_LINE_RE = /^\s*(\d+)(?:→|\t| {2,})(.*)$/;

export function deriveDiffStartLine(result: unknown, firstAddedLine: string | undefined): number | undefined {
  if (typeof result !== 'string' || !firstAddedLine?.trim()) return undefined;
  const needle = firstAddedLine.trim();
  for (const line of result.split('\n')) {
    const m = NUMBERED_LINE_RE.exec(line);
    if (m && m[2].trim() === needle) return Number(m[1]);
  }
  return undefined;
}

/**
 * Build a line-level diff from an `Edit`/`MultiEdit` tool input (`old_string`/
 * `new_string`) or a `Write` tool input (`content`, wholly added). Returns `null` for
 * any input that carries neither shape (a non-edit tool, or a malformed/partial
 * tool_use whose input hasn't streamed in yet) — callers render the generic
 * input/result view for those instead of a diff.
 */
export function parseEditDiff(input: unknown): EditDiff | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;

  if (typeof obj.old_string === 'string' && typeof obj.new_string === 'string') {
    const removed = obj.old_string.length ? obj.old_string.split('\n') : [];
    const added = obj.new_string.length ? obj.new_string.split('\n') : [];
    return { removed, added, addedN: added.length, removedN: removed.length };
  }

  if (typeof obj.content === 'string') {
    const added = obj.content.length ? obj.content.split('\n') : [];
    return { removed: [], added, addedN: added.length, removedN: 0 };
  }

  return null;
}

// ─── Display formatting (atoms: TokenBadge, Duration, TerminalBlock) ──────────────

/**
 * Rough token estimate for a thinking block, display-only (~4 chars/token). The stream
 * carries no per-block token count, so the pill shows an estimate rather than nothing.
 */
export function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.round(text.length / 4)) : 0;
}

/** `842 tokens` · `2.4k tokens` · `12k tokens` — one decimal only where it still reads. */
export function formatTokenCount(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n === 1) return '1 token';
  if (n < 1000) return `${n} tokens`;
  // Round to tenths FIRST, so a value that rounds up to 10.0k prints as `10k`, not
  // `10.0k` (and never depends on toFixed's binary-float rounding).
  const tenths = Math.round(n / 100) / 10;
  return `${tenths < 10 ? tenths.toFixed(1) : Math.round(tenths)}k tokens`;
}

/** `0.3s` · `4.1s` · `12s` · `1m 04s` — a tool card's elapsed-time readout. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, '0')}s`;
}

/** `0:24` · `1:04` · `12:03` — the sub-agent group's elapsed clock. */
export function formatClock(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/**
 * Split a sentence on backtick spans: `['Claude wants to run ', 'npm test', ' here']`
 * with EVEN indexes plain and ODD indexes code. Lets a permission card render the CLI's
 * own description with its inline code styled, without pulling a markdown parser (and
 * without `dangerouslySetInnerHTML`) into a card that renders untrusted tool text.
 */
export function splitInlineCode(text: string): string[] {
  return text.split('`');
}

/**
 * Would this shell command normally stop and ask? Used ONLY to decide whether a command
 * that already ran under bypass mode is worth calling out (the "auto-approved" notice) —
 * never to grant or deny anything, which is entirely the CLI's business. Deliberately
 * conservative: it flags the destructive/outward-facing families (delete, force-push,
 * elevate, pipe-to-shell, publish, wipe) and stays quiet about everything else, so the
 * notice marks the handful of moments a human would want to have been asked about.
 */
const GUARDED_COMMAND_RES: RegExp[] = [
  /\brm\s+(-\w*\s+)*-?\w*[rf]/i,      // rm -rf / rm -f / rm -r
  /\b(sudo|doas)\b/i,
  // Force-push only: an ordinary `git push` is the normal way to finish a piece of work,
  // and a notice that fires on every one of them trains the eye to skip all of them.
  /\bgit\s+push\b[^|&;]*\s-{1,2}f(orce)?(-with-lease)?\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-\w*[fd])/i,
  /\bnpm\s+(publish|unpublish)\b|\byarn\s+publish\b|\bpnpm\s+publish\b/i,
  /\bchmod\s+(-\w+\s+)*777\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(ba|z|fi)?sh\b/i,   // pipe-to-shell
  /\b(dd|mkfs|shutdown|reboot|kill(all)?)\b/i,
  /\bdrop\s+(table|database)\b/i,
  />\s*\/dev\/(sd|disk|nvme)/i,
];

export function isGuardedCommand(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  return GUARDED_COMMAND_RES.some((re) => re.test(c));
}

/**
 * A stable hue (0-359) for an agent's avatar, derived from its name — the same agent
 * keeps the same color across runs and across sessions, with no palette to maintain and
 * no state to store. Distribution matters more than the exact value here: a plain FNV-1a
 * over the name spreads similar names (`goal-planner` / `goal-plan-reviewer`) far apart.
 */
export function avatarHue(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

export type OutputTone = 'ok' | 'error' | 'dim' | 'plain';

/**
 * Tone for ONE line of shell output, so a test run reads at a glance (green checks, red
 * failures, dimmed progress chatter) without a full ANSI parser — the stream-json
 * transport already strips escape sequences, so the glyph/keyword prefix is all that's
 * left to go on. Display-only: an unrecognized line is `plain`, never hidden.
 */
export function classifyOutputLine(line: string): OutputTone {
  const t = line.trim();
  if (!t) return 'plain';
  if (/^[✓✔√]/.test(t) || /^(pass|ok)\b/i.test(t)) return 'ok';
  if (/^[✗✘×✖]/.test(t) || /^(fail(ed|ure)?|error)\b/i.test(t) || /(^|\s)error(:|\s|$)/i.test(t)) return 'error';
  if (/^[>»#]/.test(t) || /^(running|skipped|warn(ing)?)\b/i.test(t) || /^\.{3}/.test(t)) return 'dim';
  return 'plain';
}

// ─── Clamping an unbounded body (terminal output, a raw tool result) ──────────────

/** Lines kept at each end of a clamped shell block. A failing test run puts its summary at
 *  the END and its command context at the start; both ends are what a reader wants. */
export const TERMINAL_HEAD_LINES = 20;
export const TERMINAL_TAIL_LINES = 20;

/** Characters of a raw tool result rendered before the "show all" cut. A `Read` of a large
 *  file comes back whole, and painting megabytes of text into a `<pre>` costs both the nodes
 *  and the layout pass on every re-render of the card. */
export const GENERIC_RESULT_CHAR_CAP = 16 * 1024;

export interface ClampedLines {
  /** The first `head` lines (or ALL of them, when nothing was clamped). */
  head: string[];
  /** The last `tail` lines — empty when nothing was clamped. */
  tail: string[];
  /** How many lines fell between the two ends. `0` means the input is shown whole. */
  hidden: number;
}

/**
 * Keep the two ends of a long block and count what's between them.
 *
 * A tool result is unbounded: a `Bash` running a build, a `Read` of a generated file. The
 * card used to render every line, which is thousands of DOM nodes for ONE call — mounted for
 * as long as the conversation lives, and re-laid-out on every render of the card. Both ends
 * are kept rather than just the head because a shell failure lives at the END (the summary,
 * the stack, the exit line) while the command that produced it is at the start.
 *
 * Nothing is ever silently dropped: `hidden` is what the expander offers to show.
 */
export function clampLines(lines: string[], head: number, tail: number): ClampedLines {
  const h = Math.max(0, head);
  const t = Math.max(0, tail);
  if (lines.length <= h + t) return { head: lines, tail: [], hidden: 0 };
  return {
    head: lines.slice(0, h),
    tail: t > 0 ? lines.slice(lines.length - t) : [],
    hidden: lines.length - h - t,
  };
}

// ─── Sub-agent runs (state 9 — frame-driven, NOT parentToolUseId-driven) ──────────
//
// The type lives here (pure, unit-testable); the reduced STATE lives in
// chatSession.ts's ConversationModel.subAgents (T4) — built from the `task-started`/
// `task-progress`/`task-updated`/`task-notification` ChatEvents (see chatProtocol.ts
// below), which is the only channel the spike proved carries a sub-agent's narrative: its
// own text/thinking is never streamed to the parent.
//
// "NOT parentToolUseId-driven" is about how a RUN is assembled, and must not be read as
// "parent_tool_use_id is irrelevant": the sub-agent's tool calls DO reach the parent stream
// carrying it, and that field is exactly what keeps them out of the parent transcript
// (chatProtocol's `frameParent`). Both halves are needed — the frames build the row, the
// field suppresses the noise.

export interface SubAgentRun {
  taskId: string;
  /** The spawning tool's `tool_use_id` (the `Agent`/`Task` call) — the key used to
   *  suppress that tool's own card from the main transcript (see
   *  {@link subAgentToolUseIds}) and to correlate the final `tool-result`. */
  toolUseId?: string;
  /** Display name — the task's `description` field, as it was at START. Never overwritten
   *  by a progress frame's own `description` (that is {@link SubAgentRun.activity}). */
  name: string;
  subagentType?: string;
  /** `local_agent` (a real sub-agent), `local_bash` (a shell command the CLI auto-
   *  backgrounded), or `local_workflow`. Drives {@link isAgentRun} — a bash task has no
   *  model and no token accounting, and must not be labelled an "agent". */
  taskType?: string;
  prompt?: string;
  /** `stopped` is its own terminal state, not a flavour of `completed` or `error`: a run the
   *  USER killed (`task_updated{status:'killed'}` / `task_notification{status:'stopped'}`,
   *  both verified on 2.1.220) neither finished nor failed, and calling it either would
   *  misreport it. Before this existed both frames fell through the reducer's ternary and a
   *  killed run displayed as "running" forever. */
  status: 'running' | 'completed' | 'error' | 'stopped';
  startedAt: number;
  endedAt?: number;
  summary?: string;
  /** What the task is doing RIGHT NOW, from the latest `task-progress` frame. */
  activity?: string;
  /** Tool the task last reached for, from the latest `task-progress` frame. */
  lastToolName?: string;
  resultContent?: unknown;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  /** Full model id the run actually used (`resolvedModel` off the Agent tool's own result).
   *  Absent for a bash/workflow task, and for a sub-agent whose result hasn't landed yet. */
  model?: string;
  /** Ordered distinct models, when the run swapped models mid-flight (length > 1). */
  modelsUsed?: string[];
}

/** Is this a real dispatched sub-agent, as opposed to a shell command the CLI auto-
 *  backgrounded? `local_bash` tasks ride the exact same `task_*` frames (verified on CLI
 *  2.1.220: a sub-agent's own `sleep 20` produced its own task_started/task_notification
 *  pair), so the type tag — not the mere presence of a run — is what may call something an
 *  agent. A run with no `taskType` at all is treated as an agent: that is the shape every
 *  pre-2.1.220 spike recorded, and under-reporting a real agent is the worse error. */
export function isAgentRun(run: SubAgentRun): boolean {
  return run.taskType !== 'local_bash';
}

/** A shell command the CLI is running in the background — the complement of
 *  {@link isAgentRun}. These get their own surface (`BackgroundShellsTray`) rather than a row
 *  in the sub-agent card: a shell has no sidechain transcript to drill into, but it does have
 *  live output on disk and can be stopped, which an agent run cannot. */
export function isBackgroundShell(run: SubAgentRun): boolean {
  return run.taskType === 'local_bash';
}

/**
 * Fold a `task-started` frame into the run list — an UPSERT keyed by `task_id`, never a
 * blind append.
 *
 * A BACKGROUNDED sub-agent (the Agent tool's default, and what every fan-out skill dispatches)
 * is announced TWICE, and the roster comes first. Empirically, on a two-agent background
 * fan-out:
 *
 *   system:background_tasks_changed  [{task_id: A, task_type: 'local_agent', description}]
 *   system:task_started              {task_id: A, tool_use_id, subagent_type, description}
 *   system:background_tasks_changed  [{task_id: A, …}, {task_id: B, …}]
 *   system:task_started              {task_id: B, …}
 *
 * The roster arm adopts an unknown `task_id` (it must — that is how a resumed conversation
 * picks up a run it never saw start), so by the time `task_started` lands the run ALREADY
 * exists. Appending it a second time produced two rows per agent: every later frame patches
 * by `findIndex`, so the adopted row collected all the activity/usage and the appended twin
 * sat at "Working…" with nothing but a clock, forever. A two-agent fan-out read "4 agents
 * running". A FOREGROUND agent emits no roster frame at all, which is why this only ever
 * showed up on backgrounded dispatches.
 *
 * The merge treats the started frame as authoritative for IDENTITY (name, subagent type, task
 * type, prompt, spawning tool_use_id — the roster carries none of the last four) and the
 * existing entry as authoritative for everything LIVE (status, timings, activity, usage): a
 * late/duplicate start must never reset a run that has already reported progress, or resurrect
 * one that has already landed.
 */
export function startSubAgentRun(runs: SubAgentRun[], started: SubAgentRun): SubAgentRun[] {
  const idx = runs.findIndex((r) => r.taskId === started.taskId);
  if (idx === -1) return [...runs, started];
  const cur = runs[idx];
  const merged: SubAgentRun = {
    ...cur,
    name: started.name || cur.name,
    toolUseId: started.toolUseId ?? cur.toolUseId,
    subagentType: started.subagentType ?? cur.subagentType,
    taskType: started.taskType ?? cur.taskType,
    prompt: started.prompt ?? cur.prompt,
    // The earlier of the two stamps: the roster is what actually told us first, and the row's
    // clock should measure the run, not the frame that happened to name it.
    startedAt: Math.min(cur.startedAt, started.startedAt),
  };
  const next = runs.slice();
  next[idx] = merged;
  return next;
}

/**
 * The status a `task_updated`/`task_notification` frame's own status string means, given what
 * the run is currently at. Pure and shared by both reducer arms so the two frames can never
 * disagree about the same vocabulary.
 *
 * The vocabulary is the CLI's, empirically observed on 2.1.220: `completed` (natural end),
 * `killed`/`stopped` (this is what `stop_task` produces, on task_updated and
 * task_notification respectively), `error`/`failed`. Anything unrecognized HOLDS the current
 * status rather than guessing — a future status word must not silently retire a running row.
 */
export function runStatusFrom(raw: string | undefined, current: SubAgentRun['status']): SubAgentRun['status'] {
  if (raw === 'completed') return 'completed';
  if (raw === 'killed' || raw === 'stopped') return 'stopped';
  if (raw === 'error' || raw === 'failed') return 'error';
  return current;
}

/**
 * How long a FINISHED background shell keeps its row in the tray after it exits.
 *
 * This surface originally kept every finished shell until the conversation ended, so its
 * output stayed one click away. That is wrong for a PINNED strip: the tray sits above the
 * composer, outside the scroller, so every row it holds is height the transcript does not
 * get and cannot scroll past. A long session backgrounds dozens of commands, and the
 * accumulated list grew taller than the pane — burying the transcript, the tray's own
 * collapse header, and the composer with it, which left no way to read the chat OR to close
 * the thing eating it.
 *
 * A shell's live output is worth a seat while it runs and for the moment after it lands
 * ("what did that just do?"); past that it is history, and the command's own tool card is
 * still in the transcript as the durable record. Two minutes is that moment.
 */
export const FINISHED_SHELL_TTL_MS = 2 * 60 * 1000;

/** Does this shell still earn a row in the tray? Running ones always; finished ones until
 *  {@link FINISHED_SHELL_TTL_MS} after they ended. Every reducer arm that moves a run to a
 *  terminal status stamps `endedAt` even when the CLI frame omitted one, so a terminal run
 *  without it is a shape we did not predict — treated as "just ended" rather than "long
 *  expired", so the unknown case errs toward keeping the row instead of vanishing it. */
export function isShellVisible(run: SubAgentRun, now: number): boolean {
  if (run.status === 'running') return true;
  return now - (run.endedAt ?? now) < FINISHED_SHELL_TTL_MS;
}

/** Header data for the background-shells tray: the rows that still earn a seat (see
 *  {@link isShellVisible}), how many are still going, and `nextExpiryAt` — when the soonest
 *  finished row falls out of the window, so the tray can wake exactly then instead of
 *  holding a 1s interval open forever just in case. */
export function summarizeBackgroundShells(runs: SubAgentRun[], now: number): {
  shells: SubAgentRun[]; running: number; total: number; nextExpiryAt?: number;
} {
  const shells = runs.filter((r) => isBackgroundShell(r) && isShellVisible(r, now));
  // Only a row with a real `endedAt` gets a scheduled expiry. Deriving one from `now` for the
  // stamp-less case would make this value move every time it is read, and the tray schedules
  // its next render FROM it — a self-feeding loop for the sake of a run shape that the
  // reducer cannot actually produce.
  const expiries = shells
    .filter((r) => r.status !== 'running' && r.endedAt != null)
    .map((r) => (r.endedAt as number) + FINISHED_SHELL_TTL_MS);
  return {
    shells,
    running: shells.filter((r) => r.status === 'running').length,
    total: shells.length,
    nextExpiryAt: expiries.length ? Math.min(...expiries) : undefined,
  };
}

/** Header data for the "N agents running" group card. `agents` counts only true sub-agent
 *  runs, so the header can name what it is actually showing. */
export function summarizeSubAgents(runs: SubAgentRun[]): {
  running: number; total: number; agents: number; earliestStart?: number;
} {
  const running = runs.filter((r) => r.status === 'running').length;
  const earliestStart = runs.length ? Math.min(...runs.map((r) => r.startedAt)) : undefined;
  return { running, total: runs.length, agents: runs.filter(isAgentRun).length, earliestStart };
}

// ─── Collapsing a finished group (SubAgentCard / BackgroundShellsTray) ────────────
//
// Both surfaces show a GROUP of runs that starts as live state and ends as a record, and
// both used to stay open forever: a fan-out of N agents kept N rows of the transcript long
// after all of them had landed, and the shells tray kept its full list docked over the
// composer after every process had exited. Same rule as the tool cards (collapsed by
// default except Edit/Write) — the detail is one click away, not permanently in the way.

/** Has this run reached a terminal status? `stopped` counts: it is its own terminal state,
 *  not a flavour of `completed`/`error` (see {@link SubAgentRun.status}), and a group holding
 *  a run the user killed is just as finished as one holding a run that failed. */
export function isRunFinished(run: SubAgentRun): boolean {
  return run.status !== 'running';
}

/** Live vs. landed for the group as a whole — the only thing the AUTOMATIC open/closed state
 *  reads. An empty group is `done`; neither surface renders one. */
export type RunGroupPhase = 'running' | 'done';

export function runGroupPhase(runs: SubAgentRun[]): RunGroupPhase {
  return runs.every(isRunFinished) ? 'done' : 'running';
}

/** A user's explicit open/close, STAMPED with the phase it was made in — the whole reason
 *  the override can be sticky without also being permanent. */
export interface GroupToggle { phase: RunGroupPhase; open: boolean }

/**
 * Is the group open? The automatic rule is one line — open while anything is running,
 * collapsed to the summary header once everything has landed — and the user outranks it.
 *
 * The override is scoped to the PHASE it was made in, which is what keeps the two failure
 * modes apart. A plain sticky boolean gets one of them wrong whichever way you set it: a user
 * who collapsed a live group would have it slam open again on the next frame (unstamped auto
 * state winning), or a user who merely re-opened a live group would have pinned it open
 * through the finish and never get the auto-collapse this exists for. Stamping means: while
 * the phase holds, the user's choice is the answer and no re-render may touch it; when the
 * group actually crosses running → done (or a new run starts in a landed group), the stale
 * choice is released and the automatic transition fires exactly once.
 */
export function isGroupOpen(phase: RunGroupPhase, toggle: GroupToggle | null): boolean {
  if (toggle && toggle.phase === phase) return toggle.open;
  return phase === 'running';
}

/** {@link isGroupOpen} bound to component-local state, so the collapsed/open flag is per card
 *  and per group by construction — it lives in the instance, and `ChatPane` is keyed by
 *  session id, so it can leak neither across a split's panes nor across conversations. */
export function useGroupCollapse(runs: SubAgentRun[]): { open: boolean; onToggle: () => void } {
  const [toggle, setToggle] = useState<GroupToggle | null>(null);
  const phase = runGroupPhase(runs);
  const open = isGroupOpen(phase, toggle);
  return { open, onToggle: () => setToggle({ phase, open: !open }) };
}

/** What a COLLAPSED group must still admit to beyond its count: how many failed, how many the
 *  user killed. Empty when everything landed cleanly — a header that says "0 failed" spends
 *  the eye's attention on a number that means nothing. */
export function groupOutcomeNote(runs: SubAgentRun[]): string {
  const parts: string[] = [];
  const failed = runs.filter((r) => r.status === 'error').length;
  const stopped = runs.filter((r) => r.status === 'stopped').length;
  if (failed) parts.push(`${failed} failed`);
  if (stopped) parts.push(`${stopped} stopped`);
  return parts.join(' · ');
}

/**
 * How long a run has been going, in ms. Prefers the CLI's OWN `usage.durationMs` (it
 * measures the agent's runtime, and it keeps ticking correctly for a task that was queued
 * before it actually started) and falls back to wall-clock from `startedAt`. `now` is passed
 * in rather than read from the clock so this stays pure and testable; a finished run ignores
 * it entirely.
 */
export function runDurationMs(run: SubAgentRun, now: number): number {
  if (run.usage?.durationMs != null) return run.usage.durationMs;
  const end = run.status === 'running' ? now : run.endedAt ?? now;
  return Math.max(0, end - run.startedAt);
}

/**
 * A model id → a short human label: `claude-haiku-4-5-20251001` → `Haiku 4.5`,
 * `claude-opus-5` → `Opus 5`. The trailing 8-digit date stamp is dropped (it is a build
 * date, not a version anyone reads), and the remaining version segments join on a dot.
 *
 * An id from a family we don't know is returned VERBATIM rather than relabelled or blanked —
 * a raw id the user can read beats a dash that says nothing, and beats claiming a model ran
 * that didn't. Same rule `modelLabelFor` follows in agentComposer.ts.
 */
const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

export function formatModelName(model: string): string {
  const id = model.trim();
  if (!id) return '';
  const lower = id.toLowerCase();
  const family = MODEL_FAMILIES.find((f) => lower.includes(f));
  if (!family) return id;
  const after = lower.slice(lower.indexOf(family) + family.length);
  const version = after
    .split('-')
    .filter((part) => /^\d+$/.test(part) && part.length < 8)
    .join('.');
  const label = family.charAt(0).toUpperCase() + family.slice(1);
  return version ? `${label} ${version}` : label;
}

/**
 * The compact meta line under a run's name — duration, model, tokens, tool uses — as an
 * ordered list of already-formatted chips. Pure, so the exact readout for any run state is
 * unit-testable without rendering.
 *
 * Only what is KNOWN is emitted: a bash task contributes duration alone, a sub-agent whose
 * result hasn't landed yet has no model chip. Nothing here is inferred. Reasoning effort is
 * absent by necessity, not by omission — see `fromToolUseResult` in chatProtocol.ts for the
 * four channels that were checked and don't carry it.
 */
export function runMetaChips(run: SubAgentRun, now: number): string[] {
  const chips: string[] = [formatDuration(runDurationMs(run, now))];
  if (run.model) {
    // A mid-run model swap is the interesting case, so say so instead of silently showing
    // only the final one.
    const swapped = (run.modelsUsed?.length ?? 0) > 1;
    chips.push(swapped ? `${formatModelName(run.model)} +${run.modelsUsed!.length - 1}` : formatModelName(run.model));
  }
  if (run.usage?.totalTokens) chips.push(formatTokenCount(run.usage.totalTokens));
  const tools = run.usage?.toolUses;
  if (tools) chips.push(`${tools} tool${tools === 1 ? '' : 's'}`);
  return chips;
}

/**
 * The spawning tool's `tool_use_id`s that the main transcript must SKIP (its own
 * `Agent`/`Task` `ToolCard` would otherwise render alongside the `SubAgentCard` that
 * already represents it). Keyed by `tool_use_id`, not by tool name — correct
 * regardless of whether the CLI streams the tool as `Agent` or `Task`.
 *
 * AGENT runs only. A background shell rides the identical `task_*` frames, so before this
 * filter existed its spawning tool_use_id landed here too — and that id belongs to the
 * `Bash` call itself, so backgrounding a command SILENTLY ERASED its tool card from the
 * transcript and the user never saw the command that was now running. A shell's card must
 * always render; the tray represents its lifecycle, not its invocation.
 */
export function subAgentToolUseIds(runs: SubAgentRun[]): Set<string> {
  return new Set(
    runs.filter(isAgentRun).map((r) => r.toolUseId).filter((id): id is string => !!id),
  );
}

// ─── Turn progress (the working indicator's condition) ────────────────────────────
//
// `session.busy` says a turn is in flight; it does NOT say the transcript is showing it.
// Between sending a message and the CLI's first frame (process spawn + SessionStart hooks:
// seconds on the first turn), and again in every gap between a tool result and the next
// block, the view has nothing live on it — which reads as "nothing is happening".

/** The subset of a transcript item {@link turnHasVisibleProgress} reads. Declared
 *  structurally on purpose: this module's invariant is zero dependency on chatSession.ts
 *  (`ChatItem[]` satisfies it). */
export interface ProgressProbe {
  kind: string;
  done?: boolean;
  text?: string;
  status?: string;
}

/**
 * Whether the transcript ALREADY shows that the turn is alive — a streaming text block (it
 * renders an ellipsis bubble even before its first delta), a thinking pill that has text to
 * show, a running tool card, or a card awaiting an answer. False means the turn is running
 * with nothing on screen: the window the working indicator exists to fill.
 *
 * A thinking block with no text yet does NOT count (`ThinkingBlock` renders null until it
 * has something to disclose), and a suppressed sub-agent-spawning tool still does (the
 * `SubAgentCard` that replaces its card carries its own running progress track).
 */
export function turnHasVisibleProgress(items: ProgressProbe[], pendingCount = 0): boolean {
  if (pendingCount > 0) return true;
  return items.some((it) => (
    (it.kind === 'text' && it.done === false)
    || (it.kind === 'thinking' && it.done === false && !!it.text)
    || (it.kind === 'tool' && it.status === 'running')
  ));
}

// ─── Stick-to-bottom (transcript auto-scroll) ─────────────────────────────────────

/** How far from the bottom still counts as "at the bottom" — one short line of slack, so a
 *  token that lands between a scroll and its handler never reads as the user leaving. */
export const BOTTOM_SLACK = 48;

/** Which way a user input event asks the transcript to move. `null` = it says nothing about
 *  direction (a horizontal wheel, a key that doesn't scroll). */
export type ScrollIntent = 'up' | 'down' | null;

/** A wheel notch's intent. Negative `deltaY` is up in every delta mode — the mode only scales
 *  the magnitude, which this doesn't care about. */
export function wheelIntent(deltaY: number): ScrollIntent {
  if (deltaY < 0) return 'up';
  if (deltaY > 0) return 'down';
  return null;
}

/** A key's intent. Space is deliberately absent: it only scrolls a focused scroller, and
 *  every Space that reaches this pane is being typed into the composer. */
export function keyIntent(key: string): ScrollIntent {
  if (key === 'ArrowUp' || key === 'PageUp' || key === 'Home') return 'up';
  if (key === 'ArrowDown' || key === 'PageDown' || key === 'End') return 'down';
  return null;
}

/** A touch drag's intent, from the finger's movement since the last touch event. The finger
 *  moving DOWN the screen (positive `dy`) drags the content down, i.e. scrolls UP. */
export function touchIntent(dy: number): ScrollIntent {
  if (dy > 0) return 'up';
  if (dy < 0) return 'down';
  return null;
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** `scrollTop` at the previous scroll event — the direction signal. */
  prevScrollTop: number;
  /**
   * Whether the user is asking to move the view UP — a wheel/touch/key gesture in that
   * direction within the gesture window, or a live scrollbar drag (whose direction the
   * metrics below supply). Deliberately NOT "any gesture": see rule 2.
   */
  userDriven: boolean;
}

/**
 * The next stick-to-bottom state for a scroll event. Three rules, in this order:
 *
 * 1. At (or within {@link BOTTOM_SLACK} of) the bottom → stick. Covers arriving back by any
 *    means: wheel, drag, keyboard, or our own programmatic scroll.
 * 2. A scroll event the user did not ask to move UP cannot unstick. Position alone can't
 *    tell "the user left" from "the content moved": when a block shrinks under a pinned view
 *    (a running tool card collapsing to its done card, the working indicator unmounting) the
 *    browser CLAMPS `scrollTop` down to the new maximum, and if the next block renders before
 *    that scroll event dispatches, the handler sees a position that is both far from the
 *    bottom and lower than last time — a picture identical to scrolling up. That is what
 *    killed auto-scroll mid-stream and left the Latest pill sitting there (owner report
 *    07-25).
 *
 *    `userDriven` is therefore an UPWARD-intent signal, not a "the user touched something"
 *    signal. Scroll events fire before ResizeObserver callbacks in the same frame, so the
 *    handler is guaranteed to see the raced measurement BEFORE the re-pin that would have
 *    corrected it — and a direction-blind window meant the most ordinary thing a reader does
 *    (flick DOWN to follow the answer, whose trackpad momentum keeps the window open for the
 *    rest of the turn) licensed exactly the unstick this rule exists to prevent. The view
 *    then stranded mid-transcript the moment the turn's cards collapsed (owner report 07-25,
 *    second pass: "it jumps to the middle when the agent finishes").
 * 3. Only then does direction matter: an UPWARD move unsticks. Content growing under a
 *    pinned view pushes the bottom away without ever moving `scrollTop` backwards, so a
 *    fast stream still can't be mistaken for the user scrolling off.
 *
 * A zero-height scroller is not measurable — a minimized pane's container is detached from
 * the document, and treating that as "scrolled away" would strand the view at the top when
 * it comes back. Keep the previous state.
 */
export function nextStickToBottom(prev: boolean, m: ScrollMetrics): boolean {
  if (m.clientHeight === 0) return prev;
  if (isAtBottom(m)) return true;
  if (!m.userDriven) return prev;
  if (m.scrollTop < m.prevScrollTop - 1) return false;
  return prev;
}

/**
 * Is the view at the bottom (within {@link BOTTOM_SLACK})? The measurement half of
 * "pinned" — {@link nextStickToBottom} rule 1, and the check the pin's own re-assert makes
 * before writing again.
 *
 * Why a pinned view can be nowhere near the bottom, which is the whole reason this is
 * exported: the pane docks furniture BELOW the scroller (the background-shells tray, the
 * auto-growing composer). When one of those GROWS, the scroller shrinks under a view that is
 * already at its maximum — `scrollTop` stays perfectly valid, the maximum moves out from under
 * it, and the browser dispatches NO scroll event because nothing scrolled (measured in
 * Chromium: a tray growing by 186px left 174px of transcript below the fold, silently). So
 * the state "we believe we are pinned, and we are not" is reachable without a single event to
 * notice it by — no scroll handler runs, and the Latest pill stays hidden because the view
 * still thinks it is at the bottom. Only a re-measurement finds it.
 */
export function isAtBottom(m: Pick<ScrollMetrics, 'scrollTop' | 'scrollHeight' | 'clientHeight'>): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= BOTTOM_SLACK;
}

/**
 * Where the reader is, so a re-home can put them back — the counterpart to
 * {@link nextStickToBottom}, which only ever describes the PINNED case.
 *
 * `appendChild`-ing a session's container into another slot zeroes `scrollTop` on every
 * scroller inside it and dispatches NO scroll event for it (measured in Chromium: garaging a
 * chat tab takes the transcript 1441 → 0 with the handler never firing). So the offset has to
 * be remembered while the view is still homed; the re-pin hook restores it. Without it a
 * reader who had scrolled up came back to the TOP of the conversation, because the only
 * restore that existed was "if you were stuck, go to the bottom" — the owner-reported
 * "renaming a tab breaks the other sessions' scroll" (renaming double-clicks a tab, and the
 * click half SELECTS it, which garages whatever was on screen).
 *
 * Two rules:
 * 1. A scroller that measures nothing is parked in the detached garage — unmeasurable, not
 *    "at the top". Keep the last offset we could actually trust.
 * 2. A jump to exactly 0 that no gesture asked for is a re-home reset arriving as a scroll
 *    event (engines differ on whether one is dispatched), never a reading position. Reaching
 *    the top deliberately always carries upward intent, so this can't swallow a real one.
 */
export function nextRestoreTop(prev: number, m: ScrollMetrics): number {
  if (m.clientHeight === 0) return prev;
  if (m.scrollTop === 0 && m.prevScrollTop > 0 && !m.userDriven) return prev;
  return m.scrollTop;
}

// ─── Transcript window (how much of the conversation is actually mounted) ─────────
//
// A long conversation used to mount every item it had ever had, forever: `history.map()`
// plus `items.map()`, no ceiling. A few hundred tool cards, diffs, terminal blocks and
// images is tens of thousands of DOM nodes per pane, which is what made the overlay's
// open/close transform animate at a crawl and what kept the app's memory climbing for as
// long as a session lived.
//
// So the transcript renders a WINDOW: the last {@link WINDOW_TAIL} entries, extended
// upwards {@link WINDOW_STEP} at a time by scrolling to the top (or pressing "Show earlier
// messages"). This is hand-rolled rather than react-window/virtua on purpose — those own
// the scroller, and this pane's scroller is already the subject of a carefully-reasoned
// stick-to-bottom state machine (see above) that a library's own scroll writes would fight.
// It is also not `content-visibility: auto`: WKWebView's intrinsic-size ESTIMATES shift
// `scrollHeight` mid-scroll, which is precisely the raced-measurement class those rules
// exist to defend against.
//
// The window is an index into the CONCATENATION of `history` then `items` — one number for
// what is really two arrays, so that a resumed conversation's replayed history and its live
// items share a single ceiling instead of each having their own.

/** How many entries stay mounted when the view is following the conversation. */
export const WINDOW_TAIL = 40;

/** How many more are revealed per "show earlier" step. */
export const WINDOW_STEP = 40;

/** How close to the top a reader must get before the next step is revealed for them. Big
 *  enough that the reveal lands before they hit the ceiling, so scrolling up feels
 *  continuous rather than like hitting a wall and waiting. */
export const WINDOW_REVEAL_PX = 800;

export interface WindowInput {
  /** `history.length + items.length` — the whole conversation. */
  total: number;
  /** Is the view following the bottom? The single most important input: see rule 2. */
  pinned: boolean;
  /** This call is an explicit "show me more" (a button press, or scrolling to the top). */
  reveal?: boolean;
}

/**
 * The index of the first entry the transcript should mount, over `[...history, ...items]`.
 *
 * Four rules, in this order:
 *
 * 1. REVEAL steps the window {@link WINDOW_STEP} further back, clamped at the beginning.
 *    It wins over everything, because it is the only input that came from the user asking.
 * 2. PINNED slides the window forward to the last {@link WINDOW_TAIL} entries. This is the
 *    memory release valve: a long busy session sheds old DOM continuously instead of only
 *    ever growing, so a conversation that runs for an hour costs the same as one that just
 *    started.
 * 3. UNPINNED FREEZES the window's head. A reader who has scrolled up must never have
 *    content taken out from ABOVE them while they read — that is a scroll jump with no
 *    cause they can see, and it would happen on every streamed token. `Math.min` is what
 *    guarantees it: the head can only ever move backwards (revealing more), never forwards.
 * 4. …but never so far forward that fewer than {@link WINDOW_TAIL} entries are mounted,
 *    which is what makes a REWIND (the one thing that shrinks `total`) land on a populated
 *    transcript instead of an empty one.
 */
export function nextFirstShown(prev: number, input: WindowInput): number {
  const total = Math.max(0, input.total);
  const tail = Math.max(0, total - WINDOW_TAIL);
  if (input.reveal) return Math.max(0, Math.min(prev, tail) - WINDOW_STEP);
  if (input.pinned) return tail;
  return Math.min(Math.max(0, prev), tail);
}

/** Where each array's rendered slice starts, and how much is hidden above it. */
export interface WindowSplit {
  /** Entries not mounted at all — what the "Show earlier messages (N)" button offers. */
  hiddenCount: number;
  /** `history.slice(historyFrom)`. Equal to `historyLen` when history is entirely hidden. */
  historyFrom: number;
  /** `items.slice(itemsFrom)`. Zero while any history is still on screen. */
  itemsFrom: number;
  /** Whether ANY history is mounted — i.e. whether the "earlier conversation ↑ · resumed"
   *  divider has something above it to divide. */
  showsHistory: boolean;
}

/** Where the reveal's anchor row sat before and after the commit, in the scroller's CONTENT
 *  coordinate space (i.e. measured so that scrolling itself cannot change the number). */
export interface RevealAnchorMetrics {
  anchorTopBefore: number;
  anchorTopAfter: number;
}

/**
 * How far to push `scrollTop` down so a reveal's prepended entries don't move the row the
 * reader was looking at.
 *
 * Measured from ONE STILL-MOUNTED ROW, never from the scroller's total height, and that is
 * the whole point. A reveal is triggered from a scroll handler while a turn may still be
 * streaming, so React is free to merge the window change and an arriving frame into a single
 * commit — one that prepends 40 older entries ABOVE the reader and appends a new tool card
 * BELOW them. `scrollHeight` grows by both, so compensating with it scrolls the reader down
 * by the append's height as well: a spurious jump of hundreds of pixels mid-read, plus a
 * corrupted `restoreTopRef` for the next re-home to restore to. The anchor moves by the
 * prepend alone, whatever else the commit did.
 *
 * A reveal only ever ADDS entries above, so a non-positive delta means the anchor didn't
 * move (or something else re-laid the transcript out) — correct nothing rather than guess.
 */
export function revealScrollCorrection(m: RevealAnchorMetrics): number {
  const delta = m.anchorTopAfter - m.anchorTopBefore;
  return delta > 0 ? delta : 0;
}

/** Project a combined-index window head onto the two arrays it actually spans. */
export function splitWindow(historyLen: number, itemsLen: number, firstShown: number): WindowSplit {
  const total = Math.max(0, historyLen) + Math.max(0, itemsLen);
  const head = Math.min(Math.max(0, firstShown), total);
  const historyFrom = Math.min(head, Math.max(0, historyLen));
  return {
    hiddenCount: head,
    historyFrom,
    itemsFrom: Math.max(0, head - Math.max(0, historyLen)),
    showsHistory: historyFrom < Math.max(0, historyLen),
  };
}

// ─── Decorating the rendered markdown (copy bars, media, path chips) ──────────────
//
// The three hooks below all do the same kind of work: walk the HTML `MarkdownPreview` just
// wrote and turn parts of it into something better — a code block with a Copy bar, a media
// reference into the picture or the player itself, a path into a chip you can click.
//
// They run after EVERY render, deliberately, and that is not the same as running once. The
// markdown subtree is written with `dangerouslySetInnerHTML`, which React re-writes from
// scratch whenever it commits an update to that element — every child, and with it every
// decoration these hooks added, is thrown away and replaced by the raw markup again. Keying
// them to the message's own text (which is what they used to do) meant a re-render driven by
// ANYTHING ELSE — another message streaming, a slide-over opening, the working indicator
// ticking — silently reverted a whole answer to raw markdown with no effect left to notice.
// A `<video>` became a bare `<a href="…mp4">` again, and following one of those in a window
// with no back button IS the app closing (owner report 07-25).
//
// `MarkdownPreview` no longer rewrites on an unchanged render (it passes a stable
// `dangerouslySetInnerHTML` object), so in practice these passes are cheap no-ops: every one
// of them is guarded by a marker attribute, so a subtree that is already decorated costs
// two `querySelectorAll` calls and nothing else. Running every time is what makes the
// decoration self-healing rather than a one-shot that can be lost without a trace.

// ─── Copyable code blocks (state 2 — fenced-code Copy button + language bar) ──────

/**
 * Chat-local effect: injects a small header bar (language label + Copy button) above
 * every `pre > code` block inside `ref.current` that hasn't already been processed.
 * Scoped to this directory — every OTHER page that renders markdown (tasks, knowledge,
 * core) is unaffected. Marks each processed `pre` with `data-chat-copy` so the pass on
 * every render (see this section's header) never double-wraps one.
 */
export function useCopyableCodeBlocks(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const blocks = root.querySelectorAll<HTMLPreElement>('pre:not([data-chat-copy]):not(.mermaid)');
    blocks.forEach((pre) => {
      const code = pre.querySelector('code');
      if (!code) return;
      pre.setAttribute('data-chat-copy', '1');

      const lang = Array.from(code.classList)
        .find((c) => c.startsWith('language-'))
        ?.slice('language-'.length) ?? '';

      const bar = document.createElement('div');
      bar.className = 'chat-code-bar';

      const label = document.createElement('span');
      label.className = 'chat-code-lang';
      label.textContent = lang;
      bar.appendChild(label);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-code-copy';
      button.textContent = 'Copy';
      button.addEventListener('click', () => {
        void navigator.clipboard?.writeText(code.textContent ?? '').then(
          () => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1200); },
          () => { /* clipboard unavailable — button text simply doesn't change */ },
        );
      });
      bar.appendChild(button);

      pre.insertBefore(bar, pre.firstChild);
    });
  }); // every render — see this section's header
}

// ─── Clickable file paths in an answer ───────────────────────────────────────────────

/**
 * Does this backticked span look like a path worth opening? Deliberately narrow, because a
 * false positive is a button that opens nothing: it must contain a directory separator, no
 * whitespace, no URL scheme, and either end in a short extension or in `/` (a folder, which
 * the file endpoint answers with a listing). That covers the way an answer actually names a
 * file — `src/server/routes/agent-chat.ts` — while leaving `npm run build`, `a/b` branch
 * names and prose alone.
 */
const PATH_LIKE_RE = /^(?:\.\/)?(?:[\w.@+-]+\/)+(?:[\w.@+-]+\.[A-Za-z0-9]{1,8}|)$/;

export function looksLikePath(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 200 || /\s/.test(t) || t.includes('://')) return false;
  return PATH_LIKE_RE.test(t);
}

/**
 * Chat-local effect: turns a path the answer wrote in backticks into something you can
 * click, so `src/server/routes/agent-chat.ts` opens that file instead of being a string you
 * have to go copy. Free for the agent — it is already how paths get written.
 *
 * Only INLINE code spans (never a `<pre>` block, where a path is part of a command or a
 * snippet and clicking it would be nonsense). Marks each processed node so the pass on every
 * render never double-binds one, exactly like the sibling effects here.
 */
export function useClickablePaths(
  ref: RefObject<HTMLElement | null>,
  onOpenPath: (path: string) => void,
): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('code:not([data-chat-path])').forEach((code) => {
      code.setAttribute('data-chat-path', '1');
      if (code.closest('pre')) return;
      const text = (code.textContent ?? '').trim();
      if (!looksLikePath(text)) return;
      code.classList.add('chat-md-path');
      code.setAttribute('role', 'button');
      code.setAttribute('tabindex', '0');
      code.title = `Open ${text}`;
      code.addEventListener('click', () => onOpenPath(text));
      code.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenPath(text); }
      });
    });
  }); // every render — see this section's header
}

// ─── Inline media in an answer ───────────────────────────────────────────────────────

const MEDIA_KIND_BY_EXT: Record<string, 'image' | 'video' | 'audio'> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', ogv: 'video',
  mp3: 'audio', m4a: 'audio', wav: 'audio', oga: 'audio', ogg: 'audio', flac: 'audio',
};

/** What a referenced path should become in the transcript, from its extension alone. */
export function inlineMediaKind(path: string): 'image' | 'video' | 'audio' | null {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '');
  const ext = clean.slice(clean.lastIndexOf('.') + 1).toLowerCase();
  return (clean.includes('.') && MEDIA_KIND_BY_EXT[ext]) || null;
}

/** A path we should try to render ourselves, rather than leave as an ordinary link. */
function isLocalRef(href: string): boolean {
  return !!href && !/^(https?:|data:|blob:|mailto:|#)/i.test(href) && !href.startsWith('/api/');
}

/** Bytes for a referenced path. Built through the api client, NOT by hand: the vault has to
 *  ride in the URL because the browser fetches an element `src` itself and sends no headers
 *  (see `agentFileUrl`). Hand-building this is what made every clip 400 in launcher mode. */
function rawUrl(path: string): string {
  return agentFileUrl(path, { raw: true });
}

function basenameOf(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

/**
 * Chat-local effect: turns the file references an answer writes into the thing itself —
 * a picture you can see, a clip you can play, a folder you can look inside — instead of a
 * path you have to go find.
 *
 * Why an effect and not a marked renderer: the reference is a FILESYSTEM path, which no
 * browser can load. Bytes only reach the page through `GET /api/agent/file` — images and
 * media raw (range-streamed, so video seeks), folders as a listing. Both markdown forms are
 * handled, because markdown has no video syntax: `![x](clip.mp4)` (an `<img>` that could
 * never load) and `[x](clip.mp4)` (a plain link) both become a player.
 *
 * Three outcomes, in order of preference:
 *   1. renders inline — anything the file endpoint will serve;
 *   2. asks — a path outside the project root comes back `needs_grant`, and the user gets a
 *      card naming the file with an "Allow access" button. Granting is per-file and per-click;
 *   3. opens — if it still can't be shown (a format browsers won't play, a grant declined),
 *      one click hands it to the OS.
 *
 * Marks each processed node so the pass on every render never double-wraps one. Scoped to
 * this directory, so knowledge and task pages are unaffected.
 */
export function useInlineMedia(
  ref: RefObject<HTMLElement | null>,
  handlers: {
    /** Open an image full-size (the existing lightbox). */
    onOpen?: (path: string) => void;
    /** Hand the path to the OS — the last-resort fallback. */
    onReveal?: (path: string) => void;
    /** Ask the server to allow this exact file; resolves true when it may now be served. */
    onGrant?: (path: string) => Promise<boolean>;
  } = {},
): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    /** The card shown when bytes can't reach the page — always actionable, never a dead end. */
    const buildFallback = (path: string, reason: 'grant' | 'open'): HTMLElement => {
      const card = document.createElement('span');
      card.className = 'chat-md-blocked';
      card.title = path;

      const name = document.createElement('span');
      name.className = 'chat-md-blocked-name';
      name.textContent = `${inlineMediaKind(path) === 'video' ? '🎬' : inlineMediaKind(path) === 'audio' ? '🎵' : '🖼'} ${basenameOf(path)}`;
      card.append(name);

      if (reason === 'grant') {
        const note = document.createElement('span');
        note.className = 'chat-md-blocked-note';
        note.textContent = 'outside the project';
        card.append(note);

        const allow = document.createElement('button');
        allow.type = 'button';
        allow.className = 'chat-md-blocked-allow';
        allow.textContent = 'Allow access';
        allow.addEventListener('click', () => {
          allow.disabled = true;
          allow.textContent = 'Allowing…';
          void (handlers.onGrant?.(path) ?? Promise.resolve(false)).then((ok) => {
            // Granted → swap the card back for the real thing, which now loads.
            if (ok) card.replaceWith(buildMedia(path));
            else { allow.disabled = false; allow.textContent = 'Allow access'; }
          });
        });
        card.append(allow);
      }

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'chat-md-blocked-open';
      open.textContent = 'Open ↗';
      open.addEventListener('click', () => handlers.onReveal?.(path));
      card.append(open);
      return card;
    };

    /** The element a path deserves, wired to fall back to the card if it can't load. */
    const buildMedia = (path: string): HTMLElement => {
      const kind = inlineMediaKind(path);
      const el = kind === 'video' ? document.createElement('video')
        : kind === 'audio' ? document.createElement('audio')
          : document.createElement('img');
      el.className = `chat-md-media chat-md-${kind ?? 'image'}`;
      el.setAttribute('data-chat-media', '1');
      if (el instanceof HTMLVideoElement || el instanceof HTMLAudioElement) {
        el.controls = true;
        el.preload = 'metadata';
      } else {
        // An answer can reference a dozen screenshots, and a transcript scrolled away from
        // holds every one of them decoded in memory. `lazy` defers the fetch until the image
        // is near the viewport; `async` keeps the decode off the main thread so a large PNG
        // landing mid-stream doesn't drop the frame the token was being painted in.
        el.loading = 'lazy';
        el.decoding = 'async';
        el.addEventListener('click', () => handlers.onOpen?.(path));
      }
      el.addEventListener('error', () => {
        // `<img>`/`<video>` only ever report "it failed" — ask the endpoint WHY, so a path
        // that merely needs consent offers Allow rather than a bare Open.
        // A ONE-BYTE ranged GET, not HEAD: the router serves GET only, and a HEAD would come
        // back 404 — making every blocked file look like "can't open" when it merely needs
        // consent. One byte costs nothing even for a large clip.
        void fetch(rawUrl(path), { headers: { Range: 'bytes=0-0' } })
          .then((r): 'grant' | 'open' => (r.status === 403 ? 'grant' : 'open'))
          .catch((): 'grant' | 'open' => 'open')
          // The probe is async, and a still-streaming message re-renders in the meantime —
          // `dangerouslySetInnerHTML` throws the whole subtree away on every token. Swapping
          // a DETACHED element does nothing except drop the fallback on the floor, so only
          // replace one that is still on the page; the re-render's own pass rebuilds it.
          .then((reason) => { if (el.isConnected) el.replaceWith(buildFallback(path, reason)); });
      }, { once: true });
      el.src = rawUrl(path);
      return el;
    };

    // `![x](media)` — an <img> that can never load for video/audio, and needs the endpoint
    // rewrite even for images.
    root.querySelectorAll<HTMLImageElement>('img:not([data-chat-media])').forEach((img) => {
      const path = img.getAttribute('src') ?? '';
      if (!isLocalRef(path)) return;
      img.replaceWith(buildMedia(path));
    });

    // `[x](clip.mp4)` — markdown has no video syntax, so a LINK is how a clip is written.
    // A link to any OTHER local file opens it in the app, the same as the backticked paths
    // beside it: its href is a filesystem path, so following it would navigate the view to
    // a route that doesn't exist and take the conversation with it. Absolute URLs are left
    // untouched — `installExternalLinkHandler` sends those to the default browser.
    //
    // The marker goes on only where this pass actually TOOK the node over. Marking first and
    // deciding after — which is what this used to do — permanently blacklists any node the
    // pass declined, and the pass runs against a half-written message on every streamed
    // token: one look at an href that wasn't finished yet and the finished link could never
    // be reconsidered, leaving a live `<a href="_dream_context/…">` in the transcript. In a
    // window with no back button, following one of those IS the app closing.
    root.querySelectorAll<HTMLAnchorElement>('a:not([data-chat-media])').forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      if (!isLocalRef(href)) return;
      if (inlineMediaKind(href)) { a.replaceWith(buildMedia(href)); return; }
      a.setAttribute('data-chat-media', '1');
      a.classList.add('chat-md-path');
      a.title = `Open ${href}`;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        handlers.onOpen?.(href);
      });
    });
  }); // every render — see this section's header
}
