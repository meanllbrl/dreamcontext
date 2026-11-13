/**
 * Who is a known inviter (app-ux-genel plan r2 S2). An invitation is outside input: anyone on
 * GitHub can invite anyone to a repo carrying the app topic. Only a KNOWN inviter gets the easy
 * paths (the Apps rail dot, a single-name match proceeding, the "from your team" wording);
 * an unknown one is always shown apart, said as "tanımadığın bir GitHub hesabı".
 *
 * Known, computed here and nowhere else:
 * - the collaborators (and owner) of this brain's own GitHub repo, when it has one;
 * - the owners of apps already installed from a share, in any project on this Mac;
 * - everyone with access to, or a pending invitation to, an app this account published.
 *
 * Every read that fails leaves its logins out: a failure makes people unknown, never known
 * (fail toward the card). The result is cached with the shared list's lifetime.
 */

import { execFileSync } from 'node:child_process';
import { listApps } from '../registry.js';
import type { AppHost, Invitation } from './host.js';

const TTL_MS = 15 * 60_000;
const cache = new Map<string, { at: number; logins: Set<string> }>();
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

export function clearInvitersCache(): void { cache.clear(); }

/** `owner/repo` of the project's GitHub remote (the brain's own repo), or null. */
export function githubRepoOf(projectRoot: string): string | null {
  let out = '';
  try {
    out = execFileSync('git', ['-C', projectRoot, 'remote', '-v'], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  for (const line of out.split('\n')) {
    const m = /github\.com[:/]([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\s/.exec(`${line} `);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

export interface KnownInput {
  host: AppHost;
  home: string;
  /** The project the Apps page or the agent works in (its brain repo is read). */
  projectRoot: string;
  login: string;
  /** My own published apps (`owner/repo`), from the shared list. */
  mine?: readonly string[];
}

/** The lowercase logins this account works with. */
export async function knownInviters(input: KnownInput): Promise<Set<string>> {
  const key = `${input.host.kind}:${input.login}:${input.projectRoot}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.logins;
  const out = new Set<string>();
  const add = (l: string | null | undefined) => { if (l && LOGIN_RE.test(l)) out.add(l.toLowerCase()); };
  try {
    for (const a of listApps(input.home)) if (a.origin === 'installed') add(a.source?.owner ?? a.provenance?.fullName.split('/')[0]);
  } catch { /* no registry: nobody from here */ }
  const brain = githubRepoOf(input.projectRoot);
  if (brain) {
    add(brain.split('/')[0]);
    try { const p = await input.host.repoPeople(brain); p.collaborators.forEach(add); } catch { /* unreadable: nobody from here */ }
  }
  for (const repo of (input.mine ?? []).slice(0, 20)) {
    try { const p = await input.host.repoPeople(repo); p.collaborators.forEach(add); p.pending.forEach(add); } catch { /* skip that repo */ }
  }
  out.delete(input.login.toLowerCase());
  cache.set(key, { at: Date.now(), logins: out });
  return out;
}

/** An invitation as the screens and the agent see it: known or not, said once, here. */
export interface MarkedInvitation extends Invitation {
  known: boolean;
  /** The repo name made readable ("hava-notu-app" → "Hava notu"), until its manifest can be read. */
  title: string;
}

/** "hava-notu-app" → "Hava notu": strip `-app`, hyphens and underscores to spaces, first letter up. */
export function prettyRepoName(fullName: string): string {
  const repo = fullName.split('/')[1] ?? fullName;
  const words = repo.replace(/[-_]app$/i, '').replace(/[-_.]+/g, ' ').trim();
  if (!words) return repo;
  return words.charAt(0).toLocaleUpperCase('tr') + words.slice(1);
}

export function markInvitations(list: readonly Invitation[], known: Set<string>): MarkedInvitation[] {
  return list.map((i) => ({ ...i, known: !!i.inviter && known.has(i.inviter.toLowerCase()), title: prettyRepoName(i.fullName) }));
}

/** The words every surface uses for an inviter nobody here works with. */
export const UNKNOWN_INVITER_TR = 'tanımadığın bir GitHub hesabı';
