/**
 * The chat socket's app gate (plan r9, D8). `/api/agent/chat?app=<slug>&tk=<token>…` is how an
 * app's frame opens its conversations; the same gate also covers a conversation of an app named
 * from any other pane (main Chat History, a Resume banner), which needs no token but gets the same
 * treatment: its URL is REBUILT from an allowlist, so `bypass`, `mode`, `prompt`, `promptToken`,
 * `deferPrompt`, `cardAgent`, `cardBoard`, `chatAgent`, `stage`, `lean`, `mcp`, `tool`, `account`
 * and `origin` reach nothing, whatever the page asked for.
 *
 * Every other reader in the upgrade handler keeps reading the URL as before. That is the point:
 * there is one way through, and a new parameter added there is dropped here by default.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getRunTarget } from '../../lib/automations/store.js';
import { appChatHasRoom, reserveAppChat, resolveAppAgent } from '../../lib/apps/assistant.js';
import { createAppChat, lookupAppChatOf, reopenAppChat, type AppChatRecord } from '../../lib/apps/chat-store.js';
import { readManifest, roleFileProblem } from '../../lib/apps/manifest.js';
import { getApp, real } from '../../lib/apps/registry.js';
import { UUID_RE } from '../../lib/agent-session-map.js';
import { resolveEmbedToken } from './embed-token.js';

export const APP_SOCKET_PARAMS = ['vault', 'sessionId', 'resume', 'reattach', 'model', 'effort'] as const;

/** `hold`: the seat of a new conversation, taken here so two opens in one tick cannot both pass.
 *  The handler lets it go once the spawn has its own, or the socket dies first. */
export type AppUpgrade = null | { refuse: number } | { full: true } | { url: URL; hold?: () => void };

export interface AppUpgradeInput {
  url: URL;
  vault: string | null;
  projectRoot: string;
  phone: boolean;
  assistant: boolean;
  /** Same origin, port included, under a loopback Host. */
  sameOrigin: () => boolean;
  isLive: (id: string) => boolean;
  hasTranscript: (id: string) => boolean;
  home?: string;
}

function rebuilt(url: URL): URL {
  const next = new URL(url.pathname, url.origin);
  for (const key of APP_SOCKET_PARAMS) {
    const value = url.searchParams.get(key);
    if (value !== null) next.searchParams.set(key, value);
  }
  return next;
}

const id = (v: string | null): string => (v && UUID_RE.test(v) ? v : '');

/** What this upgrade is to the app gate: not its business (null), refused, or a rebuilt URL. */
export function appChatUpgrade(i: AppUpgradeInput): AppUpgrade {
  const home = i.home ?? homedir();
  const asked = i.url.searchParams.has('app');
  const resume = id(i.url.searchParams.get('resume'));
  const sessionId = id(i.url.searchParams.get('sessionId'));
  const hit = lookupAppChatOf([resume, sessionId], home);
  if (!asked && hit.kind === 'none') return null;
  if (i.phone || i.assistant || hit.kind === 'damaged') return { refuse: 403 };
  const projectRoot = real(i.projectRoot);
  if (hit.kind === 'record' && hit.record.projectRoot !== projectRoot) return { refuse: 403 };
  if (!asked) return { url: rebuilt(i.url) };

  const slug = i.url.searchParams.get('app') ?? '';
  const grant = resolveEmbedToken(i.url.searchParams.get('tk'));
  if (!grant || grant.slug !== slug || grant.vault !== i.vault || grant.projectRoot !== projectRoot || !i.sameOrigin()) return { refuse: 403 };
  const rec = getApp(home, projectRoot, slug);
  if (!rec) return { refuse: 403 };

  const ownRecord = (r: AppChatRecord): boolean => r.hash === rec.hash;
  if (resume) {
    if (hit.kind !== 'record' || !ownRecord(hit.record) || sessionId) return { refuse: 403 };
    if (hit.record.closedAt) reopenAppChat(hit.record.id, home);
    return { url: rebuilt(i.url) };
  }
  // A new conversation: never one that exists anywhere, so an owner's cannot be pulled in.
  if (!sessionId || hit.kind === 'record' || i.isLive(sessionId) || i.hasTranscript(sessionId)) return { refuse: 403 };
  const m = readManifest(rec.root);
  if (!m.ok) return { refuse: 409 };
  const contextRoot = join(projectRoot, '_dream_context');
  const choice = resolveAppAgent(m.manifest, i.url.searchParams.get('member'), (s) => !!getRunTarget(contextRoot, s, 'agent')?.whiteboard);
  if (choice.kind === 'none') return { refuse: 409 };
  if (choice.kind === 'own' && roleFileProblem(rec.root)) return { refuse: 409 };
  if (!appChatHasRoom(rec.hash, sessionId)) return { full: true };
  createAppChat({ id: sessionId, hash: rec.hash, slug: rec.slug, projectRoot, member: choice.kind === 'member' ? choice.member : null }, home);
  const release = reserveAppChat(rec.hash, sessionId);
  let held = true;
  return { url: rebuilt(i.url), hold: () => { if (held) { held = false; release(); } } };
}
