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
  NotebookEdit: '✎',
  Grep: '🔎',
  Glob: '📁',
  LS: '📁',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Agent: '⚡',
  Task: '⚡',
  AskUserQuestion: '❓',
  TodoWrite: '☑',
  Skill: '✦',
};

/** Fallback glyph for a tool name not in {@link TOOL_GLYPHS}. */
export const DEFAULT_TOOL_GLYPH = '✦';

export function toolGlyph(name: string): string {
  return TOOL_GLYPHS[name] ?? DEFAULT_TOOL_GLYPH;
}

/**
 * dreamcontext's OWN skills — the ones `dreamcontext install-skill` writes into `.claude/`
 * from this repo's `skill/` and `skill-…` folders. A `Skill` row for one of these wears the
 * dreamcontext mark instead of the generic ✦, so the app is visibly recognising itself at
 * work rather than reporting a nameless third-party call.
 *
 * Deliberately NOT extended to `skill-packs` (brand-voice, council, business-idea-…):
 * those are a library dreamcontext DISTRIBUTES, not skills that ARE dreamcontext, and
 * branding them would make the mark mean "shipped in the tarball" instead of "this is us".
 * Names are the `name:` frontmatter each SKILL.md declares — the string the CLI invokes.
 */
export const DREAMCONTEXT_SKILLS: ReadonlySet<string> = new Set([
  'dreamcontext',
  'initializer',
  'curator',
  'dreamcontext-deep-research',
  'dream-sync',
  'announcements',
  'patterns',
]);

export function isDreamcontextSkill(skill: string): boolean {
  return DREAMCONTEXT_SKILLS.has(skill.trim().toLowerCase());
}

// ─── Reference classification (state 3/4 — file/entity chips) ─────────────────────

export type RefKind = 'file' | 'task' | 'knowledge' | 'core' | 'inbox' | 'board' | 'image' | 'pdf';

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
const PDF_RE = /\.pdf$/i;

/** A PDF, from its name alone — the one document type the app displays itself rather than
 *  previewing as text (which for a binary means the size cap, or mojibake). */
export function isPdfPath(path: string): boolean {
  return PDF_RE.test(path.split(/[?#]/)[0]);
}

function basename(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return i === -1 ? clean : clean.slice(i + 1);
}

/** A path chip's two halves — see {@link pathChipLabel}. */
export interface PathChipLabel {
  /** The immediate parent folder, WITHOUT a trailing slash. `null` at the root. */
  dir: string | null;
  /** The basename — the half that must never be the one that gets truncated. */
  name: string;
}

/**
 * Split a path into the two things a chip should show: one parent folder for context, and
 * the FILENAME.
 *
 * The bug this exists to kill (owner report 08-01): the chip rendered the raw absolute path
 * and let CSS `max-width` + `text-overflow: ellipsis` cut it — which cuts from the RIGHT.
 * Every row therefore kept `/Users/<me>/proje…`, identical across all of them, and threw
 * away the only part that differed. Seven `Read` rows in one screenshot, not one of them
 * naming its file.
 *
 * Only ONE parent survives on purpose: `chat/chatEntities.ts` locates the file for a reader
 * who already knows the project, and any more of the path is the same shared prefix that
 * caused the problem. The full path is still exact in the chip's `title`, so nothing is lost
 * — it just stops being what you read first.
 */
export function pathChipLabel(path: string): PathChipLabel {
  const raw = String(path);
  const clean = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const cut = clean.lastIndexOf('/');
  // `dir` is one segment, never a path: the parent of `/a/b/c.ts` is `b`, not `/a/b`.
  const parent = cut === -1 ? '' : basename(clean.slice(0, cut));
  // `"/"` cleans to the empty string — fall back to the raw input so the root still renders
  // as something. A chip that draws nothing is worse than a chip that draws a slash.
  return { dir: parent || null, name: basename(clean) || clean || raw };
}

// ─── What a tool row is ABOUT (owner report 08-01) ─────────────────────────────────

/**
 * The subject of a tool call — the thing it acted ON, as opposed to the tool's own name.
 * `path` is openable (the chip stays a button into the file panel); `text` is an identity
 * with nothing behind it to open (a skill name, a search pattern, a host).
 */
export type ToolSubject =
  /** `label` overrides what the chip READS without changing what it opens — for a row whose
   *  subject has a better human name than its filename (a dreamcontext action names the task
   *  the agent typed, and opens the slug the CLI reported for it). */
  | { kind: 'path'; path: string; label?: string }
  | { kind: 'text'; text: string }
  /** Reads as a sentence, not a label — the header renders it as the muted subtitle rather
   *  than a chip. A shell command is prose of this kind; a filename is not. */
  | { kind: 'prose'; text: string };

function inputStr(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** `https://docs.anthropic.com/x` → `docs.anthropic.com`. Falls back to the raw string for
 *  anything `URL` won't parse, so a malformed url still names itself rather than vanishing. */
function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

/** How much of a command survives into the one-line header. The row also ellipsizes in CSS;
 *  this bound is about `innerText` and the DOM, not about the visible width. */
export const COMMAND_LABEL_CAP = 120;

/**
 * A shell command as ONE line of header prose.
 *
 * Newlines are the reason this exists: a heredoc or a `&&`-chained script arrives with real
 * line breaks, and dropping that into a fixed-height row either blows the row open or renders
 * as a ragged fragment. Collapsed to single spaces and capped, it reads as one sentence — and
 * the complete, unmodified command is a click away in the terminal block below.
 */
export function condenseCommand(command: string): string {
  const flat = String(command).replace(/\s+/g, ' ').trim();
  return flat.length > COMMAND_LABEL_CAP ? `${flat.slice(0, COMMAND_LABEL_CAP - 1)}…` : flat;
}

/**
 * What this tool call is ABOUT — the row's identity.
 *
 * The rule, generalised from three separate owner reports on 08-01: **a row names its
 * OBJECT, not its type.** `Skill · 1 lines` names neither — it reports the tool's class and
 * then the character count of its result, which for a skill invocation means nothing at all,
 * while the skill's actual name sits unread in `input.skill`. The same held for `Read` (the
 * file was in `input.file_path`, truncated away by CSS) and would hold for `Grep`, `Glob`,
 * `WebFetch`.
 *
 * `Bash` is `prose`, not a chip — a command is a sentence. It prefers the CLI's own
 * `description`, but FALLS BACK TO THE COMMAND, which is the whole point: `description` is
 * optional on the wire, and a Bash call that arrived without one used to render as the bare
 * word "Bash" with nothing beside it (owner report 08-01, second pass — three such rows in
 * the original screenshot). A row is never allowed to be nameless when its input says what
 * it did.
 */
export function toolSubject(name: string, input: unknown): ToolSubject | null {
  const path = inputStr(input, 'file_path') ?? inputStr(input, 'notebook_path') ?? inputStr(input, 'path');

  switch (name) {
    case 'Bash': {
      const description = inputStr(input, 'description');
      if (description) return { kind: 'prose', text: description };
      const command = inputStr(input, 'command');
      return command ? { kind: 'prose', text: condenseCommand(command) } : null;
    }
    case 'Skill': {
      const skill = inputStr(input, 'skill');
      return skill ? { kind: 'text', text: skill } : null;
    }
    case 'Grep':
    case 'Glob': {
      // A pattern IS the question being asked; the directory it ran in is context the row
      // has no room for (and is usually just the project root).
      const pattern = inputStr(input, 'pattern');
      if (pattern) return { kind: 'text', text: pattern };
      return path ? { kind: 'path', path } : null;
    }
    case 'WebFetch': {
      const url = inputStr(input, 'url');
      return url ? { kind: 'text', text: hostOf(url) } : null;
    }
    case 'WebSearch': {
      const query = inputStr(input, 'query');
      return query ? { kind: 'text', text: query } : null;
    }
    case 'Agent':
    case 'Task': {
      // Normally suppressed into the SubAgentCard, so this only fires for a run whose group
      // card never materialised — it should still say WHICH agent rather than "Task".
      const sub = inputStr(input, 'subagent_type') ?? inputStr(input, 'description');
      return sub ? { kind: 'text', text: sub } : null;
    }
    default:
      return path ? { kind: 'path', path } : null;
  }
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
  // Before the entity matchers, for the same reason images are: a PDF sitting under
  // `_dream_context/knowledge/` is still a PDF, and there is no knowledge page that could
  // render one.
  if (PDF_RE.test(normalized)) {
    return { raw, kind: 'pdf', label, isImage: false };
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

// ─── Reading a tool RESULT as text ────────────────────────────────────────────────

/** JSON for anything that isn't already a string, and `''` for `undefined` — so a result of an
 *  unforeseen shape still renders as something a human can read instead of `[object Object]`. */
export function stringifyToolValue(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/**
 * Flatten a `tool_result` content value into plain text.
 *
 * Two shapes arrive on the wire for the same thing — a bare string, or an array of
 * `{type:'text',text}` blocks — and code that only handled the first silently lost the block
 * form (which is how `· N lines` went missing from exactly the rows that were meant to become
 * informative). Anything else is stringified rather than dropped.
 */
export function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result
      .map((b) => (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string'
        ? (b as Record<string, unknown>).text as string
        : ''))
      .filter(Boolean)
      .join('\n');
  }
  return stringifyToolValue(result);
}

/** `N` for a result with content, `null` for one that hasn't landed or is empty — the caller
 *  decides whether a count is meaningful for its row (it is for a file read; it is not for a
 *  skill invocation's one-line ack). */
export function toolResultLineCount(result: unknown): number | null {
  if (result === undefined) return null;
  const text = toolResultText(result);
  return text.length ? text.split('\n').length : null;
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
   *  backgrounded), or `local_workflow`. Drives {@link isDispatchedAgent} — a bash task has
   *  no model and no token accounting, and must not be labelled a dispatched sub-agent. */
  taskType?: string;
  /** For a `local_bash` task only: the shell command it is running, resolved from the
   *  spawning `Bash` call's own input (see chatSession.ts's `bashCommandFor`). Load-bearing
   *  for {@link isHeadlessAgentShell} — the command is the ONLY channel that says a "shell"
   *  is in fact a headless `claude` session. Absent when the run was adopted off the roster
   *  and its spawning tool call is not in this conversation. */
  command?: string;
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

/** Was this run dispatched through the Agent/Task TOOL, as opposed to riding a `local_bash`
 *  task? `local_bash` tasks ride the exact same `task_*` frames (verified on CLI 2.1.220: a
 *  sub-agent's own `sleep 20` produced its own task_started/task_notification pair), so the
 *  type tag — not the mere presence of a run — is what may call something a dispatch. A run
 *  with no `taskType` at all counts as a dispatch: that is the shape every pre-2.1.220 spike
 *  recorded, and under-reporting a real agent is the worse error.
 *
 *  This, NOT {@link isAgentRun}, is the predicate for anything that depends on the Agent-tool
 *  machinery: a sidechain transcript to drill into, and a spawning tool card to suppress. */
export function isDispatchedAgent(run: SubAgentRun): boolean {
  return run.taskType !== 'local_bash';
}

// ─── Headless `claude` runs: a shell by transport, an agent by nature ──────────────
//
// Owner report (08-01): "we run a LOT of headless claude through the shell — show it as a
// sub-agent, not as a shell." Every fan-out this project actually performs (council personas,
// goal-skill builder lanes, automations) is a backgrounded `claude -p …`, which the CLI
// reports as `task_type:'local_bash'` — indistinguishable, at the frame level, from `npm
// test`. So the whole fleet landed in the background-shells TRAY: a strip of anonymous
// "shells" over the composer, while the sub-agent card the user actually watches sat empty.
//
// The command is the only channel that tells the two apart, so it is carried on the run (see
// `SubAgentRun.command`) and classified here. A run that passes is presented as an AGENT —
// agent card, agent rail, "3 agents running" — while keeping the affordances its transport
// really has: no sidechain transcript exists for it, so its drill-in is its live output, and
// it can be stopped.

/** Command-position wrappers to skip when looking for the executable. `env`/assignments cover
 *  `FOO=bar claude -p`, the rest cover the launchers a spawn actually gets written with. */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  'npx', 'bunx', 'pnpm', 'yarn', 'nohup', 'exec', 'command', 'time', 'env', 'stdbuf', 'caffeinate',
]);

/** The flags that make a `claude` invocation HEADLESS — i.e. a one-shot agent run rather
 *  than the interactive TUI. `--resume` alone is deliberately not enough: resuming is a
 *  modifier on either mode, and only `-p`/`--print` (or an explicit stream format) says the
 *  process will run to completion on its own. */
const HEADLESS_CLAUDE_FLAG_RE = /(?:^|\s)(?:-p|--print|--output-format|--input-format)(?:[\s=]|$)/;

/**
 * Is this shell command a headless Claude Code session?
 *
 * Parsed rather than pattern-matched against the whole string, because the whole string is
 * exactly where the false positives live: `grep -rn claude src/`, `git commit -m "use claude
 * -p"` and `echo "claude -p"` all CONTAIN the invocation without being one. The command is
 * split on shell separators, each segment's leading env-assignments/wrappers/flags are
 * skipped, and only a segment whose EXECUTABLE is literally `claude` (bare or path-qualified)
 * and whose own arguments carry a headless flag counts.
 *
 * Splitting on separators is what makes `printf … | claude -p` work; it can only ever produce
 * MORE segments, never merge two, so it cannot manufacture a match that the shell wouldn't.
 * A `claude` buried inside `bash -c "…"` is missed on purpose — mislabelling a real shell as
 * an agent is the worse error, since the tray is the only surface offering it a Stop.
 */
export function looksLikeHeadlessClaude(command: string | undefined): boolean {
  if (!command) return false;
  for (const segment of command.split(/\|\||&&|[|;\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t.startsWith('-') || COMMAND_WRAPPERS.has(t)) { i += 1; continue; }
      break;
    }
    const exe = tokens[i];
    if (!exe) continue;
    // Strip a subshell/brace opener, quotes, and any leading path: `(claude`, `"claude"`,
    // `~/.local/bin/claude` and `claude` are the same executable.
    const base = exe.replace(/^[({'"]+/, '').replace(/['"]+$/, '').replace(/^.*\//, '');
    if (base !== 'claude') continue;
    if (HEADLESS_CLAUDE_FLAG_RE.test(tokens.slice(i + 1).join(' '))) return true;
  }
  return false;
}

/** The subset of a transcript item {@link bashCommandFor} reads. Structural for the same
 *  reason as {@link ProgressProbe}: this module's invariant is zero dependency on
 *  chatSession.ts (`ChatItem[]` satisfies it). */
export interface CommandProbe { kind: string; toolUseId?: string; name?: string; input?: unknown }

function probeCommand(item: CommandProbe): string | undefined {
  if (!item.input || typeof item.input !== 'object') return undefined;
  const cmd = (item.input as Record<string, unknown>).command;
  return typeof cmd === 'string' && cmd ? cmd : undefined;
}

/**
 * The shell command behind a `local_bash` task, recovered from the `Bash` call that spawned
 * it — the field {@link isHeadlessAgentShell} needs to tell a headless `claude -p` fan-out
 * apart from `npm test`, since the CLI reports both as `task_type:'local_bash'` and no
 * `task_*` frame carries the command itself.
 *
 * Two lookups, in order of trust:
 *   1. `toolUseId` — exact. The `task_started` frame carries the id of the `Bash` call the
 *      CLI just backgrounded, and that tool item is already in the transcript (the tool_use
 *      frame is what STARTED the task, so it always precedes this).
 *   2. the Bash `description` — for a run adopted off the `background_tasks_changed` roster,
 *      which carries no tool_use_id at all. The roster's `description` IS the Bash tool's own
 *      `description` argument, so matching on it recovers the command for a shell whose
 *      `task_started` was never seen (a resumed conversation with work already in flight).
 *      A wrong match here can only mislabel one row; it can never lose a command.
 *
 * Every list is walked NEWEST-first, and the caller passes `items` before `history`: running
 * the same command twice is ordinary, and the run being resolved is the most recent one.
 */
export function bashCommandFor(
  lists: readonly CommandProbe[][], toolUseId?: string, description?: string,
): string | undefined {
  const find = (match: (item: CommandProbe) => boolean): string | undefined => {
    for (const list of lists) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].kind === 'tool' && match(list[i])) {
          const cmd = probeCommand(list[i]);
          if (cmd) return cmd;
        }
      }
    }
    return undefined;
  };
  if (toolUseId) {
    const byId = find((it) => it.toolUseId === toolUseId);
    if (byId) return byId;
  }
  if (!description) return undefined;
  return find((it) => (
    it.name === 'Bash' && !!it.input && typeof it.input === 'object'
    && (it.input as Record<string, unknown>).description === description
  ));
}

/**
 * A backgrounded shell that is really a headless Claude session. Presented as an agent (see
 * {@link isAgentRun}) but drilled into as a shell — there is no sidechain transcript on disk
 * for a process the CLI only ever spawned as a command.
 *
 * The `name` fallback is not a guess: when a `Bash` call omits its `description` argument the
 * CLI uses the COMMAND ITSELF as the task's description (captured live — a backgrounded
 * `claude -p '…' --output-format json` produced `task_started.description` equal to that exact
 * command line), and `name` is that description. So a run whose command could not be
 * correlated — adopted off the roster, resumed conversation, spawning tool call outside the
 * window — is still classified correctly whenever the CLI named it after its command.
 *
 * Safe because {@link looksLikeHeadlessClaude} requires `claude` to be the first non-wrapper
 * token: a PROSE description like "Run headless claude -p for the audit" fails at `Run` and
 * stays a shell, which is the right answer — that string is a label, not an invocation.
 */
export function isHeadlessAgentShell(run: SubAgentRun): boolean {
  if (run.taskType !== 'local_bash') return false;
  return looksLikeHeadlessClaude(run.command ?? run.name);
}

/** Does this run belong in the sub-agent card and rail? A dispatched sub-agent, or a
 *  backgrounded headless `claude` — both are an agent doing work on your behalf, and the
 *  transport that carried them is not what the user is watching for. */
export function isAgentRun(run: SubAgentRun): boolean {
  return isDispatchedAgent(run) || isHeadlessAgentShell(run);
}

/** A plain shell command the CLI is running in the background — the complement of
 *  {@link isAgentRun}. These get their own surface (`BackgroundShellsTray`) rather than a row
 *  in the sub-agent card: a shell has no sidechain transcript to drill into, but it does have
 *  live output on disk and can be stopped. */
export function isBackgroundShell(run: SubAgentRun): boolean {
  return run.taskType === 'local_bash' && !isHeadlessAgentShell(run);
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
    // The roster arm cannot resolve a command (it carries no tool_use_id), so the started
    // frame is usually what upgrades an anonymous "shell" row into a named agent one.
    command: started.command ?? cur.command,
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

// ─── Tool RUNS — a contiguous stretch of tool calls as one card (owner report 08-01) ──
//
// The same argument the sub-agent group card already makes, applied one level down. A turn
// is mostly tool calls; at one card each, a routine 12-call stretch filled a whole pane and
// pushed the actual answer off screen. A finished run is a RECORD, and a record that keeps N
// rows of the transcript forever is just cost — so it collapses to its header the moment the
// agent speaks again, and a click brings it back for good.

/** One rendered position in the transcript: either a lone item, or a run of adjacent ones. */
export type RunSegment<T> = { kind: 'single'; item: T } | { kind: 'run'; items: T[] };

/** A run must be worth the chrome. Two cards under one header saves nothing and costs a
 *  disclosure the reader has to operate, so a pair stays two plain cards. */
export const MIN_TOOL_RUN = 3;

/**
 * Fold maximal stretches of adjacent groupable items into runs, leaving everything else
 * exactly where it was.
 *
 * `isGroupable` is the caller's, not ours, and that is the point: `ChatPane` renders some
 * tool items as something OTHER than a tool card (a board it drew, the sub-agent group card,
 * a bypass receipt). Those must break a run rather than disappear into one — so the predicate
 * asks "does this render as a plain tool card?", which only the caller can answer.
 *
 * `rendersNothing` is the other half of that question, and the reason this shipped broken
 * (owner report 08-02). A run breaks on what the reader can SEE between two calls — an item
 * that draws zero pixels is not a boundary, it is an absence. So such an item neither joins a
 * run nor ends one: it is held and re-emitted as a single once the run around it resolves.
 *
 * Nothing is dropped or duplicated. Visible order is exact; an invisible item that sat
 * INTERIOR to a run comes back out just after it, which is unobservable by construction —
 * a run renders as ONE card, so there is no interior position for it to hold.
 */
export function segmentToolRuns<T>(
  items: readonly T[],
  isGroupable: (item: T) => boolean,
  minRun: number = MIN_TOOL_RUN,
  rendersNothing: (item: T) => boolean = () => false,
): RunSegment<T>[] {
  const out: RunSegment<T>[] = [];
  /** The open stretch: groupable items plus any invisible ones caught between them. */
  let pending: { item: T; groupable: boolean }[] = [];
  const flush = () => {
    const run = pending.filter((p) => p.groupable).map((p) => p.item);
    if (run.length >= minRun) {
      out.push({ kind: 'run', items: run });
      for (const p of pending) if (!p.groupable) out.push({ kind: 'single', item: p.item });
    } else {
      for (const p of pending) out.push({ kind: 'single', item: p.item });
    }
    pending = [];
  };
  for (const item of items) {
    if (isGroupable(item)) pending.push({ item, groupable: true });
    // Only worth holding INSIDE an open stretch. With nothing open it is just a single,
    // and emitting it straight keeps the common case's output identical to before.
    else if (pending.length && rendersNothing(item)) pending.push({ item, groupable: false });
    else { flush(); out.push({ kind: 'single', item }); }
  }
  flush();
  return out;
}

/**
 * Live vs. landed for a tool run.
 *
 * `stillAccruing` is what keeps this from flickering, and it is why the phase can't be read
 * off the items alone. Between two calls every item in the run is momentarily `done` — an
 * items-only rule would collapse the group in that gap and re-open it a frame later, once
 * per tool call, for the whole turn. The caller instead answers "is this run still the tail
 * of a turn that hasn't finished talking?", which goes false exactly once: when the agent
 * emits its next block, or the turn ends.
 */
export function toolRunPhase(
  items: readonly { status: 'running' | 'done' | 'error' }[],
  stillAccruing: boolean,
): RunGroupPhase {
  if (items.some((i) => i.status === 'running')) return 'running';
  return stillAccruing ? 'running' : 'done';
}

export interface ToolRunSummary {
  steps: number;
  reads: number;
  commands: number;
  edits: number;
  failed: number;
  /** Wall-clock SPAN of the run (first start → last end), not the sum of its parts — the
   *  calls can overlap, and a total that exceeds the turn would be a lie. `null` until
   *  something has finished. */
  durationMs: number | null;
}

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function summarizeToolRun(
  items: readonly { name: string; status: 'running' | 'done' | 'error'; startedAt: number; endedAt?: number }[],
): ToolRunSummary {
  let reads = 0; let commands = 0; let edits = 0; let failed = 0;
  let first = Infinity; let last = -Infinity;
  for (const i of items) {
    if (READ_TOOLS.has(i.name)) reads += 1;
    else if (i.name === 'Bash') commands += 1;
    else if (EDIT_TOOLS.has(i.name)) edits += 1;
    if (i.status === 'error') failed += 1;
    if (i.startedAt < first) first = i.startedAt;
    if (i.endedAt != null && i.endedAt > last) last = i.endedAt;
  }
  return {
    steps: items.length,
    reads,
    commands,
    edits,
    failed,
    durationMs: last > -Infinity && first < Infinity ? Math.max(0, last - first) : null,
  };
}

/**
 * What a COLLAPSED run says about itself. Only the counts that are non-zero: a header
 * reading "0 files read" spends the eye on a number that means nothing (same rule as
 * {@link groupOutcomeNote}). Steps always leads, because the count is the reason the group
 * exists.
 */
export function toolRunHeadline(s: ToolRunSummary): string {
  const parts = [`${s.steps} steps`];
  if (s.reads) parts.push(`${s.reads} ${s.reads === 1 ? 'file' : 'files'} read`);
  if (s.commands) parts.push(`${s.commands} ${s.commands === 1 ? 'command' : 'commands'}`);
  if (s.edits) parts.push(`${s.edits} edited`);
  if (s.failed) parts.push(`${s.failed} failed`);
  return parts.join(' · ');
}

/** {@link useGroupCollapse} for a tool run — same phase-stamped override, so the two group
 *  cards in the transcript open, collapse, and respect the user in exactly the same way. */
export function useToolRunCollapse(
  items: readonly { status: 'running' | 'done' | 'error' }[],
  stillAccruing: boolean,
): { open: boolean; onToggle: () => void } {
  const [toggle, setToggle] = useState<GroupToggle | null>(null);
  const phase = toolRunPhase(items, stillAccruing);
  const open = isGroupOpen(phase, toggle);
  return { open, onToggle: () => setToggle({ phase, open: !open }) };
}

/**
 * The item whose id KEYS a run card — the identity that must survive the window moving.
 *
 * A run's membership is recomputed from the windowed slice on every render, and its two
 * edges move for different reasons: a REVEAL moves the slice's head backwards and merges
 * the newly mounted older items into the head run (its FIRST item changes), while the run
 * still accruing at the live tail gains items at the end (its LAST item changes). So the
 * key comes from the edge that particular run cannot change: the LAST item for a landed
 * run, the FIRST for the accruing tail.
 *
 * Keyed on the first item unconditionally (as it originally was), a reveal REMOUNTED the
 * head run — React saw a new key — which reset the user's open toggle and rebuilt every
 * row node. The owner saw exactly that (report 08-01, second pass): "load older messages"
 * flashed the card back to its collapsed first frame with the revealed history invisible
 * inside it, and the anchor hold had nothing left to measure. Keyed on the last item
 * unconditionally, the accruing tail would remount on EVERY tool call instead — a full row
 * rebuild per call, and a mid-run collapse toggle slamming back open each time.
 */
export function toolRunKeyItem<T>(items: readonly T[], accruing: boolean): T {
  return accruing ? items[0] : items[items.length - 1];
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
 * DISPATCHED runs only — {@link isDispatchedAgent}, deliberately NOT {@link isAgentRun}. A
 * `local_bash` task rides the identical `task_*` frames, so before this filter existed its
 * spawning tool_use_id landed here too — and that id belongs to the `Bash` call itself, so
 * backgrounding a command SILENTLY ERASED its tool card from the transcript and the user
 * never saw the command that was now running.
 *
 * That is also why the headless-`claude` runs promoted into the agent card (see
 * {@link isHeadlessAgentShell}) still do NOT suppress anything: their card IS the `Bash`
 * card, and hiding it would re-open the same hole for exactly the commands the user most
 * wants to read. The group card represents their lifecycle, not their invocation.
 */
export function subAgentToolUseIds(runs: SubAgentRun[]): Set<string> {
  return new Set(
    runs.filter(isDispatchedAgent).map((r) => r.toolUseId).filter((id): id is string => !!id),
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
//
// It is bounded in two units, and the second one is not optional reading: entries are the
// ceiling, CARDS are the floor. See the card section below TRIM_SLACK for why an entry count
// stopped being a proxy for height the day tool calls started folding into one card.

/** How many entries stay mounted when the view is following the conversation. */
export const WINDOW_TAIL = 40;

/** How many more are revealed per "show earlier" step. */
export const WINDOW_STEP = 40;

/** How close to the top a reader must get before the next step is revealed for them. Big
 *  enough that the reveal lands before they hit the ceiling, so scrolling up feels
 *  continuous rather than like hitting a wall and waiting. */
export const WINDOW_REVEAL_PX = 800;

/**
 * How long the scroller must be QUIET — no scroll, wheel, touch or key activity — before
 * the pane may run an action that is paid for by writing `scrollTop` (a reveal's prepend
 * correction) or by unmounting rows above the fold (the pinned window snapping forward).
 *
 * This is the scrollbar-drag lesson (see {@link shouldAutoReveal}) generalized to every
 * other way the scroller can still be in motion. The app ships in a WKWebView, where
 * scrolling is animated OUT OF PROCESS: during trackpad momentum the compositor keeps
 * deriving the offset from its own animation curve, so a JS `scrollTop` write that lands
 * mid-momentum is either overwritten on the next compositor frame (the drag cascade all
 * over again — reveal, correction undone, "near the ceiling" again, reveal…) or it kills
 * the momentum dead, which reads as the transcript stuttering. Playwright cannot emit real
 * momentum, which is exactly why this failure mode survived every synthetic re-verification
 * (task `chat-transcript-holds-…`, "STILL OPEN") while the owner kept hitting it on a real
 * trackpad. The one mode we could reproduce — the thumb drag — showed the mechanism frame
 * by frame, and momentum is the same fight with a different animator.
 *
 * So the rule is: NEVER fight the animator — wait it out. macOS momentum keeps emitting
 * wheel events for its whole decay, and every one of them re-arms the quiet timer, so
 * "settled" genuinely means the compositor has nothing in flight and a write will stick.
 * 150ms sits between a trackpad's intra-gesture event gaps (~16ms, so a glide never counts
 * as settled) and the pause between deliberate wheel notches (~200ms+, so paced scrolling
 * still reveals between notches and keeps its continuous feel).
 */
export const SCROLL_SETTLE_MS = 150;

/**
 * Milliseconds still to wait before a settled-only action may run; 0 means "settled, go".
 * Pure so the re-arm arithmetic is testable: the pane's timer calls this again when it
 * fires, and re-arms for the remainder if activity arrived while it slept. A non-finite
 * `sinceMs` (no activity ever recorded — `lastActivity` starts at `-Infinity`) is settled
 * by definition.
 */
export function remainingSettleMs(nowMs: number, lastActivityMs: number, settleMs = SCROLL_SETTLE_MS): number {
  const since = nowMs - lastActivityMs;
  if (!Number.isFinite(since)) return 0;
  if (since >= settleMs) return 0;
  return settleMs - Math.max(0, since);
}

/**
 * How far the PINNED window may lag behind the tail before it snaps forward. Without slack
 * the window slid forward on every applied event, unmounting one row from above the fold per
 * streamed frame — each unmount shrinks `scrollHeight`, the browser clamps, the layout
 * effect re-pins, and the scrollbar thumb wobbled on every token (part of the owner's
 * "flicker" report 08-01). With slack, mounted rows drift from {@link WINDOW_TAIL} up to
 * `WINDOW_TAIL + TRIM_SLACK` and then shed a whole chunk at once — the same bounded memory,
 * a twentieth of the churn. The snap itself is still invisible content-wise (corrected
 * before paint); making it rare is what steadies the scrollbar.
 */
export const TRIM_SLACK = 20;

// ─── …and the same window measured in CARDS (owner report 08-02) ─────────────────────
//
// Everything above counts ENTRIES, which was the same thing as rows right up until a
// contiguous stretch of tool calls started rendering as ONE collapsing card (see
// {@link segmentToolRuns}). Now a 40-entry window is 40 rows or it is TWO — a message and a
// fold holding 39 calls — and two collapsed rows are SHORTER than the scroller. Short content
// means no overflow, no overflow means nothing to scroll, and the transcript's main way to
// read back is "scroll up and I'll load more": the owner's report is exactly that dead end
// ("1 mesaj 50 mesajlı bir grup kayamıyor ama daha fazla yüklemek için kaydır diyor").
//
// The 08-01 pass made the reveal REACHABLE from that state — wheel-up arms it even when no
// scroll event can ever fire (`armRevealFromInput`). This is the other half: make the state
// rare in the first place, and make each step out of it worth something. An entry count is
// simply not a proxy for height any more, so the window gained a second unit. Entries still
// bound it from ABOVE (memory); cards now bound it from BELOW (there has to be something to
// scroll, and a reveal has to add something the reader can see).
//
// Both bounds are cheap because they pull in opposite directions on the SAME pathological
// input: the case that needs hundreds more entries is the case where those entries fold into
// collapsed run cards, and a collapsed run card mounts no rows at all (`ToolRunCard`). What
// the extra entries cost is a header each — which is precisely the content that was missing.

/** How many rendered CARDS the following window must hold before {@link WINDOW_TAIL} is
 *  allowed to decide alone. Reached by mounting further back, never by mounting less: the two
 *  units bound the window from opposite sides and the wider one wins. */
export const WINDOW_TAIL_CARDS = 20;

/** How many cards a REVEAL must add. Without this, stepping {@link WINDOW_STEP} entries back
 *  into a stretch that merges into the fold the reader is already looking at adds nothing
 *  they can see — "Show earlier messages" appearing to do nothing, which is the same report
 *  from the other direction. */
export const WINDOW_STEP_CARDS = 20;

/** The ceiling on how far the CARD floor may reach back on its own. A conversation can be one
 *  unbroken run of thousands of calls, where no amount of walking finds another card; past
 *  this the window stops growing by itself and the reader's own reveal (button or wheel-up,
 *  which is not capped — it is an explicit ask) takes over. */
export const WINDOW_MAX_ENTRIES = 400;

/** The conversation as one index space, plus everything needed to know what it renders as.
 *  `entryAt` indexes the CONCATENATION of history then items WITHOUT materializing it — a
 *  resumed conversation's history runs to thousands of entries and this is read on every
 *  render, so a `[...history, ...items]` per token is exactly the cost this window exists to
 *  avoid. The predicates are the caller's, for the reason {@link segmentToolRuns} takes them:
 *  only `ChatPane` knows what renders as a plain tool card and what draws nothing at all. */
export interface CardWindow<T> {
  /** `history.length + items.length`. */
  total: number;
  entryAt: (index: number) => T;
  isGroupable: (item: T) => boolean;
  rendersNothing?: (item: T) => boolean;
  minRun?: number;
}

/** What a stretch of `streak` adjacent groupable items renders as: one folded card once it is
 *  worth the chrome, otherwise a plain card each. Mirrors `segmentToolRuns`'s `flush`. */
function cardsOfStreak(streak: number, minRun: number): number {
  return streak >= minRun ? 1 : streak;
}

/**
 * How many cards the slice `[from, total)` renders as — the same number as counting the
 * VISIBLE segments {@link segmentToolRuns} produces for it (asserted in the unit tests),
 * without building the segments.
 *
 * The one thing that makes this a single scan is that an invisible item can never be a
 * boundary: `segmentToolRuns` HOLDS it inside an open stretch, and with no stretch open it is
 * a single that draws nothing. Either way it contributes no card and breaks no run — so a
 * stretch is just "adjacent groupable items, ignoring the invisible", which reads the same
 * forwards and backwards. That symmetry is what lets {@link headForCards} walk from the end.
 */
export function countCards<T>(from: number, w: CardWindow<T>): number {
  const minRun = w.minRun ?? MIN_TOOL_RUN;
  const invisible = w.rendersNothing ?? (() => false);
  let cards = 0;
  let streak = 0;
  for (let i = Math.max(0, from); i < w.total; i += 1) {
    const item = w.entryAt(i);
    if (invisible(item)) continue;
    if (w.isGroupable(item)) { streak += 1; continue; }
    cards += cardsOfStreak(streak, minRun) + 1;
    streak = 0;
  }
  return cards + cardsOfStreak(streak, minRun);
}

/**
 * The head that mounts the FEWEST entries whose slice still renders `minCards` cards, reaching
 * back no further than `maxEntries`.
 *
 * Walks from the end and stops the instant the count is met, so the ordinary conversation —
 * where a card IS an entry — pays for about `minCards` iterations and the answer is simply
 * "20 entries back", which the entry tail then overrules by being wider. Only a folded
 * transcript walks far, and only for as long as it keeps finding nothing to show.
 *
 * The count is allowed to DIP by one as the head moves back (mounting a third adjacent call
 * turns two plain cards into one fold), which is why this re-checks per step instead of
 * binary-searching a monotone function. It is not one.
 */
export function headForCards<T>(minCards: number, maxEntries: number, w: CardWindow<T>): number {
  const minRun = w.minRun ?? MIN_TOOL_RUN;
  const invisible = w.rendersNothing ?? (() => false);
  const limit = Math.max(0, w.total - Math.max(0, maxEntries));
  let cards = 0;
  let streak = 0;
  let head = Math.max(0, w.total);
  while (head > limit && cards + cardsOfStreak(streak, minRun) < minCards) {
    head -= 1;
    const item = w.entryAt(head);
    if (invisible(item)) continue;
    if (w.isGroupable(item)) { streak += 1; continue; }
    cards += cardsOfStreak(streak, minRun) + 1;
    streak = 0;
  }
  return head;
}

export interface WindowInput {
  /** `history.length + items.length` — the whole conversation. */
  total: number;
  /** Is the view following the bottom? The single most important input: see rule 2. */
  pinned: boolean;
  /** This call is an explicit "show me more" (a button press, or scrolling to the top). */
  reveal?: boolean;
  /** The furthest FORWARD head the following window may take — the card floor, i.e.
   *  {@link headForCards} for {@link WINDOW_TAIL_CARDS}. Omitted, the entry tail decides
   *  alone (which is what every caller did before grouping existed). It can only ever widen
   *  the window: rule 4 still holds regardless of what is passed. */
  tailHead?: number;
  /** The head a REVEAL must reach for its step to be worth a card — {@link headForCards} for
   *  the window's current card count plus {@link WINDOW_STEP_CARDS}. Omitted, the step is the
   *  entry step alone. */
  revealHead?: number;
}

/**
 * The index of the first entry the transcript should mount, over `[...history, ...items]`.
 *
 * Four rules, in this order:
 *
 * 1. REVEAL steps the window {@link WINDOW_STEP} further back — or as far as `revealHead`
 *    asks, whichever is further — clamped at the beginning. It wins over everything, because
 *    it is the only input that came from the user asking.
 * 2. PINNED slides the window forward to the last {@link WINDOW_TAIL} entries — but only
 *    once it lags the tail by {@link TRIM_SLACK}, so the shed happens in rare chunks rather
 *    than as one unmount per streamed frame (see TRIM_SLACK for what the churn cost). This
 *    is the memory release valve: a long busy session sheds old DOM continuously instead of
 *    only ever growing, so a conversation that runs for an hour costs the same as one that
 *    just started — the ceiling is merely `WINDOW_TAIL + TRIM_SLACK` now instead of exactly
 *    `WINDOW_TAIL`.
 * 3. UNPINNED FREEZES the window's head. A reader who has scrolled up must never have
 *    content taken out from ABOVE them while they read — that is a scroll jump with no
 *    cause they can see, and it would happen on every streamed token. `Math.min` is what
 *    guarantees it: the head can only ever move backwards (revealing more), never forwards.
 * 4. …but never so far forward that fewer than {@link WINDOW_TAIL} entries are mounted,
 *    which is what makes a REWIND (the one thing that shrinks `total`) land on a populated
 *    transcript instead of an empty one.
 *
 * The CARD floors ride inside rules 1 and 2 rather than beside them, which is the whole
 * reason they are inputs here instead of a `Math.min` at the call site: `tailHead` is the
 * furthest forward the pinned snap may land, so the floor inherits {@link TRIM_SLACK}'s
 * hysteresis (a floor applied outside would shed a card's worth of rows every time a new card
 * landed) and the unpinned freeze of rule 3 (a floor that moved forward on its own would take
 * content out from above a reader). Both only ever widen the window.
 */
export function nextFirstShown(prev: number, input: WindowInput): number {
  const total = Math.max(0, input.total);
  const tail = Math.max(0, Math.min(total - WINDOW_TAIL, input.tailHead ?? total));
  if (input.reveal) {
    const stepped = Math.min(prev, tail) - WINDOW_STEP;
    return Math.max(0, Math.min(stepped, input.revealHead ?? stepped));
  }
  const held = Math.min(Math.max(0, prev), tail);
  if (input.pinned) return tail - held >= TRIM_SLACK ? tail : held;
  return held;
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
  /** Has the scroller been quiet for {@link SCROLL_SETTLE_MS}? See rule below — in motion,
   *  the offset is the animator's, not ours. */
  settled: boolean;
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
 *
 * `settled` is the same clause for every OTHER way the scroller can still be in motion —
 * above all WKWebView trackpad momentum, whose out-of-process animator overwrites or is
 * killed by a mid-flight correction exactly as the thumb was (see {@link SCROLL_SETTLE_MS}).
 * A scroll event can never be settled by definition (it IS activity), so in practice the
 * reveal always runs from the pane's quiet timer or from pointer-release — never from inside
 * the event that asked for it.
 */
export function shouldAutoReveal(m: AutoRevealMetrics): boolean {
  if (m.hiddenCount <= 0) return false;
  if (m.scrollTop >= WINDOW_REVEAL_PX) return false;
  if (m.dragging) return false;
  if (!m.settled) return false;
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
 *
 * `mode: 'reveal'` asks for the file manager outright — "show me where this is", which is a
 * different thing to want than "open this" and now has its own button. `'auto'` (the default,
 * and what every inline card uses) lets the route decide, which for anything executable is a
 * reveal regardless: that downgrade is a SUCCESS, not something to report. The file manager
 * comes to the front with the file selected, which is the honest answer to the click.
 */
export function revealPath(path: string, mode: 'auto' | 'reveal' = 'auto'): Promise<string | null> {
  return api.post('/agent/reveal', { path, mode }).then(
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

    /**
     * A local reference that is NOT media, drawn as the chip the backticked paths beside it
     * already are: it opens in the app rather than loading in place.
     *
     * The case this exists for is `![doc](handbook.pdf)`. Markdown has one embed syntax and
     * writers reach for it whatever they are embedding, so a PDF (or anything else with no
     * element that can render it) arrived as an `<img>` that was guaranteed to fail — an
     * error, a probe request, and a fallback card, all to say what the extension said up
     * front. A chip says it once and opens the file in the viewer that suits it.
     */
    const buildPathChip = (path: string, label?: string): HTMLElement => {
      const chip = document.createElement('a');
      chip.setAttribute('data-chat-media', '1');
      chip.className = 'chat-md-path';
      chip.href = path;
      chip.textContent = label?.trim() || basenameOf(path);
      chip.title = `Open ${path}`;
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        live.current.onOpen?.(path);
      });
      return chip;
    };

    // `![x](media)` — an <img> that can never load for video/audio, and needs the endpoint
    // rewrite even for images.
    root.querySelectorAll<HTMLImageElement>('img:not([data-chat-media])').forEach((img) => {
      const path = img.getAttribute('src') ?? '';
      if (!isLocalRef(path)) return;
      if (!inlineMediaKind(path)) { img.replaceWith(buildPathChip(path, img.getAttribute('alt') ?? '')); return; }
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
      // Kept in place (rather than swapped for `buildPathChip`) so the author's own link text
      // survives — `[the handbook](handbook.pdf)` should still read "the handbook".
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
