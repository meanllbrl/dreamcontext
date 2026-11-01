/**
 * The accounts of a tool whose accounts are T3 instances (Track T W5): the same register, usage
 * cache and order rules as `codex-accounts.ts`, keyed by tool. Credentials stay in each instance's
 * own folder; this file holds a row per account and never reads a credential.
 *
 * Account #0 (`primary`) is the instance T3 calls by the driver's own name. It is listed even
 * before it signs in, so the picker and Settings have one row to offer a sign-in on.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readToolSignedOut } from './account-switch.js';
import { antigravityProfileDir, antigravitySignedIn } from './antigravity-accounts.js';
import { cleanUsageWindow, codexLimitsFor, type CodexUsageReading } from './codex-accounts.js';
import type { UsageLimitsResponse } from './claude-usage.js';

export type InstanceTool = 'antigravity';
export const INSTANCE_TOOLS: readonly InstanceTool[] = ['antigravity'];
export const INSTANCE_PRIMARY_ID = 'primary';

export function isInstanceTool(tool: string | null | undefined): tool is InstanceTool {
  return (INSTANCE_TOOLS as readonly (string | null | undefined)[]).includes(tool);
}

/** A non-#0 account id: short enough for T3's instance slug, and never `primary`. */
export function isInstanceAccountId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(id) && id !== INSTANCE_PRIMARY_ID;
}

export class InstanceAccountError extends Error {
  constructor(readonly code: string, message: string, readonly status: number = 422) {
    super(message);
  }
}

export interface InstanceAccountRow { id: string; email: string; planType: string; addedAt: number }
export interface InstanceAccount extends InstanceAccountRow {
  tool: InstanceTool;
  primary: boolean;
  preferred: boolean;
  signedIn: boolean;
}

const SIGNED_IN: Record<InstanceTool, (id: string, home: string) => boolean> = {
  antigravity: antigravitySignedIn,
};
const PROFILE: Record<InstanceTool, (id: string, home: string) => string> = {
  antigravity: antigravityProfileDir,
};

const registerFile = (tool: InstanceTool, home: string): string => join(home, '.dreamcontext', `${tool}-accounts.json`);
const usageFile = (tool: InstanceTool, id: string, home: string): string => {
  if (!(id === INSTANCE_PRIMARY_ID || isInstanceAccountId(id))) throw new InstanceAccountError('bad_account_id', 'Not an account id.');
  return join(home, '.dreamcontext', `${tool}-usage`, `${id}.json`);
};

function readRows(tool: InstanceTool, home: string): InstanceAccountRow[] {
  try {
    const raw = JSON.parse(readFileSync(registerFile(tool, home), 'utf-8')) as { accounts?: unknown };
    const seen = new Set<string>();
    const rows: InstanceAccountRow[] = [];
    for (const r of (Array.isArray(raw.accounts) ? raw.accounts : []) as Array<Partial<InstanceAccountRow>>) {
      const id = typeof r?.id === 'string' ? r.id : '';
      if (!(id === INSTANCE_PRIMARY_ID || isInstanceAccountId(id)) || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        email: typeof r.email === 'string' ? r.email.slice(0, 200) : '',
        planType: typeof r.planType === 'string' ? r.planType.slice(0, 40) : '',
        addedAt: typeof r.addedAt === 'number' ? r.addedAt : 0,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

function writeRows(tool: InstanceTool, rows: InstanceAccountRow[], home: string): void {
  const file = registerFile(tool, home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify({ accounts: rows }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

/** Every account, in the owner's order: the top row is where new chats start. */
export function listInstanceAccounts(tool: InstanceTool, home: string = homedir()): InstanceAccount[] {
  const stored = readRows(tool, home);
  const rows = stored.some((r) => r.id === INSTANCE_PRIMARY_ID)
    ? stored
    : [{ id: INSTANCE_PRIMARY_ID, email: '', planType: '', addedAt: 0 }, ...stored];
  // A token the tool refused stays on disk: the signed-out store is what says it no longer works.
  const refused = readToolSignedOut(tool, home);
  return rows.map((r, i) => ({ ...r, tool, primary: r.id === INSTANCE_PRIMARY_ID, preferred: i === 0, signedIn: SIGNED_IN[tool](r.id, home) && !(r.id in refused) }));
}

export function getInstanceAccount(tool: InstanceTool, id: string, home: string = homedir()): InstanceAccount | null {
  return listInstanceAccounts(tool, home).find((a) => a.id === id) ?? null;
}

/** A new account id, with a row only once it signs in (a failed sign-in leaves nothing listed). */
export function newInstanceAccountId(): string {
  return `acct-${randomBytes(4).toString('hex')}`;
}

/** Add a row, or fill in who an existing row turned out to be. */
export function noteInstanceAccount(tool: InstanceTool, id: string, ident: { email?: string; planType?: string }, home: string = homedir()): void {
  const rows = listInstanceAccounts(tool, home).map(({ id: rowId, email, planType, addedAt }) => ({ id: rowId, email, planType, addedAt }));
  const at = rows.findIndex((r) => r.id === id);
  const row = at >= 0 ? rows[at]! : { id, email: '', planType: '', addedAt: Date.now() };
  const next = { ...row, ...(ident.email ? { email: ident.email.slice(0, 200) } : {}), ...(ident.planType ? { planType: ident.planType.slice(0, 40) } : {}) };
  if (at >= 0) rows[at] = next;
  else rows.push(next);
  writeRows(tool, rows, home);
}

export function reorderInstanceAccounts(tool: InstanceTool, ids: string[], home: string = homedir()): InstanceAccount[] {
  const rows = listInstanceAccounts(tool, home);
  if (ids.length !== rows.length || !rows.every((r) => ids.includes(r.id))) {
    throw new InstanceAccountError('bad_order', 'That list does not match the accounts.');
  }
  writeRows(tool, ids.map((id) => {
    const { email, planType, addedAt } = rows.find((r) => r.id === id)!;
    return { id, email, planType, addedAt };
  }), home);
  return listInstanceAccounts(tool, home);
}

/** Drop a non-#0 account: its row, its reading and its private profile (never following a link). */
export function removeInstanceAccount(tool: InstanceTool, id: string, home: string = homedir()): void {
  if (!isInstanceAccountId(id)) throw new InstanceAccountError('primary_account', 'The first account stays. Sign out of it in the tool instead.');
  writeRows(tool, listInstanceAccounts(tool, home).filter((a) => a.id !== id).map(({ id: rowId, email, planType, addedAt }) => ({ id: rowId, email, planType, addedAt })), home);
  rmSync(usageFile(tool, id, home), { force: true });
  rmSync(PROFILE[tool](id, home), { recursive: true, force: true });
}

export function readInstanceUsage(tool: InstanceTool, id: string, home: string = homedir()): CodexUsageReading | null {
  try {
    const raw = JSON.parse(readFileSync(usageFile(tool, id, home), 'utf-8')) as Partial<CodexUsageReading>;
    if (typeof raw.checkedAt !== 'string' || !Array.isArray(raw.windows)) return null;
    return {
      checkedAt: raw.checkedAt,
      windows: raw.windows.map(cleanUsageWindow).filter((w): w is NonNullable<typeof w> => w !== null),
      source: raw.source === 'session' ? 'session' : 'probe',
    };
  } catch {
    return null;
  }
}

export function recordInstanceUsage(tool: InstanceTool, id: string, windows: unknown[], checkedAt: string, home: string = homedir()): CodexUsageReading {
  const reading: CodexUsageReading = {
    checkedAt: Number.isNaN(Date.parse(checkedAt)) ? new Date().toISOString() : checkedAt,
    windows: windows.map(cleanUsageWindow).filter((w): w is NonNullable<typeof w> => w !== null),
    source: 'probe',
  };
  const file = usageFile(tool, id, home);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(reading) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* a reading that cannot be saved is read again next time */ }
  return reading;
}

/** The reading in the chooser's shape: the same mapping as Codex, session and weekly only. */
export const instanceLimitsFor = (reading: CodexUsageReading | null): UsageLimitsResponse => codexLimitsFor(reading);
