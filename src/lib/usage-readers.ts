/**
 * What one transcript line means to the usage ledger (usage-ledger.ts).
 *
 * The rules are T3 Code's, moved out of Effect into plain TypeScript
 * (`apps/server/src/provider/Drivers/{claudeUsage,codexUsage}.ts`,
 * Copyright (c) 2026 T3 Tools Inc., MIT, see src/vendor/t3/LICENSE):
 *   - Claude writes one record per content block and every one repeats the message's whole
 *     `usage`: only the first per `message.id + requestId` counts (T3 measured 2.4x without it);
 *   - `<synthetic>` is a local placeholder that never reached the API;
 *   - Codex `token_count` events carry no model, so it is carried from `turn_context`; cumulative
 *     counters validate each request, forks copy their parent's history in a burst, and a
 *     zero-component counter reports context size, not a request.
 *
 * Ours on top, all on the same lines: what dreamcontext injected, where a sleep ran, and where a
 * limit ran out. None of those add a token: they mark tokens already on the ledger.
 */

import { ownerWords } from './agents/team-roster.js';
import { isAgentRun } from './transcript-sessions.js';

export const CLAUDE_SYNTHETIC_MODEL = '<synthetic>';

export interface TokenTotals {
  /** Input not served from cache. */
  input: number;
  cacheRead: number;
  /** All cache writes, whatever their lifetime. */
  cacheWrite: number;
  /** The part of `cacheWrite` kept for an hour, billed higher than the 5-minute rate. */
  cacheWrite1h?: number;
  output: number;
}

export interface UsageLine {
  ts: number;
  model: string;
  totals: TokenTotals;
  speed: 'standard' | 'fast';
  /** Null: the line has no identity, so it cannot be deduped and always counts. */
  dedupeKey: string | null;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function tsOf(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export const totalTokens = (t: TokenTotals): number => t.input + t.cacheRead + t.cacheWrite + t.output;

// ── Claude ────────────────────────────────────────────────────────────────────────────

export function parseClaudeRecord(record: Record<string, unknown>): UsageLine | null {
  if (record.type !== 'assistant') return null;
  const message = record.message as Record<string, unknown> | undefined;
  if (typeof message !== 'object' || message === null) return null;
  const usage = message.usage as Record<string, unknown> | undefined;
  if (typeof usage !== 'object' || usage === null) return null;
  const ts = tsOf(record.timestamp);
  if (ts === null) return null;
  const model = typeof message.model === 'string' ? message.model : '';
  if (!model || model === CLAUDE_SYNTHETIC_MODEL) return null;
  const messageId = typeof message.id === 'string' ? message.id : null;
  const requestId = typeof record.requestId === 'string' ? record.requestId : null;
  return {
    ts,
    model,
    totals: {
      input: count(usage.input_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
      cacheWrite1h: count((usage.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens),
      output: count(usage.output_tokens),
    },
    speed: usage.speed === 'fast' ? 'fast' : 'standard',
    dedupeKey: messageId === null && requestId === null ? null : `${messageId ?? ''}:${requestId ?? ''}`,
  };
}

export interface LimitHit { ts: number; kind: 'session' | 'weekly'; resetsAt: number | null }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HIT_TEXT = /hit your (session|\d+-hour|weekly) limit\s*·\s*resets\s+(?:([A-Z][a-z]{2}) (\d{1,2})(?:,| at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

/** "You've hit your session limit · resets 9:40pm (Europe/Istanbul)", in the machine's zone. */
export function parseLimitHit(text: string, ts: number): LimitHit {
  const m = HIT_TEXT.exec(text);
  const kind = m ? (m[1].toLowerCase() === 'weekly' ? 'weekly' : 'session') : /weekly/i.test(text) ? 'weekly' : 'session';
  if (!m) return { ts, kind, resetsAt: null };
  const at = new Date(ts);
  if (m[2]) {
    const month = MONTHS.indexOf(m[2]);
    if (month >= 0) at.setMonth(month, Number(m[3]));
  }
  const hour = (Number(m[4]) % 12) + (m[6].toLowerCase() === 'pm' ? 12 : 0);
  at.setHours(hour, m[5] ? Number(m[5]) : 0, 0, 0);
  if (at.getTime() <= ts) {
    if (m[2]) at.setFullYear(at.getFullYear() + 1);
    else at.setDate(at.getDate() + 1);
  }
  return { ts, kind, resetsAt: at.getTime() };
}

/** Claude Code's own marker on the reply that says a limit ran out. */
export function claudeLimitHit(record: Record<string, unknown>): LimitHit | null {
  if (record.type !== 'assistant' || record.error !== 'rate_limit') return null;
  const ts = tsOf(record.timestamp);
  if (ts === null) return null;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  const first = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : undefined;
  return parseLimitHit(typeof first === 'string' ? first : '', ts);
}

/** At the start of a shell command only (a brief passed through Bash mentions the words too), and
 *  never `--help`, which runs no sleep. */
const SLEEP_CMD = /(?:^|[;&|\n(])\s*(?:\w+=\S*\s+)*(?:timeout\s+\S+\s+)?(?:\S*\/)?dreamcontext\s+sleep\s+(start|done)\b(?![^\n;&|]*--help)/;

/** `dreamcontext sleep start|done`, as a Bash call on this assistant line. A word in prose never counts. */
export function claudeSleepMark(record: Record<string, unknown>): 'start' | 'done' | null {
  if (record.type !== 'assistant') return null;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type !== 'tool_use' || block.name !== 'Bash') continue;
    const command = (block.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== 'string') continue;
    const m = SLEEP_CMD.exec(command);
    if (m) return m[1] as 'start' | 'done';
  }
  return null;
}

/**
 * Tokens a dreamcontext hook actually put in front of the model on this line, or null.
 *
 * `content`, never `stdout`: past the harness's cap the model gets a 2 KB preview of an 18 KB
 * snapshot, and the stored `content` is that preview. Chars / 3.5 is the same rule the snapshot
 * budget counts with, so this is a measured size in a stated unit.
 */
export function claudeInjection(record: Record<string, unknown>): { kind: 'snapshot' | 'recall'; tokens: number } | null {
  if (record.type !== 'attachment') return null;
  const a = record.attachment as Record<string, unknown> | undefined;
  if (a?.type !== 'hook_success') return null;
  const event = a.hookEvent;
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return null;
  if (typeof a.command !== 'string' || !a.command.includes('dreamcontext')) return null;
  const size = typeof a.content === 'string' ? a.content.length : 0;
  if (size === 0) return null;
  return { kind: event === 'SessionStart' ? 'snapshot' : 'recall', tokens: Math.round(size / 3.5) };
}

export type SessionOrigin = 'sleep' | 'automation' | null;

/** The briefs this app writes when it spawns an agent (transcript-sessions.ts holds their sources). */
export function originOfFirstPrompt(text: string): SessionOrigin {
  const s = text.trimStart().toLowerCase();
  if (s.startsWith('think hard. run a full dreamcontext memory consolidation')) return 'sleep';
  if (s.startsWith('you are scheduled dreamcontext automation')) return 'automation';
  return null;
}

export function firstPromptText(record: Record<string, unknown>): string | null {
  if (record.type !== 'user') return null;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const b of content as Array<Record<string, unknown>>) {
    if (b?.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return null;
}

// ── Who wrote a prompt ────────────────────────────────────────────────────────────────

/** `owner`: a person typed it. `super`: the Super Agent's brief or send to a child. `auto`: a
 *  machine run's (automation, sleep, builder, reviewer, one-shot `claude -p`). */
export type PromptKind = 'owner' | 'super' | 'auto';

/** Server-written turns no marker tells apart, by their fixed opening. They count for nobody. */
const SERVER_TURNS = ['[Request interrupted', '[ran in chat]', '[delegated-session event]', 'The previous turn ', 'Your previous turn was stopped'];
/** Every `super delegate` brief opens with one of these (routes/super.ts `delegateJob`). */
export const SUPER_BIRTH_OPENINGS = ['If you start a dev server, pin its url', 'You work in your own git worktree:'];
/** A record's own word that nobody typed it. `scheduled` still goes on, as a machine run's turn. */
const NOT_A_TURN = new Set(['task_notification', 'peer', 'system']);

export interface HumanTurn { ts: number; uuid: string | null; text: string; machineShaped: boolean; scheduled: boolean }

/**
 * A user record that may be a prompt, or null: tool results, hook text, sub-agent turns, compaction
 * summaries, notifications, slash-command stubs and Super event turns are not.
 *
 * `machineShaped`: the app's chats send content blocks, while `claude -p "<text>"` writes a plain
 * string under the SDK entrypoint. So a session that OPENS that way was started by a program.
 */
export function humanTurn(record: Record<string, unknown>): HumanTurn | null {
  if (record.type !== 'user') return null;
  if (record.isMeta === true || record.isSynthetic === true || record.isCompactSummary === true || record.isSidechain === true) return null;
  if (record.toolUseResult !== undefined) return null;
  const origin = record.origin as { kind?: unknown } | string | undefined;
  const originKind = typeof origin === 'object' && origin !== null ? origin.kind : origin;
  if (originKind && originKind !== 'human') return null;
  if (typeof record.turnOrigin === 'string' && NOT_A_TURN.has(record.turnOrigin)) return null;
  const ts = tsOf(record.timestamp);
  if (ts === null) return null;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  let text = '';
  let picture = false;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (b?.type === 'tool_result') return null;
      if (b?.type === 'image') picture = true;
      if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    text = parts.join('\n');
  } else return null;
  const words = ownerWords(text.trimStart());
  if (words === null || (!words && !picture) || words.startsWith('<')) return null;
  if (SERVER_TURNS.some((p) => words.startsWith(p))) return null;
  return {
    ts, uuid: typeof record.uuid === 'string' ? record.uuid : null, text: words,
    machineShaped: typeof content === 'string' && record.entrypoint === 'sdk-cli',
    scheduled: record.turnOrigin === 'scheduled',
  };
}

/**
 * Who a session's FIRST turn says opened it, and so who writes all of it. A delegated child's later
 * turns read like a person's and are the Super's: its resumes, its "the owner picked A". On the
 * real logs a sample of them held almost nothing else, so a word the owner typed into a child's own
 * tab counts as the Super's. An owner's chat stays the owner's until a send claims a turn in it
 * (usage-report.ts `superSends`): that is the adopted child.
 */
export function firstTurnKind(turn: HumanTurn, origin: SessionOrigin): PromptKind {
  if (SUPER_BIRTH_OPENINGS.some((p) => turn.text.startsWith(p))) return 'super';
  if (origin || turn.scheduled || turn.machineShaped || isAgentRun(turn.text)) return 'auto';
  return 'owner';
}

/** The start of a shell command only, as `SLEEP_CMD`: a brief quoting the words is no send. */
const SUPER_SEND = /(?:^|[;&|\n(])\s*(?:\w+=\S*\s+)*(?:\S*\/)?dreamcontext\s+super\s+send\s+['"]?([0-9a-zA-Z][0-9a-zA-Z-]{5,})\b/g;

/** `dreamcontext super send <child>` calls on this assistant line: [tool call id, child]. */
export function claudeSuperSends(record: Record<string, unknown>): Array<[string, string]> {
  if (record.type !== 'assistant') return [];
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<[string, string]> = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type !== 'tool_use' || block.name !== 'Bash' || typeof block.id !== 'string') continue;
    const command = (block.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== 'string') continue;
    for (const m of command.matchAll(SUPER_SEND)) out.push([block.id, m[1]]);
  }
  return out;
}

// ── Codex ─────────────────────────────────────────────────────────────────────────────

interface CodexCounters {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

const CODEX_FIELDS: Array<keyof CodexCounters> = [
  'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens',
];

function readCounters(value: unknown): CodexCounters | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const num = (k: string, fallback?: number): number | null => {
    const v = raw[k] === undefined ? fallback : raw[k];
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  };
  const input = num('input_tokens');
  const output = num('output_tokens');
  if (input === null || output === null) return null;
  const cached = num('cached_input_tokens', 0);
  const write = num('cache_write_input_tokens', 0);
  const reasoning = num('reasoning_output_tokens', 0);
  const total = num('total_tokens', input + output);
  if (cached === null || write === null || reasoning === null || total === null) return null;
  if (cached + write > input || reasoning > output || total < input + output) return null;
  return {
    input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write,
    output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total,
  };
}

export interface CodexScanState {
  model: string;
  speed: 'standard' | 'fast';
  sessionId: string;
  cwd: string;
  /** Who ran it: Codex's own id for the ChatGPT account, the only per-account fact in a rollout. */
  creator: string;
  sawMeta: boolean;
  lastSignature: string | null;
  lastCumulative: CodexCounters | null;
  suppressingForkCopies: boolean;
  forkAnchorMs: number;
}

export function initialCodexState(): CodexScanState {
  return {
    model: '', speed: 'standard', sessionId: '', cwd: '', creator: '', sawMeta: false,
    lastSignature: null, lastCumulative: null, suppressingForkCopies: false, forkAnchorMs: 0,
  };
}

/** Forks restamp copied history in 0-40 ms gaps; genuine child usage follows a model turn. */
const FORK_COPY_MAX_GAP_MS = 1000;

function isForkedMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload.forked_from_id === 'string') return true;
  const spawn = ((payload.source as Record<string, unknown> | undefined)?.subagent as Record<string, unknown> | undefined)
    ?.thread_spawn as Record<string, unknown> | undefined;
  return typeof spawn?.parent_thread_id === 'string';
}

export function parseCodexRecord(record: Record<string, unknown>, state: CodexScanState): UsageLine | null {
  const payload = record.payload as Record<string, unknown> | undefined;
  if (typeof payload !== 'object' || payload === null) return null;

  if (record.type === 'session_meta') {
    // Only the first meta identifies the session: a fork copies its ancestors' metas after it.
    if (state.sawMeta) return null;
    state.sawMeta = true;
    const id = payload.id ?? payload.session_id;
    if (typeof id === 'string') state.sessionId = id;
    if (typeof payload.cwd === 'string') state.cwd = payload.cwd;
    if (typeof payload.creator_account_id === 'string') state.creator = payload.creator_account_id;
    const at = tsOf(record.timestamp);
    if (at !== null && isForkedMeta(payload)) { state.suppressingForkCopies = true; state.forkAnchorMs = at; }
    return null;
  }
  if (record.type === 'turn_context') {
    if (typeof payload.model === 'string') state.model = payload.model;
    return null;
  }
  if (payload.type === 'thread_settings_applied') {
    const tier = (payload.thread_settings as Record<string, unknown> | undefined)?.service_tier;
    state.speed = tier === 'priority' || tier === 'fast' ? 'fast' : 'standard';
    return null;
  }
  if (payload.type !== 'token_count') return null;

  const info = payload.info as Record<string, unknown> | undefined;
  if (typeof info !== 'object' || info === null) return null;
  const ts = tsOf(record.timestamp);
  if (ts === null || !state.model) return null;

  const last = readCounters(info.last_token_usage);
  const rawCumulative = info.total_token_usage;
  const hasCumulative = rawCumulative !== undefined && rawCumulative !== null;
  const cumulative = hasCumulative ? readCounters(rawCumulative) : null;

  if (state.suppressingForkCopies) {
    if (ts - state.forkAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkAnchorMs = ts;
      // Billed in the parent; only the child's baseline comes from here.
      if (cumulative) state.lastCumulative = cumulative;
      state.lastSignature = last ? JSON.stringify(last) : null;
      return null;
    }
    state.suppressingForkCopies = false;
    state.lastSignature = null;
  }

  const previous = state.lastCumulative;
  if (cumulative) state.lastCumulative = cumulative;
  if (!last || (hasCumulative && !cumulative)) return null;

  // A context-size report, not a request.
  if (last.input_tokens + last.output_tokens === 0) { state.lastSignature = null; return null; }
  if (cumulative && previous && CODEX_FIELDS.every((k) => cumulative[k] === previous[k])) return null;
  if (last.total_tokens !== last.input_tokens + last.output_tokens) return null;

  const signature = JSON.stringify(last);
  if (cumulative) {
    const restarted = CODEX_FIELDS.every((k) => cumulative[k] === last[k]);
    const reconciled = previous
      ? CODEX_FIELDS.every((k) => cumulative[k] - previous[k] === last[k])
      : CODEX_FIELDS.every((k) => cumulative[k] - last[k] >= 0);
    if (!restarted && !reconciled) return null;
  } else {
    if (signature === state.lastSignature) return null;
    const advanced = Object.fromEntries(CODEX_FIELDS.map((k) => [k, (previous?.[k] ?? 0) + last[k]])) as unknown as CodexCounters;
    state.lastCumulative = advanced;
  }
  state.lastSignature = signature;

  // Codex's `input_tokens` already includes the cached part.
  const totals: TokenTotals = {
    input: last.input_tokens - last.cached_input_tokens - last.cache_write_input_tokens,
    cacheRead: last.cached_input_tokens,
    cacheWrite: last.cache_write_input_tokens,
    output: last.output_tokens,
  };
  if (totalTokens(totals) === 0) return null;
  return { ts, model: state.model, totals, speed: state.speed, dedupeKey: null };
}
