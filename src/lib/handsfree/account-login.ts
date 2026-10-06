/**
 * `dreamcontext handsfree account-login [<id>|--all]` (Accounts section, D13).
 *
 * A cloud Claude account signs in with the CLI's own `claude auth login`, run inside the
 * codespace as dcuser into that account's sandbox config dir, exactly like the app's
 * `signInto`. This module ONLY builds (and, from the CLI, launches in the owner's terminal)
 *
 *   gh codespace ssh -c <name> -- -t sudo /opt/dc-hf/entrypoint.sh claude-login <id>
 *
 * `-t` (a pty for the interactive login) is an ssh flag, so it goes AFTER `--`: gh itself
 * rejects it before ("unknown shorthand flag: t", smoke #3).
 *
 * The owner opens the printed URL and pastes the code back into that terminal. Nothing is
 * captured, relayed or stored by dreamcontext; success is judged only by the cloud's
 * `claude auth status --json` (the go summary and the phone's account list show it).
 */
import { spawn } from 'node:child_process';
import { isSafeAccountId, listClaudeAccounts } from '../claude-accounts.js';

const CODESPACE_NAME_RE = /^[A-Za-z0-9-]{1,90}$/;

export class AccountLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountLoginError';
  }
}

/** argv for one account's cloud login (the entrypoint's only interactive subcommand). */
export function accountLoginArgv(codespace: string, accountId: string): string[] {
  if (!CODESPACE_NAME_RE.test(codespace)) throw new AccountLoginError(`bad codespace name ${JSON.stringify(codespace)}`);
  if (!isSafeAccountId(accountId)) throw new AccountLoginError(`bad account id ${JSON.stringify(accountId)}`);
  return ['gh', 'codespace', 'ssh', '-c', codespace, '--', '-t', 'sudo', '/opt/dc-hf/entrypoint.sh', 'claude-login', accountId];
}

/** The same command as one copy-pasteable line (every token is already shell-inert). */
export function accountLoginLine(codespace: string, accountId: string): string {
  return accountLoginArgv(codespace, accountId).join(' ');
}

/** Which account ids to sign in: one (validated against this laptop's registry) or every registered one. */
export function accountIdsFor(selector: { id?: string; all?: boolean }, home?: string): string[] {
  const ids = listClaudeAccounts(home).map((a) => a.id);
  if (selector.all) return ids;
  if (!selector.id) throw new AccountLoginError('name an account id or pass --all');
  if (!ids.includes(selector.id)) throw new AccountLoginError(`no registered Claude account ${JSON.stringify(selector.id)} (known: ${ids.join(', ') || 'none'})`);
  return [selector.id];
}

/**
 * Run the login in the owner's own terminal (stdio inherited: the URL prints there and the
 * code is pasted there). Resolves with gh's exit code; nothing is read from the child.
 */
export function launchAccountLogin(codespace: string, accountId: string, spawnImpl: typeof spawn = spawn): Promise<number> {
  const [cmd, ...args] = accountLoginArgv(codespace, accountId);
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(cmd, args, { stdio: 'inherit' });
    child.on('error', (err) => reject(new AccountLoginError(`could not run gh (${(err as NodeJS.ErrnoException).code ?? err.message}); install the GitHub CLI and run the printed command yourself`)));
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}
