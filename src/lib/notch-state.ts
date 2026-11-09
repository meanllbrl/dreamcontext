import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listVaults } from './vaults.js';
import { vaultNameForContextRoot } from './app-link.js';

/**
 * Is the notch on screen right now? Owner, 2026-11-09: "notch açıksa ve bildirim notch'ta
 * gözüken bir bildirimse normalden bildirim gitmemeli". A notice the notch draws (a chat's
 * question or permission, a finish, an agent's post, an app's notice, a Super question) must
 * not ALSO arrive as a macOS banner while the notch is up: he got it twice.
 *
 * THE SHELL IS THE SOURCE, never a setting. The desktop shell (desktop/src-tauri/src/
 * assistant.rs `write_notch_state`) asks the notch panel itself (`NSWindow.isVisible`) on
 * every show and hide and every NOTCH_BEAT_MS, and writes `{visible, at}` here. A setting
 * ("notch enabled") can say on while the panel is hidden or the app is quit; this cannot,
 * because a file nobody refreshes goes stale.
 *
 * Every process reads it (the server, the automation runner under launchd, the CLI), which
 * is why it is a file and not server memory.
 *
 * UNKNOWN SENDS THE BANNER (better twice than never): no file, junk, a beat older than
 * NOTCH_STATE_TTL_MS (the app quit or crashed), or a time from the future. Only a fresh
 * `visible: true` holds a banner back.
 */

/** How often the shell re-asks the panel (mirrors `NOTCH_BEAT` in assistant.rs). */
export const NOTCH_BEAT_MS = 5_000;
/** A beat older than this is not believed: three missed beats means the shell is gone. */
export const NOTCH_STATE_TTL_MS = 15_000;
/** Clock skew tolerated on a beat stamped ahead of this process. */
const FUTURE_SLACK_MS = 5_000;

export type NotchState = 'open' | 'closed' | 'unknown';

export function notchStatePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'notch-state.json');
}

/** The notch as the shell last saw it, or `unknown` when that report cannot be believed. */
export function readNotchState(home: string = homedir(), now: number = Date.now()): NotchState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(notchStatePath(home), 'utf-8'));
  } catch {
    return 'unknown';
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'unknown';
  const { visible, at } = raw as { visible?: unknown; at?: unknown };
  if (typeof visible !== 'boolean' || typeof at !== 'number' || !Number.isFinite(at)) return 'unknown';
  if (at > now + FUTURE_SLACK_MS || now - at > NOTCH_STATE_TTL_MS) return 'unknown';
  return visible ? 'open' : 'closed';
}

/**
 * THE RULE. True when the macOS banner must be held back: the notice is one the notch draws
 * (`notchShows`, the caller's knowledge) AND the notch is on screen. A notice the notch does
 * not draw, a hidden notch, or an unknown state all let the banner go.
 */
export function notchCoversBanner(notchShows: boolean | undefined, state: NotchState): boolean {
  return notchShows === true && state === 'open';
}

/** {@link notchCoversBanner} against the shell's live report. Never throws. */
export function notchCovers(notchShows: boolean | undefined, home: string = homedir(), now: number = Date.now()): boolean {
  if (notchShows !== true) return false;
  return notchCoversBanner(true, readNotchState(home, now));
}

// ─── Muted agents ───────────────────────────────────────────────────────────────────

/** `~/.dreamcontext/notch-muted.json` — `{ "<project root>": ["<slug>", …] }`, machine-local. */
export function notchMutedPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'notch-muted.json');
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** Never throws: an unreadable file is "nothing muted" (over-notifying beats a silent miss). */
export function readMutedAutomations(home: string = homedir()): Record<string, string[]> {
  const p = notchMutedPath(home);
  if (!existsSync(p)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(p, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string[]> = {};
    for (const [root, slugs] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(slugs)) continue;
      const ok = slugs.filter((s): s is string => typeof s === 'string' && SLUG_RE.test(s));
      if (ok.length) out[root] = [...new Set(ok)];
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Does the notch list this agent's unread posts? Mirrors `unreadAutomationPosts`
 * (src/server/assistant-inbox.ts): only a REGISTERED project's agents, and never a muted one
 *. Anything else is not a notch notice, so
 * its banner goes. Never throws: a doubt answers false (the banner goes).
 */
export function notchListsAgent(contextRoot: string, slug: string, home: string = homedir()): boolean {
  try {
    // Matched on realpath, as every banner link is (a temp dir or a symlinked checkout).
    const name = vaultNameForContextRoot(contextRoot, home);
    const vault = name === null ? undefined : listVaults(home).find((v) => v.name === name);
    if (!vault) return false;
    // The notch's own key: the registered path (`unreadAutomationPosts`, `p.projectRoot`).
    const here = readMutedAutomations(home)[vault.path] ?? [];
    return !here.includes(slug);
  } catch {
    return false;
  }
}
