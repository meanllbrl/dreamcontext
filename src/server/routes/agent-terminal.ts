import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, statSync, chmodSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { sendJson, sendError } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { listVaults } from '../../lib/vaults.js';
import { trackChild } from '../lifecycle.js';

/**
 * Agent terminal — the in-app surface that runs the REAL, interactive Claude Code
 * (the TUI) inside the active vault, instead of a custom chat that re-implements a
 * slice of the agent. Two delivery paths share this file:
 *
 *  1. **Open in (external) Terminal** — `POST /api/agent/open-terminal` launches the
 *     user's real terminal app at the vault path running `claude`. Zero native deps,
 *     always available on macOS. The reliable fallback.
 *  2. **Embedded terminal** — a WebSocket-bridged `node-pty` running `claude` rendered
 *     by xterm.js in the webview (`/api/agent/terminal` upgrade). Full Claude Code
 *     parity (slash menu, skills, sub-agents, reasoning effort, real permission
 *     prompts) for free, because it IS the client.
 *
 * Both are **desktop-only** and **loopback-only** by design: an interactive shell is
 * powerful and must NEVER be reachable from the npm/browser/hosted dashboard build.
 * The desktop Rust shell exports `DREAMCONTEXT_DESKTOP=1`; every entry point here is
 * gated on it. `bypassPermissions` is OFF by default — the caller opts in explicitly,
 * and the UI shows a standing warning while it's armed.
 */

// ─── Gating ─────────────────────────────────────────────────────────────────

/**
 * node-pty 1.x ships prebuilt binaries, but npm's tarball extraction drops the
 * execute bit on macOS's `spawn-helper` — so `import('node-pty')` SUCCEEDS yet
 * `pty.spawn` then dies with `posix_spawnp failed`. Restore +x on every shipped
 * spawn-helper (prebuilds + any local build) before we rely on node-pty. Idempotent
 * and cheap; runs once. Survives any install path (dev link, `npm i -g`, app).
 */
function ensurePtyHelperExecutable(): void {
  try {
    const require = createRequire(import.meta.url);
    const root = dirname(dirname(require.resolve('node-pty'))); // …/node-pty/lib/index.js → …/node-pty
    const candidates: string[] = [join(root, 'build', 'Release', 'spawn-helper')];
    const prebuilds = join(root, 'prebuilds');
    if (existsSync(prebuilds)) {
      for (const d of readdirSync(prebuilds)) candidates.push(join(prebuilds, d, 'spawn-helper'));
    }
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      const mode = statSync(p).mode;
      if ((mode & 0o111) !== 0o111) chmodSync(p, mode | 0o755);
    }
  } catch { /* best-effort; a real spawn failure still degrades gracefully */ }
}

/** node-pty is a native module; it may be absent in the bundled-only first-run app. */
let ptyAvailable: boolean | null = null;
async function hasNodePty(): Promise<boolean> {
  if (ptyAvailable !== null) return ptyAvailable;
  try {
    await import('node-pty');
    ensurePtyHelperExecutable();
    ptyAvailable = true;
  } catch {
    ptyAvailable = false;
  }
  return ptyAvailable;
}

/** Bust the memoized node-pty probe so the next capabilities check re-imports
 *  (e.g. right after the in-app installer materialised node-pty on disk). */
function resetPtyCache(): void { ptyAvailable = null; }

/**
 * Is a command resolvable on the user's PATH, as the embedded terminal will see
 * it? We probe through the SAME interactive-login shell (`-ilc`) the PTY spawn
 * uses, so detection can't disagree with the real spawn — `claude` is commonly
 * added to PATH in `~/.zshrc` (e.g. `~/.local/bin`), which only `-i` sources.
 * `cmd` is an internal whitelist literal, never user input (no injection).
 */
function detectOnPath(cmd: 'claude' | 'npm', timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    let out = '';
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const child = spawn(shell, ['-ilc', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done(false); }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    child.on('error', () => done(false));
    child.on('close', () => done(out.trim().length > 0));
  });
}

// ─── Vault / path helpers ───────────────────────────────────────────────────

function projectRootOf(contextRoot: string): string {
  return contextRoot.endsWith('_dream_context') ? dirname(contextRoot) : contextRoot;
}

/**
 * Strict name-only vault resolver for WebSocket upgrades. The browser WebSocket API
 * cannot set the `X-Dreamcontext-Vault` header, so the upgrade carries `?vault=<name>`.
 * Mirrors `resolveRequestVault` in index.ts: rejects path-shaped / unknown values, never
 * calls resolve() on raw input (confused-deputy guard). Returns the project ROOT.
 */
function resolveVaultProjectRoot(name: string | null): string | null {
  if (!name) return null;
  if (/[/\\:.\x00]/.test(name)) return null;
  const v = listVaults().find((x) => x.name === name);
  if (!v || !existsSync(v.path)) return null;
  return v.path;
}

// ─── Capabilities ─────────────────────────────────────────────────────────────

/** GET /api/agent/capabilities — tells the UI which agent surfaces are usable here. */
export async function handleAgentCapabilities(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const desktop = isDesktop();
  // Probe the three prerequisites in parallel (only when desktop — they cost a
  // login-shell spawn each). `nodePty` gates the embedded renderer; `claudeCli`
  // gates whether the spawned shell can actually find `claude`; `npm` tells the
  // UI whether the in-app installer can even run.
  const [nodePty, claudeCli, npm] = desktop
    ? await Promise.all([hasNodePty(), detectOnPath('claude'), detectOnPath('npm')])
    : [false, false, false];
  sendJson(res, 200, {
    desktop,
    platform: process.platform,
    // Embedded terminal needs the desktop shell AND the native node-pty module.
    embeddedTerminal: desktop && process.platform !== 'win32' && nodePty,
    // Launching the user's real terminal is macOS-only (osascript) today.
    openTerminal: desktop && process.platform === 'darwin',
    // Prerequisite breakdown for the in-app Setup panel.
    nodePty,
    claudeCli,
    npm,
  });
}

// ─── Open in external Terminal (macOS) ────────────────────────────────────────

/** Escape a string for inclusion inside an AppleScript double-quoted literal. */
function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * POST /api/agent/open-terminal  { bypass?: boolean }
 * Opens Terminal.app at the vault's project root running an interactive `claude`.
 */
export async function handleOpenTerminal(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'The agent terminal is only available in the desktop app.');
    return;
  }
  if (process.platform !== 'darwin') {
    sendError(res, 501, 'unsupported_platform', 'Opening a terminal is currently macOS-only.');
    return;
  }

  let bypass = false;
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { bypass?: unknown };
      bypass = body.bypass === true;
    }
  } catch { /* empty/invalid body → defaults (bypass off) */ }

  const cwd = projectRootOf(contextRoot);
  // `cd <cwd> && exec claude [flags]` — cwd is a real on-disk path (validated by the
  // vault resolver upstream), single-quoted so spaces are safe. Run via login shell so
  // a Finder-launched terminal still finds `claude` on PATH.
  const flag = bypass ? ' --permission-mode bypassPermissions' : '';
  const shellCmd = `cd '${cwd.replace(/'/g, `'\\''`)}' && exec claude${flag}`;
  const appleScript = `tell application "Terminal"\n  activate\n  do script "${escapeForAppleScript(shellCmd)}"\nend tell`;

  try {
    const child = spawn('osascript', ['-e', appleScript], { stdio: 'ignore' });
    child.on('error', () => { /* surfaced via the 500 below only if synchronous */ });
    sendJson(res, 200, { ok: true, bypass });
  } catch (err) {
    sendError(res, 500, 'spawn_failed', err instanceof Error ? err.message : 'Could not open Terminal.');
  }
}

// ─── In-app prerequisite installer ────────────────────────────────────────────
//
// When the embedded terminal's prerequisites are missing — the `claude` CLI or the
// native `node-pty` module — the Setup panel offers a one-click install instead of
// only falling back to an external terminal. Installs run in the user's LOGIN shell
// (so a Finder-launched app sees their real nvm/brew PATH) and are tracked like the
// Sleepy capture runs: POST starts it + returns an id, the UI polls status.
//
// Trust model: identical to `ensure-cli.ts` / `open-terminal` — desktop-gated, and
// the package names are FIXED internal literals, never user input. The only body
// field is `target`, validated against a closed whitelist.

type InstallTarget = 'claude' | 'pty';

interface InstallRun {
  state: 'running' | 'done' | 'error';
  target: InstallTarget;
  /** Combined stdout+stderr tail — shown live, and as the detail on failure. */
  output: string;
  startedAt: number;
  endedAt?: number;
}

const installRuns = new Map<string, InstallRun>();
const INSTALL_RUN_TTL_MS = 10 * 60 * 1000;
const INSTALL_RUNS_MAX = 20;
const INSTALL_WATCHDOG_MS = 5 * 60 * 1000; // kill a wedged npm after 5 min

function pruneInstallRuns(): void {
  const now = Date.now();
  for (const [id, run] of installRuns) {
    if (run.endedAt && now - run.endedAt > INSTALL_RUN_TTL_MS) installRuns.delete(id);
  }
  while (installRuns.size > INSTALL_RUNS_MAX) {
    const oldest = installRuns.keys().next().value;
    if (oldest === undefined) break;
    installRuns.delete(oldest);
  }
}

/**
 * The package root of the running CLI (nearest ancestor with a package.json),
 * walking up from the entry module. `node-pty` is installed HERE so it resolves
 * from the bundled `dist/index.js` exactly as the runtime `import('node-pty')`
 * does (node walks up to `<root>/node_modules`). Returns null if not found.
 */
function cliPackageRoot(): string | null {
  let dir = process.argv[1] ? dirname(process.argv[1]) : '';
  if (!dir) return null;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Build the shell command + cwd for a target. Returns null if it can't be run here. */
function installPlan(target: InstallTarget): { script: string; cwd?: string } | null {
  if (target === 'claude') {
    // Anthropic's official Claude Code distribution.
    return { script: 'npm install -g @anthropic-ai/claude-code' };
  }
  // node-pty: install into the CLI's own package so the server can import it. Pinned
  // to the declared range; `--no-save` leaves the package manifest untouched.
  const root = cliPackageRoot();
  if (!root) return null;
  return { script: 'npm install node-pty@^1.1.0 --no-save', cwd: root };
}

/**
 * POST /api/agent/install  { target: 'claude' | 'pty' }
 * Starts a background install and returns `{ ok, runId }`. Poll status to track it.
 */
export async function handleAgentInstall(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'The in-app installer is only available in the desktop app.');
    return;
  }

  let target: unknown;
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    target = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { target?: unknown }).target : undefined;
  } catch { /* invalid body → 400 below */ }

  if (target !== 'claude' && target !== 'pty') {
    sendError(res, 400, 'bad_target', "Body must be { target: 'claude' | 'pty' }.");
    return;
  }
  const plan = installPlan(target);
  if (!plan) {
    sendError(res, 500, 'no_install_path', "Couldn't locate the CLI package to install node-pty into.");
    return;
  }

  pruneInstallRuns();
  const runId = randomUUID();
  const run: InstallRun = { state: 'running', target, output: '', startedAt: Date.now() };
  installRuns.set(runId, run);

  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const child = spawn(shell, ['-ilc', plan.script], {
      cwd: plan.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (chunk: Buffer) => { run.output = (run.output + chunk.toString('utf-8')).slice(-8000); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const watchdog = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      if (run.state === 'running') { run.state = 'error'; run.output += '\n[timed out after 5 min]'; run.endedAt = Date.now(); }
    }, INSTALL_WATCHDOG_MS);
    child.on('error', (err) => {
      clearTimeout(watchdog);
      if (run.state !== 'running') return;
      run.state = 'error';
      run.output = `Couldn't start install: ${err.message}. Run manually: ${plan.script}`;
      run.endedAt = Date.now();
    });
    child.on('close', (code) => {
      clearTimeout(watchdog);
      if (run.state !== 'running') return;
      if (code === 0) {
        // node-pty just landed: restore the spawn-helper +x bit and bust the probe
        // cache so the very next capabilities check reports the terminal as ready.
        if (target === 'pty') { ensurePtyHelperExecutable(); resetPtyCache(); }
        run.state = 'done';
      } else {
        run.state = 'error';
        if (!run.output.trim()) run.output = `Install exited with code ${code}. Run manually: ${plan.script}`;
      }
      run.endedAt = Date.now();
    });
  } catch (err) {
    run.state = 'error';
    run.output = `Couldn't start install: ${err instanceof Error ? err.message : 'spawn failed'}`;
    run.endedAt = Date.now();
  }

  sendJson(res, 200, { ok: true, runId });
}

/** GET /api/agent/install/status?id=<runId> — poll a background install. */
export async function handleAgentInstallStatus(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const id = url.searchParams.get('id') ?? '';
  const run = id ? installRuns.get(id) : undefined;
  if (!run) { sendJson(res, 200, { state: 'unknown', output: '' }); return; }
  sendJson(res, 200, { state: run.state, target: run.target, output: run.output.trim() });
}

// ─── Embedded terminal (WebSocket ↔ node-pty) ─────────────────────────────────

/** What the PTY runs: the real Claude Code agent, or a plain vault-scoped login shell. */
type PtyKind = 'agent' | 'shell';

interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/**
 * Attach the agent-terminal WebSocket upgrade handler to the shared http server.
 * Path: `/api/agent/terminal?vault=<name>&bypass=0|1`. No-ops (rejects the upgrade)
 * unless the desktop gate is on, the request is loopback, and node-pty is present.
 */
export function attachAgentTerminal(server: Server): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(req.url || '/', `http://${req.headers.host}`); }
    catch { socket.destroy(); return; }
    if (url.pathname !== '/api/agent/terminal') return; // not ours — leave for others

    // Hard gates. Reject (don't just ignore) so a misconfigured client sees the close.
    const remote = req.socket.remoteAddress || '';
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isDesktop() || !loopback) { rejectUpgrade(socket, 403); return; }

    const projectRoot = resolveVaultProjectRoot(url.searchParams.get('vault'));
    if (!projectRoot) { rejectUpgrade(socket, 400); return; }
    const bypass = url.searchParams.get('bypass') === '1';
    const theme: 'light' | 'dark' = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
    // `kind=shell` runs a plain interactive login shell (the same terminal the user
    // would open anyway, scoped to the vault) instead of `exec claude`. Any other value
    // — including absent — is the default Claude agent. Shell sessions ignore the
    // bypass/resume/session-id machinery (a shell has no permission model or conversation).
    const kind: PtyKind = url.searchParams.get('kind') === 'shell' ? 'shell' : 'agent';
    // Conversation continuity across an app reopen: `sessionId` pins a NEW conversation to
    // a client-generated UUID (`claude --session-id`); `resume` reopens that exact prior
    // conversation (`claude --resume`). Both are STRICT-UUID-validated before they ever
    // touch the shell command string, so a non-UUID is dropped and neither can inject.
    const sessionId = sanitizeUuid(url.searchParams.get('sessionId'));
    const resumeId = sanitizeUuid(url.searchParams.get('resume'));
    // Model chosen in the composer bar (`claude --model <id>`). Strictly sanitized to a
    // whitelist charset before it can touch the shell command, so a hostile value is
    // dropped rather than injected. Empty → no flag (Claude Code's own default).
    const model = sanitizeModel(url.searchParams.get('model'));
    // Reasoning effort (`claude --effort <level>`) — whitelist-gated to the documented set.
    const effort = sanitizeEffort(url.searchParams.get('effort'));

    void (async () => {
      let pty: typeof import('node-pty');
      let WebSocketServer: typeof import('ws').WebSocketServer;
      try {
        pty = await import('node-pty');
        ensurePtyHelperExecutable();
        ({ WebSocketServer } = await import('ws'));
      } catch { rejectUpgrade(socket, 501); return; }

      const wss = new WebSocketServer({ noServer: true });
      wss.handleUpgrade(req, socket, head, (ws) => {
        startPtySession(ws, pty, projectRoot, bypass, theme, sessionId, resumeId, kind, model, effort);
      });
    })();
  });
}

function rejectUpgrade(socket: Duplex, code: number): void {
  const text = code === 403 ? 'Forbidden' : code === 400 ? 'Bad Request' : 'Not Implemented';
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Strict UUID gate. Returns the value only when it is a canonical UUID (hex + hyphens,
 *  no shell metacharacters), else '' — so a resume/session id can be interpolated into the
 *  `claude` shell command with zero injection risk. */
function sanitizeUuid(v: string | null): string {
  return v && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v) ? v : '';
}

/** Strict model-token gate. Claude Code's `--model` takes an alias (`opus`/`sonnet`/
 *  `haiku`) or a full model id — all of which are `[A-Za-z0-9._-]`. Anything with a shell
 *  metacharacter, whitespace, or over 64 chars is rejected to '' (no flag), so the value is
 *  safe to interpolate into the `claude` shell command. Never trusts the client. */
function sanitizeModel(v: string | null): string {
  return v && v.length <= 64 && /^[A-Za-z0-9._-]+$/.test(v) ? v : '';
}

/** Effort-level gate. `claude --effort` accepts exactly this documented set; anything else
 *  (including empty) → '' (no flag), so the value is safe to interpolate unquoted. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
function sanitizeEffort(v: string | null): string {
  return v && EFFORT_LEVELS.includes(v) ? v : '';
}

/**
 * Does `claude` actually have a stored transcript for this conversation id? Claude Code
 * persists each conversation at `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`, but
 * ONLY after the first turn — a tab that was opened and never used has NO transcript. So
 * `claude --resume <id>` on such an id fails with "No conversation found with session ID".
 * We scan the project dirs for `<id>.jsonl` (the uuid is globally unique, so we needn't
 * reproduce claude's exact cwd-slug encoding) and only `--resume` when it truly exists;
 * otherwise we start fresh PINNED to that id so the tab stays resumable going forward.
 * `id` is a pre-validated UUID (sanitizeUuid), so the filename can't escape the dir.
 */
function findTranscriptPath(id: string): string | null {
  if (!id) return null;
  try {
    const base = join(homedir(), '.claude', 'projects');
    if (!existsSync(base)) return null;
    for (const dir of readdirSync(base)) {
      const p = join(base, dir, `${id}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return null;
}

function claudeConversationExists(id: string): boolean {
  return findTranscriptPath(id) !== null;
}

// ─── Auto-title (Haiku names a tab from the session's first user message) ──────
//
// Every agent tab is pinned to a known conversation UUID, and Claude Code writes
// that conversation's transcript to `~/.claude/projects/<slug>/<uuid>.jsonl` — so
// we never touch the raw PTY byte-stream to learn what the user asked. We read the
// FIRST real user message from the transcript and let Haiku turn it into a short
// tab title. Cheap (one Haiku `-p` call), and isolated: run in the home dir, NOT
// the vault, so the project's SessionStart hook / brain preload never fires.

/**
 * Pull the first genuine user message out of a Claude Code transcript JSONL. Skips
 * tool results and the `<...>`-wrapped system-reminder / command-stub lines so the
 * title reflects what the human actually typed. Returns null if none is found yet.
 */
function firstUserMessage(jsonlPath: string): string | null {
  let raw: string;
  try { raw = readFileSync(jsonlPath, 'utf-8'); } catch { return null; }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj: { type?: unknown; role?: unknown; message?: { role?: unknown; content?: unknown } };
    try { obj = JSON.parse(s); } catch { continue; }
    const role = obj?.message?.role ?? obj?.role;
    if (obj?.type !== 'user' && role !== 'user') continue;
    const content = obj?.message?.content ?? (obj as { content?: unknown }).content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((c): c is { text: string } => !!c && typeof (c as { text?: unknown }).text === 'string')
        .map((c) => c.text)
        .join(' ');
    }
    text = text.trim();
    if (!text) continue;
    // Skip tool-result echoes and reminder/command wrappers — not the user's ask.
    if (text.startsWith('<')) continue;
    return text.slice(0, 800);
  }
  return null;
}

/** Trim Haiku's reply to a clean tab title: one line, no wrapping quotes/markdown,
 *  no trailing punctuation, ≤7 words / 52 chars. The cap is generous so the title
 *  can stay specific and descriptive rather than clipped to a vague label. Returns
 *  null if nothing usable. */
function sanitizeTitle(raw: string): string | null {
  let t = raw.replace(/[\r\n]+/g, ' ').trim();
  t = t.replace(/^["'`*]+/, '').replace(/["'`*.]+$/, '').trim();
  t = t.split(/\s+/).slice(0, 7).join(' ');
  if (t.length > 52) t = t.slice(0, 52).trim();
  return t.length >= 2 ? t : null;
}

/** One-shot Haiku call that returns a short tab title for `message`, or null. Runs
 *  headless (`claude --model haiku -p`) in `cwd`; `$0` is a positional (no injection). */
function generateTitle(message: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    const prompt =
      'You name terminal tabs so a user can tell many open tabs apart at a glance. ' +
      'Read the user\'s first request to a coding agent and reply with ONLY a tab title in Title Case that is specific and clearly describes the actual task — name the concrete thing being worked on, not a vague category. ' +
      '3 to 6 words, no quotes, no punctuation, no trailing period, max 48 characters.\n\nRequest:\n' +
      message;
    let out = '';
    let settled = false;
    const child = spawn(shell, ['-ilc', 'exec claude --model haiku -p "$0"', prompt], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* gone */ }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 30_000);
    child.stdout?.on('data', (c: Buffer) => { out = (out + c.toString('utf-8')).slice(0, 500); });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? sanitizeTitle(out) : null));
  });
}

/**
 * POST /api/agent/title  { claudeId }
 * Returns `{ title }` — a Haiku-generated tab title from the session's first user
 * message — or `{ title: null }` if there's no transcript/message yet or Haiku
 * failed. Desktop-gated + vault-scoped (same posture as /agent/drop). Idempotent
 * and side-effect-free: the client decides whether to apply the rename.
 */
export async function handleAgentTitle(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Auto-title is only available in the desktop app.');
    return;
  }
  let claudeId = '';
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { claudeId?: unknown };
      claudeId = sanitizeUuid(typeof body.claudeId === 'string' ? body.claudeId : null);
    }
  } catch { /* invalid body → 400 below */ }
  if (!claudeId) {
    sendError(res, 400, 'bad_id', 'Body must be { claudeId: <uuid> }.');
    return;
  }
  const path = findTranscriptPath(claudeId);
  if (!path) { sendJson(res, 200, { title: null, reason: 'no_transcript' }); return; }
  const message = firstUserMessage(path);
  if (!message) { sendJson(res, 200, { title: null, reason: 'no_message' }); return; }
  // Home dir, not the vault: a titling call must not fire the project's SessionStart
  // brain preload — keep it lean.
  const title = await generateTitle(message, homedir());
  sendJson(res, 200, { title });
}

// ─── Model + effort config (sourced from the Claude CLI's own state) ───────────
//
// The composer's model/effort pickers reflect what the CLI actually offers and what a
// session is actually running — never a hardcoded guess:
//   • available models   → the base aliases (opus/sonnet/haiku) UNION the CLI's own
//                           `additionalModelOptionsCache` in `~/.claude.json` (e.g. Fable).
//   • available efforts   → parsed from `claude --help` (`--effort <level> (low, …, max)`).
//   • the user's defaults → `~/.claude/settings.json` (`model`, `effortLevel`).
//   • a session's CURRENT model → the latest `message.model` in its transcript.

/** Map any full model id / alias to our short alias bucket (opus/sonnet/haiku/fable). */
function modelAlias(full: string): string {
  const s = (full || '').toLowerCase();
  if (s.includes('opus')) return 'opus';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('haiku')) return 'haiku';
  if (s.includes('fable')) return 'fable';
  return full || '';
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>; } catch { return null; }
}

/** Effort levels straight from `claude --help` (the source of truth), with the documented
 *  set as a fallback if the help text ever can't be read/parsed. */
function parseEffortsFromCli(): Promise<string[]> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    let out = '';
    let settled = false;
    const done = (v: string[]) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const child = spawn(shell, ['-ilc', 'claude --help'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done([...EFFORT_LEVELS]); }, 8000);
    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    child.on('error', () => done([...EFFORT_LEVELS]));
    child.on('close', () => {
      const m = /--effort\s+<level>[\s\S]{0,160}?\(([^)]+)\)/.exec(out);
      const list = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
      done(list.length ? list : [...EFFORT_LEVELS]);
    });
  });
}

interface ModelOpt { id: string; label: string; }
interface ModelConfig { models: ModelOpt[]; efforts: string[]; defaultModel: string; defaultEffort: string; }

// Only the STATIC parts are cached for the server's lifetime: the model list (from the CLI's
// `.claude.json` cache) and the effort levels (parsed from `claude --help`, an expensive spawn).
// These change only across CLI versions. The DEFAULTS (which model/effort the user is currently
// on) are read LIVE on every request — a `/model` or `/effort` switch persists to
// `~/.claude/settings.json`, and we must reflect it without a server restart. Caching the
// defaults was the bug behind the composer being frozen at opus/high.
interface StaticModelConfig { models: ModelOpt[]; efforts: string[]; }
let staticModelConfigCache: StaticModelConfig | null = null;

async function buildStaticModelConfig(): Promise<StaticModelConfig> {
  if (staticModelConfigCache) return staticModelConfigCache;
  const globalJson = readJsonSafe(join(homedir(), '.claude.json')) ?? {};
  const base: ModelOpt[] = [
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
    { id: 'fable', label: 'Fable' },
  ];
  // Extra models the CLI itself has cached as available (e.g. Fable), deduped by alias.
  const cache = globalJson.additionalModelOptionsCache;
  const extras: ModelOpt[] = Array.isArray(cache)
    ? cache
        .map((m) => { const v = String((m as { value?: unknown })?.value ?? ''); const id = modelAlias(v); return { id, label: String((m as { label?: unknown })?.label ?? id) }; })
        .filter((m) => m.id)
    : [];
  const seen = new Set(base.map((m) => m.id));
  const models = [...base];
  for (const e of extras) if (!seen.has(e.id)) { seen.add(e.id); models.push(e); }
  const efforts = await parseEffortsFromCli();
  staticModelConfigCache = { models, efforts };
  return staticModelConfigCache;
}

async function buildModelConfig(): Promise<ModelConfig> {
  const { models, efforts } = await buildStaticModelConfig();
  // Read the user's CURRENT Claude Code defaults live (never cached).
  const settings = readJsonSafe(join(homedir(), '.claude', 'settings.json')) ?? {};
  const defaultEffort = typeof settings.effortLevel === 'string' && efforts.includes(settings.effortLevel)
    ? settings.effortLevel
    : (efforts.includes('high') ? 'high' : efforts[0] ?? 'high');
  const defaultModel = modelAlias(String(settings.model ?? 'opus')) || 'opus';
  return { models, efforts, defaultModel, defaultEffort };
}

/** GET /api/agent/model-config — the model/effort options + the user's CLI defaults. */
export async function handleAgentModelConfig(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isDesktop()) { sendError(res, 403, 'desktop_only', 'Agent model config is desktop-only.'); return; }
  sendJson(res, 200, await buildModelConfig());
}

/** The most recent `message.model` recorded in a transcript, as an alias, or null. */
function latestTranscriptModel(jsonlPath: string): string | null {
  let raw: string;
  try { raw = readFileSync(jsonlPath, 'utf-8'); } catch { return null; }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s) continue;
    let obj: { message?: { model?: unknown } };
    try { obj = JSON.parse(s); } catch { continue; }
    const model = obj?.message?.model;
    if (typeof model === 'string' && model) return modelAlias(model);
  }
  return null;
}

/** GET /api/agent/session-model?claudeId=<uuid> — the model a session is CURRENTLY running,
 *  read from its transcript (so a mid-session `/model` switch is reflected). null if unknown. */
export async function handleAgentSessionModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isDesktop()) { sendJson(res, 200, { model: null }); return; }
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const id = sanitizeUuid(url.searchParams.get('claudeId'));
  const path = id ? findTranscriptPath(id) : null;
  sendJson(res, 200, { model: path ? latestTranscriptModel(path) : null });
}

// ─── Per-session context-window + cost (read from the transcript's token usage) ───────
//
// Claude Code records `message.usage` (input / output / cache-write / cache-read tokens)
// on every assistant turn. From that we derive two live numbers for the composer strip:
//   • context tokens → the LAST turn's total footprint (input + both cache buckets + output)
//     ≈ how full the context window currently is.
//   • cost (USD)     → the CUMULATIVE spend priced AT PUBLIC API RATES, per the model each
//     turn actually ran on. This is an ESTIMATE "if you paid per token" — a Max/Pro
//     subscription is flat-rate, so it's a what-if, not a bill.

interface TokenPrice { in: number; out: number; cacheWrite: number; cacheRead: number }
/** Public API list prices, USD per MILLION tokens (best-effort; Fable priced at Opus tier as
 *  a placeholder until its public rate is wired in). Cache-write is the 5-minute rate. */
const MODEL_PRICING: Record<string, TokenPrice> = {
  opus:   { in: 15,   out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { in: 3,    out: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  haiku:  { in: 1,    out: 5,  cacheWrite: 1.25,  cacheRead: 0.1 },
  fable:  { in: 15,   out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
};

interface SessionStats { contextTokens: number | null; contextLimit: number | null; costUsd: number | null }
const EMPTY_STATS: SessionStats = { contextTokens: null, contextLimit: null, costUsd: null };

function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

/** Parse a transcript's per-turn `usage` into { contextTokens, contextLimit, costUsd }. */
function computeSessionStats(jsonlPath: string): SessionStats {
  let raw: string;
  try { raw = readFileSync(jsonlPath, 'utf-8'); } catch { return EMPTY_STATS; }
  let costUsd = 0;
  let contextTokens: number | null = null;
  let lastModel = '';
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj: { message?: { usage?: Record<string, unknown>; model?: unknown } };
    try { obj = JSON.parse(s); } catch { continue; }
    const u = obj?.message?.usage;
    if (!u || typeof u !== 'object') continue;
    const model = typeof obj.message?.model === 'string' && obj.message.model ? obj.message.model : lastModel;
    lastModel = model || lastModel;
    const inp = num(u.input_tokens);
    const out = num(u.output_tokens);
    const cw = num(u.cache_creation_input_tokens);
    const cr = num(u.cache_read_input_tokens);
    const p = MODEL_PRICING[modelAlias(model)] ?? MODEL_PRICING.opus;
    costUsd += (inp * p.in + cw * p.cacheWrite + cr * p.cacheRead + out * p.out) / 1_000_000;
    // The context window is what the MOST RECENT turn carried — not a running sum.
    contextTokens = inp + cw + cr + out;
  }
  if (contextTokens === null) return EMPTY_STATS;
  // Claude Code's model ids carry a `[1m]` suffix for the 1M-context variants; fall back to
  // the standard 200K, and bump to 1M if the observed footprint already exceeds 200K.
  const contextLimit = /1m/i.test(lastModel) || contextTokens > 200_000 ? 1_000_000 : 200_000;
  return { contextTokens, contextLimit, costUsd };
}

/** GET /api/agent/session-stats?claudeId=<uuid> — the session's live context-window
 *  footprint + cumulative API-rate cost estimate, from its transcript. Nulls if unknown. */
export async function handleAgentSessionStats(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isDesktop()) { sendJson(res, 200, EMPTY_STATS); return; }
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const id = sanitizeUuid(url.searchParams.get('claudeId'));
  const path = id ? findTranscriptPath(id) : null;
  sendJson(res, 200, path ? computeSessionStats(path) : EMPTY_STATS);
}

function startPtySession(
  ws: import('ws').WebSocket,
  pty: typeof import('node-pty'),
  projectRoot: string,
  bypass: boolean,
  theme: 'light' | 'dark',
  sessionId: string,
  resumeId: string,
  kind: PtyKind = 'agent',
  model = '',
  effort = '',
): void {
  const shell = process.env.SHELL || '/bin/zsh';
  const flag = bypass ? ' --permission-mode bypassPermissions' : '';
  // `--model <id>` / `--effort <level>` when picked (both whitelist-sanitized upstream, so
  // shell-safe). Agent-only — a shell has neither a model nor an effort.
  const modelFlag = model ? ` --model ${model}` : '';
  const effortFlag = effort ? ` --effort ${effort}` : '';
  // Conversation continuity (both ids are pre-validated UUIDs → shell-safe):
  //  • resume requested AND a transcript exists → `--resume <id>` (reopen the real chat).
  //  • resume requested but NO transcript (tab was never used, or claude state was lost)
  //    → fall back to `--session-id <id>`: start FRESH but pinned to the same id, so the
  //    tab keeps working and becomes resumable once used — instead of `--resume` erroring
  //    with "No conversation found with session ID".
  //  • fresh tab → `--session-id <sessionId>` pins it for a future resume.
  const resumable = resumeId && claudeConversationExists(resumeId);
  const pinId = resumeId || sessionId; // prefer the resume id so a fresh-fallback keeps it
  const idArg = resumable ? ` --resume ${resumeId}` : pinId ? ` --session-id ${pinId}` : '';
  // COLORFGBG hints the terminal's light/dark to TUI apps that read it: the trailing
  // field is the background (0 = dark, 15 = light). Combined with the webview's OSC
  // 10/11 colour replies, this lets Claude Code theme to our surface at spawn.
  const colorfgbg = theme === 'light' ? '0;15' : '15;0';
  // Interactive login shell (`-ilc`) so a Finder-launched app inherits the user's PATH
  // (where `claude` usually lives) — same reason the capture/chat pipelines use it.
  //  • agent → `-ilc 'exec claude …'`: replace the shell with Claude Code.
  //  • shell → `-il`: a plain interactive login shell (the vault-scoped terminal the user
  //    would open anyway) — no `-c`, no claude, no bypass/resume flags.
  const shellArgs = kind === 'shell' ? ['-il'] : ['-ilc', `exec claude${idArg}${modelFlag}${effortFlag}${flag}`];
  const term = pty.spawn(shell, shellArgs, {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: projectRoot,
    env: { ...process.env, TERM: 'xterm-256color', COLORFGBG: colorfgbg } as Record<string, string>,
  }) as unknown as PtyLike;

  let alive = true;
  // Reap this PTY's `claude` process if the whole server shuts down (parent-death
  // watchdog / SIGTERM) — otherwise it would orphan to launchd. Untracked on exit.
  const untrack = trackChild(() => { try { term.kill(); } catch { /* gone */ } });
  term.onData((data) => { if (ws.readyState === ws.OPEN) ws.send(data); });
  term.onExit(({ exitCode }) => {
    alive = false;
    untrack();
    if (ws.readyState === ws.OPEN) {
      const what = kind === 'shell' ? 'shell' : 'claude';
      try { ws.send(`\r\n\x1b[2m[${what} exited with code ${exitCode}]\x1b[0m\r\n`); } catch { /* closing */ }
      ws.close();
    }
  });

  ws.on('message', (raw: Buffer | string) => {
    if (!alive) return;
    const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
    // Control frames are JSON ({type:'input'|'resize'}); anything else is raw input.
    if (str.startsWith('{')) {
      try {
        const msg = JSON.parse(str) as { type?: string; data?: string; cols?: number; rows?: number };
        if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          term.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0));
          return;
        }
        if (msg.type === 'input' && typeof msg.data === 'string') { term.write(msg.data); return; }
      } catch { /* not control JSON — fall through to raw */ }
    }
    term.write(str);
  });

  const teardown = () => { if (alive) { alive = false; try { term.kill(); } catch { /* already dead */ } } };
  ws.on('close', teardown);
  ws.on('error', teardown);
}
