import type {
  RemoteChild, RemoteContainer, RemoteGroup, RemoteView, SuperRemoteView,
} from '../handsfree/mac/contract.js';
import { superDigest } from './phone-mirror.js';
import { superQueueHead } from './inbox.js';
import type { SuperState } from './types.js';

/**
 * The Super Agent's stage as a REMOTE screen may see it (hands-free sekmeler W1): the computer
 * or landscape tablet on the tunnel draws the stage from this, never from the record.
 *
 * Built from an ALLOWLIST, field by field, so a field added to `SuperState` later never reaches
 * the tunnel by default. Never carried: a child's brief, branch, worktree, prompt, MCP servers or
 * settings; the pool; the AI Team's jobs; the dismissed list; notes; the held ledger; raw owner
 * text (the waiting rows carry the question as the owner reads it, as the phone's digest does);
 * an absolute path; a web address only the Mac can reach.
 *
 * A web card shows an `https:` page on another host; anything else (loopback, private, link-local,
 * the tunnel's own host, an `http:` page, a project file) becomes a placeholder
 * (`blocked: 'mac_only'`) with no address at all. The live browser card is always a placeholder.
 * A child is named by its card's title only (never the Super's brief).
 */

/** Container kinds whose ref is a slug or a project-relative path. */
const PATH_KINDS = new Set(['image', 'task', 'knowledge', 'insight', 'whiteboard', 'board']);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** A project-relative ref: not absolute, no `..`, no home, no scheme or drive, no backslash. */
export function relativeRef(ref: string): string | null {
  if (!ref || ref.length > 2048) return null;
  if (ref.startsWith('/') || ref.startsWith('~') || ref.includes('\\') || ref.includes(':')) return null;
  if (ref.split('/').some((seg) => seg === '..')) return null;
  if (/[\u0000-\u001f\u007f]/.test(ref)) return null;
  return ref;
}

/** Is this hostname reachable only from the Mac (loopback, private, link-local, `.local`)? */
export function isMacOnlyHost(hostname: string, tunnelHost: string | null): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (tunnelHost && h === tunnelHost.toLowerCase().replace(/\.$/, '')) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  // Every IPv6 literal: loopback, unspecified, IPv4-mapped, unique-local (fc00::/7) and
  // link-local (fe80::/10) are the Mac's, and a public literal is no page an agent opens.
  if (h.startsWith('[') || h.includes(':')) return true;
  // A bare name with no dot (`intranet`, `nas`) resolves only on the Mac's network.
  return !h.includes('.');
}

function remoteWeb(ref: string, tunnelHost: string | null): Pick<RemoteContainer, 'ref' | 'blocked'> {
  let url: URL | null = null;
  try { url = new URL(ref); } catch { url = null; }
  // Blocked: no address at all travels, not even its host (the placeholder names the card).
  if (!url || url.protocol !== 'https:' || url.username || url.password || isMacOnlyHost(url.hostname, tunnelHost)) return { blocked: 'mac_only' };
  return { ref: url.href };
}

function remoteContainer(c: SuperState['containers'][number], tunnelHost: string | null): RemoteContainer {
  const base: RemoteContainer = {
    id: c.id, kind: c.kind, shape: c.shape, place: c.place,
    ...(c.size ? { size: c.size } : {}),
    ...(c.sizeBy ? { sizeBy: c.sizeBy } : {}),
    ...(c.pos ? { pos: { x: c.pos.x, y: c.pos.y } } : {}),
    ...(c.title ? { title: c.title } : {}),
    ...(c.min ? { min: true as const } : {}),
    ...(c.heldAt !== undefined ? { heldAt: c.heldAt } : {}),
  };
  switch (c.kind) {
    case 'chat':
    case 'team':
      return ID_RE.test(c.ref) ? { ...base, ref: c.ref } : base;
    case 'agenda':
      return { ...base, ref: 'agenda' };
    case 'web':
      return { ...base, ...remoteWeb(c.ref, tunnelHost) };
    case 'browser':
      return { ...base, blocked: 'mac_only' };
    default: {
      if (!PATH_KINDS.has(c.kind)) return { ...base, blocked: 'mac_only' };
      const ref = relativeRef(c.ref);
      return ref ? { ...base, ref } : { ...base, blocked: 'mac_only' };
    }
  }
}

function remoteView(v: SuperState['view']): RemoteView {
  return {
    mode: v.mode,
    ...(v.card ? { card: v.card } : {}),
    ...(v.cards ? { cards: [...v.cards] } : {}),
    ...(v.layout ? { layout: v.layout } : {}),
    ...(v.layoutBy ? { layoutBy: v.layoutBy } : {}),
    ...(v.chat ? { chat: v.chat } : {}),
  };
}

function remoteChild(sid: string, ch: SuperState['children'][string]): RemoteChild {
  return {
    sessionId: sid, startedAt: ch.startedAt,
    ...(ch.row ? { row: ch.row } : {}),
    ...(ch.finishedAt !== undefined ? { finishedAt: ch.finishedAt } : {}),
    ...(ch.seenAt !== undefined ? { seenAt: ch.seenAt } : {}),
    ...(ch.endedAt !== undefined ? { endedAt: ch.endedAt } : {}),
  };
}

/** The remote stage of `state`. Pure: `vault` is the project's registered name, `tunnelHost` the
 *  tunnel's own hostname (a web card pointing back at it is the Mac's own pages). */
export function superRemoteView(state: SuperState, vault: string, tunnelHost: string | null, rotating = false): SuperRemoteView {
  const digest = superDigest(state);
  const head = superQueueHead(state);
  // The agenda's child names: the Mac's card titles, never a brief (the digest falls back to it).
  const names: Record<string, string> = {};
  for (const sid of Object.keys(digest.names)) {
    const title = state.containers.find((c) => c.kind === 'chat' && c.ref === sid)?.title;
    if (title) names[sid] = digest.names[sid];
  }
  const children: Record<string, RemoteChild> = {};
  for (const [sid, ch] of Object.entries(state.children)) if (ID_RE.test(sid)) children[sid] = remoteChild(sid, ch);
  const groups: RemoteGroup[] = state.groups.map((g) => ({
    id: g.id, name: g.name, cards: [...g.cards], place: g.place, ...(g.pos ? { pos: { x: g.pos.x, y: g.pos.y } } : {}),
  }));
  return {
    vault,
    session: state.session,
    enabled: state.enabled,
    containers: state.containers.map((c) => remoteContainer(c, tunnelHost)),
    groups,
    view: remoteView(state.view),
    children,
    pad: digest.pad,
    waiting: digest.waiting,
    ownerBatches: digest.ownerBatches,
    names,
    head: head ? { item: head.id, kind: head.kind, text: digest.waiting.find((w) => w.id === head.id)?.text ?? '' } : null,
    ...(rotating ? { rotating: true as const } : {}),
  };
}
