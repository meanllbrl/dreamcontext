import type { IncomingMessage, ServerResponse } from 'node:http';
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { sanitizeUuid } from './agent-spawn-shared.js';
import { goalLiveRunFor } from './agent-terminal.js';
import { liveTranscriptPath } from '../../lib/transcript-locate.js';
import { parseTranscriptHistory } from '../../lib/transcript-history.js';
import { TEAMMATE_SESSION_RE } from '../../lib/goal-live.js';
import {
  readTeammateTranscript, summarizeTeammateTranscript, teammatesAlive, type TeammateSummary,
} from '../../lib/headless-teammate.js';

/**
 * Headless teammates: `claude -p` runs a pane's orchestrator started, drawn in Chat as party
 * members with their brief, steps and status, and drilled into over their real transcript.
 *
 * AUTHORIZATION is the whole design of this file. A transcript is a whole conversation, so the
 * server reads one ONLY for an id this pane has a claim to, and the claim is checked here, never
 * taken from the client:
 *
 *   • REGISTERED — the id is the `sid` of a lineage entry in the goal-skill live file THIS pane
 *     sees (`goalLiveRunFor`, the same scoping the quest map uses). This is the contract: it
 *     holds however the builder was launched (tracked, detached, wrapped in a script) and after
 *     the orchestrating conversation has ended.
 *   • LAUNCHED — the client names an id it saw in one of this pane's own `claude -p
 *     --session-id <uuid>` calls, and the server confirms that text is in the pane's OWN
 *     transcript. A client cannot name an id the conversation never launched.
 *
 * Every id is a strict UUID before anything touches the disk, and the file itself is read by
 * `readTeammateTranscript` (projects-dir scan, symlink refused, realpath contained, tail cap).
 */

/** Ids a request may name as launched: more than a party ever holds. */
const LAUNCHED_MAX = 12;
/** A registered run with no transcript after this long never started. */
const START_GRACE_MS = 2 * 60 * 1000;
/** The most of the pane's own transcript read to confirm a launch. */
const PANE_READ_CAP_BYTES = 32 * 1024 * 1024;

export interface RegisteredTeammate { sid: string; actor: string; role: string; kind: string; name?: string; from?: string; at?: string; wave?: number; round?: number }

/** A lineage `w` / `r`: a positive integer, or nothing. */
function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** The registered teammates of a live run, newest registration per id winning. */
export function registeredTeammates(state: Record<string, unknown> | null): RegisteredTeammate[] {
  const lineage = Array.isArray(state?.lineage) ? state!.lineage as unknown[] : [];
  const bySid = new Map<string, RegisteredTeammate>();
  for (const raw of lineage) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.sid !== 'string' || !TEAMMATE_SESSION_RE.test(e.sid) || typeof e.a !== 'string') continue;
    bySid.delete(e.sid); // re-insert: order follows the newest registration
    bySid.set(e.sid, {
      sid: e.sid,
      actor: e.a.slice(0, 40),
      role: typeof e.role === 'string' ? e.role.slice(0, 40) : 'agent',
      kind: typeof e.k === 'string' ? e.k : 'spawn',
      ...(typeof e.name === 'string' ? { name: e.name.slice(0, 60) } : {}),
      ...(typeof e.from === 'string' ? { from: e.from.slice(0, 40) } : {}),
      ...(typeof e.at === 'string' ? { at: e.at } : {}),
      ...(positiveInt(e.w) ? { wave: positiveInt(e.w) } : {}),
      ...(positiveInt(e.r) ? { round: positiveInt(e.r) } : {}),
    });
  }
  return [...bySid.values()];
}

/** `a,b,c` → the strict UUIDs among them, deduped and capped. */
export function parseLaunched(raw: string | null): string[] {
  if (!raw) return [];
  const ids = raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => TEAMMATE_SESSION_RE.test(s));
  return [...new Set(ids)].slice(0, LAUNCHED_MAX);
}

/** Does this pane's own conversation contain a `claude` call that started `id`? */
export function launchedBy(paneTranscript: string, id: string): boolean {
  return launchIndex(paneTranscript, id) !== -1;
}

function launchIndex(paneTranscript: string, id: string): number {
  const spaced = paneTranscript.indexOf(`--session-id ${id}`);
  return spaced !== -1 ? spaced : paneTranscript.indexOf(`--session-id=${id}`);
}

/** When the launching call was made: the `timestamp` of the transcript line that holds it, or
 *  null. What gives a launched run its start grace, the way a registration's `at` does. */
export function launchedAt(paneTranscript: string, id: string): number | null {
  const at = launchIndex(paneTranscript, id);
  if (at === -1) return null;
  const line = paneTranscript.slice(paneTranscript.lastIndexOf('\n', at) + 1, (paneTranscript.indexOf('\n', at) + 1 || paneTranscript.length + 1) - 1);
  try {
    const ts = Date.parse(String((JSON.parse(line) as { timestamp?: unknown }).timestamp ?? ''));
    return Number.isFinite(ts) ? ts : null;
  } catch { return null; }
}

function readPaneTranscript(contextRoot: string, claudeId: string): string {
  const path = liveTranscriptPath(contextRoot, claudeId);
  if (!path) return '';
  try {
    if (!lstatSync(path).isFile()) return '';
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - PANE_READ_CAP_BYTES);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf-8');
    } finally { closeSync(fd); }
  } catch { return ''; }
}

/** Launches already confirmed, as `<pane>:<id>` → when it was launched (null: unknown). A
 *  launch never un-happens, and the list is polled every few seconds: re-reading a long pane
 *  transcript per poll to re-prove it would be the route's whole cost. Bounded; the oldest
 *  confirmation is dropped first. */
const confirmedLaunches = new Map<string, number | null>();
const CONFIRMED_MAX = 500;

/** Every id this request may read, with the registration it came from (a launch reads as one
 *  with no actor, stamped with the launching call's time). */
function authorized(contextRoot: string, claudeId: string, launchedRaw: string | null): Map<string, RegisteredTeammate | null> {
  const out = new Map<string, RegisteredTeammate | null>();
  for (const t of registeredTeammates(goalLiveRunFor(contextRoot, claudeId))) out.set(t.sid, t);
  const asked = parseLaunched(launchedRaw).filter((id) => !out.has(id));
  const unproven = asked.filter((id) => !confirmedLaunches.has(`${claudeId}:${id}`));
  const pane = unproven.length ? readPaneTranscript(contextRoot, claudeId) : '';
  for (const id of asked) {
    const key = `${claudeId}:${id}`;
    if (!confirmedLaunches.has(key)) {
      if (!pane || !launchedBy(pane, id)) continue;
      confirmedLaunches.set(key, launchedAt(pane, id));
      if (confirmedLaunches.size > CONFIRMED_MAX) confirmedLaunches.delete(confirmedLaunches.keys().next().value as string);
    }
    const at = confirmedLaunches.get(key);
    out.set(id, at != null ? { sid: id, actor: '', role: '', kind: '', at: new Date(at).toISOString() } : null);
  }
  return out;
}

export type TeammateWire = (TeammateSummary & { missing?: false } | { session: string; status: 'running' | 'failed'; missing: true; steps: []; toolUses: 0 })
  & { actor?: string; role?: string; kind?: string; name?: string; from?: string; registeredAt?: string; wave?: number; round?: number };

/** GET /api/agent/teammates?claudeId=<pane>[&launched=<uuid,uuid>] — every headless teammate
 *  this pane may see, each summarized from its own transcript. Desktop-gated like every other
 *  transcript read; `{teammates: []}` for anything it cannot answer. */
export async function handleAgentTeammates(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  if (!isDesktop() || !contextRoot) { sendJson(res, 200, { teammates: [] }); return; }
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const claudeId = sanitizeUuid(url.searchParams.get('claudeId'));
  if (!claudeId) { sendJson(res, 200, { teammates: [] }); return; }

  const allowed = authorized(contextRoot, claudeId, url.searchParams.get('launched'));
  const now = Date.now();
  const alive = await teammatesAlive([...allowed.keys()], now);
  const teammates: TeammateWire[] = [];
  for (const [sid, reg] of allowed) {
    const who = reg?.actor
      ? { actor: reg.actor, role: reg.role, kind: reg.kind, ...(reg.name ? { name: reg.name } : {}), ...(reg.from ? { from: reg.from } : {}), ...(reg.at ? { registeredAt: reg.at } : {}), ...(reg.wave ? { wave: reg.wave } : {}), ...(reg.round ? { round: reg.round } : {}) }
      : {};
    const file = readTeammateTranscript(sid);
    if (!file) {
      // Registered but nothing on disk yet: starting, or it never did.
      const at = reg?.at ? Date.parse(reg.at) : NaN;
      const starting = alive.get(sid) === true || (Number.isFinite(at) && now - at < START_GRACE_MS);
      teammates.push({ session: sid, status: starting ? 'running' : 'failed', missing: true, steps: [], toolUses: 0, ...who });
      continue;
    }
    teammates.push({ ...summarizeTeammateTranscript(sid, file.raw, file.mtimeMs, now, alive.get(sid) ?? null), ...who });
  }
  sendJson(res, 200, { teammates });
}

/** GET /api/agent/teammate-history?claudeId=<pane>&session=<uuid>[&launched=1] — one teammate's
 *  whole transcript as replayable items, for the drill-in. Same authorization as the list:
 *  `launched=1` lets an id the pane launched (not registered) through, after the same check. */
export async function handleAgentTeammateHistory(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  if (!isDesktop() || !contextRoot) { sendJson(res, 200, { items: [] }); return; }
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const claudeId = sanitizeUuid(url.searchParams.get('claudeId'));
  const session = (url.searchParams.get('session') ?? '').trim().toLowerCase();
  if (!claudeId || !TEAMMATE_SESSION_RE.test(session)) { sendJson(res, 200, { items: [] }); return; }
  const allowed = authorized(contextRoot, claudeId, url.searchParams.get('launched') ? session : null);
  if (!allowed.has(session)) { sendJson(res, 200, { items: [] }); return; }
  const file = readTeammateTranscript(session);
  sendJson(res, 200, { items: file ? parseTranscriptHistory(file.raw) : [] });
}
