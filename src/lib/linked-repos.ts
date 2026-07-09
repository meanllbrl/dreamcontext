import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { readSetupConfig, updateSetupConfig, type LinkedRepo } from './setup-config.js';
import { canonicalRemote, parseRepoSlug, sanitizeRepoName } from './git-sync/origin-setup.js';
import { withGitCredentials } from './git-sync/credentials.js';
import { resolveBrainSyncToken } from './git-sync/brain-repo.js';
import type { ResolvedToken } from './task-backend/secrets.js';
import * as git from './git-sync/git.js';

/**
 * Linked repos — one shared brain governs bare CODE repos (products) that have
 * NO `_dream_context/` of their own. Two layers:
 *
 *  1. SHARED (pushed): `SetupConfig.linkedRepos: [{name, gitRemoteUrl}]` in
 *     `.config.json` — travels with the team. NO path (setup-config.ts).
 *  2. MACHINE-GLOBAL (never leaves this machine): `~/.dreamcontext/linked-repos.json`,
 *     a `{ repos: Record<canonicalUrl, absPath> }` registry KEYED BY CANONICAL
 *     GitHub URL (globally unique across ALL projects) → the repo's local path on
 *     THIS machine.
 *
 * File mechanics (home location, atomic temp+rename, never-throw read,
 * sanitize-on-read) mirror `vaults.ts` / `connections.ts`. The SCHEMA does NOT —
 * it is url-keyed, never name-keyed (a name is only a per-project label).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** On-disk shape of `~/.dreamcontext/linked-repos.json`. Keyed by canonical URL. */
export interface LinkedRepoRegistry {
  repos: Record<string, string>;
}

/** One resolved linked repo for a project on THIS machine (config entry + local presence). */
export interface ResolvedLinkedRepo {
  /** Per-project label from the shared config. */
  name: string;
  /** Canonical GitHub URL (the registry key + display value). */
  gitRemoteUrl: string;
  /** True iff the registry maps this URL AND that path exists on disk. */
  present: boolean;
  /** The resolved absolute path when present, else null. */
  path: string | null;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class LinkedRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkedRepoError';
  }
}

// ─── Paths ────────────────────────────────────────────────────────────────────

/** Path to the machine-global registry. Injectable `home` for testability. */
export function linkedReposFilePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'linked-repos.json');
}

// ─── Registry read (never throws) ───────────────────────────────────────────────

/**
 * Read the url→path map. Missing file ⇒ `{}`; malformed JSON ⇒ `{}` + a logged
 * notice; entries whose key or value is not a string, or whose path is not
 * absolute, are filtered out. NEVER throws (a corrupt machine-global file must
 * never break a session-start glance).
 */
export function readLinkedRepoRegistry(home?: string): Record<string, string> {
  const filePath = linkedReposFilePath(home);
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<LinkedRepoRegistry>;
    if (!parsed || typeof parsed !== 'object' || parsed.repos === null || typeof parsed.repos !== 'object' || Array.isArray(parsed.repos)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [url, path] of Object.entries(parsed.repos as Record<string, unknown>)) {
      if (typeof url === 'string' && url.length > 0 && typeof path === 'string' && isAbsolute(path)) {
        out[url] = path;
      }
    }
    return out;
  } catch {
    console.error('[dreamcontext] linked-repos.json is malformed — treating registry as empty.');
    return {};
  }
}

// ─── Registry write (atomic temp+rename, pid+nonce) ─────────────────────────────

/**
 * Persist the url→path map atomically: serialise to a sibling temp file
 * (pid + random nonce in the name so two writers never pick the same scratch
 * path), then `rename` it over the target. A reader never observes a half-written
 * file, and two interleaved writes can never corrupt it.
 */
export function writeLinkedRepoRegistry(repos: Record<string, string>, home?: string): void {
  const filePath = linkedReposFilePath(home);
  mkdirSync(dirname(filePath), { recursive: true });
  const registry: LinkedRepoRegistry = { repos };
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  renameSync(tmp, filePath);
}

// ─── Registry accessors (keyed by canonical URL) ────────────────────────────────

export function getLinkedRepoPath(url: string, home?: string): string | null {
  return readLinkedRepoRegistry(home)[url] ?? null;
}

export function setLinkedRepoPath(url: string, absPath: string, home?: string): void {
  const repos = readLinkedRepoRegistry(home);
  repos[url] = absPath;
  writeLinkedRepoRegistry(repos, home);
}

export function removeLinkedRepoPath(url: string, home?: string): boolean {
  const repos = readLinkedRepoRegistry(home);
  if (!(url in repos)) return false;
  delete repos[url];
  writeLinkedRepoRegistry(repos, home);
  return true;
}

// ─── deriveRemoteUrl ────────────────────────────────────────────────────────────

/**
 * The canonical URL of a repo's `origin` on disk, or null when there is no
 * `origin` or it is not a canonicalizable GitHub URL. Injectable git module.
 */
export function deriveRemoteUrl(path: string, gitModule: Pick<typeof git, 'getRemoteUrl'> = git): string | null {
  const origin = gitModule.getRemoteUrl(path, 'origin');
  return origin ? canonicalRemote(origin) : null;
}

// ─── resolveLinkedRepos (HOT-PATH SAFE — no net/git) ───────────────────────────

/**
 * Resolve this project's shared `linkedRepos` against the machine-global
 * registry, reporting present/missing + the resolved path. Reads ONLY local
 * files (`readSetupConfig` + the registry + `existsSync`) — NO network, NO git —
 * so it is safe on the session-start hot path.
 */
export function resolveLinkedRepos(projectRoot: string, home?: string): ResolvedLinkedRepo[] {
  const entries = readSetupConfig(projectRoot)?.linkedRepos ?? [];
  const registry = readLinkedRepoRegistry(home);
  return entries.map((entry) => {
    // Render the canonical URL even if the config stored a non-canonical form.
    const canon = canonicalRemote(entry.gitRemoteUrl) ?? entry.gitRemoteUrl;
    const mapped = registry[canon];
    const present = typeof mapped === 'string' && existsSync(mapped);
    return {
      name: entry.name,
      gitRemoteUrl: canon,
      present,
      path: present ? mapped : null,
    };
  });
}

// ─── linkRepo ───────────────────────────────────────────────────────────────────

export interface LinkRepoOptions {
  /** Explicit canonical-able URL — required when the local repo has no `origin` (S3 escape hatch). */
  url?: string;
  home?: string;
  gitModule?: Pick<typeof git, 'isGitRepo' | 'getRemoteUrl'>;
}

/**
 * Bind a local path to a linked repo: writes `{name, gitRemoteUrl}` (ALWAYS
 * canonical, NO path) to `.config.json` AND `canonicalUrl → absPath` to the home
 * registry. Safety (S3): the path must exist, be a directory, be a git repo, and
 * — when it has an `origin` — that origin's canonical URL must equal the
 * entry/`--url` canonical URL. `--url` is the escape hatch for an origin-less
 * repo; a non-canonicalizable `--url` is rejected, never stored.
 */
export function linkRepo(projectRoot: string, name: string, path: string, opts: LinkRepoOptions = {}): LinkedRepo {
  const gitModule = opts.gitModule ?? git;
  const abs = resolve(path);

  if (!existsSync(abs)) throw new LinkedRepoError(`Path does not exist: ${abs}`);
  if (!statSync(abs).isDirectory()) throw new LinkedRepoError(`Path is not a directory: ${abs}`);
  if (!gitModule.isGitRepo(abs)) throw new LinkedRepoError(`Path is not a git repo: ${abs}`);

  const originUrl = gitModule.getRemoteUrl(abs, 'origin');
  const localCanon = originUrl ? canonicalRemote(originUrl) : null;

  let entryCanon: string;
  if (opts.url) {
    const urlCanon = canonicalRemote(opts.url);
    if (!urlCanon) throw new LinkedRepoError(`--url is not a GitHub repo URL: ${opts.url}`);
    // When the local repo HAS a canonicalizable origin, it must match the URL.
    if (localCanon && localCanon !== urlCanon) {
      throw new LinkedRepoError(
        `origin mismatch: the repo at ${abs} points at ${localCanon}, not ${urlCanon}.`,
      );
    }
    entryCanon = urlCanon;
  } else {
    if (!localCanon) {
      throw new LinkedRepoError(
        `Could not read a GitHub origin from ${abs}. Pass --url <owner/repo> to bind it explicitly.`,
      );
    }
    entryCanon = localCanon;
  }

  // Name-collision guard: the same label may not point at a DIFFERENT repo.
  const existing = readSetupConfig(projectRoot)?.linkedRepos ?? [];
  const collision = existing.find(
    (r) => r.name === name && (canonicalRemote(r.gitRemoteUrl) ?? r.gitRemoteUrl) !== entryCanon,
  );
  if (collision) {
    throw new LinkedRepoError(
      `A different repo is already linked as "${name}" (${collision.gitRemoteUrl}). Unlink it first.`,
    );
  }

  const entry: LinkedRepo = { name, gitRemoteUrl: entryCanon };
  const nextRepos = [...existing.filter((r) => r.name !== name), entry];
  updateSetupConfig(projectRoot, { linkedRepos: nextRepos });
  setLinkedRepoPath(entryCanon, abs, opts.home);
  return entry;
}

// ─── unlinkRepo ─────────────────────────────────────────────────────────────────

/**
 * Remove the SHARED config entry by name. LEAVES the machine-global registry
 * mapping intact (the local path is still valid — re-linking should not re-clone).
 * Returns true if an entry was removed.
 */
export function unlinkRepo(projectRoot: string, name: string): boolean {
  const existing = readSetupConfig(projectRoot)?.linkedRepos ?? [];
  const next = existing.filter((r) => r.name !== name);
  if (next.length === existing.length) return false;
  updateSetupConfig(projectRoot, { linkedRepos: next });
  return true;
}

// ─── cloneLinkedRepo (trust-gated; every gate BEFORE any git call) ─────────────

export interface CloneLinkedRepoOptions {
  /** Parent directory override for the clone destination (default: `dirname(projectRoot)`). */
  dir?: string;
  /** Trust gate — the team-writable URL requires an explicit confirmation. */
  confirmed?: boolean;
  home?: string;
  /** Injectable for tests — only its `clone` is used. */
  gitModule?: Pick<typeof git, 'clone'>;
  /** Injectable token resolver for tests. */
  resolveToken?: (projectRoot: string) => ResolvedToken | null;
}

/**
 * Clone a MISSING linked repo behind a trust gate. The stored URL is
 * team-writable (any teammate can set it in the shared config), so EVERY gate
 * runs before any git call, in this exact order:
 *
 *  1. find the config entry by name (throw if absent);
 *  2. S1 — `parseRepoSlug(url)` null ⇒ HARD throw BEFORE any git; rebuild
 *     `cloneUrl = canonicalRemote(url)` so the raw string never reaches git;
 *  3. S2 — `base = sanitizeRepoName(slug.repo)` (null ⇒ throw), then assert the
 *     destination is a direct child of the resolved parent (guards `--dir` too);
 *  4. refuse if the destination already exists;
 *  5. require `confirmed === true`;
 *  6. resolve a GitHub token (throw if none);
 *  7. clone under `withGitCredentials` using the CANONICAL url;
 *  8. record `canonicalUrl → dest` in the home registry.
 */
export async function cloneLinkedRepo(projectRoot: string, name: string, opts: CloneLinkedRepoOptions = {}): Promise<string> {
  const gitModule = opts.gitModule ?? git;
  const resolveToken = opts.resolveToken ?? resolveBrainSyncToken;

  // 1) find entry
  const entries = readSetupConfig(projectRoot)?.linkedRepos ?? [];
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new LinkedRepoError(`No linked repo named "${name}".`);

  // 2) S1 — reject non-GitHub / RCE-shaped URLs BEFORE any git; rebuild canonical.
  const slug = parseRepoSlug(entry.gitRemoteUrl);
  if (!slug) {
    throw new LinkedRepoError(
      `Refusing to clone "${name}": ${entry.gitRemoteUrl} is not a GitHub repo URL.`,
    );
  }
  const cloneUrl = canonicalRemote(entry.gitRemoteUrl);
  if (!cloneUrl) {
    throw new LinkedRepoError(`Refusing to clone "${name}": could not build a safe URL.`);
  }

  // 3) S2 — sanitized folder name + containment (a direct child of the parent).
  const base = sanitizeRepoName(slug.repo);
  if (!base) throw new LinkedRepoError(`Refusing to clone "${name}": no safe folder name.`);
  const parent = resolve(opts.dir ?? dirname(projectRoot));
  const dest = join(parent, base);
  if (!resolve(dest).startsWith(resolve(parent) + sep)) {
    throw new LinkedRepoError(`Refusing to clone "${name}": destination escapes ${parent}.`);
  }

  // 4) refuse an occupied destination.
  if (existsSync(dest)) {
    throw new LinkedRepoError(`Refusing to clone "${name}": ${dest} already exists.`);
  }

  // 5) trust gate.
  if (opts.confirmed !== true) {
    throw new LinkedRepoError(
      `Cloning "${name}" needs confirmation — the URL comes from the shared config and could have been set by any teammate.`,
    );
  }

  // 6) token.
  const resolved = resolveToken(projectRoot);
  if (!resolved) {
    throw new LinkedRepoError(`No GitHub token found — sign in with GitHub, or set GITHUB_TOKEN/GH_TOKEN.`);
  }

  // 7) clone under credentials, with the CANONICAL url (never the raw string).
  await withGitCredentials(resolved.token, (env) => gitModule.clone(cloneUrl, dest, env));

  // 8) record the local path.
  setLinkedRepoPath(cloneUrl, dest, opts.home);
  return dest;
}
