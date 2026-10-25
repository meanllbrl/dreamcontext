import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { projectKey } from '../local-store.js';
import { safeWriteTarget } from '../vault-read.js';
import { isSafeAutomationSlug } from './slot.js';

/**
 * Global agents (AI Team v2 D1): an agent of the OWNER'S MACHINE rather than of one project.
 *
 * Everything about it stays on this machine and out of every brain:
 *   - its file             `~/.dreamcontext/agents/<slug>.md`
 *   - its memory           `~/.dreamcontext/agents/<slug>/memory/` (`global-memory.ts`)
 *   - its project side     `~/.dreamcontext/agents/<slug>/projects/<projectKey>/` (threads, outputs,
 *                          run lock, run record, cache), keyed by M0's project key
 *
 * Every local project lists it; a session in project X runs with X's folder and context plus the
 * global identity and memory. Whatever X keeps per agent (its run lock, its job slot, its queue,
 * its thread) lives in X's own folder above, so a run in X never waits for one in Y.
 *
 * A project member of the same name (an agent file or anything in the automation slot) wins in
 * that project: there the global agent is not there at all.
 *
 * Imports no store (the stores import this), only the M0 key and the slug rule.
 */

/** The machine registry's bucket for global agents' approvals (`registry.ts`), never a path. */
export const GLOBAL_REGISTRY_KEY = 'global';

/** `~/.dreamcontext/agents`. */
export function globalAgentsDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'agents');
}

function safeSlug(slug: string): string {
  if (!isSafeAutomationSlug(slug)) throw new Error(`Invalid agent slug "${slug}".`);
  return slug;
}

/** `~/.dreamcontext/agents/<slug>.md`. Throws on a slug that is not path-safe. */
export function globalAgentPath(slug: string, home?: string): string {
  return join(globalAgentsDir(home), `${safeSlug(slug)}.md`);
}

/** `~/.dreamcontext/agents/<slug>/`: everything of the agent but its file. */
export function globalAgentHome(slug: string, home?: string): string {
  return join(globalAgentsDir(home), safeSlug(slug));
}

/** `~/.dreamcontext/agents/<slug>/memory/`. */
export function globalMemoryDir(slug: string, home?: string): string {
  return join(globalAgentHome(slug, home), 'memory');
}

/** `~/.dreamcontext/agents/<slug>/projects/<projectKey>/`: what one project keeps of it. */
export function globalProjectDir(slug: string, projectRoot: string, home?: string): string {
  return join(globalAgentHome(slug, home), 'projects', projectKey(projectRoot));
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether the project has a member of this name: an agent file, or anything in the automation slot. */
export function hasProjectMember(contextRoot: string, slug: string): boolean {
  return occupied(join(contextRoot, 'agents', `${slug}.md`)) || occupied(join(contextRoot, 'automations', `${slug}.md`));
}

/** Whether a global agent of this name exists on this machine (a regular file; a link is never one). */
export function globalAgentExists(slug: string, home?: string): boolean {
  return isSafeAutomationSlug(slug) && isRegularFile(globalAgentPath(slug, home));
}

/** Whether `slug` names the global agent in THIS project: it exists, and no project member shadows it. */
export function isGlobalAgentHere(contextRoot: string, slug: string, home?: string): boolean {
  return isSafeAutomationSlug(slug) && !hasProjectMember(contextRoot, slug) && globalAgentExists(slug, home);
}

/** Every global agent's slug, sorted. A link, a folder or an unsafe name is skipped. */
export function listGlobalAgentSlugs(home?: string): string[] {
  let names: string[];
  try {
    names = readdirSync(globalAgentsDir(home));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.slice(0, -3))
    .filter((s) => globalAgentExists(s, home))
    .sort();
}

/**
 * Where a project-side file of member `slug` lives: under the global agent's project folder when
 * `slug` is the global agent here, else at the project path given. `projectSide` is the path
 * relative to `<contextRoot>/automations/` (e.g. `threads/<slug>`, `cache/.<slug>.lock`).
 */
export function memberSidePath(contextRoot: string, slug: string, projectSide: string, home?: string): string {
  if (isGlobalAgentHere(contextRoot, slug, home)) return join(globalProjectDir(slug, dirname(contextRoot), home), projectSide);
  return join(contextRoot, 'automations', projectSide);
}

/** Whether `abs` lies inside the global agents folder (the root a safe write is judged against). */
export function underGlobalAgents(abs: string, home?: string): boolean {
  const rel = relative(globalAgentsDir(home), abs);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}

/**
 * `safeWriteTarget` judged against the right root: the global agents folder for a path inside it
 * (a global agent's thread or output), else the brain. Never through a link, never outside.
 */
export function safeMemberWrite(contextRoot: string, abs: string, home?: string): boolean {
  return underGlobalAgents(abs, home) ? safeWriteTarget(globalAgentsDir(home), abs) : safeWriteTarget(contextRoot, abs);
}
