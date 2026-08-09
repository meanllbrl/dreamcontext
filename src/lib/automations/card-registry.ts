/**
 * Machine-local card → session bindings.
 *
 * THE PROBLEM THIS SOLVES. A review card names the claude session that a
 * verdict resumes, and that resume runs with `bypassPermissions`. The card
 * itself lives in the PROJECT directory (`_dream_context/automations/review/`),
 * so anything able to write there could plant a card with a chosen body and a
 * chosen session id and wait for a human to approve it. That is the approval
 * tripwire defeated through a door it does not watch — and it is a strictly
 * lower bar than the one the feature's stated security model concedes, which is
 * write access to the HOME directory ("same boundary as shell rc").
 *
 * So the capability-bearing field moves to that boundary. The card may still
 * SAY which session it belongs to — it is useful to read, and it is what the
 * dashboard renders — but that value is not trusted. The binding recorded here,
 * machine-local and never synced, is the authority, and a card whose id has no
 * binding cannot be approved or steered at all.
 *
 * The card body stays in the project directory deliberately: a human should be
 * able to read what an automation proposed by opening a file, and the body is
 * inert — it is shown to a person, never executed. Only the session id is a
 * capability, so only the session id is moved.
 *
 * Its own file rather than a key inside `automations.json`, for the same reason
 * the tick heartbeat got its own: two writers on one JSON file is a lost-update
 * race, and removing it by construction costs nothing.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isSafeSessionId } from '../transcript-locate.js';

/** Bindings older than this are pruned on write. Generous — a card can sit
 *  unanswered for a long time and must still be answerable — but bounded, so
 *  the file cannot grow forever on a machine that runs automations daily. */
const BINDING_TTL_MS = 90 * 24 * 60 * 60 * 1000;

interface CardBinding {
  sessionId: string;
  slug: string;
  at: string;
}

export function cardBindingsPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'automations-cards.json');
}

function readAll(home: string): Record<string, CardBinding> {
  const path = cardBindingsPath(home);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, CardBinding> = {};
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const b = v as Record<string, unknown>;
      if (typeof b.sessionId !== 'string' || !isSafeSessionId(b.sessionId)) continue;
      out[id] = {
        sessionId: b.sessionId,
        slug: typeof b.slug === 'string' ? b.slug : '',
        at: typeof b.at === 'string' ? b.at : '',
      };
    }
    return out;
  } catch {
    // Never throw: an unreadable bindings file must degrade to "no card is
    // resumable", which is safe, rather than taking the whole subsystem down.
    return {};
  }
}

function writeAll(home: string, all: Record<string, CardBinding>, nowMs: number): void {
  const path = cardBindingsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const kept: Record<string, CardBinding> = {};
  for (const [id, b] of Object.entries(all)) {
    const at = Date.parse(b.at);
    if (Number.isFinite(at) && nowMs - at > BINDING_TTL_MS) continue;
    kept[id] = b;
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
}

/** Bind a card to the session a verdict may resume. Called by the RUNNER only —
 *  the one component that knows, first-hand, which session actually produced
 *  the card, because it is the process that spawned it. */
export function recordCardSession(
  cardId: string,
  slug: string,
  sessionId: string | null,
  home: string = homedir(),
  nowMs: number = Date.now(),
): boolean {
  if (!cardId || !isSafeSessionId(sessionId)) return false;
  const all = readAll(home);
  all[cardId] = { sessionId, slug, at: new Date(nowMs).toISOString() };
  writeAll(home, all, nowMs);
  return true;
}

/**
 * THE AUTHORITY on which session a card may resume.
 *
 * Returns null for a card this machine never recorded — which is exactly what a
 * planted card looks like. The caller must treat null as "not resumable",
 * never as "fall back to what the card says".
 */
export function readCardSession(cardId: string, slug: string, home: string = homedir()): string | null {
  const binding = readAll(home)[cardId];
  if (!binding) return null;
  // The slug is bound too, so a card file cannot be moved under a different
  // automation to borrow another automation's session.
  if (binding.slug && binding.slug !== slug) return null;
  return binding.sessionId;
}

/** Drop a binding once its card is answered — the capability should not outlive
 *  the decision it existed for. */
export function forgetCardSession(cardId: string, home: string = homedir(), nowMs: number = Date.now()): void {
  const all = readAll(home);
  if (!(cardId in all)) return;
  delete all[cardId];
  writeAll(home, all, nowMs);
}
