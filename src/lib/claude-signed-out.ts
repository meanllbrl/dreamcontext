import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Accounts a turn found SIGNED OUT (field 2026-10-21: an account's sign-in had lapsed, the app
 * kept opening new sessions on it, super children included, and each one stalled on "/login").
 *
 * The CLI says so on the stream (`error: 'authentication_failed'`, or an API error message that
 * points at `/login`). That observation is written here, per machine, so the next NEW chat opens
 * on a signed-in account (automations/account.ts `chatSpawnAccount`) and a running chat moves to
 * one (agent-chat.ts `onAuthFailed`). It is cleared by a successful turn on that account or a
 * re-login, and it expires on its own after {@link SIGNED_OUT_FOR_MS}: a sign-in done in a
 * terminal, which nothing here observes, is never locked out for long.
 */

export const SIGNED_OUT_FOR_MS = 6 * 60 * 60_000;

export function signedOutFilePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'claude-account-signedout.json');
}

function readAll(home: string): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(signedOutFilePath(home), 'utf-8')) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(raw)) if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
    return out;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, number>, home: string): void {
  const file = signedOutFilePath(home);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* best effort: the next refusal records it again */ }
}

/** The accounts recorded signed out right now (id -> when). */
export function readSignedOut(home: string = homedir(), now: number = Date.now()): Record<string, number> {
  const all = readAll(home);
  for (const [id, at] of Object.entries(all)) if (now - at > SIGNED_OUT_FOR_MS) delete all[id];
  return all;
}

export function recordSignedOut(accountId: string, home: string = homedir(), now: number = Date.now()): void {
  if (!accountId) return;
  writeAll({ ...readSignedOut(home, now), [accountId]: now }, home);
}

/** A turn succeeded on it, or it signed in again. True when there was a record to clear. */
export function clearSignedOut(accountId: string, home: string = homedir()): boolean {
  const all = readAll(home);
  if (!(accountId in all)) return false;
  delete all[accountId];
  writeAll(all, home);
  return true;
}

/**
 * Is this stream frame the CLI saying the account is signed out? The same test the chat surface
 * applies (dashboard chatProtocol `isAuthFailure`), on both spellings of the API-error flag.
 * An unrecognized shape is not a sign-out.
 */
export function isAuthFailureFrame(frame: unknown): boolean {
  if (!frame || typeof frame !== 'object') return false;
  const f = frame as Record<string, unknown>;
  if (f.error === 'authentication_failed') return true;
  if (f.type !== 'assistant' || (f.is_api_error_message !== true && f.isApiErrorMessage !== true)) return false;
  const content = (f.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
    && typeof (b as { text?: unknown }).text === 'string' && /(^|\s)\/login\b/.test((b as { text: string }).text));
}
