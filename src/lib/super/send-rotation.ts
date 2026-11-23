import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { HandoffRecord } from '../context-watch.js';
import { HANDOFF_FIELDS } from '../handoff-readiness.js';
import type { ResolvedContextHandoff } from '../setup-config.js';
import { queuedCommandText } from '../sleep-packet.js';
import { ROTATE_HOLD_MAX_MS } from './fresh-session.js';
import { userTextsIn } from './outbox.js';
import { MAX_READ_BYTES } from './types.js';

/**
 * New work on a big idle Super child, and what a handoff turn must not lose (plan
 * super-cocuk-tasarruf D2, D3). Pure parts only: the send route decides the lead line, the
 * chat bridge reads the folded texts; neither does any I/O through here but the one bounded read.
 */

/** The first line of a task-less Super child's hand-back reply; the same mark the hard-band nudge
 *  asks for (context-watch.ts `TASKLESS_HANDOFF_MARK`), so the Super reads one sign. */
const TASKLESS_MARK = 'HANDOFF:';

const k = (n: number): string => `${Math.round(n / 1000)}k`;

export interface NewWorkLeadInput {
  /** Eco on for this pane (its tab file, else this Mac's switch). */
  enabled: boolean;
  /** The pane's CURRENT conversation's main-chain context, or null when unread. */
  ctx: number | null;
  /** The pane's ladder (a child's: 250k / 400k / 50k by default). */
  ladder: Pick<ResolvedContextHandoff, 'nudgeAt'>;
  /** `super send --keep`: the reply needs the live conversation. */
  keep: boolean;
  /** The child's own task slug, when its record names one. */
  task: string | null;
  /** The child's tool; only a Claude child's context is in a Claude transcript. */
  tool: string;
  /** The pane's handoff record, if any. */
  record: Pick<HandoffRecord, 'actedAt' | 'consumedAt'> | null;
  now?: number;
}

/**
 * The one `[dreamcontext]` line put ahead of the Super's text when new work lands on a child
 * already at or past its ladder's first rung, or null. Null when Eco is off, `--keep`, a bridge
 * child, an unread or small context, or a pane whose record already rotates (pending: it rotates
 * at its next result anyway; mid-rotation: `actedAt` without `consumedAt`, younger than
 * {@link ROTATE_HOLD_MAX_MS}; older reads as done).
 */
export function newWorkLead(input: NewWorkLeadInput): string | null {
  const { enabled, ctx, ladder, keep, task, tool, record } = input;
  if (!enabled || keep || tool !== 'claude') return null;
  if (ctx === null || !Number.isFinite(ctx) || ctx < ladder.nudgeAt) return null;
  if (record) {
    // Pending = no actedAt AND no consumedAt (shouldRotateForHandoff): a record a resume banner
    // consumed is done, so the lead still goes out.
    if (!record.actedAt && !record.consumedAt) return null;
    if (record.actedAt && !record.consumedAt) {
      const acted = Date.parse(record.actedAt);
      const now = input.now ?? Date.now();
      if (Number.isFinite(acted) && now - acted < ROTATE_HOLD_MAX_MS) return null;
    }
  }
  const head = `[dreamcontext] This session is at ~${k(ctx)} context tokens. If the message below is more than a short answer, hand off FIRST and do it in the fresh session:`;
  if (task) {
    const cmd = `dreamcontext tasks handoff ${task} ${HANDOFF_FIELDS.map((f) => `${f.flag} "<${f.hint}>"`).join(' ')}`;
    return `${head} run \`${cmd}\` with the message below copied whole into --next, then end your turn. A short answer: just answer.`;
  }
  return `${head} end this turn with your whole state in your reply, its first line \`${TASKLESS_MARK}\`, and the message below copied whole into it; the Super continues the job in a fresh session. A short answer: just answer.`;
}

/** A block of the child's own that is no one's words: a `<command-name>` echo, a task
 *  notification, an `<owner-msg ref>` stub, any `<`-wrapped harness block. */
const isStub = (t: string): boolean => /^\s*</.test(t);

/**
 * The texts a person sent into a transcript at or after `sinceMs`, in file order: plain `user`
 * turns (the outbox's rules) and mid-turn messages folded as `queued_command` (sleep-packet's
 * parser). Stub blocks are dropped per block, before a turn's blocks are joined. One synchronous,
 * bounded tail read ({@link MAX_READ_BYTES}); unreadable = nothing. Never throws.
 */
export function userTextsSinceSync(path: string | null | undefined, sinceMs: number): string[] {
  if (!path || !Number.isFinite(sinceMs)) return [];
  let text = '';
  let truncated = false;
  try {
    const fd = openSync(path, 'r');
    try {
      const { size } = fstatSync(fd);
      const start = Math.max(0, size - MAX_READ_BYTES);
      const len = size - start;
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const n = readSync(fd, buf, read, len - read, start + read);
        if (n === 0) break;
        read += n;
      }
      text = buf.subarray(0, read).toString('utf-8');
      truncated = start > 0;
    } finally { closeSync(fd); }
  } catch { return []; }
  const lines = text.split('\n');
  if (truncated) lines.shift();
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.includes('"queued_command"')) {
      let rec: Record<string, unknown>;
      try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
      if (Number.isFinite(ts) && ts < sinceMs) continue;
      const blocks = queuedCommandBlocks(rec);
      const joined = blocks.filter((b) => !isStub(b)).map((b) => b.trim()).filter(Boolean).join('\n').trim();
      if (joined) out.push(joined);
      continue;
    }
    const blocks = userTextsIn([line], sinceMs).filter((b) => !isStub(b));
    const joined = blocks.map((b) => b.trim()).filter(Boolean).join('\n').trim();
    if (joined) out.push(joined);
  }
  return out;
}

/** A folded message's blocks, through sleep-packet's one parser (one block at a time, so the stub
 *  filter runs per block). */
function queuedCommandBlocks(rec: Record<string, unknown>): string[] {
  const att = rec.attachment as { prompt?: unknown } | undefined;
  const p = att?.prompt;
  const parts = typeof p === 'string' ? [p] : Array.isArray(p) ? p : [];
  const out: string[] = [];
  for (const part of parts) {
    const t = queuedCommandText({ ...rec, attachment: { ...(att as object), prompt: typeof part === 'string' ? part : [part] } });
    if (t) out.push(t);
  }
  return out;
}

/** The heading the carried texts ride under in the continue prompt (fixed wording). */
export const CARRIED_HEADING = 'Messages the previous session received after it wrote this handoff (act on what its entry does not already cover):';

/** The continue prompt with the carried texts appended, or the prompt unchanged when none. */
export function withCarriedTexts(prompt: string, texts: readonly string[]): string {
  const kept = texts.map((t) => t.trim()).filter(Boolean);
  if (kept.length === 0) return prompt;
  return `${prompt}\n\n${CARRIED_HEADING}\n${kept.map((t) => `---\n${t}`).join('\n')}`;
}
