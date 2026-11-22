/**
 * A member's past work, served from this server's warm index (plan uye-gecmis-is C3, C4, D4).
 *
 *   POST /api/agents/work/select {member, root, query, audience, app?, exclude}
 *
 * Loopback only, like `/api/recall/prompt` (a member's hook asks the running app; the phone is
 * denied by route-policy). Also here: the derivation queue the chat route feeds after every main
 * `result` of a member conversation, and D4's sweep the index runs before its build.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isLoopback } from './agent-spawn-shared.js';
import { listVaults } from '../../lib/vaults.js';
import { realPath } from '../../lib/real-path.js';
import { workIndex, type WorkAudience } from '../../lib/agents/work-index.js';
import {
  deriveTranscript, transcriptsOf, locateTranscript, type TranscriptTool,
} from '../../lib/agents/work-trace.js';
import { memberScope, isGlobalAgentHere } from '../../lib/agents/scope.js';
import { isSafeAutomationSlug } from '../../lib/agents/slot.js';
import { isSafeSessionId } from '../../lib/transcript-locate.js';
import { resolveAgentSession } from '../../lib/agent-session-map.js';
import { isAutomationBoundSession } from '../../lib/automations/session-registry.js';
import { isNotedRunSession } from '../../lib/automations/run-session.js';
import { readAutomationCache } from '../../lib/automations/store.js';
import { readOwnerTurns } from '../../lib/owner-words.js';
import { projectKey } from '../../lib/local-store.js';

const real = (p: string): string | null => { try { return realPath(p); } catch { return null; } };

/** A project root this machine knows (a registered vault), or the server's own. */
function knownProject(root: string, contextRoot: string | null): string | null {
  const r = real(root);
  if (!r) return null;
  if (contextRoot && real(join(contextRoot, '..')) === r) return r;
  try { if (listVaults().some((v) => real(v.path) === r)) return r; } catch { /* no registry */ }
  return null;
}

function bodyIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x)).slice(0, 5_000) : [];
}

export async function handleAgentWorkSelect(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, contextRoot: string): Promise<void> {
  if (!isLoopback(req)) {
    sendError(res, 403, 'forbidden', 'laptop-only: a member\'s hook asks the running app.');
    return;
  }
  const body = await parseJsonBody(req);
  const member = typeof body?.member === 'string' ? body.member : '';
  const root = typeof body?.root === 'string' ? body.root : '';
  const query = typeof body?.query === 'string' ? body.query.slice(0, 4_000) : '';
  const audience: WorkAudience = body?.audience === 'app' ? 'app' : 'owner';
  if (!isSafeAutomationSlug(member) || !root || !query.trim()) {
    sendError(res, 400, 'bad_request', 'member, root and query are required');
    return;
  }
  const projectRoot = knownProject(root, contextRoot || null);
  if (!projectRoot) {
    sendError(res, 409, 'other_vault', 'This machine does not know that project.');
    return;
  }
  const ex = (body?.exclude ?? {}) as Record<string, unknown>;
  const conversation = typeof ex.conversation === 'string' && isSafeSessionId(ex.conversation) ? ex.conversation : null;
  const since = typeof ex.since === 'number' && Number.isFinite(ex.since) ? ex.since : null;
  const app = typeof body?.app === 'string' && isSafeAutomationSlug(body.app) ? body.app : null;
  try {
    if (body?.mode === 'search') {
      // `agents history --search`: every match, no room (D12); the index waits for its build.
      const hit = await workIndex.whenBuilt(member, projectRoot);
      if (!hit) { sendJson(res, 200, { hits: [] }); return; }
      const viewer = audience === 'app' ? { app } : null;
      const hits = hit.idx.allMatches(query, { projectKey: projectKey(projectRoot), scope: hit.scope }, body.all === true && !viewer, viewer);
      sendJson(res, 200, { hits });
      return;
    }
    const sel = workIndex.select(member, projectRoot, { query, audience, app, exclude: { ids: bodyIds(ex.ids), conversation, since } });
    sendJson(res, 200, sel);
  } catch (err) {
    sendError(res, 500, 'work_select_failed', err instanceof Error ? err.message : 'failed');
  }
}

// ─── Derivation (C4a) and the sweep (D4) ─────────────────────────────────

/** A run's own session, and when that run ended (a chat opened before this build splits there). */
function runSessionOf(projectRoot: string): (id: string) => { run: true; endedAt: number | null } | null {
  return (id: string) => {
    let slug: string | null = null;
    try { slug = isAutomationBoundSession(id); } catch { slug = null; }
    let noted = false;
    try { noted = !slug && isNotedRunSession(id); } catch { noted = false; }
    if (!slug && !noted) return null;
    let endedAt: number | null = null;
    if (slug) {
      try {
        const h = readAutomationCache(join(projectRoot, '_dream_context'), slug)?.history.find((r) => r.sessionId === id);
        const t = h ? Date.parse(h.finishedAt) : NaN;
        endedAt = Number.isFinite(t) ? t : null;
      } catch { endedAt = null; }
    }
    return { run: true, endedAt };
  };
}

function ownerTextsOf(projectRoot: string): Set<string> {
  try { return new Set(readOwnerTurns({ vault: projectRoot }).map((t) => t.own.trim()).filter(Boolean)); } catch { return new Set(); }
}

/** D4's sweep: every transcript of the member that moved since its cursor, in every project it is a member of. */
export async function sweepMember(slug: string, projectRoot: string, home: string = homedir()): Promise<void> {
  const ctx = join(projectRoot, '_dream_context');
  const scope = memberScope(ctx, slug, home);
  if (!scope) return;
  let roots = [projectRoot];
  if (scope === 'global') {
    try { roots = [...new Set([projectRoot, ...listVaults(home).map((v) => resolve(v.path))])].filter((r) => isGlobalAgentHere(join(r, '_dream_context'), slug, home)); } catch { /* this project only */ }
  }
  for (const r of roots) {
    const runSession = runSessionOf(r);
    const ownerTexts = ownerTextsOf(r);
    const rctx = join(r, '_dream_context');
    for (const t of transcriptsOf(slug, r, { home, successor: (id) => { try { const s = resolveAgentSession(rctx, id); return s || null; } catch { return null; } } })) {
      await deriveTranscript(slug, r, t.id, { home, tool: t.tool, path: t.path, runSession, ownerTexts });
      await new Promise((done) => setImmediate(done));
    }
  }
}

workIndex.hooks.sweep = (slug, projectRoot) => sweepMember(slug, projectRoot);

const pending = new Map<string, ReturnType<typeof setTimeout>>();
const DERIVE_DEBOUNCE_MS = 1_500;
const BRIDGE_FILE_WAIT_MS = 10_000;

/**
 * C4(a): a main `result` of a member conversation queues the derivation of the transcript it
 * belongs to, debounced, off the hot path. On Antigravity the bridge writes the file after the
 * result, so it waits (bounded) for the file to move past the result.
 */
export function queueDerive(slug: string, projectRoot: string, transcriptId: string, tool: TranscriptTool, at: number = Date.now()): void {
  if (!isSafeAutomationSlug(slug) || !isSafeSessionId(transcriptId)) return;
  const k = `${slug}\0${projectRoot}\0${transcriptId}`;
  const prev = pending.get(k);
  if (prev) clearTimeout(prev);
  pending.set(k, setTimeout(() => {
    pending.delete(k);
    void (async () => {
      try {
        if (tool === 'antigravity') {
          const deadline = Date.now() + BRIDGE_FILE_WAIT_MS;
          for (;;) {
            const loc = locateTranscript(transcriptId, tool);
            let moved = false;
            try { moved = !!loc && existsSync(loc.path) && statSync(loc.path).mtimeMs >= at; } catch { moved = false; }
            if (moved || Date.now() >= deadline) break;
            await new Promise((done) => setTimeout(done, 250));
          }
        }
        await deriveTranscript(slug, projectRoot, transcriptId, { tool, runSession: runSessionOf(projectRoot), ownerTexts: ownerTextsOf(projectRoot) });
      } catch { /* the next result or the next build derives it */ }
    })();
  }, DERIVE_DEBOUNCE_MS));
}
