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
