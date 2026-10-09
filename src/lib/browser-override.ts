import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A chat's Playwright browser runs HEADLESS, with a side door the Chat view can watch through.
 *
 * ── The problem ──────────────────────────────────────────────────────────────────────────
 * `@playwright/mcp` opens a HEADED Chrome by default. Every `browser_navigate` from an agent in
 * the desktop app therefore put a Chrome window in front of the owner and took the keyboard
 * away from whatever they were typing, and what the browser was doing could only be seen by
 * looking at that window, outside dreamcontext.
 *
 * ── The fix, measured before it was built (2026-10-08, CLI 2.x, @playwright/mcp latest) ─────
 *  1. A `--mcp-config` server REPLACES a same-named server from every other scope (project
 *     `.mcp.json`, local, user): only the dynamic one starts, and the tool names stay
 *     `mcp__<name>__*`, so permission rules and habits keep matching. Between two
 *     `--mcp-config` files the LATER one wins, so this file rides last.
 *  2. `--headless` plus a config whose `browser.launchOptions.args` carries
 *     `--remote-debugging-port=<n>` keeps the MCP's own default browser (system Chrome) and
 *     opens a CDP endpoint beside Playwright's pipe. Chrome only exists once the agent's first
 *     browser tool call launches it, so a chat that never browses pays nothing.
 *  3. `Page.startScreencast` over that endpoint delivers JPEG frames on every paint
 *     (`src/server/browser-mirror.ts`). No window, no focus change.
 *
 * ── What is reused and what is not ───────────────────────────────────────────────────────
 * A server the OWNER configured (user or local scope, `~/.claude.json`) keeps its command,
 * args and env: a pinned version or a `--user-data-dir` is theirs. A server from the project's
 * `.mcp.json` is a file anyone with commit access wrote, and Claude Code asks before running
 * it; re-emitting its command through `--mcp-config` would skip that approval. So a project
 * server is recognised only when it already names the official package, and is replaced by
 * the canonical `npx -y @playwright/mcp@latest` with no env of its own.
 *
 * A server that attaches to an EXISTING browser (`--cdp-endpoint`, `--extension`) is left
 * alone: the owner chose a visible browser on purpose.
 */

/** The official package, as a substring of a command line. Any version tag matches. */
const OFFICIAL = '@playwright/mcp';

/** Flags that point the MCP at a browser it does not own. Such a server is not overridden. */
const ATTACH_FLAGS = ['--cdp-endpoint', '--extension', '--remote-endpoint'];

type RawServer = Record<string, unknown>;

/** One Playwright server as the session would resolve it, with the scope it came from. */
export interface PlaywrightServer {
  name: string;
  scope: 'local' | 'project' | 'user';
  raw: RawServer;
}

/** What a spawn carries: the `--mcp-config` file, the CDP port it opens, the server name. */
export interface BrowserOverride {
  configPath: string;
  port: number;
  server: string;
  /** Removes the per-spawn files. Safe to call more than once. */
  dispose: () => void;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function stringArgs(raw: RawServer): string[] {
  return Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [];
}

/** A stdio server that runs the official Playwright MCP. */
export function isPlaywrightServer(raw: RawServer): boolean {
  if (raw.type !== undefined && raw.type !== 'stdio') return false;
  const command = typeof raw.command === 'string' ? raw.command : '';
  return [command, ...stringArgs(raw)].some((part) => part.includes(OFFICIAL));
}

/** True when the server drives a browser somebody else launched. */
export function attachesToExistingBrowser(raw: RawServer): boolean {
  return stringArgs(raw).some((a) => ATTACH_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
}

function serversIn(record: Record<string, unknown> | null): Record<string, RawServer> {
  const out: Record<string, RawServer> = {};
  for (const [name, raw] of Object.entries(record ?? {})) {
    const r = asRecord(raw);
    if (r) out[name] = r;
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | null {
  try { return asRecord(JSON.parse(readFileSync(path, 'utf-8'))); } catch { return null; }
}

/**
 * The Playwright server this project's session would start, in Claude Code's own precedence
 * (local, then project, then user). Null when there is none, or when the winning definition
 * attaches to an existing browser.
 */
export function findPlaywrightServer(projectRoot: string, home: string = homedir()): PlaywrightServer | null {
  const claudeJson = readJson(join(home, '.claude.json'));
  const local = serversIn(asRecord(asRecord(asRecord(claudeJson?.projects)?.[projectRoot])?.mcpServers));
  const project = serversIn(asRecord(readJson(join(projectRoot, '.mcp.json'))?.mcpServers));
  const user = serversIn(asRecord(claudeJson?.mcpServers));

  // A name in a higher scope shadows the same name below it, exactly as the CLI resolves it:
  // a local `playwright` that is NOT Playwright hides a project one that is.
  const seen = new Set<string>();
  for (const [scope, servers] of [['local', local], ['project', project], ['user', user]] as const) {
    for (const [name, raw] of Object.entries(servers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!isPlaywrightServer(raw)) continue;
      if (attachesToExistingBrowser(raw)) return null;
      return { name, scope, raw };
    }
  }
  return null;
}

/**
 * The server definition the spawn carries in place of `found`: headless, with `configFile` as
 * its config. Pure, so the security rule above is a unit test, not a comment.
 */
export function overrideDefinition(found: PlaywrightServer, configFile: string): RawServer {
  if (found.scope === 'project') {
    return { type: 'stdio', command: 'npx', args: ['-y', `${OFFICIAL}@latest`, '--headless', '--config', configFile] };
  }
  const args: string[] = [];
  const theirs = stringArgs(found.raw);
  for (let i = 0; i < theirs.length; i += 1) {
    const a = theirs[i];
    if (a === '--headless' || a === '--headed') continue;
    // Their own config is folded into ours (`mergedConfig`), so ours is the only one passed.
    if (a === '--config') { i += 1; continue; }
    if (a.startsWith('--config=')) continue;
    args.push(a);
  }
  args.push('--headless', '--config', configFile);
  const out: RawServer = { ...found.raw, type: 'stdio', args };
  return out;
}

/** The owner's own `--config` file, when their (non-project) definition names one. */
function ownConfigPath(found: PlaywrightServer): string | null {
  if (found.scope === 'project') return null;
  const args = stringArgs(found.raw);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--config' && args[i + 1]) return args[i + 1];
    if (args[i].startsWith('--config=')) return args[i].slice('--config='.length);
  }
  return null;
}

/**
 * The MCP config file body: the owner's own config (if any) with one launch argument added.
 * Any remote-debugging flag of theirs is replaced, never doubled: Chrome honours one port.
 */
export function mergedConfig(base: Record<string, unknown> | null, port: number): Record<string, unknown> {
  const root = { ...(base ?? {}) };
  const browser = { ...(asRecord(root.browser) ?? {}) };
  const launch = { ...(asRecord(browser.launchOptions) ?? {}) };
  const args = Array.isArray(launch.args) ? launch.args.filter((a): a is string => typeof a === 'string') : [];
  launch.args = [...args.filter((a) => !a.startsWith('--remote-debugging-port')), `--remote-debugging-port=${port}`];
  launch.headless = true;
  browser.launchOptions = launch;
  root.browser = browser;
  return root;
}

/**
 * A free loopback port, asked of the OS. The spawn path is synchronous, so the question runs
 * in a child (~50 ms, only for a project that has a Playwright server). The port is free at
 * the moment of asking; if something else binds it before Chrome does, Chrome logs and goes
 * on without the side door, and the mirror refuses whatever answers there instead
 * (`browser-mirror.ts` checks the shape of `/json/version`).
 */
export function freeLoopbackPort(): number | null {
  const probe = spawnSync(process.execPath, ['-e',
    "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});",
  ], { encoding: 'utf-8', timeout: 3000 });
  const port = Number.parseInt(probe.stdout ?? '', 10);
  return Number.isInteger(port) && port > 1024 && port < 65536 ? port : null;
}

/** Where per-spawn configs live. Under the OS temp dir, one directory per spawn, 0700. */
function overrideDir(): string {
  return join(tmpdir(), 'dreamcontext-browser');
}

/**
 * Writes the per-spawn MCP config and returns what the spawn needs, or null when this
 * project has no Playwright server to override (or the files cannot be written, in which
 * case the session runs exactly as it did before this feature).
 */
export function prepareBrowserOverride(
  projectRoot: string,
  home: string = homedir(),
  pickPort: () => number | null = freeLoopbackPort,
): BrowserOverride | null {
  const found = findPlaywrightServer(projectRoot, home);
  if (!found) return null;
  const port = pickPort();
  if (!port) return null;

  const dir = join(overrideDir(), randomUUID());
  const playwrightConfig = join(dir, 'playwright.json');
  const mcpConfig = join(dir, 'mcp.json');
  const own = ownConfigPath(found);
  const base = own && existsSync(own) ? readJson(own) : null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(playwrightConfig, `${JSON.stringify(mergedConfig(base, port), null, 2)}\n`, { mode: 0o600 });
    writeFileSync(mcpConfig, `${JSON.stringify({ mcpServers: { [found.name]: overrideDefinition(found, playwrightConfig) } }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing written */ }
    return null;
  }
  let disposed = false;
  return {
    configPath: mcpConfig,
    port,
    server: found.name,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    },
  };
}
