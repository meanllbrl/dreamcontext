import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { readSessionTitles } from '../session-titles.js';
import { findTranscriptBySessionId } from '../transcript-locate.js';
import { oneLine, promptLabel, scanChunk } from '../transcript-sessions.js';

/**
 * What an EXISTING conversation is already about, read from disk once when its chat registers.
 *
 * A `claude --resume` respawn (every tab the app restores after a restart) replays no history,
 * so the registry (chat-registry.ts) would list it with no title and no text until its next
 * turn — and the Assistant could not tell what any restored session is about. This reads the
 * tab title the owner saw (`state/.session-titles.json`), else the transcript's first human
 * prompt, plus the transcript's newest assistant texts.
 *
 * BOUNDED: a transcript runs to 10-18 MB, so only its first and last {@link END_BYTES} are read,
 * through the descriptor. Synchronous and cheap — it runs once per chat spawn. Never throws: any
 * failure is `{}`, and the chat registers unseeded.
 */

export interface ChatSeed { title?: string; lastAssistantText?: string[] }

const END_BYTES = 64 * 1024;
const MAX_TEXTS = 3;

function readAt(fd: number, position: number, length: number): string {
  if (length <= 0) return '';
  const buf = Buffer.allocUnsafe(length);
  const n = readSync(fd, buf, 0, length, position);
  return n > 0 ? buf.subarray(0, n).toString('utf8') : '';
}

/** First and last END_BYTES of a file; `tail` is '' when the head already holds all of it. */
function readEnds(path: string): { head: string; tail: string } {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const head = readAt(fd, 0, Math.min(size, END_BYTES));
    const tailLen = Math.min(Math.max(0, size - END_BYTES), END_BYTES);
    return { head, tail: tailLen > 0 ? readAt(fd, size - tailLen, tailLen) : '' };
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/** The newest top-level (non-sidechain) assistant texts in a JSONL chunk, oldest first.
 *  Lines that do not parse — the cut line at a chunk edge — are skipped. */
function assistantTexts(chunk: string): string[] {
  const out: string[] = [];
  for (const line of chunk.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(s) as Record<string, unknown>; } catch { continue; }
    if (!obj || obj.type !== 'assistant' || obj.isSidechain === true) continue;
    const content = (obj.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) out.push(text);
  }
  return out.slice(-MAX_TEXTS);
}

export function seedForConversation(contextRoot: string | null, ids: string[], opts: { home?: string } = {}): ChatSeed {
  try {
    const wanted = ids.filter(Boolean);
    let title = '';
    if (contextRoot) {
      const stored = readSessionTitles(contextRoot);
      for (const id of wanted) { const t = stored.get(id); if (t) { title = t; break; } }
    }
    const path = findTranscriptBySessionId(wanted, opts.home ?? homedir());
    let texts: string[] = [];
    if (path) {
      const { head, tail } = readEnds(path);
      if (!title) {
        // 2, not 1: past its cap scanChunk overwrites the LAST slot, so with one slot
        // prompts[0] would be the head's newest prompt rather than its first.
        const first = scanChunk(head, 2).prompts[0];
        if (first) title = oneLine(promptLabel(first), 80);
      }
      // A short tail (a 64-128 KB file) can hold no reply at all: fall back to the head's.
      texts = tail ? assistantTexts(tail) : [];
      if (!texts.length) texts = assistantTexts(head);
    }
    return {
      ...(title ? { title } : {}),
      ...(texts.length ? { lastAssistantText: texts } : {}),
    };
  } catch {
    return {};
  }
}
