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
import { spawn } from 'node:child_process';
import { antigravityInstalled } from '../../lib/antigravity-accounts.js';
import { nodeTooOldMessage } from '../../lib/t3-bridge/node-floor.js';
import { holdOpen } from '../hold-open.js';
import {
  INSTANCE_PRIMARY_ID, InstanceAccountError, getInstanceAccount, instanceLimitsFor, listInstanceAccounts, newInstanceAccountId,
  noteInstanceAccount, readInstanceUsage, removeInstanceAccount, reorderInstanceAccounts, type InstanceTool,
} from '../../lib/instance-accounts.js';
import { instanceSpawnAccount, probeInstanceReading } from '../../lib/tool-switch.js';
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
  tool: 'codex' | InstanceTool;
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

// ── Accounts that are T3 instances (Track T W5) ──────────────────────────────────────────
// The same panel and the same guards as Codex's routes. A sign-in is T3's Google flow in a short
// child (`t3-account signin`): the first signs in account #0, later ones get a new private
// instance. A row appears only after the sign-in worked.

const SIGNIN_TIMEOUT_MS = 6 * 60_000;
const GOOGLE_PAGE = /^https:\/\/accounts\.google\.com\/[^\s"']+$/;

function instanceAccountsWire(tool: InstanceTool, home: string): ToolAccountWire[] {
  const refusals = readToolRejections(tool, home);
  return listInstanceAccounts(tool, home).map((acc) => {
    const reading = acc.signedIn ? readInstanceUsage(tool, acc.id, home) : null;
    const limits = instanceLimitsFor(reading);
    const refusal = refusals[acc.id];
    return {
      id: acc.id,
      tool,
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

export const instanceAccountsList = (tool: InstanceTool) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (!agentGuard(req, res)) return;
  const home = homedir();
  sendJson(res, 200, { tool, accounts: instanceAccountsWire(tool, home), nextSessionAccountId: instanceSpawnAccount(tool, home), autoSwitch: autoSwitchEnabled(home) });
};

/** Run T3's sign-in for one account, opening the page it prints. Resolves with whether it worked. */
function signInChild(tool: InstanceTool, accountId: string, open: (url: string) => void): Promise<boolean> {
  const deps = codexAccountDeps();
  const cli = deps.cli ?? (process.env.DREAMCONTEXT_CLI || process.argv[1] || '');
  if (!deps.node || !cli) return Promise.reject(new InstanceAccountError('needs_node', nodeTooOldMessage('This tool')));
  return accountChild(deps.node, [cli, 't3-account', 'signin', '--tool', tool, ...(accountId === INSTANCE_PRIMARY_ID ? [] : ['--account', accountId])], deps.env ?? process.env, SIGNIN_TIMEOUT_MS, open);
}

function accountChild(node: string, args: string[], env: NodeJS.ProcessEnv, timeout: number, open: (url: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(node, args, { stdio: ['ignore', 'pipe', 'ignore'], env, timeout });
    let buf = '';
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const page = (JSON.parse(line) as { signInUrl?: unknown }).signInUrl;
          if (typeof page === 'string' && GOOGLE_PAGE.test(page)) open(page);
        } catch { /* not a line of ours */ }
      }
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

const openInBrowser = (url: string): void => {
  const [cmd, ...args] = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler'] : ['xdg-open'];
  try {
    const child = spawn(cmd!, [...args, url], { stdio: 'ignore', detached: true });
    // A missing opener arrives as an event: unheard, it would end the server and every live chat.
    child.on('error', () => undefined);
    child.unref();
  } catch { /* the sign-in times out */ }
};

const signingIn = new Set<InstanceTool>();
let signInForTests: ((tool: InstanceTool, accountId: string) => Promise<boolean>) | null = null;
export function setInstanceSignInForTests(fn: typeof signInForTests): void { signInForTests = fn; }

export const instanceAccountsLogin = (tool: InstanceTool) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (!guard(req, res)) return;
  const home = homedir();
  const body = await parseJsonBody(req);
  // A row whose sign-in stopped working signs in again, in its own profile.
  const asked = typeof body?.id === 'string' ? body.id : '';
  if (asked && !getInstanceAccount(tool, asked, home)) { sendError(res, 422, 'account_error', 'No such account.'); return; }
  const primaryOut = !listInstanceAccounts(tool, home).find((a) => a.primary)?.signedIn;
  const id = asked || (primaryOut ? INSTANCE_PRIMARY_ID : newInstanceAccountId());
  // The install belongs to the picker, whose fix is a job that outlives a page. One request here
  // cannot wait out a download, and a second click must not start a second sign-in.
  if (!antigravityInstalled({ home })) { sendError(res, 409, 'not_installed', 'Install Antigravity from the model picker first.'); return; }
  if (signingIn.has(tool)) { sendError(res, 409, 'signin_running', 'A sign-in is already open in your browser. Finish it first.'); return; }
  signingIn.add(tool);
  holdOpen(req);
  try {
    const worked = await (signInForTests ? signInForTests(tool, id) : signInChild(tool, id, openInBrowser));
    if (!worked) { sendError(res, 422, 'signin_failed', 'The sign-in did not finish.'); return; }
    noteInstanceAccount(tool, id, {}, home);
    clearToolSignedOut(tool, id);
    sendJson(res, 200, { id });
  } catch (err) {
    if (err instanceof InstanceAccountError) sendError(res, err.status, err.code, err.message);
    else sendError(res, 500, 'account_error', 'The account could not be changed.');
  } finally {
    signingIn.delete(tool);
  }
};

export const instanceAccountsRemove = (tool: InstanceTool) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (!guard(req, res)) return;
  const body = await parseJsonBody(req);
  const id = typeof body?.id === 'string' ? body.id : '';
  // Only a registered id ever names a folder for deletion.
  if (!getInstanceAccount(tool, id)) { sendError(res, 422, 'account_error', 'No such account.'); return; }
  try {
    removeInstanceAccount(tool, id);
    clearToolRejection(tool, id);
    clearToolSignedOut(tool, id);
    sendJson(res, 200, { removed: id });
  } catch (err) {
    if (err instanceof InstanceAccountError) sendError(res, err.status, err.code, err.message);
    else sendError(res, 500, 'account_error', 'The account could not be changed.');
  }
};

export const instanceAccountsReorder = (tool: InstanceTool) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (!guard(req, res)) return;
  const body = await parseJsonBody(req);
  const ids = Array.isArray(body?.ids) && body.ids.every((x: unknown) => typeof x === 'string') ? body.ids as string[] : null;
  if (!ids) { sendError(res, 400, 'invalid_ids', 'ids must be an array of account ids.'); return; }
  try {
    sendJson(res, 200, { ids: reorderInstanceAccounts(tool, ids).map((a) => a.id) });
  } catch (err) {
    if (err instanceof InstanceAccountError) sendError(res, err.status, err.code, err.message);
    else sendError(res, 500, 'account_error', 'The account could not be changed.');
  }
};

export const instanceAccountsRefresh = (tool: InstanceTool) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (!guard(req, res)) return;
  const body = await parseJsonBody(req);
  const only = typeof body?.id === 'string' ? body.id : null;
  const accounts = listInstanceAccounts(tool).filter((a) => a.signedIn && (!only || a.id === only));
  if (only && accounts.length === 0) { sendError(res, 422, 'account_error', 'No such account.'); return; }
  const refreshed: string[] = [];
  const failed: { id: string; why: string }[] = [];
  for (const acc of accounts) {
    const out = await probeInstanceReading(tool, acc.id).catch(() => ({ id: acc.id, problem: 'unknown' as const }));
    if (out.problem === 'unknown' || out.problem === 'needs-relogin') failed.push({ id: acc.id, why: out.problem });
    else { refreshed.push(acc.id); clearToolSignedOut(tool, acc.id); }
  }
  sendJson(res, 200, { refreshed, failed });
};
