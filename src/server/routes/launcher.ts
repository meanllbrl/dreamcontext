import { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, readdirSync, statSync, createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { discoverVaultsAsync } from '../../lib/vault-discovery.js';
import {
  addVault,
  listVaults,
  removeVault,
  resolveVaultContextRoot,
  VaultError,
  type Vault,
} from '../../lib/vaults.js';
import {
  listConnections,
  addConnection,
  removeConnection,
  type ConnectionDirection,
} from '../../lib/connections.js';
import { readSetupConfig, updateSetupConfig } from '../../lib/setup-config.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { compareVersions } from '../../lib/version-check.js';
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
import { insertToJsonArray } from '../../lib/json-file.js';
import { today } from '../../lib/id.js';
import { randomUUID } from 'node:crypto';
import { readSleepState } from '../../cli/commands/sleep.js';
import { readAppManifest } from '../../cli/commands/app.js';
import {
  consolidationDepth,
  inspectSleepLock,
  isDestructiveAllowed,
  type ConsolidationDepth,
} from '../../lib/sleep-consolidation.js';

const execFileAsync = promisify(execFile);

/**
 * In-memory state of a background Claude enrichment run, keyed by capture id.
 * The capture POST starts the run and returns the id; the capture bar polls
 * `GET /api/launcher/capture/status?id=` to show a live spinner and, when done,
 * Claude's response. Purely ephemeral — lost on server restart (fine: the note
 * itself was already saved synchronously).
 */
interface CaptureRun {
  state: 'running' | 'done' | 'error';
  /** User-facing: Claude's stdout response (live), or an error detail on failure. */
  output: string;
  /** Captured separately; surfaced only if the run fails (keeps the response clean). */
  stderr: string;
  startedAt: number;
  endedAt?: number;
}
const captureRuns = new Map<string, CaptureRun>();
const CAPTURE_RUN_TTL_MS = 10 * 60 * 1000; // forget a run 10 min after it ends
const CAPTURE_RUNS_MAX = 50;

/** Drop finished runs older than the TTL and cap the map size (oldest-first). */
function pruneCaptureRuns(): void {
  const now = Date.now();
  for (const [id, run] of captureRuns) {
    if (run.endedAt && now - run.endedAt > CAPTURE_RUN_TTL_MS) captureRuns.delete(id);
  }
  while (captureRuns.size > CAPTURE_RUNS_MAX) {
    const oldest = captureRuns.keys().next().value;
    if (oldest === undefined) break;
    captureRuns.delete(oldest);
  }
}

/**
 * Vault path → capture id of the Sleep consolidation currently running for that
 * vault. A consolidation is mutually exclusive per vault (it rewrites the shared
 * .sleep.json + core files); this in-process guard rejects a second desktop
 * Sleep BEFORE its agent has had a chance to stamp the .sleep.json lock — the
 * window two rapid clicks would otherwise race through. Cleared when the child
 * exits. (The .sleep.json lock itself is the cross-process backstop for
 * session-driven / CLI sleeps.)
 */
const sleepJobsInFlight = new Map<string, string>();

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
  /** Target agent platforms (e.g. ['claude']). Defaults to ['claude']. */
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

  // setup installs/refreshes the platform integration (.claude skills, agents,
  // hooks) for the SELECTED platforms. Run it for both fresh and existing
  // projects: a fresh project needs it (init suppresses the interactive offer in
  // a non-TTY child); connecting an existing folder uses it to install the
  // platforms the user chose — idempotent and non-destructive.
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
 * platforms (Claude, with the default ones flagged `recommended`) and
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

// ─── Sleepy config persistence (~/.dreamcontext/sleepy.json) ───────────────────
//
// The app picks a fresh loopback port each launch, so localStorage (origin-keyed)
// resets between launches. Persist the Sleepy config server-side so "Enable
// Sleepy" + the hotkey survive restarts; the launcher seeds localStorage from
// here on mount, and within a launch the windows sync via localStorage events.

function sleepyConfigPath(): string {
  return join(homedir(), '.dreamcontext', 'sleepy.json');
}

/** GET /api/launcher/sleepy-config — persisted { enabled, hotkey } (defaults if absent). */
export async function handleSleepyConfigGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  let enabled = false;
  let hotkey = 'Alt+Cmd+S';
  try {
    const p = sleepyConfigPath();
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as { enabled?: unknown; hotkey?: unknown };
      enabled = raw.enabled === true;
      if (typeof raw.hotkey === 'string' && raw.hotkey.trim()) hotkey = raw.hotkey;
    }
  } catch {
    /* fall back to defaults */
  }
  sendJson(res, 200, { enabled, hotkey });
}

/** POST /api/launcher/sleepy-config — persist { enabled, hotkey }. STRICT-PICK. */
export async function handleSleepyConfigSet(
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
  const enabled = body.enabled === true;
  const hotkey = typeof body.hotkey === 'string' && body.hotkey.trim() ? body.hotkey.trim() : 'Alt+Cmd+S';
  try {
    const p = sleepyConfigPath();
    mkdirSync(join(homedir(), '.dreamcontext'), { recursive: true });
    writeFileSync(p, JSON.stringify({ enabled, hotkey }, null, 2) + '\n', 'utf-8');
    sendJson(res, 200, { enabled, hotkey });
  } catch (err) {
    console.error('[launcher] sleepy-config write failed:', err);
    sendError(res, 500, 'write_failed', 'Failed to persist Sleepy config.');
  }
}

// ─── Agent-surface UI settings persistence (~/.dreamcontext/agent-ui.json) ─────
//
// Same rationale as sleepy.json: the app's per-launch loopback port resets
// localStorage, so the Agents (beta) preferences — feature on/off, restore-past-
// tabs, default agent, and the in-app open/close hotkey — are persisted here so
// they survive restarts. App-global (not vault-scoped): these are surface
// preferences, so every project window shares them. Vault-agnostic route.

type AgentUiDefaultAgent = 'claude';
interface AgentUiSettings {
  enabled: boolean;
  restoreTabs: boolean;
  defaultAgent: AgentUiDefaultAgent;
  autoTitle: boolean;
  hotkey: string;
}
const AGENT_UI_DEFAULTS: AgentUiSettings = {
  enabled: true,
  restoreTabs: true,
  defaultAgent: 'claude',
  autoTitle: false,
  hotkey: 'Ctrl+A',
};

function agentSettingsPath(): string {
  return join(homedir(), '.dreamcontext', 'agent-ui.json');
}

/** Coerce an arbitrary parsed blob to a valid AgentUiSettings, filling defaults. */
function coerceAgentSettings(raw: Record<string, unknown>): AgentUiSettings {
  return {
    // Default-TRUE flags: only an explicit `false` turns them off (an absent key
    // must not silently disable the surface for someone upgrading).
    enabled: raw.enabled !== false,
    restoreTabs: raw.restoreTabs !== false,
    defaultAgent: raw.defaultAgent === 'claude' ? 'claude' : AGENT_UI_DEFAULTS.defaultAgent,
    // Opt-in flag: default FALSE, only an explicit `true` enables tab auto-naming.
    autoTitle: raw.autoTitle === true,
    hotkey: typeof raw.hotkey === 'string' && raw.hotkey.trim() ? raw.hotkey.trim() : AGENT_UI_DEFAULTS.hotkey,
  };
}

/** GET /api/launcher/agent-settings — persisted Agents-surface prefs (defaults if absent). */
export async function handleAgentSettingsGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  let settings = { ...AGENT_UI_DEFAULTS };
  try {
    const p = agentSettingsPath();
    if (existsSync(p)) {
      settings = coerceAgentSettings(JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>);
    }
  } catch {
    /* fall back to defaults */
  }
  sendJson(res, 200, settings);
}

/** POST /api/launcher/agent-settings — persist Agents-surface prefs. STRICT-PICK. */
export async function handleAgentSettingsSet(
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
  const settings = coerceAgentSettings(body as Record<string, unknown>);
  try {
    mkdirSync(join(homedir(), '.dreamcontext'), { recursive: true });
    writeFileSync(agentSettingsPath(), JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    sendJson(res, 200, settings);
  } catch (err) {
    console.error('[launcher] agent-settings write failed:', err);
    sendError(res, 500, 'write_failed', 'Failed to persist Agent settings.');
  }
}

// ─── Sleepy mascot video (desktop-only; bundled in the .app Resources) ─────────

const SLEEPY_MODES = new Set(['idle', 'sleepy', 'sleeps']);

/**
 * GET /api/sleepy/video?mode=idle|sleepy|sleeps — stream a bundled mascot clip
 * for the notch bar. Reads from DREAMCONTEXT_SLEEPY_DIR (set by the Tauri shell
 * to Resources/sleepy). Desktop-only: 404 when the env/dir/file is absent, so it
 * ships nothing to the npm CLI. Supports Range so WKWebView's <video> plays it.
 */
export async function handleSleepyVideo(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const mode = url.searchParams.get('mode') || 'idle';
  if (!SLEEPY_MODES.has(mode)) {
    sendError(res, 400, 'bad_mode', 'mode must be idle, sleepy, or sleeps.');
    return;
  }
  const dir = process.env.DREAMCONTEXT_SLEEPY_DIR;
  if (!dir) {
    res.writeHead(404);
    res.end();
    return;
  }
  const file = join(dir, `${mode}.mp4`);
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const size = statSync(file).size;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size });
    createReadStream(file).pipe(res);
  }
}

/**
 * GET /api/sleepy/anim?mode=idle|sleepy|sleeps — serve the bundled mascot as an
 * animated WebP. Unlike <video>, an <img> autoplays unconditionally in WKWebView
 * (which blocks muted <video> autoplay and offers no Tauri toggle to change it),
 * so the notch mascot animates without a play-button overlay. Desktop-only: 404
 * when the env/dir/file is absent. Whole-file (no Range needed for <img>).
 */
export async function handleSleepyAnim(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const mode = url.searchParams.get('mode') || 'idle';
  if (!SLEEPY_MODES.has(mode)) {
    sendError(res, 400, 'bad_mode', 'mode must be idle, sleepy, or sleeps.');
    return;
  }
  const dir = process.env.DREAMCONTEXT_SLEEPY_DIR;
  const file = dir ? join(dir, `${mode}.webp`) : '';
  if (!file || !existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const size = statSync(file).size;
  res.writeHead(200, {
    'Content-Type': 'image/webp',
    'Content-Length': size,
    'Cache-Control': 'public, max-age=86400',
  });
  createReadStream(file).pipe(res);
}

// ─── Sleepy quick-capture ──────────────────────────────────────────────────────

/**
 * Build the headless-claude enrichment prompt for a captured note. The injection
 * keeps the run non-interactive (no follow-ups) — it just learns the note.
 * Exported for testing. The note is passed to claude as an ARGUMENT (never
 * interpolated into a shell string), so this string is injection-safe.
 */
export function buildCapturePrompt(note: string): string {
  // Leading "Think hard" requests medium extended thinking (Claude Code keyword).
  return (
    `Think hard. A quick-capture note was just saved to this project's dreamcontext memory:\n\n` +
    `"${note}"\n\n` +
    `Do NOT ask any follow-up questions. Review it and, if warranted, organize or ` +
    `enrich it into the appropriate dreamcontext knowledge/memory via the dreamcontext ` +
    `CLI WITHOUT duplicating the raw note. Then stop.`
  );
}

/**
 * Build the headless-claude prompt for "Ask" mode: a single-shot question about
 * THIS project, answered directly with no follow-ups and no side effects. The
 * question is passed to claude as an ARGUMENT (never a shell string), so this is
 * injection-safe. Exported for testing.
 */
export function buildAskPrompt(question: string): string {
  // Leading "Think hard" requests medium extended thinking; the answer itself must
  // stay short, clear, and Markdown-formatted (it's rendered in the notch bar).
  return (
    `Think hard, then answer the following question about THIS project. Format the ` +
    `answer as GitHub-flavored Markdown. Be SHORT and CLEAR — at most a few sentences ` +
    `or a tight bullet list, no preamble, do not restate the question. Use the ` +
    `project's dreamcontext context and code as needed. Do NOT ask any follow-up ` +
    `questions and do NOT make any file changes. Give ONE direct answer, then stop.\n\n` +
    `Question: "${question}"`
  );
}

/**
 * Build the headless-claude prompt for "Sleep" mode: run a full dreamcontext
 * memory consolidation for THIS project, autonomously, then report a short
 * summary. No user text involved, so nothing to injection-escape.
 *
 * The desktop Sleep button bypasses `dreamcontext sleep start`, so the caller
 * resolves the consolidation depth and passes it in. The prompt injects a
 * destructive-authorization line ONLY at `deep` (per `isDestructiveAllowed`);
 * at light/standard it injects an explicit non-destructive guard so the agent
 * never silently merges/summarize-replaces/deletes knowledge from this path.
 */
export function buildSleepPrompt(depth: ConsolidationDepth): string {
  const depthLine = isDestructiveAllowed(depth)
    ? `This is a DEEP consolidation: you ARE authorized to perform destructive/expensive ` +
      `knowledge ops (merge-with-delete, summarize-and-replace still-valid detail, archive/` +
      `delete stale files) — but first copy any file you will merge/replace/delete to ` +
      `\`_dream_context/knowledge/.archive/<slug>-<YYYYMMDD>.md\` (create the dir if absent).`
    : `This is a ${depth.toUpperCase()} consolidation: do NOT merge, summarize-and-replace, ` +
      `or delete any knowledge. Only create/extend/retag/tick. If you spot merge or deletion ` +
      `candidates, FLAG them in your report instead of acting on them.`;
  return (
    `Think hard. Run a dreamcontext memory consolidation ("sleep") for THIS project ` +
    `now, fully autonomously — do NOT ask any questions. Follow the project's ` +
    `dreamcontext sleep/consolidation flow: pin the epoch with \`dreamcontext sleep ` +
    `start\`, reconcile the task/changelog/knowledge/feature files to current truth ` +
    `as warranted (prefer updating existing entities over creating new ones), then ` +
    `close the cycle with \`dreamcontext sleep done "<one-paragraph summary>"\` to ` +
    `reset the debt. ${depthLine} When finished, reply with a SHORT GitHub-flavored ` +
    `Markdown summary (a few bullets) of what was consolidated. Keep it concise.`
  );
}

/**
 * POST /api/launcher/capture — the Sleepy notch bar's submit. Captures a note
 * into the chosen vault: (1) INSTANT, guaranteed `dreamcontext memory remember`
 * (deterministic, no tokens), then (2) fire-and-forget headless `claude -p` to
 * enrich/learn it (best-effort; silently skipped if claude is absent). Mutation;
 * behind the cross-site CSRF guard. STRICT-PICK: only `vault` + `text` are read.
 * No user text ever reaches a shell string — memory remember gets it as argv,
 * claude gets it as the login-shell positional `$0`.
 */
export async function handleLauncherCapture(
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
  const vaultName = typeof body.vault === 'string' ? body.vault.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!vaultName) {
    sendError(res, 400, 'invalid_vault', 'vault must be a non-empty string.');
    return;
  }
  // Mode: 'learn' (default) saves the note + enriches; 'ask' is a one-shot Q&A
  // (no side effects); 'sleep' runs a full memory consolidation (no text needed).
  const mode = body.mode === 'ask' ? 'ask' : body.mode === 'sleep' ? 'sleep' : 'learn';
  if (mode !== 'sleep' && !text) {
    sendError(res, 400, 'invalid_text', 'text must be a non-empty string.');
    return;
  }

  const vault = listVaults().find((v) => v.name === vaultName);
  if (!vault) {
    sendError(res, 400, 'unknown_vault', `No registered vault named "${vaultName}".`);
    return;
  }
  const cwd = resolve(vault.path);
  if (!existsSync(cwd)) {
    sendError(res, 400, 'missing_vault', `Vault path no longer exists: ${cwd}`);
    return;
  }

  // (1) Learn mode only: instant, guaranteed capture — never lose the note even
  // if claude fails. Done IN-PROCESS (this server IS dreamcontext): a
  // deterministic CHANGELOG append, mirroring `memory remember`. We do NOT spawn
  // a child CLI here — in a packaged desktop app the resolvable CLI can be a
  // stale/older global whose `memory remember` differs or is absent, which
  // surfaced as a "failed" capture. A direct file write removes that failure
  // class. (Ask mode writes nothing — it's a question, not a note.)
  if (mode === 'learn') {
    try {
      const changelogPath = join(cwd, '_dream_context', 'core', 'CHANGELOG.json');
      if (!existsSync(changelogPath)) {
        sendError(res, 400, 'not_initialized', `"${vaultName}" has no _dream_context — run init first.`);
        return;
      }
      const summary = text.length > 200 ? text.slice(0, 197) + '...' : text;
      insertToJsonArray(changelogPath, {
        date: today(),
        type: 'note',
        scope: 'quick',
        summary,
        description: text,
        breaking: false,
      });
    } catch (err) {
      console.error('[launcher] capture changelog write failed:', err);
      const detail = err instanceof Error ? err.message : 'unknown error';
      sendError(res, 500, 'capture_failed', `Failed to save the note: ${detail}`);
      return;
    }
  }

  // (1.5) Sleep is mutually exclusive per vault. Reject a new Sleep when either
  // (a) this server already has a Sleep child in flight for this vault (catches
  // two rapid desktop clicks, before either agent has stamped the lock), or
  // (b) the vault's .sleep.json already holds a non-stale consolidation lock (a
  // session-driven or CLI sleep is mid-cycle). A stale lock is ignored — the
  // spawned agent's `sleep start` will reclaim it.
  if (mode === 'sleep') {
    const inFlightId = sleepJobsInFlight.get(cwd);
    if (inFlightId && captureRuns.get(inFlightId)?.state === 'running') {
      sendError(
        res,
        409,
        'sleep_in_progress',
        'A Sleep consolidation is already running for this vault. Wait for it to finish.',
      );
      return;
    }
    try {
      const lock = inspectSleepLock(readSleepState(cwd), Date.now());
      if (lock.locked && !lock.stale) {
        sendError(
          res,
          409,
          'sleep_in_progress',
          `A consolidation is already in progress for this vault (started ${lock.startedAt}). ` +
            'Wait for it to finish before starting another.',
        );
        return;
      }
    } catch (err) {
      // Unreadable/absent sleep state must not hard-block a user-requested sleep;
      // the agent's own `sleep start` remains the cross-process backstop.
      console.error('[launcher] could not read sleep lock state:', err);
    }
  }

  // (2) Best-effort enrichment via a headless claude run, TRACKED so the capture
  // bar can show a live spinner + Claude's response. The prompt is passed as the
  // positional `$0` (double-quoted in the script) so the note is never
  // shell-interpreted.
  //
  // We use an INTERACTIVE login shell (`-ilc`), not just login (`-lc`): tools
  // like claude are often added to PATH in `~/.zshrc` (e.g. `~/.local/bin`),
  // which a non-interactive login shell does NOT source — so `-lc` yields
  // "command not found: claude" for a Finder-launched app. `-ilc` mirrors a real
  // terminal's PATH. stdout (Claude's reply) and stderr (shell/init noise) are
  // captured separately so rc-file chatter never pollutes the shown response.
  pruneCaptureRuns();
  const captureId = randomUUID();
  const run: CaptureRun = { state: 'running', output: '', stderr: '', startedAt: Date.now() };
  captureRuns.set(captureId, run);
  // Claim the per-vault Sleep slot so a concurrent desktop click is rejected by
  // guard (1.5) until this child exits. Released in every terminal path below.
  if (mode === 'sleep') sleepJobsInFlight.set(cwd, captureId);
  const releaseSleepSlot = () => {
    if (mode === 'sleep' && sleepJobsInFlight.get(cwd) === captureId) {
      sleepJobsInFlight.delete(cwd);
    }
  };
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    let sleepDepth: ConsolidationDepth = 'deep';
    if (mode === 'sleep') {
      // Desktop Sleep = user-requested deep. Read the vault's debt to record the
      // honest source/reason, but the user override forces 'deep' regardless.
      try {
        sleepDepth = consolidationDepth(readSleepState(cwd).debt, {
          userRequestedDeep: true,
        }).depth;
      } catch (err) {
        // No/unreadable sleep state — fall back to deep (user explicitly asked).
        console.error('[launcher] could not read sleep state for depth:', err);
        sleepDepth = 'deep';
      }
    }
    const prompt =
      mode === 'sleep'
        ? buildSleepPrompt(sleepDepth)
        : mode === 'ask'
          ? buildAskPrompt(text)
          : buildCapturePrompt(text);
    // Sleepy runs on Sonnet (medium thinking is requested via the prompt). `$0` is
    // the prompt positional — never interpolated into the shell string.
    const child = spawn(shell, ['-ilc', 'exec claude --model sonnet -p "$0"', prompt], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Keep only the tail so a chatty run can't grow memory unbounded.
    child.stdout?.on('data', (chunk: Buffer) => {
      run.output = (run.output + chunk.toString('utf-8')).slice(-8000);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      run.stderr = (run.stderr + chunk.toString('utf-8')).slice(-4000);
    });
    child.on('error', (err) => {
      // claude not on PATH / spawn failure — note is already saved; report it.
      run.state = 'error';
      run.output = `Couldn't start claude: ${err.message}`;
      run.endedAt = Date.now();
      releaseSleepSlot();
    });
    child.on('close', (code) => {
      releaseSleepSlot();
      if (run.state !== 'running') return;
      if (code === 0) {
        run.state = 'done';
      } else {
        // Failed: show stdout if any, else the stderr tail (e.g. "command not
        // found: claude"), else the exit code.
        run.state = 'error';
        if (!run.output.trim()) run.output = run.stderr.trim() || `claude exited with code ${code}`;
      }
      run.endedAt = Date.now();
    });
  } catch (err) {
    run.state = 'error';
    run.output = `Couldn't start claude: ${err instanceof Error ? err.message : 'spawn failed'}`;
    run.endedAt = Date.now();
    releaseSleepSlot();
  }

  sendJson(res, 200, { ok: true, captureId });
}

/**
 * GET /api/launcher/capture/status?id=<captureId> — poll the background Claude
 * enrichment run started by a capture. Returns its state (`running` | `done` |
 * `error`) and accumulated output (Claude's response tail). Read-only; an
 * unknown id returns `{ state: 'unknown' }` (the run may have expired). Vault-
 * agnostic (under the `/api/launcher` prefix).
 */
export async function handleLauncherCaptureStatus(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const id = url.searchParams.get('id') ?? '';
  const run = id ? captureRuns.get(id) : undefined;
  if (!run) {
    sendJson(res, 200, { state: 'unknown', output: '' });
    return;
  }
  sendJson(res, 200, { state: run.state, output: run.output.trim() });
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

// ─── Per-project status (exists / update-needed) ────────────────────────────────
//
// The launcher dot is GREEN when a project's installed dreamcontext files are
// current, YELLOW when the project is behind the running CLI (its `setupVersion`
// is older than `dreamcontextVersion()` → a `dreamcontext update` would refresh
// its skills/agents/hooks), and RED when the folder is gone. This mirrors the
// upgrade-vs-update distinction: upgrading the CLI does NOT touch a project's
// installed files; each project must be updated individually.

export interface VaultStatus {
  name: string;
  path: string;
  /** Folder still on disk? RED dot + removable when false. */
  exists: boolean;
  /** The project's recorded setup version ('0.0.0' when unknown / uninitialised). */
  setupVersion: string;
  /** The running CLI version the project would be brought up to by `update`. */
  latestVersion: string;
  /** True iff the folder exists AND setupVersion is behind latestVersion. */
  needsUpdate: boolean;
  /** Federation read gate — whether peers may recall this vault's corpus. */
  shareable: boolean;
}

/** Compute one vault's launcher status (pure-ish: reads disk, never throws). */
function computeVaultStatus(v: Vault, latest: string): VaultStatus {
  const exists = existsSync(resolve(v.path));
  let setupVersion = '0.0.0';
  let shareable = false;
  if (exists) {
    try {
      const cfg = readSetupConfig(resolve(v.path));
      if (cfg) {
        setupVersion = cfg.setupVersion || '0.0.0';
        shareable = cfg.shareable === true;
      }
    } catch {
      /* leave defaults — a project we can't read is treated as up-to-date */
    }
  }
  const needsUpdate = exists && compareVersions(setupVersion, latest) < 0;
  return { name: v.name, path: v.path, exists, setupVersion, latestVersion: latest, needsUpdate, shareable };
}

/**
 * GET /api/launcher/status — per-vault freshness for the launcher cards. Read-only
 * and vault-agnostic (launcher mode). Each entry says whether the folder still
 * exists, the project's `setupVersion`, the running CLI version, and whether an
 * in-project `dreamcontext update` is warranted.
 */
export async function handleLauncherStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const latest = dreamcontextVersion();
  const vaults = listVaults().map((v) => computeVaultStatus(v, latest));
  sendJson(res, 200, { vaults, latestVersion: latest });
}

/**
 * POST /api/launcher/unregister — drop a vault from the global registry (e.g. a
 * deleted project the launcher still shows). Mutation; behind the CSRF guard.
 * STRICT-PICK: only `name` is read. `removeVault` is idempotent and never throws,
 * so a stale/duplicate request still returns the (refreshed) list. Does NOT touch
 * the project folder — only the registry entry.
 */
export async function handleLauncherUnregister(
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
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    sendError(res, 400, 'invalid_name', 'name must be a non-empty string.');
    return;
  }
  const removed = removeVault(name);
  sendJson(res, 200, { removed, vaults: listVaults() });
}

/**
 * POST /api/launcher/update — run `dreamcontext update` inside a registered
 * project to refresh its installed skills/agents/hooks to the running CLI's
 * shipped version (the per-project counterpart to a CLI upgrade). Mutation;
 * behind the CSRF guard. STRICT-PICK: only `name` is read. Spawns the bundled
 * CLI in a child process with an explicit `cwd` (the same no-shell pattern as
 * scaffold) — the long-lived server never mutates its own `process.cwd()`.
 */
export async function handleLauncherUpdate(
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
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    sendError(res, 400, 'invalid_name', 'name must be a non-empty string.');
    return;
  }
  const vault = listVaults().find((v) => v.name === name);
  if (!vault) {
    sendError(res, 400, 'unknown_vault', `No registered vault named "${name}".`);
    return;
  }
  const target = resolve(vault.path);
  if (!existsSync(target)) {
    sendError(res, 400, 'missing_vault', `Vault path no longer exists: ${target}`);
    return;
  }
  try {
    await defaultCliRunner(['update'], target);
    const latest = dreamcontextVersion();
    sendJson(res, 200, { ok: true, status: computeVaultStatus(vault, latest) });
  } catch (err) {
    console.error('[launcher] update failed:', err);
    const detail = err instanceof Error ? err.message : 'unknown error';
    sendError(res, 500, 'update_failed', `Update failed: ${detail}`);
  }
}

// ─── Full-machine upgrade (CLI + desktop app + every project, in one job) ────────
//
// The header "Update available" badge triggers this. It runs the SAME
// `dreamcontext upgrade --yes` the CLI exposes — npm-installs the latest CLI,
// updates the installed desktop app, then refreshes every registered project —
// as ONE background job the badge polls. Singleton: only one upgrade runs
// machine-wide at a time (it mutates the global npm install AND the shared .app
// bundle, so a second concurrent run would race). State is lost on server
// restart, which is fine — the on-disk result is what matters, and a re-poll
// after restart simply reports `idle`.

interface UpgradeRun {
  state: 'running' | 'done' | 'error';
  /** Combined stdout+stderr tail — a live log for the badge popover. */
  output: string;
  startedAt: number;
  endedAt?: number;
}
let upgradeRun: UpgradeRun | null = null;
/** Safety ceiling: npm install + app download + N project refreshes. */
const UPGRADE_MAX_MS = 12 * 60 * 1000;

/**
 * POST /api/launcher/upgrade — start (or no-op re-attach to) the one-shot full
 * upgrade. Mutation; behind the CSRF guard. Vault-agnostic. Returns immediately
 * with `{ ok, state: 'running' }`; progress is polled via `/upgrade/status`.
 *
 * The CLI is spawned inside an INTERACTIVE LOGIN shell (`$SHELL -ilc`) so `npm`
 * and `npx` resolve even when the desktop app was launched from Finder/Spotlight
 * (which do NOT inherit the user's interactive-shell PATH) — the same PATH fix
 * used by the agent-terminal and Sleepy capture. `$0`/`$1` are argv positionals,
 * never interpolated into the command string (no shell injection).
 */
export async function handleLauncherUpgrade(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  if (upgradeRun?.state === 'running') {
    sendJson(res, 200, { ok: true, state: 'running' });
    return;
  }
  const cliEntry = process.env.DREAMCONTEXT_CLI || process.argv[1];
  if (!cliEntry) {
    sendError(res, 500, 'no_cli', 'Could not locate the dreamcontext CLI entry to upgrade.');
    return;
  }

  const run: UpgradeRun = { state: 'running', output: '', startedAt: Date.now() };
  upgradeRun = run;

  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const child = spawn(
      shell,
      ['-ilc', 'exec "$0" "$1" upgrade --yes', process.execPath, cliEntry],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
    );
    // Keep only the tail so a chatty npm/update run can't grow memory unbounded.
    const append = (chunk: Buffer) => {
      run.output = (run.output + chunk.toString('utf-8')).slice(-8000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const guard = setTimeout(() => {
      if (run.state !== 'running') return;
      run.state = 'error';
      run.output = (run.output + '\n\nUpgrade timed out.').slice(-8000);
      run.endedAt = Date.now();
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, UPGRADE_MAX_MS);

    child.on('error', (err) => {
      clearTimeout(guard);
      if (run.state !== 'running') return;
      run.state = 'error';
      run.output = `Couldn't start the upgrade: ${err.message}`;
      run.endedAt = Date.now();
    });
    child.on('close', (code) => {
      clearTimeout(guard);
      if (run.state !== 'running') return;
      run.state = code === 0 ? 'done' : 'error';
      if (code !== 0 && !run.output.trim()) run.output = `Upgrade exited with code ${code}`;
      run.endedAt = Date.now();
    });
  } catch (err) {
    run.state = 'error';
    run.output = `Couldn't start the upgrade: ${err instanceof Error ? err.message : 'spawn failed'}`;
    run.endedAt = Date.now();
  }

  // Reflect the ACTUAL state: a synchronous spawn failure above already flipped run.state to
  // 'error', so don't hardcode 'running' (that made the badge show a spinner for one poll
  // cycle before /upgrade/status corrected it).
  sendJson(res, 200, { ok: run.state !== 'error', state: run.state });
}

/**
 * GET /api/launcher/upgrade/status — poll the background upgrade job. Returns
 * `idle` when none has run this server lifetime, else its live state + log tail.
 * Read-only, vault-agnostic.
 */
export async function handleLauncherUpgradeStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  if (!upgradeRun) {
    sendJson(res, 200, { state: 'idle', output: '' });
    return;
  }
  sendJson(res, 200, { state: upgradeRun.state, output: upgradeRun.output.trim() });
}

/**
 * POST /api/launcher/relaunch — relaunch the installed desktop app so a freshly
 * upgraded CLI/app bundle takes effect. Mutation; behind the CSRF guard.
 *
 * The frontend calls this, then closes its own window; closing the last window
 * quits the app, which tears down THIS server (via the parent-death watchdog +
 * Rust process-group reap). So we detach a `sleep 2 && open <app>` into its OWN
 * session (`detached` + `unref`) — a new process group that ESCAPES the reap —
 * which re-opens the swapped bundle after the old process has quit and released
 * it. No-op (reports `app_not_installed`) outside an installed app.
 */
export async function handleLauncherRelaunch(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const manifest = readAppManifest();
  const appPath = manifest?.path;
  if (!appPath || !existsSync(appPath)) {
    sendJson(res, 200, { ok: false, reason: 'app_not_installed' });
    return;
  }
  try {
    // `$0` is the bundle path positional — never interpolated into the string.
    const child = spawn('/bin/sh', ['-c', 'sleep 2; open "$0"', appPath], {
      detached: true,
      stdio: 'ignore',
    });
    // Detached + unref'd: a LATE (async) spawn 'error' has no listener otherwise and would
    // crash this long-lived server as an uncaughtException. Best-effort relaunch — there's
    // nothing to recover once detached, so just swallow it (matches the upgrade child above).
    child.on('error', () => { /* relaunch failed; the user reopens the app manually */ });
    child.unref();
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 200, { ok: false, reason: err instanceof Error ? err.message : 'spawn failed' });
  }
}

// ─── Federation graph (cross-vault relationship network) ────────────────────────
//
// The launcher renders an interactive network of all registered vaults and the
// "reads" edges between them. A directed edge A→B means "A reads B" — A's
// `--connected` recall reaches into B's corpus. Per the federation model
// (federation-recall.ts), that holds iff A's connection to B has direction
// `out` or `both` AND B is `shareable`. We surface BOTH the edge and the
// shareable state so the UI can flag a reads-edge whose target hasn't opted in.

export interface FederationEdge {
  /** Reader vault name (the source of the "reads" arrow). */
  source: string;
  /** Source vault that is read. */
  target: string;
  /** True when the target vault has opted into being read (`shareable`). */
  active: boolean;
}

/**
 * GET /api/launcher/federation-graph — nodes (every registered vault, with its
 * launcher status) + directed "reads" edges derived from each vault's
 * `out`/`both` connections. Read-only and vault-agnostic. Reciprocal edges
 * (A→B and B→A) are both emitted; the frontend renders the pair as a two-way link.
 */
export async function handleLauncherFederationGraph(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string | null,
): Promise<void> {
  const latest = dreamcontextVersion();
  const vaults = listVaults();
  const nodes = vaults.map((v) => computeVaultStatus(v, latest));
  const shareableByName = new Map(nodes.map((n) => [n.name, n.shareable]));
  const known = new Set(vaults.map((v) => v.name));

  const edges: FederationEdge[] = [];
  // Raw per-vault directions so the frontend can derive BOTH the live-read wires
  // (out/both + target shareable) and the digest-sync wires ("to listens to from"
  // = from out/both->to AND to in/both->from).
  const connections: { from: string; to: string; direction: ConnectionDirection }[] = [];
  const seen = new Set<string>();
  for (const v of vaults) {
    if (!existsSync(resolve(v.path))) continue; // a dead vault can't host live edges
    const conns = listConnections(join(resolve(v.path), '_dream_context'));
    for (const c of conns) {
      if (!known.has(c.vault)) continue; // peer no longer registered
      if (c.status === 'stale') continue;
      connections.push({ from: v.name, to: c.vault, direction: c.direction });
      // A "reads" edge: this vault reaches across `out`/`both` peers.
      if (c.direction !== 'out' && c.direction !== 'both') continue;
      const key = `${v.name} ${c.vault}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: v.name, target: c.vault, active: shareableByName.get(c.vault) === true });
    }
  }

  sendJson(res, 200, { nodes, edges, connections, latestVersion: latest });
}

/**
 * POST /api/launcher/connection — create a "reads" edge from one vault to another
 * ("from reads to"), stored as an `out` connection on the FROM vault. Mutation;
 * behind the CSRF guard. STRICT-PICK: only `from` and `to` are read. Validation
 * (unknown peer, self-connect) maps to 400 via `addConnection`'s `VaultError`.
 */
export async function handleLauncherConnectionCreate(
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
  const from = typeof body.from === 'string' ? body.from.trim() : '';
  const to = typeof body.to === 'string' ? body.to.trim() : '';
  if (!from || !to) {
    sendError(res, 400, 'invalid_body', 'from and to must be non-empty strings.');
    return;
  }
  const fromVault = listVaults().find((v) => v.name === from);
  if (!fromVault) {
    sendError(res, 400, 'unknown_vault', `No registered vault named "${from}".`);
    return;
  }
  const fromRoot = join(resolve(fromVault.path), '_dream_context');
  try {
    // Merge, don't clobber: if `from` already accepts `to` (`in`), adding the
    // read makes it `both` rather than overwriting the consent.
    const cur = dirToward(fromRoot, to);
    addConnection(fromRoot, from, to, addOut(cur?.dir ?? null), cur?.topics ?? null);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    if (err instanceof VaultError) {
      sendError(res, 400, 'invalid_connection', err.message);
      return;
    }
    console.error('[launcher] connection create failed:', err);
    sendError(res, 500, 'connection_failed', 'Failed to create connection.');
  }
}

/**
 * POST /api/launcher/connection/remove — drop the "reads" edge from `from` to
 * `to`. Mutation; behind the CSRF guard. STRICT-PICK. `removeConnection` is
 * idempotent and never throws, so removing a non-existent edge still 200s.
 */
export async function handleLauncherConnectionRemove(
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
  const from = typeof body.from === 'string' ? body.from.trim() : '';
  const to = typeof body.to === 'string' ? body.to.trim() : '';
  if (!from || !to) {
    sendError(res, 400, 'invalid_body', 'from and to must be non-empty strings.');
    return;
  }
  const fromVault = listVaults().find((v) => v.name === from);
  if (!fromVault) {
    sendError(res, 400, 'unknown_vault', `No registered vault named "${from}".`);
    return;
  }
  // resolveVaultContextRoot would re-validate the folder; we only need the path.
  const fromRoot = join(resolve(fromVault.path), '_dream_context');
  // Drop the A→B ordered relationship: remove A's `out` component (kills the
  // live read) AND B's `in` consent toward A (kills "B listens to A"). A's own
  // `in` toward B (a separate B→A relationship) is preserved.
  const a = dirToward(fromRoot, to);
  if (a) applyDir(fromRoot, from, to, dropOut(a.dir), a.topics);
  const toRoot = vaultRoot(to);
  if (toRoot) {
    const b = dirToward(toRoot, from);
    if (b) applyDir(toRoot, to, from, dropIn(b.dir), b.topics);
  }
  sendJson(res, 200, { ok: true, removed: true });
}

// ─── Direction algebra (out/in/both compose & decompose) ─────────────────────
// `out` = "I share to + read" the peer; `in` = "I accept the peer's digest".
// The launcher is cross-vault, so it can set BOTH sides of a consented sync in
// one action (a per-vault Settings panel can only edit its own side).
type Dir = 'out' | 'in' | 'both';
const addOut = (d: Dir | null): Dir => (d === 'in' || d === 'both' ? 'both' : 'out');
const addIn = (d: Dir | null): Dir => (d === 'out' || d === 'both' ? 'both' : 'in');
const dropOut = (d: Dir): Dir | null => (d === 'both' ? 'in' : d === 'in' ? 'in' : null);
const dropIn = (d: Dir): Dir | null => (d === 'both' ? 'out' : d === 'out' ? 'out' : null);

/** The vault's stored direction toward `peer` (+ its topics), or null. */
function dirToward(root: string, peer: string): { dir: Dir; topics: string[] | null } | null {
  const c = listConnections(root).find((x) => x.vault === peer);
  return c ? { dir: c.direction as Dir, topics: c.topics } : null;
}

/** Resolve a registered vault's `_dream_context` root, or null if unregistered. */
function vaultRoot(name: string): string | null {
  const v = listVaults().find((x) => x.name === name);
  return v ? join(resolve(v.path), '_dream_context') : null;
}

/** Set (or remove when `next` is null) `fromName`'s connection direction to `peer`. */
function applyDir(
  fromRoot: string,
  fromName: string,
  peer: string,
  next: Dir | null,
  topics: string[] | null,
): void {
  if (next === null) removeConnection(fromRoot, peer);
  else addConnection(fromRoot, fromName, peer, next, topics);
}

/**
 * POST /api/launcher/sync — establish a consented digest sync so `to` listens to
 * `from`'s changes: at sleep, `from` pushes its new knowledge into `to`'s inbox.
 * Sets BOTH sides atomically — `from`:out→to (share) AND `to`:in→from (consent).
 * Mutation; CSRF-guarded; STRICT-PICK (`from`, `to`). VaultError → 400.
 */
export async function handleLauncherSyncCreate(
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
  const from = typeof body.from === 'string' ? body.from.trim() : '';
  const to = typeof body.to === 'string' ? body.to.trim() : '';
  if (!from || !to) {
    sendError(res, 400, 'invalid_body', 'from and to must be non-empty strings.');
    return;
  }
  const fromRoot = vaultRoot(from);
  const toRoot = vaultRoot(to);
  if (!fromRoot) {
    sendError(res, 400, 'unknown_vault', `No registered vault named "${from}".`);
    return;
  }
  if (!toRoot) {
    sendError(res, 400, 'unknown_vault', `No registered vault named "${to}".`);
    return;
  }
  try {
    const a = dirToward(fromRoot, to);
    addConnection(fromRoot, from, to, addOut(a?.dir ?? null), a?.topics ?? null);
    const b = dirToward(toRoot, from);
    addConnection(toRoot, to, from, addIn(b?.dir ?? null), b?.topics ?? null);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    if (err instanceof VaultError) {
      sendError(res, 400, 'invalid_connection', err.message);
      return;
    }
    console.error('[launcher] sync create failed:', err);
    sendError(res, 500, 'sync_failed', 'Failed to enable sync.');
  }
}

/**
 * POST /api/launcher/sync/remove — stop `to` listening to `from` by dropping
 * `to`'s `in` consent toward `from`. Leaves `from`'s `out` (the live read) intact.
 * Idempotent; never throws. STRICT-PICK (`from`, `to`).
 */
export async function handleLauncherSyncRemove(
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
  const from = typeof body.from === 'string' ? body.from.trim() : '';
  const to = typeof body.to === 'string' ? body.to.trim() : '';
  if (!from || !to) {
    sendError(res, 400, 'invalid_body', 'from and to must be non-empty strings.');
    return;
  }
  const toRoot = vaultRoot(to);
  if (toRoot) {
    const b = dirToward(toRoot, from);
    if (b) applyDir(toRoot, to, from, dropIn(b.dir), b.topics);
  }
  sendJson(res, 200, { ok: true });
}

/**
 * POST /api/launcher/shareable — flip a vault's federation read gate so peers may
 * (or may not) recall its corpus. Mutation; behind the CSRF guard. STRICT-PICK:
 * `name` + boolean `shareable`. Lets the user enable sharing on a reads-edge's
 * target directly from the launcher graph (otherwise the edge is inert). Private
 * by default stays intact — this only changes the named vault on explicit action.
 */
export async function handleLauncherShareable(
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
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const shareable = body.shareable === true;
  if (!name) {
    sendError(res, 400, 'invalid_name', 'name must be a non-empty string.');
    return;
  }
  const vault = listVaults().find((v) => v.name === name);
  if (!vault) {
    sendError(res, 400, 'unknown_vault', `No registered vault named "${name}".`);
    return;
  }
  const root = resolve(vault.path);
  if (!existsSync(root)) {
    sendError(res, 400, 'missing_vault', `Vault path no longer exists: ${root}`);
    return;
  }
  try {
    updateSetupConfig(root, { shareable });
    sendJson(res, 200, { ok: true, name, shareable });
  } catch (err) {
    console.error('[launcher] shareable toggle failed:', err);
    sendError(res, 500, 'shareable_failed', 'Failed to update sharing.');
  }
}
