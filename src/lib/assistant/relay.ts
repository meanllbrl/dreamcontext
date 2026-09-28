import { randomBytes } from 'node:crypto';
import { getAssistantSurface } from './session-state.js';

/**
 * The relay for the Assistant's UI verbs (open, chat, send, answer, focus, tile, notify).
 *
 * NO NEW SOCKET. The server already holds one channel to the notch: the assistant's own chat
 * WebSocket. A command goes DOWN it as a `_meta{subtype:'assistant_command'}` frame; the notch
 * executes it (itself, or by ringing a vault window's doorbell — see `claimCommand`) and the
 * result comes back either UP the same socket or through `POST /api/assistant/commands/:id/result`.
 * Both land in {@link deliverResult}.
 *
 * No surface registered (no notch, or a pane that never declared it can execute) →
 * `no_surface` at once. A surface that never answers → `no_surface` after
 * {@link RELAY_TIMEOUT_MS}.
 *
 * COMMAND IDS ARE THE ANTI-FORGERY PRIMITIVE. Each is 128 random bits, single-use, and
 * minted ONLY here — behind the token-gated `/api/assistant/*` routes. A vault window that
 * hears a doorbell must CLAIM the id from the server with its own vault name and window nonce
 * before it does anything; a forged doorbell carries an id the server never issued, or one
 * already claimed, or one minted for another vault or window, and the claim fails.
 */

// 25 s, inside the 30 s claim TTL: a cold project window has to be built, boot the SPA and
// register its nonce before it can claim — 15 s was too tight for that path.
export const RELAY_TIMEOUT_MS = 25_000;
export const CLAIM_TTL_MS = 30_000;

export type RelayResult = { ok: true; result: unknown } | { ok: false; error: string };

interface PendingCommand {
  id: string;
  verb: string;
  args: Record<string, unknown>;
  /** The vault window this command is for, when a vault window must act on it. */
  vault: string | null;
  /** The window instance (nonce) allowed to claim it. */
  windowNonce: string | null;
  claimed: boolean;
  mintedAt: number;
  resolve: (r: RelayResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingCommand>();

function settle(id: string, r: RelayResult): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(r);
  return true;
}

/** Send one UI verb to the notch and wait for its result. */
export function relayCommand(
  verb: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<RelayResult> {
  const surface = getAssistantSurface();
  if (!surface) return Promise.resolve({ ok: false, error: 'no_surface' });
  const id = randomBytes(16).toString('hex');
  return new Promise<RelayResult>((resolve) => {
    const timer = setTimeout(() => settle(id, { ok: false, error: 'no_surface' }), opts.timeoutMs ?? RELAY_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { id, verb, args, vault: null, windowNonce: null, claimed: false, mintedAt: Date.now(), resolve, timer });
    const sent = surface.send({ subtype: 'assistant_command', id, verb, args });
    if (!sent) settle(id, { ok: false, error: 'no_surface' });
  });
}

/**
 * The notch names the vault window that must act on a command (after resolving it through
 * its window registry, by Tauri LABEL). The server binds the pending id to the nonce THAT
 * window registered at bootstrap — the notch never sees a nonce. A second bind, a bind of an
 * unknown id, or a label with no registered window for that vault is refused.
 */
export function bindCommandToWindow(id: string, vault: string, label: string): boolean {
  const p = pending.get(id);
  if (!p || p.vault !== null || p.claimed) return false;
  const nonce = [...windows.entries()].reverse().find(([, w]) => w.vault === vault && w.label === label)?.[0];
  if (!nonce) return false;
  p.vault = vault;
  p.windowNonce = nonce;
  return true;
}

/**
 * A vault window heard a doorbell and asks for the command behind it. Returns the
 * authoritative `{verb, args}` only for an id this server issued, bound to THIS vault and
 * window nonce, unclaimed and inside {@link CLAIM_TTL_MS}. Everything else is null — and the
 * window does nothing.
 */
export function claimCommand(id: string, vault: string, windowNonce: string, now: number = Date.now()): { verb: string; args: Record<string, unknown> } | null {
  const p = pending.get(id);
  if (!p || p.claimed) return null;
  if (p.vault !== vault || !p.windowNonce || p.windowNonce !== windowNonce) return null;
  if (now - p.mintedAt > CLAIM_TTL_MS) return null;
  p.claimed = true;
  return { verb: p.verb, args: p.args };
}

/** A result for a pending command — from the notch's socket or a vault window's POST. For a
 *  window-bound command, only the window that claimed it may answer. */
export function deliverResult(id: string, r: RelayResult, from?: { vault: string; windowNonce: string }): boolean {
  const p = pending.get(id);
  if (!p) return false;
  if (p.vault !== null) {
    if (!from || !p.claimed || from.vault !== p.vault || from.windowNonce !== p.windowNonce) return false;
  }
  return settle(id, r);
}

/** Every pending command fails `no_surface` — the surface went away. */
export function failAllCommands(): void {
  for (const id of [...pending.keys()]) settle(id, { ok: false, error: 'no_surface' });
}

// ─── Window nonces ────────────────────────────────────────────────────────────────────

const windows = new Map<string, { vault: string; label: string; page: string; registeredAt: number }>();

/**
 * A vault window registers itself at bootstrap; the nonce stays in a module closure there.
 *
 * `page` is a random id the window's JS mints once per page load. A registration for the
 * same label under a DIFFERENT page is a previous load of that window (a reload, a crash
 * that rebuilt it) whose listeners are gone — it is dropped here, or it would keep answering
 * "this project lives in that window" for a project the reloaded window may not hold.
 */
export function registerWindow(vault: string, label: string, page = ''): string {
  if (page) {
    for (const [n, w] of windows) if (w.label === label && w.page && w.page !== page) windows.delete(n);
  }
  const nonce = randomBytes(16).toString('hex');
  windows.set(nonce, { vault, label, page, registeredAt: Date.now() });
  // Bounded: a long session opens and closes many windows. Oldest first.
  if (windows.size > 200) {
    const oldest = [...windows.entries()].sort((a, b) => a[1].registeredAt - b[1].registeredAt)[0];
    if (oldest) windows.delete(oldest[0]);
  }
  return nonce;
}

/** A project instance went away (its tab closed or went cold): its nonce answers nothing. */
export function releaseWindowNonce(nonce: string): boolean {
  return windows.delete(nonce);
}

/**
 * Every window label that holds a live instance of `vault`, newest registration first.
 *
 * THE AUTHORITATIVE ANSWER to "is this project already open?". The browser-side window
 * registry is a localStorage heartbeat, and macOS throttles the timers of a window that sits
 * behind other apps, so its row can go stale while the project is plainly open in a tab —
 * which is how the notch used to conclude "not open" and build a second window for it.
 * A registration here lives exactly as long as the instance that made it.
 */
export function windowLabelsForVault(vault: string): string[] {
  const labels: string[] = [];
  for (const w of [...windows.values()].reverse()) {
    if (w.vault === vault && !labels.includes(w.label)) labels.push(w.label);
  }
  return labels;
}

export function windowVault(nonce: string): string | null {
  return windows.get(nonce)?.vault ?? null;
}

/** Test-only reset. */
export function _resetRelay(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  windows.clear();
}
