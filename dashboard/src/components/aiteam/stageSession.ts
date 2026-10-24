import { createChatSession, type ChatSession } from '../sleepy/chatSession';
import { REATTACH_PASSIVE } from '../handsfree/macContract';
import { bindChatAgent, bindStageChat } from '../../lib/chatAgentBinding';
import { DEFAULT_CHAT_MODE } from '../../lib/chatModes';

/**
 * One live conversation per agent STAGE (vault + agent), kept across re-renders and across
 * switching between teammates, like a whiteboard card's (`boardAgentScratch.ts`): the stage's
 * chat card is a host the session's container is moved into, never the owner of the process.
 *
 * Which conversation: the stage's home session the server recorded on this machine (resumed), or
 * a fresh one whose first accepted open the server records as the home (`stage=1`). The server
 * decides the envelope from the agent's manifest at every spawn (its level, its approval).
 */

interface Entry {
  session: ChatSession | null;
  /** The autonomy level the session was opened at: the server decided its permission mode from it. */
  level: string | null;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();

const keyOf = (vault: string, agent: string): string => `${vault}\u0000${agent}`;

function entryFor(vault: string, agent: string): Entry {
  const key = keyOf(vault, agent);
  let e = entries.get(key);
  if (!e) {
    e = { session: null, level: null, listeners: new Set() };
    entries.set(key, e);
  }
  return e;
}

/** The stage's live session, or null before it was opened. */
export function peekStageSession(vault: string, agent: string): ChatSession | null {
  return entries.get(keyOf(vault, agent))?.session ?? null;
}

/** The level the live session was opened at, or null. */
export function stageSessionLevel(vault: string, agent: string): string | null {
  return entries.get(keyOf(vault, agent))?.level ?? null;
}

/** Hear the stage session change (opened, replaced, busy, asking). Returns the unsubscribe. */
export function subscribeStageSession(vault: string, agent: string, fn: () => void): () => void {
  const e = entryFor(vault, agent);
  e.listeners.add(fn);
  return () => {
    e.listeners.delete(fn);
    if (!e.session && e.listeners.size === 0) entries.delete(keyOf(vault, agent));
  };
}

/**
 * Open the stage's session: `continue` keeps a live one, else resumes `homeId` (the recorded home
 * session) or starts a new one; `resume` respawns the same conversation (the Session ended banner).
 */
export function openStageSession(
  o: { vault: string; agent: string; homeId: string | null; model: string; effort: string; level: string },
  how: 'continue' | 'resume' = 'continue',
): ChatSession {
  const e = entryFor(o.vault, o.agent);
  if (how === 'continue' && e.session) return e.session;
  const previous = e.session;
  const id = previous?.claudeId ?? o.homeId ?? crypto.randomUUID();
  const resume = !!(previous || o.homeId);
  bindChatAgent(id, o.agent);
  bindStageChat(id);
  previous?.dispose();
  const notify = () => { for (const fn of e.listeners) fn(); };
  // Coming back to a home conversation: adopt its child when it is still running detached (the
  // stage was left a moment ago), never evict a screen that holds it. A respawn replaces it.
  const reattach = resume && !previous ? REATTACH_PASSIVE : '';
  const cs = createChatSession(o.vault, false, notify, id, resume, o.model, o.effort, '', '', false, DEFAULT_CHAT_MODE, '', '', null, reattach);
  e.session = cs;
  e.level = o.level;
  notify();
  return cs;
}

/** End every stage session of `vault` (or of every vault). The home ids stay recorded on the server. */
export function dropStageSessions(vault?: string): void {
  for (const [key, e] of [...entries]) {
    if (vault !== undefined && !key.startsWith(`${vault}\u0000`)) continue;
    e.session?.dispose();
    e.session = null;
    e.level = null;
    for (const fn of [...e.listeners]) fn();
    if (e.listeners.size === 0) entries.delete(key);
  }
}
