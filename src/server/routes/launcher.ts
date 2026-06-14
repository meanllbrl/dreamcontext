import { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, readdirSync, statSync, createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
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
import { insertToJsonArray } from '../../lib/json-file.js';
import { today } from '../../lib/id.js';
import { randomUUID } from 'node:crypto';

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
  output: string;
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

// ─── Sleepy quick-capture ──────────────────────────────────────────────────────

/**
 * Build the headless-claude enrichment prompt for a captured note. The injection
 * keeps the run non-interactive (no follow-ups) — it just learns the note.
 * Exported for testing. The note is passed to claude as an ARGUMENT (never
 * interpolated into a shell string), so this string is injection-safe.
 */
export function buildCapturePrompt(note: string): string {
  return (
    `A quick-capture note was just saved to this project's dreamcontext memory:\n\n` +
    `"${note}"\n\n` +
    `Do NOT ask any follow-up questions. Review it and, if warranted, organize or ` +
    `enrich it into the appropriate dreamcontext knowledge/memory via the dreamcontext ` +
    `CLI WITHOUT duplicating the raw note. Then stop.`
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
  if (!text) {
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

  // (1) Instant, guaranteed capture — never lose the note even if claude fails.
  // Done IN-PROCESS (this server IS dreamcontext): a deterministic CHANGELOG
  // append, mirroring `memory remember`. We do NOT spawn a child CLI here — in a
  // packaged desktop app the resolvable CLI can be a stale/older global whose
  // `memory remember` differs or is absent, which surfaced as a "failed" capture.
  // A direct file write removes that whole class of failure.
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

  // (2) Best-effort enrichment via a headless claude run, TRACKED so the capture
  // bar can show a live spinner + Claude's response. Login shell resolves
  // `claude` from the user's PATH; the prompt is passed as the positional `$0`
  // (double-quoted in the script) so the note is never shell-interpreted.
  pruneCaptureRuns();
  const captureId = randomUUID();
  const run: CaptureRun = { state: 'running', output: '', startedAt: Date.now() };
  captureRuns.set(captureId, run);
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const child = spawn(shell, ['-lc', 'exec claude -p "$0"', buildCapturePrompt(text)], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const cap = (chunk: Buffer) => {
      // Keep only the tail so a chatty run can't grow memory unbounded.
      run.output = (run.output + chunk.toString('utf-8')).slice(-8000);
    };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    child.on('error', (err) => {
      // claude not on PATH / spawn failure — note is already saved; report it.
      run.state = 'error';
      run.output = run.output || `Couldn't start claude: ${err.message}`;
      run.endedAt = Date.now();
    });
    child.on('close', (code) => {
      if (run.state === 'running') {
        run.state = code === 0 ? 'done' : 'error';
        if (code !== 0 && !run.output) run.output = `claude exited with code ${code}`;
        run.endedAt = Date.now();
      }
    });
  } catch (err) {
    run.state = 'error';
    run.output = `Couldn't start claude: ${err instanceof Error ? err.message : 'spawn failed'}`;
    run.endedAt = Date.now();
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
