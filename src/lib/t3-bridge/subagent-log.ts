/**
 * A Codex or Antigravity sub-agent's own steps, kept where its card's drill-in reads them.
 *
 * Claude Code writes each sub-agent's turns to `<conversation>/subagents/agent-<id>.jsonl`, and
 * the chat's drill-in replays that file (agent-chat.ts `handleAgentChatHistory`). These tools
 * keep a sub-agent's steps in their own stores, in their own shapes, so the bridge writes the
 * same file itself as the steps arrive: one per sub-agent, under the chat's native thread,
 * in Claude's transcript shape (`parseTranscriptHistory` reads it unchanged).
 *
 * The first line names the project the thread ran in: the route serves a file only to the
 * project it belongs to, the way it serves the thread's own history.
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

const SAFE_ID = /^[a-z0-9-]{1,128}$/i;
/** A thread id from a tool: Codex and Antigravity use UUIDs; nothing else is a folder name here. */
const SAFE_THREAD = /^[a-z0-9][a-z0-9-]{0,127}$/i;
/** One step's text is capped: a sub-agent that dumps a large file must not grow this without end. */
const MAX_LINE = 64_000;

export function subagentLogDir(home: string, nativeThreadId: string): string | null {
  if (!SAFE_THREAD.test(nativeThreadId)) return null;
  return join(home, '.dreamcontext', 't3', 'subagents', nativeThreadId);
}

export function subagentLogPath(home: string, nativeThreadId: string, taskId: string): string | null {
  const dir = subagentLogDir(home, nativeThreadId);
  if (!dir || !SAFE_ID.test(taskId)) return null;
  return join(dir, `agent-${taskId}.jsonl`);
}

/** Append one step. Best effort: a drill-in that cannot be written falls back to the card's summary. */
export function appendSubagentStep(home: string, nativeThreadId: string, cwd: string, taskId: string, frame: Record<string, unknown>): void {
  const path = subagentLogPath(home, nativeThreadId, taskId);
  if (!path) return;
  try {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) appendFileSync(path, JSON.stringify({ type: 'dc_subagent', cwd }) + '\n', { mode: 0o600 });
    let line = JSON.stringify({ ...frame, isSidechain: true, timestamp: new Date().toISOString() });
    if (line.length > MAX_LINE) line = JSON.stringify({ ...shrink(frame), isSidechain: true, timestamp: new Date().toISOString() });
    appendFileSync(path, line + '\n');
  } catch { /* best effort */ }
}

/** A step too large to keep whole: its text blocks cut. */
function shrink(frame: Record<string, unknown>): Record<string, unknown> {
  const msg = frame.message as { content?: unknown } | undefined;
  const content = Array.isArray(msg?.content) ? msg.content.map((b) => {
    const s = JSON.stringify(b);
    return s.length > MAX_LINE / 2 ? { type: 'text', text: `${s.slice(0, MAX_LINE / 2)}… (cut)` } : b;
  }) : [];
  return { ...frame, message: { ...(msg ?? {}), content } };
}

/**
 * The steps of one sub-agent, for the project at `projectRoot`. `null` = no such file, or it
 * belongs to another project. Never follows a link: the folder and the file are the bridge's own.
 */
export function readSubagentLog(home: string, nativeThreadId: string, taskId: string, projectRoot: string): string | null {
  const path = subagentLogPath(home, nativeThreadId, taskId);
  if (!path) return null;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    // The file's folder must really be under the bridge's own: no link out of it, anywhere on the way.
    const base = realpathSync(join(home, '.dreamcontext', 't3', 'subagents'));
    if (!realpathSync(path).startsWith(base + sep)) return null;
    const raw = readFileSync(path, 'utf-8');
    const first = raw.slice(0, raw.indexOf('\n') + 1 || raw.length);
    const head = JSON.parse(first) as { type?: unknown; cwd?: unknown };
    if (head.type !== 'dc_subagent' || typeof head.cwd !== 'string' || !sameDir(head.cwd, projectRoot)) return null;
    return raw;
  } catch {
    return null;
  }
}

function sameDir(a: string, b: string): boolean {
  if (a === b) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}
