/**
 * Where an Antigravity account lives (Track T W5). No Effect here: the dashboard server reads this
 * on every Composer open. T3 owns the profile: each account is one T3 instance, and
 * `resolveAntigravityInstanceDirectories` gives every instance its own private `GEMINI_HOME` with
 * file storage (`AGY_ACP_FORCE_FILE_STORAGE`), so there is no folder of ours to lay out.
 * `antigravity-accounts.test.ts` pins this path to T3's own function.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const ANTIGRAVITY_PRIMARY_ID = 'primary';

/** T3's state folder for the bridge (session.ts `bridgeServerConfig`). */
export function t3StateRoot(home: string = homedir()): string {
  return join(home, '.dreamcontext', 't3');
}

/** One account = one T3 instance. A non-#0 id is at most 40 characters, so this fits T3's 64-character slug. */
export function antigravityInstanceId(accountId: string): string {
  return !accountId || accountId === ANTIGRAVITY_PRIMARY_ID ? 'antigravity' : `antigravity-${accountId}`;
}

/** The account's private profile: T3 points `GEMINI_HOME` inside it. */
export function antigravityProfileDir(accountId: string, home: string = homedir()): string {
  const key = createHash('sha256').update(antigravityInstanceId(accountId)).digest('hex');
  return join(t3StateRoot(home), 'state', 'providers', 'antigravity', key);
}

/** Signed in = the agent's token file exists in this account's profile (presence only, never read). */
export function antigravitySignedIn(accountId: string, home: string = homedir()): boolean {
  try {
    return lstatSync(join(antigravityProfileDir(accountId, home), 'antigravity-acp', 'acp_token.json')).isFile();
  } catch {
    return false;
  }
}

/** Installed = T3's managed runtime is active here, or the agent is on PATH (T3's own two routes). */
export function antigravityInstalled(o: { home?: string; path?: string; platform?: string; arch?: string } = {}): boolean {
  const home = o.home ?? homedir();
  const target = `${o.platform ?? process.platform}-${o.arch ?? process.arch}`;
  if (existsSync(join(t3StateRoot(home), 'tools', 'antigravity-acp', target, 'active.json'))) return true;
  return (o.path ?? process.env.PATH ?? '').split(delimiter).some((dir) => !!dir && existsSync(join(dir, 'agy_acp_server.par')));
}
