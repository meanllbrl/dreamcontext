import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { sendJson, sendError } from '../middleware.js';
import { listVaults } from '../../lib/vaults.js';

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

/** The interactive-shell features only exist inside the desktop app. */
function isDesktop(): boolean {
  return process.env.DREAMCONTEXT_DESKTOP === '1';
}

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
  sendJson(res, 200, {
    desktop,
    platform: process.platform,
    // Embedded terminal needs the desktop shell AND the native node-pty module.
    embeddedTerminal: desktop && process.platform !== 'win32' && (await hasNodePty()),
    // Launching the user's real terminal is macOS-only (osascript) today.
    openTerminal: desktop && process.platform === 'darwin',
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

// ─── Embedded terminal (WebSocket ↔ node-pty) ─────────────────────────────────

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
        startPtySession(ws, pty, projectRoot, bypass, theme);
      });
    })();
  });
}

function rejectUpgrade(socket: Duplex, code: number): void {
  const text = code === 403 ? 'Forbidden' : code === 400 ? 'Bad Request' : 'Not Implemented';
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function startPtySession(
  ws: import('ws').WebSocket,
  pty: typeof import('node-pty'),
  projectRoot: string,
  bypass: boolean,
  theme: 'light' | 'dark',
): void {
  const shell = process.env.SHELL || '/bin/zsh';
  const flag = bypass ? ' --permission-mode bypassPermissions' : '';
  // COLORFGBG hints the terminal's light/dark to TUI apps that read it: the trailing
  // field is the background (0 = dark, 15 = light). Combined with the webview's OSC
  // 10/11 colour replies, this lets Claude Code theme to our surface at spawn.
  const colorfgbg = theme === 'light' ? '0;15' : '15;0';
  // Interactive login shell (`-ilc`) so a Finder-launched app inherits the user's
  // PATH (where `claude` usually lives) — same reason the capture/chat pipelines use it.
  const term = pty.spawn(shell, ['-ilc', `exec claude${flag}`], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: projectRoot,
    env: { ...process.env, TERM: 'xterm-256color', COLORFGBG: colorfgbg } as Record<string, string>,
  }) as unknown as PtyLike;

  let alive = true;
  term.onData((data) => { if (ws.readyState === ws.OPEN) ws.send(data); });
  term.onExit(({ exitCode }) => {
    alive = false;
    if (ws.readyState === ws.OPEN) {
      try { ws.send(`\r\n\x1b[2m[claude exited with code ${exitCode}]\x1b[0m\r\n`); } catch { /* closing */ }
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
