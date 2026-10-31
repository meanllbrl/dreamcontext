/**
 * Our Codex accounts → T3 Codex instance settings (plan r5 §4b). W1 runs on account #0 only
 * (`~/.codex`, the owner's own `codex login`); W2 adds the rows and the per-tool switch.
 *
 * A non-#0 account is an instance with `homePath: ~/.codex` and `shadowHomePath` set: that alone
 * puts T3's `CodexHomeLayout` into "authOverlay" (credentials private, sessions shared), so every
 * account reports the SAME continuation key and can resume the others' threads. Never
 * `CODEX_HOME` in the environment: that is "direct" mode, with no shared sessions.
 */
import { join } from 'node:path';

export interface CodexInstanceSettings {
  readonly homePath: string;
  readonly shadowHomePath: string;
  /** `-c` overrides only this account needs (file credential store). */
  readonly launchArgs: string;
}

/** Account #0: `~/.codex` itself, the owner's own `codex login`. Never a shadow home. */
export const CODEX_PRIMARY_ID = 'primary';

/** A non-#0 account id: a folder name under `~/.dreamcontext/codex-accounts/`, never `primary`. */
export function isCodexAccountId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && id !== CODEX_PRIMARY_ID;
}

/** The private home of a non-#0 Codex account. */
export function codexAccountHome(home: string, accountId: string): string {
  if (!isCodexAccountId(accountId)) throw new Error(`invalid codex account id: ${accountId}`);
  return join(home, '.dreamcontext', 'codex-accounts', accountId);
}

export function codexInstanceSettings(home: string, accountId: string | null): CodexInstanceSettings {
  const shared = join(home, '.codex');
  if (!accountId || accountId === CODEX_PRIMARY_ID) return { homePath: shared, shadowHomePath: '', launchArgs: '' };
  return {
    homePath: shared,
    shadowHomePath: codexAccountHome(home, accountId),
    launchArgs: `-c 'cli_auth_credentials_store="file"'`,
  };
}
