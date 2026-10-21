import { promises as fsp } from 'node:fs';
import { MAX_READ_BYTES } from './types.js';

/**
 * `super read` — the END of a child's transcript, bounded (plan-r7 D10).
 *
 * A transcript can be tens of megabytes. This opens the file, reads at most
 * {@link MAX_READ_BYTES} from its end with one positioned read, and renders the whole lines in
 * that window as short "Owner:/Claude:/[tool]" lines. Never the whole file, never `foldJsonl`
 * (a first fold reads everything). The caller fences the result: it is the child's text.
 */

export const DEFAULT_READ_BYTES = 64 * 1024;
const LINE_CAP = 2000;

export interface TailRead {
  /** The bytes actually read (≤ the bound). */
  bytesRead: number;
  /** The file's size when read. */
  size: number;
  /** True when the window starts after the file's beginning (its first line was cut). */
  truncated: boolean;
  text: string;
}

/** Read at most `maxBytes` (clamped to {@link MAX_READ_BYTES}) from the end of `path`. */
export async function readTail(path: string, maxBytes: number = DEFAULT_READ_BYTES): Promise<TailRead> {
  const want = Math.max(1, Math.min(MAX_READ_BYTES, Math.floor(Number.isFinite(maxBytes) ? maxBytes : DEFAULT_READ_BYTES)));
  const fh = await fsp.open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - want);
    const len = size - start;
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const { bytesRead } = await fh.read(buf, read, len - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { bytesRead: read, size, truncated: start > 0, text: buf.subarray(0, read).toString('utf-8') };
  } finally {
    await fh.close();
  }
}

const clip = (s: string) => (s.length > LINE_CAP ? `${s.slice(0, LINE_CAP)}…` : s);

/** The readable lines of a JSONL window: dialogue and tool calls, nothing else. */
export function renderTail(t: Pick<TailRead, 'text' | 'truncated'>): string {
  const lines = t.text.split('\n');
  if (t.truncated) lines.shift();
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    if (obj.isSidechain === true) continue;
    const msg = obj.message as { content?: unknown } | undefined;
    const who = obj.type === 'user' ? 'Owner' : 'Claude';
    if (typeof msg?.content === 'string') {
      if (msg.content.trim()) out.push(`${who}: ${clip(msg.content.trim())}`);
      continue;
    }
    if (!Array.isArray(msg?.content)) continue;
    for (const b of msg.content as Array<Record<string, unknown>>) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        // A server-written block (`<super-agent-note>`, `<live-context>`) is not the owner's.
        if (obj.type === 'user' && b.text.startsWith('<')) continue;
        out.push(`${who}: ${clip(b.text.trim())}`);
      } else if (b?.type === 'tool_use' && typeof b.name === 'string') {
        out.push(`[tool: ${b.name.slice(0, 80)}]`);
      }
    }
  }
  return out.join('\n');
}

/** How far back `readLastReply` walks before it gives up (a reply is near the end). */
export const MAX_REPLY_SCAN_BYTES = 64 * 1024 * 1024;
const REPLY_CHUNK = 256 * 1024;

export interface LastReply {
  /** The reply's whole text, its text blocks in order; '' when none was found. */
  text: string;
  /** Its `timestamp`, when the transcript stamped one. */
  at: string | null;
  size: number;
  /** How many bytes from the end were read to find it. */
  scanned: number;
  /** A usage-limit or API-error banner came AFTER the reply: the child stopped there. */
  stoppedBy?: 'banner';
}

/** The text blocks of one assistant line, when it is a main-thread assistant line. */
function replyBlocks(line: string): { id: string | null; text: string; at: string | null; banner?: true } | null {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (obj.type !== 'assistant' || obj.isSidechain === true) return null;
  // A usage-limit or API-error banner is the CLI's, not the child's reply (end review): skipped,
  // but reported as `stoppedBy` so the reply before it does not read as the child's latest word.
  if (obj.isApiErrorMessage === true || (obj.message as { model?: unknown } | undefined)?.model === '<synthetic>') {
    return { id: null, text: '', at: null, banner: true };
  }
  const msg = obj.message as { id?: unknown; content?: unknown } | undefined;
  const id = typeof msg?.id === 'string' ? msg.id : null;
  const at = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  if (typeof msg?.content === 'string') return { id, text: msg.content.trim(), at };
  if (!Array.isArray(msg?.content)) return { id, text: '', at };
  const text = (msg.content as Array<Record<string, unknown>>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim())
    .map((b) => (b.text as string).trim())
    .join('\n\n');
  return { id, text, at };
}

/**
 * `super read`'s default: the child's LAST assistant reply, whole (field 2026-10-21: a 64 KB tail
 * of a 16 MB transcript ended in tool output and read as nothing; long replies were cut).
 *
 * Walks the file BACKWARD in chunks (never the whole file at once), skipping tool calls, tool
 * results and sub-agent lines, to the newest assistant line with text; the lines of that same
 * message (one per content block, same `message.id`) are joined in order. Bounded by
 * {@link MAX_REPLY_SCAN_BYTES}.
 */
export async function readLastReply(path: string, maxScan: number = MAX_REPLY_SCAN_BYTES): Promise<LastReply> {
  const fh = await fsp.open(path, 'r');
  try {
    const { size } = await fh.stat();
    let pos = size;
    let carry: Buffer = Buffer.alloc(0);
    const parts: string[] = [];
    let id: string | null = null;
    let at: string | null = null;
    let found = false;
    let stopped = false;
    // Returns true when the reply is complete (an older line belongs to another message).
    const take = (line: string): boolean => {
      if (!line.trim()) return false;
      const r = replyBlocks(line);
      if (!found) {
        if (r?.banner) stopped = true;
        if (!r || !r.text) return false;
        found = true; id = r.id; at = r.at; parts.unshift(r.text);
        return id === null;
      }
      if (!r || id === null || r.id !== id) return true;
      if (r.text) parts.unshift(r.text);
      at = at ?? r.at;
      return false;
    };
    while (pos > 0 && size - pos < maxScan) {
      const len = Math.min(REPLY_CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const { bytesRead } = await fh.read(buf, read, len - read, pos + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      carry = Buffer.concat([buf.subarray(0, read), carry]);
      // Every complete line in the window, newest first; the first (maybe partial) stays.
      let end = carry.length;
      for (let i = carry.length - 1; i >= 0; i--) {
        if (carry[i] !== 0x0a) continue;
        if (take(carry.subarray(i + 1, end).toString('utf-8'))) return { text: parts.join('\n\n'), at, size, scanned: size - pos, ...(stopped ? { stoppedBy: 'banner' as const } : {}) };
        end = i;
      }
      carry = carry.subarray(0, end);
    }
    // The file's first line has no newline before it.
    if (pos === 0 && carry.length) take(carry.toString('utf-8'));
    return { text: parts.join('\n\n'), at, size, scanned: size - pos, ...(stopped ? { stoppedBy: 'banner' as const } : {}) };
  } finally {
    await fh.close();
  }
}
