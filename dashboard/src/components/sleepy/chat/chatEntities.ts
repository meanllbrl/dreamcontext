import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { api, agentFileUrl, RequestError } from '../../../api/client';

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

// ─── Prompt history (composer ↑/↓ recall) ─────────────────────────────────────────

/** The subset of a transcript item {@link promptHistory} reads — structural for the same
 *  reason as {@link ProgressProbe}: this module never imports chatSession.ts. */
export interface PromptProbe { kind: string; text?: string }

/**
 * The prompts already sent in THIS conversation, NEWEST FIRST — what ↑ walks back through.
 *
 * Both lists are passed because a resumed chat keeps its replayed transcript in `history`,
 * separate from the live `items` (see ConversationModel), and recall has to cover both: the
 * whole point of resuming is that the earlier turns are yours to re-run.
 *
 * Consecutive duplicates collapse to one entry. A shell history does the same, and for the
 * same reason: sending "npm test" three times in a row should cost one ↑, not three. Two
 * NON-adjacent sends of the same text are kept — the positions between them are what make
 * walking back through the conversation legible.
 */
export function promptHistory(history: PromptProbe[], items: PromptProbe[]): string[] {
  const out: string[] = [];
  for (const it of [...history, ...items]) {
    if (it.kind !== 'user') continue;
    const text = (it.text ?? '').trim();
    if (!text) continue;
    if (out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out.reverse();
}

/** Where the composer is in its walk back through {@link promptHistory}. `index === null`
 *  means "not browsing — the textarea holds the user's own draft"; otherwise it is an index
 *  into the newest-first entries list, and `stash` is the draft that was displaced when the
 *  walk began (restored by stepping forward past the newest entry). */
export interface HistoryNav { index: number | null; stash: string }

export const NO_HISTORY_NAV: HistoryNav = { index: null, stash: '' };

/**
 * Whether ↑ should recall a past prompt rather than move the caret.
 *
 * Already browsing → always (that's the walk continuing). Otherwise the draft must be empty,
 * or the caret parked at the very start with nothing selected — the shell/Claude Code rule.
 * Without the caret clause, ↑ inside a half-written multi-line message would throw the
 * message away to show an old one, which is the worse failure by far: recall is a
 * convenience, losing what you just typed is not recoverable.
 */
export function canRecallHistory(
  draft: string, caret: number, selectionEnd: number, nav: HistoryNav,
): boolean {
  if (nav.index !== null) return true;
  if (!draft) return true;
  return caret === 0 && selectionEnd === 0;
}

/**
 * One ↑/↓ step through the history. Pure: returns the next nav state plus the text the
 * textarea should show, or `null` when the step is a no-op (already at the oldest entry, ↓
 * while not browsing, or no history at all) — the caller then leaves the keystroke alone
 * instead of swallowing it.
 *
 * `draft` is the CURRENT textarea text, stashed on the first backward step so stepping
 * forward past the newest entry hands it back verbatim.
 */
export function stepHistory(
  entries: string[], nav: HistoryNav, dir: 'back' | 'forward', draft: string,
): { nav: HistoryNav; text: string } | null {
  if (dir === 'back') {
    const next = nav.index === null ? 0 : nav.index + 1;
    if (next >= entries.length) return null;
    const stash = nav.index === null ? draft : nav.stash;
    return { nav: { index: next, stash }, text: entries[next] };
  }
  if (nav.index === null) return null;
  const next = nav.index - 1;
  // Walked back out of the history: the draft that was displaced comes back, and the nav
  // resets so the next ↑ starts a fresh walk (and re-stashes whatever is there by then).
  if (next < 0) return { nav: NO_HISTORY_NAV, text: nav.stash };
  return { nav: { index: next, stash: nav.stash }, text: entries[next] };
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

/** What the scroll handler knows when it decides whether to extend the window. */
export interface AutoRevealMetrics {
  /** Entries above the window's ceiling. Nothing to reveal → nothing to decide. */
  hiddenCount: number;
  scrollTop: number;
  /** Did a gesture cause this, or did our own code / a clamp move the offset? */
  userDriven: boolean;
  /** Is the scrollbar thumb currently held? */
  dragging: boolean;
}

/**
 * Should reading up to the ceiling extend the window right now?
 *
 * `userDriven` is necessary and NOT sufficient, and the gap between those two is a bug the
 * owner reported as the transcript teleporting while it loaded history.
 *
 * Everything about the reveal assumes the reader can be put back by WRITING `scrollTop` —
 * that is how the prepend is paid for. While the scrollbar thumb is held that assumption is
 * false: the browser keeps deriving `scrollTop` from the thumb, so it overwrites the
 * correction on the next drag update and the view returns to what the thumb says, the top.
 * Then this predicate is asked again, sees the ceiling and a user-driven event (a drag is the
 * most unambiguous gesture there is), and reveals again. Traced on a 500-item transcript: 42
 * mounted rows became 282 in one slow drag, the reader thrown to the top at every step.
 *
 * So a drag is exactly the state that most looks like intent and least permits the response.
 * ChatPane makes the deferred reveal on pointer-release instead, where the offset is its own
 * again — dragging to the ceiling still extends the window, once, and holds.
 */
export function shouldAutoReveal(m: AutoRevealMetrics): boolean {
  if (m.hiddenCount <= 0) return false;
  if (m.scrollTop >= WINDOW_REVEAL_PX) return false;
  if (m.dragging) return false;
  return m.userDriven;
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

/** Where the held anchor row sat before and after a layout change, in the scroller's CONTENT
 *  coordinate space (i.e. measured so that scrolling itself cannot change the number). */
export interface AnchorHoldMetrics {
  anchorTopBefore: number;
  anchorTopAfter: number;
}

/** Sub-pixel noise floor. Zoom, fractional layout and `getBoundingClientRect` rounding make an
 *  untouched row's content offset wobble by a fraction of a pixel; correcting for that would
 *  write `scrollTop` on every frame of every stream for no visible reason. */
export const ANCHOR_EPSILON = 0.5;

/**
 * How far to move `scrollTop` so the row the reader is looking at stays exactly where it is on
 * screen, given where that row sat before and after a layout change.
 *
 * This is scroll anchoring, done by hand, because nothing else will do it for us: the scroller
 * sets `overflow-anchor: none` (native anchoring would double-correct the reveal below), and
 * this app ships in a WKWebView where the feature is young at best. So EVERY height change
 * above an unpinned reader is ours to absorb — and there are many more of them than the reveal
 * this started as: an image or clip in a revealed message finishing its load, a code block
 * growing its copy bar in a post-paint decoration pass, a tool card above the fold expanding
 * or collapsing, a rewind truncating the transcript. Left alone, each one slides the reader
 * off what they were reading (owner report 07-28: "I scroll up, you load the history, and the
 * place I was at moves").
 *
 * Measured from ONE STILL-MOUNTED ROW, never from the scroller's total height, and that is the
 * whole point. A reveal is triggered from a scroll handler while a turn may still be streaming,
 * so React is free to merge the window change and an arriving frame into a single commit — one
 * that prepends 40 older entries ABOVE the reader and appends a new tool card BELOW them.
 * `scrollHeight` grows by both, so compensating with it scrolls the reader down by the append's
 * height as well: a spurious jump of hundreds of pixels mid-read, plus a corrupted
 * `restoreTopRef` for the next re-home to restore to. The anchor moves by the prepend alone,
 * whatever else the commit did.
 *
 * SIGNED, unlike the reveal-only correction it replaces. A reveal can only ever add entries
 * above, so that one could treat a negative delta as "something else re-laid the transcript
 * out, don't guess". A hold that survives for as long as the reader is unpinned sees the other
 * direction for real — a card above them collapsing, an image failing and shrinking to its alt
 * text — and following the row UP is just as much "hold still" as following it down.
 */
export function anchorHoldCorrection(m: AnchorHoldMetrics): number {
  const delta = m.anchorTopAfter - m.anchorTopBefore;
  return Math.abs(delta) < ANCHOR_EPSILON ? 0 : delta;
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
// markdown subtree is not React's to reconcile — `MarkdownPreview` writes it to the DOM
// itself — so any markup it rewrites comes back undecorated, with no dependency change to
// notice it happened. Keying these hooks to the message's own text (which is what they used
// to do) meant a re-render driven by ANYTHING ELSE — another message streaming, a slide-over
// opening, the working indicator ticking — silently reverted a whole answer to raw markdown.
// A `<video>` became a bare `<a href="…mp4">` again, and following one of those in a window
// with no back button IS the app closing (owner report 07-25).
//
// What a rewrite costs is now bounded: `MarkdownPreview` re-renders only the markdown BLOCKS
// that changed (lib/markdownBlocks.ts), so a streamed token reaches the paragraph being typed
// and nothing above it. These passes stay cheap either way — every one is guarded by a marker
// attribute, so an already-decorated subtree costs two `querySelectorAll` calls and nothing
// else. Running every time is what makes the decoration self-healing rather than a one-shot
// that can be lost without a trace.

// ─── Copyable code blocks (state 2 — fenced-code Copy button + language bar) ──────

/**
 * Chat-local effect: injects a small header bar (language label + Copy button) above
 * every `pre > code` block inside `ref.current` that hasn't already been processed.
 * Scoped to this directory — every OTHER page that renders markdown (tasks, knowledge,
 * core) is unaffected. Marks each processed `pre` with `data-chat-copy` so the pass on
 * every render (see this section's header) never double-wraps one.
 */
export function useCopyableCodeBlocks(ref: RefObject<HTMLElement | null>): void {
  // A LAYOUT effect, for the same reason `useInlineMedia` is one: this pass ADDS HEIGHT to a
  // row (the bar is ~34px per fenced block), and a passive effect adds it after the browser
  // has painted. Above a reader who has scrolled up, that is a shove they can see. ChatPane's
  // hold corrects it — but only on the NEXT frame, via the ResizeObserver, so the wrong
  // position gets one painted frame first. Child layout effects run before the parent's, so
  // decorating here means the reveal's correction measures the DECORATED layout and there is
  // nothing left to catch up on.
  //
  // Measured against the real dashboard, a 360-entry resumed transcript, scrolling up through
  // the reveals: the revealed block carried 6 fenced blocks, each grew by exactly 34px after
  // the correction had been computed, and the reader's own row jumped by the 204px total for
  // exactly one frame at every single reveal. The same fixture with no fenced blocks and no
  // images slipped 0-1px, which is what named this pass as the cause.
  //
  // The cost is bounded and was already being paid every commit: the pass is guarded by
  // `data-chat-copy`, so an already-decorated subtree is two `querySelectorAll` calls.
  useLayoutEffect(() => {
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
  // A LAYOUT effect for the same reason as `useCopyableCodeBlocks` above: turning a bare
  // `<code>` into a chip changes its box, which can rewrap the line it sits in and take the
  // paragraph with it. Small per path, but it lands above a scrolled-up reader in the same
  // post-paint window, and the correction for it is a frame behind.
  useLayoutEffect(() => {
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

/** How many media elements ONE message keeps alive for re-use (see {@link useInlineMedia}). */
const MEDIA_KEEP_MAX = 8;

// ─── Remembered image boxes (why a scrolled-up reader stops getting nudged) ───────────
//
// An `<img>` with no width/height attributes occupies ZERO height until its bits arrive and
// the browser learns the intrinsic size. Everywhere else in the transcript that is merely
// untidy; above a reader who has scrolled up it is the bug. The window reveals 40 older
// entries, ChatPane's hold measures the prepend in its layout effect and corrects `scrollTop`
// by exactly what it measured — and every image in that block is still 0px tall at that
// moment. They resolve a beat later, grow the content ABOVE the reader, and the correction
// for THAT lands one painted frame afterwards. So the reader sees one frame at the wrong
// place per image, which is felt as the transcript shoving them around while it loads.
//
// Measured against the real dashboard, a 360-entry resumed transcript, same fixture, same
// browser, scrolling up through the reveals: with an image in every answer the reveal frame
// slipped 205px EVERY time; with the images removed from the same fixture it slipped 0-1px.
// That is the whole defect — not the hold, which corrects exactly what it can see.
//
// So the box is RESERVED before the bits arrive. The natural size of every image the
// transcript has ever displayed is remembered here and replayed onto the next element built
// for that path, which gives the browser the aspect ratio up front and leaves nothing to
// grow. `localStorage`, not just memory, because the case this exists for is REOPENING a
// conversation and reading back through it: those images were displayed when the work
// happened, and a memory-only cache would be empty at exactly the moment it is needed.
//
// A stale entry (the file was overwritten at a different aspect) costs one ordinary
// correction — the same one an unreserved image costs today — and is repaired on load.

/** Remembered `naturalWidth`/`naturalHeight` per referenced path. */
const mediaBoxes = new Map<string, { w: number; h: number }>();
const MEDIA_BOX_KEY = 'dreamcontext.chat.mediaBoxes';
/** Bound on what is persisted. Oldest out — a vault's screenshots are read newest-first. */
const MEDIA_BOX_MAX = 400;
let mediaBoxesLoaded = false;

/** Hydrate the remembered boxes once per page. Any failure leaves the map empty, which is
 *  simply the behaviour that existed before this cache — never an exception into a render. */
function loadMediaBoxes(): void {
  if (mediaBoxesLoaded) return;
  mediaBoxesLoaded = true;
  try {
    const raw = localStorage.getItem(MEDIA_BOX_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [path, box] of Object.entries(parsed as Record<string, unknown>)) {
      const b = box as { w?: unknown; h?: unknown };
      // Only a pair of finite positive numbers is an aspect ratio. Anything else would put
      // a NaN into an attribute and reserve a box of unpredictable height.
      if (typeof b?.w === 'number' && typeof b?.h === 'number'
        && Number.isFinite(b.w) && Number.isFinite(b.h) && b.w > 0 && b.h > 0) {
        mediaBoxes.set(path, { w: b.w, h: b.h });
      }
    }
  } catch { /* unreadable/disabled storage — reserve nothing, exactly as before */ }
}

/** Remember one image's natural size, and mirror the map to storage. */
export function rememberMediaBox(path: string, w: number, h: number): void {
  if (!(w > 0 && h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return;
  const known = mediaBoxes.get(path);
  // Re-insert at the END so eviction is least-recently-SEEN rather than insertion order: a
  // screenshot the reader keeps scrolling past must outlive images they only ever passed once.
  mediaBoxes.delete(path);
  mediaBoxes.set(path, { w, h });
  while (mediaBoxes.size > MEDIA_BOX_MAX) {
    mediaBoxes.delete(mediaBoxes.keys().next().value as string);
  }
  // Seeing a known image again reorders the queue but writes nothing: `load` fires for every
  // image on every mount, and serializing the whole map each time would put a few hundred
  // entries through `JSON.stringify` on a scroll.
  if (known && known.w === w && known.h === h) return;
  try {
    localStorage.setItem(MEDIA_BOX_KEY, JSON.stringify(Object.fromEntries(mediaBoxes)));
  } catch { /* quota/disabled — the in-memory map still serves this page */ }
}

/** The remembered box for a path, or null when this image has never been displayed. */
export function knownMediaBox(path: string): { w: number; h: number } | null {
  loadMediaBoxes();
  return mediaBoxes.get(path) ?? null;
}

// ─── Folders (the file panel's directory listing) ────────────────────────────────────

/**
 * The path of one entry inside a listed folder. The listed path may or may not carry a
 * trailing slash — the agent writes `_dream_context/knowledge/legal/` as readily as without
 * it — and `a//b` is a different path to the server's resolver than `a/b`, so joining is
 * never plain concatenation.
 */
export function joinChildPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/** `1.4 KB` · `310 B` · `2.1 MB` — a folder row's size, or `''` for a subfolder. */
export function formatEntrySize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** What a folder row says about entries the server didn't send. Null when nothing was cut. */
export function dirTruncationNote(shown: number, total?: number, truncated?: boolean): string | null {
  if (!truncated && (total == null || total <= shown)) return null;
  return total != null ? `Showing ${shown} of ${total} entries` : `Showing the first ${shown} entries`;
}

// ─── Media the USER attached (the sent bubble) ───────────────────────────────────────

/** Cap on thumbnails one sent message draws — a folder of screenshots stays a strip. */
const USER_MEDIA_MAX = 6;

export interface UserMedia {
  /** The text to SHOW in the bubble: the trailing attachment paths taken out, because they
   *  are drawn below it instead. Never used for copy/quote/rewind, which keep the real text. */
  text: string;
  /** Attached media paths, in the order they were attached. */
  media: string[];
}

/**
 * Split a SENT message into the part to read and the part to look at.
 *
 * The composer folds an attachment into the message as a (quoted) ABSOLUTE path at the end
 * (see Composer's `commit`) — that is how the agent receives a picture at all, the chat
 * protocol being text-only. But a path is not what the person who attached it should get
 * back: they sent a screenshot and the transcript owes them the screenshot (owner report
 * 07-27 — the bubble showed the path and nothing else).
 *
 * Deliberately narrow, because this rewrites what the user sees of their OWN words:
 *  - only an ABSOLUTE path (or a quoted one, which is how a path with spaces is written)
 *    counts as an attachment. `check shot.png` typed in prose is left completely alone —
 *    no thumbnail, no text surgery;
 *  - only the TRAILING run comes out of the text, which is exactly what the composer appends.
 *    An attachment path mid-sentence stays where the user put it, and is still drawn.
 *
 * Pure: string in, strings out. No filesystem, no network — safe on every render.
 */
export function splitUserMedia(raw: string): UserMedia {
  const tokens = tokenizeQuoted(raw);
  const isAttachment = (t: Token) => !!inlineMediaKind(t.value) && (t.quoted || t.value.startsWith('/'));
  let cut = tokens.length;
  while (cut > 0 && isAttachment(tokens[cut - 1])) cut -= 1;
  const trailing = tokens.slice(cut);
  const inline = tokens.slice(0, cut).filter(isAttachment);
  const media: string[] = [];
  for (const t of [...inline, ...trailing]) {
    if (!media.includes(t.value)) media.push(t.value);
    if (media.length >= USER_MEDIA_MAX) break;
  }
  const text = trailing.length ? raw.slice(0, trailing[0].start).replace(/\s+$/, '') : raw;
  return { text, media };
}

interface Token { value: string; start: number; quoted: boolean }

/**
 * Split text into whitespace-separated tokens, treating a single-quoted run as ONE token and
 * unwrapping it — the composer quotes any path that needs it (`quotePath`), so a screenshot
 * with a space in its name arrives as `'…/CleanShot 2026-07-27.png'` and must not be read as
 * two tokens. Records each token's start offset so a caller can cut the original string.
 */
function tokenizeQuoted(raw: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < raw.length) {
    if (/\s/.test(raw[i])) { i += 1; continue; }
    const start = i;
    if (raw[i] === "'") {
      const end = raw.indexOf("'", i + 1);
      if (end !== -1) {
        out.push({ value: raw.slice(i + 1, end), start, quoted: true });
        i = end + 1;
        continue;
      }
    }
    while (i < raw.length && !/\s/.test(raw[i])) i += 1;
    out.push({ value: raw.slice(start, i), start, quoted: false });
  }
  return out;
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
 * Hand a path to the OS (`POST /api/agent/reveal`) and say whether it actually went.
 *
 * Resolves to `null` when the opener took it, or to a short line to SHOW when it could not.
 * A button that silently does nothing is worse than no button — the user clicks, the app
 * says nothing, and there is no telling "opened behind the window" from "never reachable".
 *
 * The words are chosen HERE, from the route's `error` slug, and are deliberately the sort a
 * person says. The route's own prose ("Path escapes the project root") is a correct answer
 * to the wrong audience: nobody reading a chat bubble asked about project roots. Finding the
 * file the reference actually meant is `resolveChatReference`'s job on the server, and it
 * now handles the case that produced this line at all — so this copy is the rare tail, not
 * the everyday outcome.
 */
export function revealPath(path: string): Promise<string | null> {
  return api.post('/agent/reveal', { path }).then(
    () => null,
    (err: unknown) => {
      const code = err instanceof RequestError ? err.code : '';
      if (code === 'not_found') return 'this file isn’t there any more';
      if (code === 'desktop_only') return 'only available in the desktop app';
      return 'couldn’t open this one';
    },
  );
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
    /** Hand the path to the OS — the last-resort fallback. Resolves to null when it opened,
     *  or to the reason it could not, which the card then SHOWS (see {@link revealPath}). */
    onReveal?: (path: string) => Promise<string | null>;
    /** Ask the server to allow this exact file; resolves true when it may now be served. */
    onGrant?: (path: string) => Promise<boolean>;
  } = {},
): void {
  // The elements this pass has built, by path. A media element that is merely DETACHED still
  // holds its decoded frames and its buffer, so putting the same one back is free where
  // building a new one costs a fresh request for the whole clip. That is the difference the
  // owner saw: a message still streaming under a clip re-created the `<video>` per frame
  // (report 07-26). Block-level markdown rendering means most re-renders no longer reach a
  // finished clip at all; this covers the ones that do — a reference in the paragraph still
  // being typed, or a block whose markdown genuinely changed.
  const cache = useRef<Map<string, HTMLElement>>(new Map());
  // Listeners on a REUSED element were bound on an earlier render, so they must not close over
  // that render's handlers.
  const live = useRef(handlers);
  live.current = handlers;

  // A LAYOUT effect: the reinsert has to happen in the same task as the removal. A media
  // element removed from the document is paused once the browser reaches a stable state, so
  // waiting until after paint (a passive effect) would stop a playing clip every time the
  // block around it was re-rendered. It also means no frame is ever painted showing the raw
  // `<a href="…mp4">` this pass replaces.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;

    /**
     * The card shown when bytes can't reach the page — always actionable, never a dead end.
     *
     * `grantPath` is the file the SERVER resolved the reference to, which is what "Allow
     * access" must record: the endpoint decides which file `../../tmp/x.png` means, and a
     * grant written against the notation instead of the file would never match on the next
     * read. Falls back to the reference itself when the server sent nothing.
     */
    const buildFallback = (path: string, reason: 'grant' | 'open', grantPath: string): HTMLElement => {
      const card = document.createElement('span');
      card.className = 'chat-md-blocked';
      card.title = path;

      const name = document.createElement('span');
      name.className = 'chat-md-blocked-name';
      name.textContent = `${inlineMediaKind(path) === 'video' ? '🎬' : inlineMediaKind(path) === 'audio' ? '🎵' : '🖼'} ${basenameOf(path)}`;
      card.append(name);

      // The card's one line of explanation, sitting right after the name. Created up front
      // but only ATTACHED when it has something to say — an empty span would otherwise show
      // as a gap in the flex row. Carries the standing "outside the project" reason, and
      // later whatever the OS opener came back with.
      const note = document.createElement('span');
      note.className = 'chat-md-blocked-note';
      const setNote = (text: string | null): void => {
        if (!text) { note.remove(); return; }
        note.textContent = text;
        if (!note.isConnected) name.after(note);
      };

      /** What the card says when nothing has gone wrong (yet). */
      const standingNote = reason === 'grant' ? 'outside the project' : null;
      setNote(standingNote);

      if (reason === 'grant') {
        const allow = document.createElement('button');
        allow.type = 'button';
        allow.className = 'chat-md-blocked-allow';
        allow.textContent = 'Allow access';
        allow.addEventListener('click', () => {
          allow.disabled = true;
          allow.textContent = 'Allowing…';
          void (live.current.onGrant?.(grantPath) ?? Promise.resolve(false)).then((ok) => {
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
      // `live.current`, never the `handlers` of the render this card was built in — a card
      // outlives the render that created it (see this hook's `live` ref), and closing over a
      // dead render's handler is how a button quietly stops working.
      open.addEventListener('click', () => {
        const pending = live.current.onReveal?.(path);
        if (!pending) return; // nothing wired to open with — leave the card exactly as it was
        open.disabled = true;
        open.textContent = 'Opening…';
        void pending.then((err) => {
          open.disabled = false;
          open.textContent = 'Open ↗';
          // Failure SAYS why, in the card, rather than leaving the click looking like it
          // did something; success drops the line back to the standing reason.
          setNote(err ?? standingNote);
        });
      });
      card.append(open);
      return card;
    };

    /** The element a path deserves, wired to fall back to the card if it can't load. */
    const buildMedia = (path: string): HTMLElement => {
      // Already built one for this path and it is off the page? Put THAT one back — same
      // resource, same buffer, same playhead, no request. A still-connected one means the
      // answer references the file twice, which needs a second element of its own.
      const kept = cache.current.get(path);
      if (kept && !kept.isConnected) return kept;

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
        // Reserve the box BEFORE the bits arrive, so a revealed block does not grow under a
        // reader who has scrolled up (see `mediaBoxes`). The attributes only supply an aspect
        // ratio here — `.chat-md-image` keeps `width/height: auto` under its two caps, so the
        // used size is still decided by the column and `max-height`, exactly as before.
        const box = knownMediaBox(path);
        if (box) { el.width = box.w; el.height = box.h; }
        // First sight of this image (or a file that changed shape) teaches the cache, so the
        // next transcript that mounts it reserves the right box from the start.
        el.addEventListener('load', () => {
          rememberMediaBox(path, el.naturalWidth, el.naturalHeight);
        });
        el.addEventListener('click', () => live.current.onOpen?.(path));
      }
      el.addEventListener('error', () => {
        // Never hand a failed element back out of the cache: its error listener is `once`, so
        // a reused one would sit there broken instead of offering Allow/Open again.
        if (cache.current.get(path) === el) cache.current.delete(path);
        // `<img>`/`<video>` only ever report "it failed" — ask the endpoint WHY, so a path
        // that merely needs consent offers Allow rather than a bare Open.
        // A ONE-BYTE ranged GET, not HEAD: the router serves GET only, and a HEAD would come
        // back 404 — making every blocked file look like "can't open" when it merely needs
        // consent. One byte costs nothing even for a large clip.
        // The 403 body also carries the file the server RESOLVED the reference to, which is
        // what "Allow access" has to grant — see `buildFallback`.
        void fetch(rawUrl(path), { headers: { Range: 'bytes=0-0' } })
          .then(async (r): Promise<{ reason: 'grant' | 'open'; grantPath: string }> => {
            if (r.status !== 403) return { reason: 'open', grantPath: path };
            const body = await r.json().catch(() => null) as { path?: unknown } | null;
            return { reason: 'grant', grantPath: typeof body?.path === 'string' ? body.path : path };
          })
          .catch((): { reason: 'grant' | 'open'; grantPath: string } => ({ reason: 'open', grantPath: path }))
          // The probe is async, and the block around a still-streaming reference re-renders in
          // the meantime. Swapping a DETACHED element does nothing except drop the fallback on
          // the floor, so only replace one that is still on the page; the next pass rebuilds it.
          .then(({ reason, grantPath }) => {
            if (el.isConnected) el.replaceWith(buildFallback(path, reason, grantPath));
          });
      }, { once: true });
      el.src = rawUrl(path);
      // Cap what a single message can keep alive: a detached clip still holds its buffer, and
      // an answer with two dozen screenshots should not pin all of them off-screen. Oldest out.
      if (cache.current.size >= MEDIA_KEEP_MAX) {
        cache.current.delete(cache.current.keys().next().value as string);
      }
      cache.current.set(path, el);
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
        live.current.onOpen?.(href);
      });
    });
  }); // every render — see this section's header
}
