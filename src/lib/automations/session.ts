/**
 * Automations — reading back the claude session a run actually had.
 *
 * A scheduled run produces a polished output document, which is what it was
 * asked for and is NOT what you need when it does something surprising: the
 * document is the conclusion with the working thrown away. Every run already
 * records its `sessionId` (see RunEvent), and Claude Code already keeps the
 * full transcript on disk, so the whole capability here is joining those two
 * facts — no new capture path, nothing extra written at run time.
 *
 * Read-only and best-effort by construction. A transcript can legitimately be
 * missing (a run that failed before claude produced JSON never had a session
 * id at all; a transcript can be pruned by a program that is not ours), so
 * every function reports absence as a value rather than throwing.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { findTranscriptBySessionId } from '../transcript-locate.js';
import { parseTranscriptHistory, toolCallLabel, type ChatHistoryItem } from '../transcript-history.js';
import type { AutomationCache, RunEvent } from './types.js';

/** Bytes of transcript read from disk. A long automation run is a few hundred
 *  KB; the cap exists so a pathological file can never be slurped whole into a
 *  CLI process. The tail is what matters (parseTranscriptHistory itself keeps
 *  the last HISTORY_MAX_ITEMS), but JSONL must be parsed from a line boundary,
 *  so a truncated head is dropped by the parser's own per-line try/catch. */
export const MAX_TRANSCRIPT_BYTES = 8_000_000;

export interface ResolvedRunSession {
  /** The run this session belongs to. */
  event: RunEvent;
  /** 1-based, newest-first — the same numbering `automations session --run N` takes. */
  runNumber: number;
  sessionId: string | null;
  /** Null when the id is unknown OR no transcript exists for it on disk. */
  transcriptPath: string | null;
}

/**
 * Pick a run out of the cache's history.
 *
 * `runNumber` is 1-based because it is a user-facing selector (`--run 2` means
 * "the one before last"). It indexes the history AS STORED: `recordRun`
 * prepends (`[event, ...existing]`), so the array is already newest-first and
 * must NOT be reversed here. Reversing it silently makes `--run 1` the OLDEST
 * run — which reads as plausible right up until you notice the session you
 * opened is a week old.
 */
export function resolveRunSession(
  cache: AutomationCache | null,
  opts: { runNumber?: number; home?: string } = {},
): ResolvedRunSession | null {
  const history = Array.isArray(cache?.history) ? (cache as AutomationCache).history : [];
  if (history.length === 0) return null;

  let index: number;
  if (opts.runNumber !== undefined) {
    index = opts.runNumber - 1;
    if (index < 0 || index >= history.length) return null;
  } else {
    // No explicit run: the most recent one that HAS a session, not simply the
    // most recent. A blocked or deferred run records no session at all, and
    // answering "there is nothing to show" for it would be technically true
    // and useless — the run the user is asking about is the last one that ran.
    index = history.findIndex((e) => e.sessionId);
    if (index === -1) index = 0;
  }

  const event = history[index];
  const sessionId = event.sessionId;
  return {
    event,
    runNumber: index + 1,
    sessionId,
    transcriptPath: sessionId ? findTranscriptBySessionId([sessionId], opts.home ?? homedir()) : null,
  };
}

export interface SessionDigest {
  items: ChatHistoryItem[];
  /** Tool name → call count, for the "what did it actually do" one-liner. */
  toolCounts: Record<string, number>;
  toolCalls: number;
  toolErrors: number;
  assistantMessages: number;
}

/** Parse a transcript into the digest the CLI prints and the dashboard renders.
 *  PURE — takes the raw text, so tests never touch a filesystem. */
export function digestTranscript(raw: string): SessionDigest {
  const items = parseTranscriptHistory(raw);
  const toolCounts: Record<string, number> = {};
  let toolCalls = 0;
  let toolErrors = 0;
  let assistantMessages = 0;
  for (const item of items) {
    if (item.kind === 'tool') {
      const name = item.name ?? 'tool';
      toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      toolCalls += 1;
      if (item.status === 'error') toolErrors += 1;
    } else if (item.kind === 'text') {
      assistantMessages += 1;
    }
  }
  return { items, toolCounts, toolCalls, toolErrors, assistantMessages };
}

/** Read + digest a transcript from disk. Null when it cannot be read — a
 *  caller distinguishing "no transcript" from "empty transcript" should check
 *  the path first. */
export function readSessionDigest(transcriptPath: string): SessionDigest | null {
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    return digestTranscript(raw.length > MAX_TRANSCRIPT_BYTES ? raw.slice(-MAX_TRANSCRIPT_BYTES) : raw);
  } catch {
    return null;
  }
}

export { toolCallLabel };
