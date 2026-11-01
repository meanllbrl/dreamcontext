import { homedir } from 'node:os';
import { codexRules } from '../account-rules.js';
import { readToolRejections } from '../account-switch.js';
import { codexLimitsFor, listCodexAccounts, readCodexUsage } from '../codex-accounts.js';
import { CODEX_PRIMARY_ID } from '../t3-bridge/accounts.js';
import { INSTANCE_PRIMARY_ID, instanceLimitsFor, listInstanceAccounts, readInstanceUsage } from '../instance-accounts.js';
import type { HeadlessTool } from '../t3-bridge/headless-envelope.js';

/** How long an unattended run waits when no reading says when an account frees up. */
const WAIT_WITHOUT_READING_MS = 60 * 60_000;

export type CodexPick = { account: string } | { waitUntil: number } | { none: true };

/**
 * Which Codex account a run goes out on (Track T W4): the same rule Claude's automations follow,
 * for this tool's accounts. In the owner's order, skipping refused accounts; an unattended run
 * also skips any account at or past `agentThreshold` on a known window and waits when none is
 * left. A pinned account is the only one considered. `''` as the account = #0 (`~/.codex`).
 */
export function pickCodexRunAccount(o: {
  pinned?: string;
  unattended?: boolean;
  exclude?: readonly string[];
  home?: string;
  now?: number;
}): CodexPick {
  const home = o.home ?? homedir();
  const now = o.now ?? Date.now();
  const threshold = codexRules(home).agentThreshold;
  const rejected = readToolRejections('codex', home, now);
  const accounts = listCodexAccounts(home).filter((a) => a.signedIn && (!o.pinned || a.id === o.pinned) && !o.exclude?.includes(a.id));
  if (accounts.length === 0) return { none: true };
  let earliest = Infinity;
  for (const a of accounts) {
    const refusal = rejected[a.id];
    if (refusal) { earliest = Math.min(earliest, refusal.until); continue; }
    if (!o.unattended) return { account: a.id };
    const limits = codexLimitsFor(readCodexUsage(a.id, home)).limits.filter((l) => l.percent >= threshold);
    if (limits.length === 0) return { account: a.id };
    earliest = Math.min(earliest, Math.max(...limits.map((l) => l.resetsAt)));
  }
  if (o.unattended) return { waitUntil: Number.isFinite(earliest) ? earliest : now + WAIT_WITHOUT_READING_MS };
  // Attended with every account refused: it goes out and the limit reports itself, as on Claude.
  return { account: accounts[0]!.id };
}

/** The `--account` a run passes: none for #0, whose home is the default. */
export function codexRunAccountArg(id: string): string | null {
  return id && id !== CODEX_PRIMARY_ID ? id : null;
}

/**
 * The same pick for any tool a run can go out on. Antigravity's accounts are its instance
 * accounts (instance-accounts.ts), with their own refusal store and limit readings; the threshold
 * is Codex's (the one switch policy the non-Claude tools share today).
 */
export function pickToolRunAccount(tool: HeadlessTool, o: Parameters<typeof pickCodexRunAccount>[0]): CodexPick {
  if (tool === 'codex') return pickCodexRunAccount(o);
  const home = o.home ?? homedir();
  const now = o.now ?? Date.now();
  const threshold = codexRules(home).agentThreshold;
  const rejected = readToolRejections('antigravity', home, now);
  const accounts = listInstanceAccounts('antigravity', home).filter((a) => a.signedIn && (!o.pinned || a.id === o.pinned) && !o.exclude?.includes(a.id));
  if (accounts.length === 0) return { none: true };
  let earliest = Infinity;
  for (const a of accounts) {
    const refusal = rejected[a.id];
    if (refusal) { earliest = Math.min(earliest, refusal.until); continue; }
    if (!o.unattended) return { account: a.id };
    const limits = instanceLimitsFor(readInstanceUsage('antigravity', a.id, home)).limits.filter((l) => l.percent >= threshold);
    if (limits.length === 0) return { account: a.id };
    earliest = Math.min(earliest, Math.max(...limits.map((l) => l.resetsAt)));
  }
  if (o.unattended) return { waitUntil: Number.isFinite(earliest) ? earliest : now + WAIT_WITHOUT_READING_MS };
  return { account: accounts[0]!.id };
}

/** The `--account` a run passes on `tool`: none for its first account. */
export function toolRunAccountArg(tool: HeadlessTool, id: string): string | null {
  if (tool === 'codex') return codexRunAccountArg(id);
  return id && id !== INSTANCE_PRIMARY_ID ? id : null;
}
