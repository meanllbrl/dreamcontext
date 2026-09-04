import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { isLoopback } from './agent-spawn-shared.js';
import { executeClaudeDetached } from '../../lib/automations/runner.js';
import {
  ClaudeAccountError,
  accountIdFromEmail,
  accountEnvFor,
  autoSwitchEnabled,
  isSafeAccountId,
  listClaudeAccounts,
  removeClaudeAccount,
  resolveConfigDir,
  sandboxDirFor,
  setAutoSwitchEnabled,
  setPreferredClaudeAccount,
  upsertClaudeAccount,
} from '../../lib/claude-accounts.js';
import { ensureSandbox, sandboxHasIdentity } from '../../lib/claude-account-sandbox.js';
import { claudeAuthStatus } from '../../lib/claude-auth.js';
import { readUsageLimits, type UsageLimitWire } from '../../lib/claude-usage.js';

/**
 * The multi-account surface: list the accounts, add one through the CLI's OWN OAuth flow,
 * mark a preferred one, remove one, and toggle auto-switch.
 *
 * ── The token is never handled ────────────────────────────────────────────────────────
 * Signing in is `claude auth login` spawned with the NEW account's sandbox environment. The
 * browser does the OAuth, the CLI writes its own credential into its own directory, and this
 * process never sees, stores, displays or asks anyone to paste a token. Because the sandbox
 * has its own `CLAUDE_CONFIG_DIR`, the real `~/.claude` is never disturbed either — which is
 * what made the separate "sign in from Settings" task collapse into this one.
 *
 * ── The login child's output is DISCARDED on all three legs ───────────────────────────
 * `executeClaudeDetached` normally buffers the child's full stdout, and other callers in that
 * file write that buffer to disk. An interactive OAuth flow's stdout can carry a callback URL
 * bearing an authorization code. So the login spawn sets `discardOutput`, and this route
 * writes it to NO file, puts it in NO response, and hands it to NO logger. The only thing that
 * comes back is a boolean plus a fresh `claudeAuthStatus(configDir)` reading.
 *
 * Desktop + loopback only, like every other agent-spawn surface.
 */

/** How long an interactive sign-in may take before the child is killed. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** One account as the Settings list draws it. Built field by field — no blob is spread. */
interface AccountWire {
  id: string;
  email: string;
  organizationName: string;
  tier: string;
  preferred: boolean;
  /** True for account #0 — the one signed in to the real `~/.claude`. */
  isPrimary: boolean;
  /**
   * `ok` — usable. `needs-relogin` — its credential is gone; the UI says "sign in again"
   * rather than showing an ambiguous blank row.
   */
  state: 'ok' | 'needs-relogin';
  /** The account's cached limits. Empty when there is nothing cached yet. */
  limits: UsageLimitWire[];
  /** When the CLI last refreshed that cache, so a stale reading can be labelled. */
  fetchedAtMs: number | null;
}

function guard(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isDesktop() || !isLoopback(req)) {
    sendError(res, 403, 'forbidden', 'Account management is available in the desktop app only.');
    return false;
  }
  return true;
}

/**
 * GET /api/agent/accounts — every registered account with its identity and limit state.
 *
 * Reads each account's OWN cache (`<configDir>/.claude.json`), which is why a non-active
 * account's limits are visible without switching to it. Deliberately does NOT probe: the list
 * renders instantly from what the CLI already cached, and probing N accounts on every page
 * paint would be a spawn storm. A caller who wants fresh numbers asks for a refresh.
 */
export async function handleAgentAccountsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  const home = homedir();
  const accounts = listClaudeAccounts(home);

  const wire: AccountWire[] = accounts.map((acc) => {
    const dir = acc.configDir ?? home;
    const hasIdentity = sandboxHasIdentity(dir, home);
    let limits: UsageLimitWire[] = [];
    let fetchedAtMs: number | null = null;
    if (hasIdentity) {
      const reading = readUsageLimits(dir);
      limits = reading.limits;
      fetchedAtMs = reading.fetchedAtMs;
    }
    return {
      id: acc.id,
      email: acc.email,
      organizationName: acc.organizationName,
      tier: acc.tier,
      preferred: acc.preferred,
      isPrimary: acc.configDir === null,
      state: hasIdentity ? 'ok' : 'needs-relogin',
      limits,
      fetchedAtMs,
    };
  });

  sendJson(res, 200, { accounts: wire, autoSwitch: autoSwitchEnabled(home) });
}

/**
 * POST /api/agent/accounts/adopt — register the account already signed in to `~/.claude`.
 *
 * Account #0 exists before this feature does, so it is ADOPTED rather than added: nothing is
 * moved, nothing is copied, and no sign-in is asked for. `configDir: null` records that its
 * credential store is the real HOME.
 */
export async function handleAgentAccountsAdopt(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  const status = await claudeAuthStatus();
  if (status.loggedIn !== true || !status.email) {
    sendError(res, 409, 'not_signed_in', 'No account is signed in to this machine yet — sign in first, then add it.');
    return;
  }
  const id = accountIdFromEmail(status.email);
  if (!isSafeAccountId(id)) {
    sendError(res, 422, 'bad_account_id', 'Could not derive a usable id from that account.');
    return;
  }
  const existing = listClaudeAccounts();
  const account = upsertClaudeAccount({
    id,
    accountUuid: '',            // filled by the watcher's fingerprint on the next real read
    email: status.email,
    organizationUuid: status.orgId ?? '',
    organizationName: status.orgId ?? '',
    tier: status.subscription ?? '',
    configDir: null,
    // The first account registered becomes the preferred one — otherwise the very first
    // session after adoption would have no default to start on.
    preferred: existing.length === 0,
  });
  sendJson(res, 200, { id: account.id, email: account.email });
}

/**
 * POST /api/agent/accounts/login — add an account by running the CLI's own OAuth flow into a
 * fresh sandbox.
 *
 * The id is derived from the email the user gives, so the sandbox has a stable, readable
 * directory name. A half-finished login leaves an UNREGISTERED sandbox; the next attempt
 * reuses it, and it is otherwise inert.
 */
export async function handleAgentAccountsLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  const body = await parseJsonBody(req);
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (!email || !email.includes('@')) {
    sendError(res, 422, 'email_required', 'An email address is needed to name the new account.');
    return;
  }
  const id = accountIdFromEmail(email);
  if (!isSafeAccountId(id)) {
    sendError(res, 422, 'bad_account_id', 'Could not derive a usable account id from that email.');
    return;
  }
  if (listClaudeAccounts().some((a) => a.id === id)) {
    sendError(res, 409, 'already_connected', 'That account is already connected.');
    return;
  }

  const configDir = sandboxDirFor(id);
  try {
    ensureSandbox(configDir);
  } catch (err) {
    sendError(res, 409, 'sandbox_blocked', (err as Error).message);
    return;
  }

  // `claude auth login` in THIS sandbox. Output discarded — see the module header.
  const execution = await executeClaudeDetached(['auth', 'login'], {
    cwd: homedir(),
    env: accountEnvFor(configDir),
    discardOutput: true,
    timeoutMs: LOGIN_TIMEOUT_MS,
  });

  if (!execution.spawned) {
    sendError(res, 500, 'spawn_failed', 'Could not start the sign-in — the Claude CLI did not launch.');
    return;
  }
  if (execution.timedOut) {
    sendError(res, 504, 'login_timeout', 'The sign-in timed out. Nothing was saved; you can try again.');
    return;
  }

  // Did it actually work? Ask the authoritative judge about THAT directory — the exit code is
  // not the criterion here either.
  const status = await claudeAuthStatus(configDir);
  if (status.loggedIn !== true) {
    sendError(res, 409, 'login_incomplete', 'The sign-in did not complete. Nothing was saved; you can try again.');
    return;
  }

  const account = upsertClaudeAccount({
    id,
    accountUuid: '',
    email: status.email ?? email,
    organizationUuid: status.orgId ?? '',
    organizationName: status.orgId ?? '',
    tier: status.subscription ?? '',
    configDir,
    preferred: false,
  });
  // Never the token, never the child's output: an id, an email, and the org.
  sendJson(res, 200, {
    id: account.id,
    email: account.email,
    organizationName: account.organizationName,
    tier: account.tier,
  });
}

/** POST /api/agent/accounts/preferred — `{ id }`. New sessions start on this account. */
export async function handleAgentAccountsPreferred(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  const body = await parseJsonBody(req);
  const id = typeof body?.id === 'string' ? body.id : '';
  try {
    setPreferredClaudeAccount(id);
  } catch (err) {
    sendError(res, err instanceof ClaudeAccountError ? 422 : 500, 'account_error', (err as Error).message);
    return;
  }
  sendJson(res, 200, { id });
}

/** POST /api/agent/accounts/remove — `{ id }`. Drops the row and deletes the sandbox. */
export async function handleAgentAccountsRemove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  const body = await parseJsonBody(req);
  const id = typeof body?.id === 'string' ? body.id : '';
  try {
    // Through the gate first: it refuses an unregistered id, so a stray slug can never name a
    // directory for deletion.
    resolveConfigDir(id);
    removeClaudeAccount(id);
  } catch (err) {
    sendError(res, err instanceof ClaudeAccountError ? 422 : 500, 'account_error', (err as Error).message);
    return;
  }
  sendJson(res, 200, { removed: id });
}

/** POST /api/agent/accounts/auto-switch — `{ enabled }`. Off means REPORT, never change. */
export async function handleAgentAccountsAutoSwitch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  const body = await parseJsonBody(req);
  if (typeof body?.enabled !== 'boolean') {
    sendError(res, 422, 'bad_request', '`enabled` must be true or false.');
    return;
  }
  setAutoSwitchEnabled(body.enabled);
  sendJson(res, 200, { autoSwitch: body.enabled });
}
