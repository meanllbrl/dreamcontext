/**
 * The kits Codex and Antigravity read, refreshed by the project catch-up (brief-dalga1: no tool
 * waits for a chat to open). A chat still refreshes its own kit as it opens; this is the same
 * code, run for every registered project and every Antigravity account that has a profile:
 *
 *   - Codex: `prepareCodexKit` per project (our skills once, the project's links and roles);
 *   - Antigravity: `syncAntigravitySkills` + `syncAntigravityRoles` per account profile.
 *
 * Cheap when nothing moved: a stamp (`~/.dreamcontext/tool-kits.json`) holds the CLI version and
 * every project's setup version; the work runs only when one of them changed, or after
 * {@link KIT_MAX_AGE_MS} (the owner's own `~/.claude/skills` and agents change by hand). A tool
 * never used on this Mac gets nothing: no `~/.dreamcontext/codex` and no `~/.codex` = no Codex
 * kit; an account with no profile folder = nothing written for it. Never throws.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { antigravityProfileDir } from './antigravity-accounts.js';
import { syncAntigravityRoles } from './antigravity-roles.js';
import { syncAntigravitySkills } from './antigravity-skills.js';
import { codexToolDir, prepareCodexKit } from './codex-skills.js';
import { listInstanceAccounts } from './instance-accounts.js';

export const KIT_MAX_AGE_MS = 6 * 60 * 60_000;

export interface KitProject { readonly path: string; readonly version: string }

export interface KitRefreshResult {
  readonly ran: boolean;
  readonly codexProjects: number;
  readonly antigravityAccounts: number;
  readonly failures: string[];
}

export interface KitRefreshDeps {
  readonly home?: string;
  readonly now?: number;
  /** Tests: the package's folders. */
  readonly packageDir?: (sub: string) => string | null;
  /** Tests: the account ids to refresh. */
  readonly accounts?: () => string[];
}

const isDir = (p: string): boolean => {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
};

export const toolKitsStampPath = (home: string = homedir()): string => join(home, '.dreamcontext', 'tool-kits.json');

function readStamp(home: string): { key: string; at: number } | null {
  try {
    const raw = JSON.parse(readFileSync(toolKitsStampPath(home), 'utf-8')) as { key?: unknown; at?: unknown };
    return typeof raw.key === 'string' && typeof raw.at === 'number' ? { key: raw.key, at: raw.at } : null;
  } catch {
    return null;
  }
}

function writeStamp(home: string, key: string, at: number): void {
  const file = toolKitsStampPath(home);
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ key, at })}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Refresh every kit when the CLI or a project moved, or the last refresh is old. */
export function refreshToolKits(cliVersion: string, projects: readonly KitProject[], deps: KitRefreshDeps = {}): KitRefreshResult {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now();
  const failures: string[] = [];
  const key = JSON.stringify([cliVersion, [...projects].map((p) => `${p.path}@${p.version}`).sort()]);
  const stamp = readStamp(home);
  if (stamp && stamp.key === key && now - stamp.at < KIT_MAX_AGE_MS) return { ran: false, codexProjects: 0, antigravityAccounts: 0, failures };
  let codexProjects = 0;
  let antigravityAccounts = 0;
  try {
    if (isDir(codexToolDir(home)) || isDir(join(home, '.codex'))) {
      for (const p of projects) {
        if (!existsSync(p.path)) continue;
        const kit = prepareCodexKit({ home, cwd: p.path, ...(deps.packageDir ? { packageDir: deps.packageDir } : {}) });
        if (!kit.skills.ok) failures.push(`codex ${p.path}: ${kit.skills.reason}`);
        codexProjects += 1;
      }
    }
  } catch (err) {
    failures.push(`codex: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
  try {
    const ids = deps.accounts ? deps.accounts() : listInstanceAccounts('antigravity', home).map((a) => a.id);
    for (const id of ids) {
      // A profile is made by a sign-in or a chat; an account with neither gets nothing written.
      if (!isDir(antigravityProfileDir(id, home))) continue;
      const opts = { home, ...(deps.packageDir ? { packageDir: deps.packageDir } : {}) };
      const skills = syncAntigravitySkills(id, opts);
      const roles = syncAntigravityRoles(id, opts);
      if (!skills.ok) failures.push(`antigravity ${id} skills: ${skills.reason}`);
      if (!roles.ok) failures.push(`antigravity ${id} roles: ${roles.reason}`);
      antigravityAccounts += 1;
    }
  } catch (err) {
    failures.push(`antigravity: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
  // A failure is retried on the next check, not after the max age.
  try { if (failures.length === 0) writeStamp(home, key, now); } catch { /* retried next time */ }
  return { ran: true, codexProjects, antigravityAccounts, failures };
}
