import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isAgentRequest, isDesktop } from '../desktop.js';
import { isLoopback } from './agent-spawn-shared.js';
import { clearToolRejection, clearToolSignedOut, readToolRejections } from '../../lib/account-switch.js';
import { autoSwitchEnabled } from '../../lib/claude-accounts.js';
import {
  CodexAccountError, CODEX_PRIMARY_ID, adoptCodexAccounts, orphanCodexAccountIds, codexAccountDeps, codexAccountSignedIn, codexPrimaryHidden, codexLimitsFor, getCodexAccount, listCodexAccounts, probeCodexAccount,
  readCodexUsage, removeCodexAccount, reorderCodexAccounts, signInNewCodexAccount, type CodexAccountDeps, type CodexUsageWindow,
} from '../../lib/codex-accounts.js';
import { codexSpawnAccount } from '../../lib/codex-switch.js';
import type { UsageLimitWire } from '../../lib/claude-usage.js';

/**
 * Per-tool account routes (plan r5 §4b, W2): `/api/agent/accounts/<tool>/…`, today for Codex.
 * Each route carries its Claude twin's guard (agent-accounts.ts `guard` / `agentGuard`) and its
 * twin's route-policy class: listing is the phone's too; signing in, adopting and removing are
 * desktop + loopback only and denied to the phone.
 *
 * The sign-in is `codex login` in the new account's own home (codex-accounts.ts): the browser
 * does the ChatGPT OAuth, the CLI writes its own `auth.json`, and nothing here reads, stores,
 * returns or logs a credential or the child's output.
 */

function guard(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isDesktop() || !isLoopback(req)) {
    sendError(res, 403, 'forbidden', 'Account management is available in the desktop app only.');
    return false;
  }
  return true;
}

function agentGuard(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isAgentRequest(req)) {
    sendError(res, 403, 'forbidden', 'Account management is available in the desktop app only.');
    return false;
  }
  return true;
}

const deps = (): CodexAccountDeps => codexAccountDeps();

function sendAccountError(res: ServerResponse, err: unknown): void {
  if (err instanceof CodexAccountError) sendError(res, err.status, err.code, err.message);
  else sendError(res, 500, 'account_error', 'The account could not be changed.');
}

/** One Codex account as Settings and the composer chip draw it. Built field by field. */
export interface ToolAccountWire {
  id: string;
  tool: 'codex';
  email: string;
  planType: string;
  isPrimary: boolean;
  preferred: boolean;
  state: 'ok' | 'needs-relogin';
  /** The chooser's windows (`session` = 5 hours, `weekly`), the same shape Claude rows carry. */
  limits: UsageLimitWire[];
  fetchedAtMs: number | null;
  /** T3's windows as read (monthly and credit windows included), for the Stats screen. */
  windows: CodexUsageWindow[];
  refusedUntil?: number;
  refusedWindow?: 'session' | 'weekly';
}

export function codexAccountsWire(home: string = homedir()): ToolAccountWire[] {
  const refusals = readToolRejections('codex', home);
  return listCodexAccounts(home).map((acc) => {
    const reading = acc.signedIn ? readCodexUsage(acc.id, home) : null;
    const limits = codexLimitsFor(reading);
    const refusal = refusals[acc.id];
    return {
      id: acc.id,
      tool: 'codex',
      email: acc.email,
      planType: acc.planType,
      isPrimary: acc.primary,
      preferred: acc.preferred,
      state: acc.signedIn ? 'ok' : 'needs-relogin',
      limits: limits.limits,
      fetchedAtMs: limits.fetchedAtMs,
      windows: reading?.windows ?? [],
      ...(refusal ? { refusedUntil: refusal.until } : {}),
      ...(refusal && (refusal.window === 'session' || refusal.window === 'weekly') ? { refusedWindow: refusal.window } : {}),
    };
  });
}

/** GET /api/agent/accounts/codex — every Codex account with its identity and cached windows. No probe. */
export async function handleCodexAccountsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!agentGuard(req, res)) return;
  const home = homedir();
  let nextSessionAccountId: string | null = null;
  try { nextSessionAccountId = codexSpawnAccount(home); } catch { /* the panel falls back to the top row */ }
  sendJson(res, 200, {
    tool: 'codex',
    accounts: codexAccountsWire(home),
    nextSessionAccountId,
    autoSwitch: autoSwitchEnabled(home),
    // `~/.codex` left the list but is still signed in: Settings offers it back (adopt).
    primaryHidden: codexPrimaryHidden(home) && codexAccountSignedIn(CODEX_PRIMARY_ID, home),
    // Signed-in folders with no row (a sign-in that outlived its server): the same button brings them in.
    orphans: orphanCodexAccountIds(home).length,
  });
}

/** POST /api/agent/accounts/codex/login — add an account through ChatGPT sign-in in its own home. */
export async function handleCodexAccountsLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  try {
    const acc = await signInNewCodexAccount(deps());
    sendJson(res, 200, { id: acc.id, email: acc.email, planType: acc.planType });
  } catch (err) {
    sendAccountError(res, err);
  }
}

/**
 * POST /api/agent/accounts/codex/adopt — list `~/.codex` (account #0) again after it was removed,
 * and every signed-in account folder the list lost (a sign-in that finished after its server died).
 */
export async function handleCodexAccountsAdopt(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  try {
    const out = await adoptCodexAccounts(deps());
    sendJson(res, 200, out);
  } catch (err) {
    sendAccountError(res, err);
  }
}

/** POST /api/agent/accounts/codex/remove — `{ id }`. Logs out, then deletes the confined home. #0 only leaves the list. */
export async function handleCodexAccountsRemove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  const body = await parseJsonBody(req);
  const id = typeof body?.id === 'string' ? body.id : '';
  // Only a registered id ever names a folder for deletion.
  if (!getCodexAccount(id)) {
    sendError(res, 422, 'account_error', 'No such Codex account.');
    return;
  }
  try {
    await removeCodexAccount(id, deps());
    clearToolRejection('codex', id);
    clearToolSignedOut('codex', id);
    sendJson(res, 200, { removed: id });
  } catch (err) {
    sendAccountError(res, err);
  }
}

/** POST /api/agent/accounts/codex/reorder — `{ ids }`. Top = where new Codex chats start. */
export async function handleCodexAccountsReorder(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  const body = await parseJsonBody(req);
  const ids = Array.isArray(body?.ids) && body.ids.every((x: unknown) => typeof x === 'string') ? body.ids as string[] : null;
  if (!ids) {
    sendError(res, 400, 'invalid_ids', 'ids must be an array of account ids.');
    return;
  }
  try {
    sendJson(res, 200, { ids: reorderCodexAccounts(ids).map((a) => a.id) });
  } catch (err) {
    sendAccountError(res, err);
  }
}

/** POST /api/agent/accounts/codex/refresh — `{ id? }`. Read the windows again (no model call). */
export async function handleCodexAccountsRefresh(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guard(req, res)) return;
  const body = await parseJsonBody(req);
  const only = typeof body?.id === 'string' ? body.id : null;
  const accounts = listCodexAccounts().filter((a) => !only || a.id === only);
  if (only && accounts.length === 0) {
    sendError(res, 422, 'account_error', 'No such Codex account.');
    return;
  }
  const refreshed: string[] = [];
  const failed: { id: string; why: string }[] = [];
  const d = deps();
  for (const acc of accounts) {
    const out = await probeCodexAccount(acc.id, d).catch(() => ({ status: 'unknown' as const }));
    if (out.status === 'ok') { refreshed.push(acc.id); clearToolSignedOut('codex', acc.id); }
    else failed.push({ id: acc.id, why: out.status });
  }
  sendJson(res, 200, { refreshed, failed });
}
