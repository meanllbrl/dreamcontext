import { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { discoverVaultsAsync } from '../../lib/vault-discovery.js';
import { addVault, listVaults, VaultError, type Vault } from '../../lib/vaults.js';
import { detectTechStack } from '../../lib/tech-stack.js';
import { ensureCliInstalled } from '../../lib/ensure-cli.js';
import {
  PLATFORM_CATALOG,
  DEFAULT_PLATFORMS,
  normalizePlatforms,
  ensurePlatformSelection,
  type PlatformId,
} from '../../lib/platforms.js';
import { loadCatalog } from '../../lib/catalog.js';

const execFileAsync = promisify(execFile);

/**
 * GET /api/launcher/discover?root=<absPath> — find every dreamcontext project
 * under an absolute root and flag which are already registered (P1.1).
 *
 * Read-only and vault-agnostic (works in launcher mode). `root` must be an
 * absolute path that exists; anything else is a 400. Each result carries its
 * absolute project `path`, derived `name` (basename), and `registered` flag.
 */
export async function handleLauncherDiscover(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const root = url.searchParams.get('root');

  if (!root || !isAbsolute(root)) {
    sendError(res, 400, 'invalid_root', 'root must be an absolute path.');
    return;
  }
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot)) {
    sendError(res, 400, 'invalid_root', `Path does not exist: ${resolvedRoot}`);
    return;
  }

  const registeredPaths = new Set(listVaults().map((v) => resolve(v.path)));
  const discovered = await discoverVaultsAsync(resolvedRoot);
  const projects = discovered.map((path) => ({
    name: basename(path),
    path,
    registered: registeredPaths.has(resolve(path)),
  }));

  sendJson(res, 200, { projects });
}

/**
 * POST /api/launcher/register — register a project directory as a vault (P1.2).
 *
 * Mutation; protected by the existing cross-site-Origin CSRF guard. STRICT-PICK:
 * only `name` and `path` are read off the body BY NAME — the body is never
 * spread. `addVault` validates the path exists and contains `_dream_context/`;
 * any rejection maps to 400. On success returns the updated vault list.
 */
export async function handleLauncherRegister(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
    return;
  }

  const name = body.name;
  if (typeof name !== 'string' || !name.trim()) {
    sendError(res, 400, 'invalid_name', 'name must be a non-empty string.');
    return;
  }

  const path = body.path;
  if (typeof path !== 'string' || !path.trim()) {
    sendError(res, 400, 'invalid_path', 'path must be a non-empty string.');
    return;
  }

  try {
    addVault(name.trim(), path.trim());
    sendJson(res, 200, { vaults: listVaults() });
  } catch (err) {
    if (err instanceof VaultError) {
      sendError(res, 400, 'invalid_vault', err.message);
      return;
    }
    console.error('[launcher] register failed:', err);
    sendError(res, 500, 'register_failed', 'Failed to register vault.');
  }
}

// ─── Scaffold (quiz onboarding) ────────────────────────────────────────────────

/** Typed failure for scaffold input/precondition violations (→ 400). */
export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

/** Quiz answers collected by the launcher onboarding wizard. */
export interface ScaffoldAnswers {
  mode: 'new' | 'existing';
  name: string;
  description?: string;
  targetUser?: string;
  stack?: string;
  priority?: string;
  /** Absolute parent directory under which a NEW project folder is created. */
  parentDir?: string;
  /** Absolute path to an EXISTING folder to initialize in place. */
  projectPath?: string;
  /** Target agent platforms (e.g. ['claude','codex']). Defaults to ['claude']. */
  platforms?: string[];
  /** Optional skill-pack names to install after setup (e.g. ['engineering']). */
  packs?: string[];
}

/**
 * Runs a bundled-CLI subcommand in `cwd`. Injectable so tests can substitute a
 * fake that fabricates `_dream_context/` without spawning a real process.
 */
export type CliRunner = (args: string[], cwd: string) => Promise<void>;

/**
 * Production runner: invoke THIS dreamcontext CLI in a child process. We never
 * mutate the long-lived server's own `process.cwd()`; instead we spawn the CLI
 * with an explicit `cwd`. `execFile` (no shell) + an arg array means quiz values
 * are passed as argv, never interpolated into a command line — no shell injection.
 * The CLI entry is the same `dist/index.js` the desktop shell booted us with
 * (`process.argv[1]`), overridable via DREAMCONTEXT_CLI (matches the Rust shell).
 */
const defaultCliRunner: CliRunner = async (args, cwd) => {
  const cliEntry = process.env.DREAMCONTEXT_CLI || process.argv[1];
  if (!cliEntry) {
    throw new ScaffoldError('Could not locate the dreamcontext CLI entry to scaffold the project.');
  }
  await execFileAsync(process.execPath, [cliEntry, ...args], {
    cwd,
    timeout: 120_000,
    // Mark as an internal setup-driven invocation so `init` skips its
    // interactive "finish setup" offer and deprecation hints.
    env: { ...process.env, DREAMCONTEXT_SETUP_INTERNAL: '1' },
  });
};

/** A name usable both as a directory segment and a registry name. */
const SAFE_NAME_RE = /^[^/\\]+$/;

function isNonEmptyDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Create-or-initialize a project, then register it as a vault. Deterministic and
 * LLM-free: `init` (with the quiz answers as flags) scaffolds `_dream_context/`,
 * `setup` installs the platform integration (.claude/ skills, agents, hooks).
 * Idempotent: a folder that already has `_dream_context/` is registered as-is.
 */
export async function scaffoldProject(
  a: ScaffoldAnswers,
  runner: CliRunner = defaultCliRunner,
  home?: string,
): Promise<{ vault: Vault; vaults: Vault[] }> {
  const name = (a.name ?? '').trim();
  if (!name) throw new ScaffoldError('name must be a non-empty string.');

  // Resolve the target platforms: filter to known ids, default to ['claude'].
  const platforms: PlatformId[] = ensurePlatformSelection(normalizePlatforms(a.platforms ?? []));
  const platformArg = platforms.join(',');

  // Validate requested packs against the catalog (drop anything unknown so we
  // never pass garbage to install-skill).
  const knownPackNames = new Set((loadCatalog()?.catalog.packs ?? []).map((p) => p.name));
  const packs = (a.packs ?? []).map((p) => String(p).trim()).filter((p) => knownPackNames.has(p));

  // Resolve the target directory per mode.
  let target: string;
  if (a.mode === 'new') {
    if (!SAFE_NAME_RE.test(name)) {
      throw new ScaffoldError('Project name must not contain path separators.');
    }
    if (name === '.' || name === '..') {
      throw new ScaffoldError('Project name is invalid.');
    }
    const parentDir = (a.parentDir ?? '').trim();
    if (!parentDir || !isAbsolute(parentDir)) {
      throw new ScaffoldError('parentDir must be an absolute path.');
    }
    const resolvedParent = resolve(parentDir);
    if (!existsSync(resolvedParent) || !statSync(resolvedParent).isDirectory()) {
      throw new ScaffoldError(`Parent directory does not exist: ${resolvedParent}`);
    }
    target = resolve(resolvedParent, name);
    // Defense in depth: the resolved target must be a direct child of the parent
    // (guards against a name that slipped past SAFE_NAME_RE).
    if (target !== join(resolvedParent, name) || !target.startsWith(resolvedParent + sep)) {
      throw new ScaffoldError('Resolved project path escapes the parent directory.');
    }
    if (isNonEmptyDir(target) && !existsSync(join(target, '_dream_context'))) {
      throw new ScaffoldError(`A non-empty folder already exists at ${target}.`);
    }
    mkdirSync(target, { recursive: true });
  } else if (a.mode === 'existing') {
    const projectPath = (a.projectPath ?? '').trim();
    if (!projectPath || !isAbsolute(projectPath)) {
      throw new ScaffoldError('projectPath must be an absolute path.');
    }
    target = resolve(projectPath);
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      throw new ScaffoldError(`Folder does not exist: ${target}`);
    }
  } else {
    throw new ScaffoldError("mode must be 'new' or 'existing'.");
  }

  // init scaffolds _dream_context/ — only needed when this folder is not already
  // a dreamcontext project.
  const alreadyProject = existsSync(join(target, '_dream_context'));
  if (!alreadyProject) {
    const initArgs = ['init', '--yes', '--platforms', platformArg, '--name', name];
    if (a.description?.trim()) initArgs.push('--description', a.description.trim());
    if (a.targetUser?.trim()) initArgs.push('--user', a.targetUser.trim());
    if (a.stack?.trim()) initArgs.push('--stack', a.stack.trim());
    if (a.priority?.trim()) initArgs.push('--priority', a.priority.trim());
    await runner(initArgs, target);
  }

  // setup installs/refreshes the platform integration (.claude/.agents skills,
  // agents, hooks) for the SELECTED platforms. Run it for both fresh and
  // existing projects: a fresh project needs it (init suppresses the interactive
  // offer in a non-TTY child); connecting an existing folder uses it to install
  // the platforms the user chose (e.g. add Codex) — idempotent and non-destructive.
  await runner(['setup', '--defaults', '--platforms', platformArg], target);

  // Install any chosen optional skill packs onto the selected platforms. Runs
  // after setup (which lays down the base skill the packs extend). Best-effort
  // for the project as a whole — a pack-install failure shouldn't orphan an
  // otherwise-created vault, so it surfaces as a thrown ScaffoldError only when
  // it genuinely fails the child process.
  if (packs.length > 0) {
    await runner(['install-skill', '--packs', ...packs, '--platforms', platformArg], target);
  }

  // addVault validates the path + _dream_context child and rejects dupes.
  const vault = addVault(name, target, home);
  return { vault, vaults: listVaults(home) };
}

/**
 * POST /api/launcher/scaffold — create a NEW project or initialize an EXISTING
 * folder from quiz answers, then register it (P-onboarding). Mutation; protected
 * by the cross-site-Origin CSRF guard. STRICT-PICK: every field is read off the
 * body BY NAME — the body is never spread.
 */
export async function handleLauncherScaffold(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
    return;
  }

  const answers: ScaffoldAnswers = {
    mode: body.mode === 'existing' ? 'existing' : 'new',
    name: typeof body.name === 'string' ? body.name : '',
    description: typeof body.description === 'string' ? body.description : undefined,
    targetUser: typeof body.targetUser === 'string' ? body.targetUser : undefined,
    stack: typeof body.stack === 'string' ? body.stack : undefined,
    priority: typeof body.priority === 'string' ? body.priority : undefined,
    parentDir: typeof body.parentDir === 'string' ? body.parentDir : undefined,
    projectPath: typeof body.projectPath === 'string' ? body.projectPath : undefined,
    platforms: Array.isArray(body.platforms)
      ? body.platforms.filter((p: unknown): p is string => typeof p === 'string')
      : undefined,
    packs: Array.isArray(body.packs)
      ? body.packs.filter((p: unknown): p is string => typeof p === 'string')
      : undefined,
  };

  try {
    const result = await scaffoldProject(answers);
    // Ensure a PATH-resolvable `dreamcontext` exists so the new project's
    // `npx dreamcontext hook …` calls work when opened in Claude Code. The
    // bundled app CLI is not on PATH; install from npm if missing. Best-effort —
    // the project is already created, so a CLI-install failure is reported, not thrown.
    const cli = await ensureCliInstalled();
    sendJson(res, 200, { ...result, cli });
  } catch (err) {
    if (err instanceof ScaffoldError || err instanceof VaultError) {
      sendError(res, 400, 'scaffold_failed', err.message);
      return;
    }
    console.error('[launcher] scaffold failed:', err);
    sendError(res, 500, 'scaffold_failed', 'Failed to set up the project.');
  }
}

/**
 * GET /api/launcher/detect?path=<absPath> — best-effort tech-stack detection for
 * an existing folder, used to prefill the onboarding quiz. Read-only and
 * vault-agnostic. Returns `{ stack: string }` ('' when nothing recognizable).
 */
export async function handleLauncherDetect(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const path = url.searchParams.get('path');
  if (!path || !isAbsolute(path)) {
    sendError(res, 400, 'invalid_path', 'path must be an absolute path.');
    return;
  }
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    sendError(res, 400, 'invalid_path', `Path does not exist: ${resolved}`);
    return;
  }
  sendJson(res, 200, {
    stack: detectTechStack(resolved) ?? '',
    hasContext: existsSync(join(resolved, '_dream_context')),
    name: basename(resolved),
  });
}

/**
 * GET /api/launcher/catalog — the choices the onboarding wizard offers: target
 * platforms (Claude / Codex, with the default ones flagged `recommended`) and
 * the available optional skill packs (name + description + tags). Read-only and
 * vault-agnostic (works in launcher mode). Never 500s: an unreadable pack
 * catalog yields an empty `packs` list, not an error.
 */
export async function handleLauncherCatalog(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const recommended = new Set<string>(DEFAULT_PLATFORMS);
  const platforms = PLATFORM_CATALOG.map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    recommended: recommended.has(p.id),
  }));
  const packs = (loadCatalog()?.catalog.packs ?? []).map((p) => ({
    name: p.name,
    description: p.description,
    tags: p.tags,
  }));
  sendJson(res, 200, { platforms, packs });
}

/**
 * GET /api/launcher/defaults — absolute paths the onboarding quiz prefills with
 * (the user's home + a suggested `~/projects` parent). Read-only, vault-agnostic.
 */
export async function handleLauncherDefaults(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const home = homedir();
  sendJson(res, 200, { home, defaultParent: join(home, 'projects') });
}
