/**
 * What the harness actually handed the model, read from the project's own transcripts. In a
 * transcript a hook's `content` is what the model got and `stdout` what the hook printed, so a
 * preview is on record even though nothing failed anywhere. Used by `dreamcontext doctor`.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { listTranscriptFiles } from './transcript-sessions.js';
import { listSubagentTranscripts, resolveTranscript } from './transcript-locate.js';

/** The harness's own words where a hook's output used to be. */
export const PREVIEW_MARKER = 'Output too large';

const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'SubagentStart']);
const SESSIONS_TO_READ = 5;
const SUBAGENTS_PER_SESSION = 10;
/** A session's context is in its head and its turns; the tail of a huge transcript can wait. */
const MAX_BYTES_PER_FILE = 8 * 1024 * 1024;

export interface ContextDeliveryAudit {
  sessions: number;
  subagents: number;
  /** Hook outputs that became a preview, by event. */
  previews: Record<string, number>;
  /** Sessions whose first snapshot piece promised a part that never arrived. */
  missingParts: number;
}

function readHead(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(statSync(path).size, MAX_BYTES_PER_FILE));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf-8', 0, n);
  } finally {
    closeSync(fd);
  }
}

/** Each context hook's text as the model got it, with its event. */
function hookDeliveries(transcript: string): Array<{ event: string; text: string }> {
  const out: Array<{ event: string; text: string }> = [];
  for (const line of transcript.split('\n')) {
    if (!line.includes('"attachment"') || !line.includes('"hookEvent"')) continue;
    let attachment: { type?: unknown; hookEvent?: unknown; content?: unknown };
    try {
      attachment = (JSON.parse(line) as { attachment?: typeof attachment }).attachment ?? {};
    } catch {
      continue;
    }
    const { type, hookEvent, content } = attachment;
    if (typeof hookEvent !== 'string' || !CONTEXT_EVENTS.has(hookEvent)) continue;
    if (type !== 'hook_success' && type !== 'hook_additional_context') continue;
    out.push({ event: hookEvent, text: Array.isArray(content) ? content.join('\n') : String(content ?? '') });
  }
  return out;
}

function countPreviews(deliveries: ReadonlyArray<{ event: string; text: string }>, into: Record<string, number>): void {
  for (const d of deliveries) {
    if (d.text.includes(PREVIEW_MARKER)) into[d.event] = (into[d.event] ?? 0) + 1;
  }
}

/** Promised parts (`continues in part N of M`) with no matching `part N of M, continued`. */
function lostPart(deliveries: ReadonlyArray<{ text: string }>): boolean {
  const all = deliveries.map((d) => d.text).join('\n');
  for (const m of all.matchAll(/context continues in part (\d+) of (\d+)/g)) {
    if (!all.includes(`context, part ${m[1]} of ${m[2]}, continued`)) return true;
  }
  return false;
}

export function scanContextDelivery(projectRoot: string, home: string = homedir()): ContextDeliveryAudit {
  const audit: ContextDeliveryAudit = { sessions: 0, subagents: 0, previews: {}, missingParts: 0 };
  let files: ReturnType<typeof listTranscriptFiles>['files'] = [];
  try {
    files = listTranscriptFiles(projectRoot, home).files;
  } catch {
    return audit;
  }
  for (const file of files.slice(0, SESSIONS_TO_READ)) {
    try {
      const deliveries = hookDeliveries(readHead(file.path));
      audit.sessions++;
      countPreviews(deliveries, audit.previews);
      if (lostPart(deliveries)) audit.missingParts++;
      const loc = resolveTranscript(file.path, { sessionId: file.id });
      for (const sub of listSubagentTranscripts(loc, { max: SUBAGENTS_PER_SESSION })) {
        audit.subagents++;
        countPreviews(hookDeliveries(readHead(sub)), audit.previews);
      }
    } catch { /* a transcript that vanished or will not read says nothing either way */ }
  }
  return audit;
}
