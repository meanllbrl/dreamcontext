import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Per-BOOT server-side state of the dreamcontext Assistant: its credential, its taint flag,
 * and the surface (the notch's chat socket) UI commands are relayed down.
 *
 * THE TOKEN. Minted once per server process and injected ONLY into the `__assistant__` chat's
 * spawn env (`DREAMCONTEXT_ASSISTANT_TOKEN`), so the `dreamcontext assistant …` CLI the
 * assistant runs can reach `/api/assistant/*` and no other vault's agent can. Its shape is
 * `dca_<bootId>_<secret>`: the boot id is what lets a token from a PREVIOUS server process be
 * told apart from a wrong one, so a turn that outlived an app restart gets the honest
 * "the app restarted" instead of "wrong token".
 *
 * HONEST BOUNDARY (also in the feature doc): the token stops remote use and accidental use by
 * other vaults' agents. It is not a defence against a malicious same-user process — anything
 * the assistant itself spawns inherits it and is equally privileged.
 */

const BOOT_ID = randomBytes(6).toString('hex');
const SECRET = randomBytes(24).toString('hex');
const TOKEN = `dca_${BOOT_ID}_${SECRET}`;

export function assistantToken(): string {
  return TOKEN;
}

export type TokenCheck = 'ok' | 'missing' | 'stale' | 'wrong';

export function checkAssistantToken(presented: unknown): TokenCheck {
  if (typeof presented !== 'string' || !presented) return 'missing';
  const m = /^dca_([0-9a-f]{12})_([0-9a-f]{48})$/.exec(presented);
  if (m && m[1] !== BOOT_ID) return 'stale';
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return 'wrong';
  return timingSafeEqual(a, b) ? 'ok' : 'wrong';
}

// ─── Taint ─────────────────────────────────────────────────────────────────────────────

let tainted = false;

/** Set when the server SERVES project-derived text to the assistant (watch, sessions,
 *  projects, broadcast replies) and when a session starts with a roster carrying any. */
export function markTainted(): void { tainted = true; }
/** Cleared ONLY by the owner's next message on the assistant's socket. */
export function clearTaint(): void { tainted = false; }
export function isTainted(): boolean { return tainted; }

// ─── Surface (the relay channel) ─────────────────────────────────────────────────────

/** The notch's side of the relay: send one frame down the assistant's own chat socket. */
export interface AssistantSurface {
  id: string;
  send(frame: Record<string, unknown>): boolean;
}

let surface: AssistantSurface | null = null;

/** Called by the assistant chat bridge once the NOTCH declares it can execute commands.
 *  Returns a disposer that clears the surface only if it is still this one. */
export function setAssistantSurface(s: AssistantSurface): () => void {
  surface = s;
  return () => { if (surface?.id === s.id) surface = null; };
}

export function getAssistantSurface(): AssistantSurface | null {
  return surface;
}

/** Test-only reset. */
export function _resetAssistantState(): void {
  tainted = false;
  surface = null;
}
