import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findTranscriptBySessionId } from '../transcript-locate.js';
import type { ChatHistoryItem } from '../transcript-history.js';
import { isAutomationBoundSession, readAutomationSession, sessionForRun } from './session-registry.js';
import { isNotedRunSession, runningSessionFor } from './run-session.js';
import { isSafeAutomationSlug, readAutomationCache } from './store.js';

/**
 * WHICH SESSION A RUN LIVES IN, as a surface may believe it. A session id is a capability, and the
 * run cache that also names one is brain-synced, so its `sessionId` is never read here: the id
 * comes from this machine's binding to this slug (`sessionForRun`) or, while the run has no
 * binding yet, from its own hook's note (`runningSessionFor`). Either way a transcript must be on
 * disk: `--resume` against a missing one starts a blank chat that claims to be the run.
 */

/** A question's or a run's session id, but only when opening it would reach that conversation. */
export function offerableSession(slug: string, sessionId: string | null, home: string = homedir()): string | null {
  if (!sessionId) return null;
  if (readAutomationSession(slug, sessionId, home) === null) return null;
  if (findTranscriptBySessionId([sessionId], home) === null) return null;
  return sessionId;
}

export interface RunChat {
  claudeId: string;
  /** This machine bound the session to the run, so a reply can resume it. A session only noted
   *  while it ran (a one-off job, a killed run) shows and cannot be continued. */
  resumable: boolean;
}

/** The session of one run, or null when none can be opened here. */
export function runChatSession(contextRoot: string, slug: string, runId: string, home: string = homedir()): RunChat | null {
  const bound = sessionForRun(contextRoot, slug, runId, home, false);
  const claudeId = bound ?? runningSessionFor(contextRoot, slug, runId, home);
  if (!claudeId || findTranscriptBySessionId([claudeId], home) === null) return null;
  return { claudeId, resumable: bound !== null };
}

/**
 * Is this conversation a run's, on this machine? Answers for a run in flight and a killed one (the
 * note), a finished one (the binding), and one whose binding was retired or aged out (its project's
 * run cache). The cache is synced, and a planted id is safe here for the reason it is safe in a
 * warning: all a yes can do is show the phone less.
 */
export function isRunSession(contextRoot: string | null, ids: readonly string[], home: string = homedir()): boolean {
  for (const id of ids) {
    if (!id) continue;
    if (isNotedRunSession(id, home) || isAutomationBoundSession(id, home)) return true;
    if (contextRoot && cachedRunSessions(contextRoot).has(id)) return true;
  }
  return false;
}

/** Read from the folder, not from the manifests: a cache can outlive its automation. */
function cacheSlugs(contextRoot: string): string[] {
  try {
    return readdirSync(join(contextRoot, 'automations', 'cache'))
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter(isSafeAutomationSlug);
  } catch { return []; }
}

function cachedRunSessions(contextRoot: string): Set<string> {
  const out = new Set<string>();
  for (const slug of cacheSlugs(contextRoot)) {
    try {
      const history = readAutomationCache(contextRoot, slug)?.history;
      if (!Array.isArray(history)) continue;
      for (const e of history) if (typeof e?.sessionId === 'string') out.add(e.sessionId);
    } catch { /* one bad cache never blinds the others */ }
  }
  return out;
}

/**
 * WHAT A PHONE MAY READ OF A RUN (owner decision K4): the agent's words and each tool's bare name.
 * Built field by field, so nothing a tool was given or returned crosses the tunnel, and a field
 * added to a transcript item later stays home. `toolCallLabel` is not used: it carries `command`.
 * `toolUseId` stays because the pane drops a tool item without one.
 */
export function phoneRunItems(items: readonly ChatHistoryItem[]): ChatHistoryItem[] {
  const out: ChatHistoryItem[] = [];
  for (const it of items) {
    if (it.kind === 'text' && typeof it.text === 'string') {
      out.push({ kind: 'text', text: it.text, ...(typeof it.at === 'number' ? { at: it.at } : {}) });
    } else if (it.kind === 'tool' && typeof it.toolUseId === 'string') {
      out.push({
        kind: 'tool', toolUseId: it.toolUseId, name: typeof it.name === 'string' ? it.name : '',
        ...(it.status ? { status: it.status } : {}),
      });
    }
  }
  return out;
}
