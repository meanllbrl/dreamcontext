/**
 * How `dreamcontext apps …` reaches the desktop server (dreamcontext-apps plan r19, W2).
 *
 * - `node:http`, not `fetch`: undici's 5-minute header limit races an `apps do` that runs that
 *   long.
 * - The port comes from `~/.dreamcontext/desktop-server.json`; the vault NAME is resolved from
 *   the project (`x-dreamcontext-vault`, or the server refuses with `no_vault`).
 * - The project: the registered app whose root holds the cwd first (an agent works INSIDE
 *   `<project>-apps/<slug>/`, and a stray `_dream_context` up the tree must not win), else the
 *   nearest `_dream_context`. Neither → `project_not_found` (never "run dreamcontext init").
 * - dreamcontext not running: start it in the background (`open -g -b <shell id> --args
 *   --background`, only when the shell itself is not running) and wait up to 20 s.
 * - Shell liveness in Node is `lsappinfo find bundleid=<id>` (empty output = not running).
 */

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { bundleRunState } from './bundle.js';
import { resolveContextRoot } from '../context-path.js';
import { vaultNameForContextRoot } from '../app-link.js';
import { readDesktopServerFile, shellBundleId } from '../../server/desktop-server-file.js';
import { appContaining, type AppRecord } from './registry.js';
import { callClaim, encodeClaim, RUN_HEADER } from './call-claim.js';

export class AppsClientError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) {
    super(message);
    this.name = 'AppsClientError';
  }
}

export interface ProjectRef {
  projectRoot: string;
  contextRoot: string;
  vault: string;
  /** Set when the cwd is inside a registered app. */
  app: AppRecord | null;
}

export function resolveProject(cwd: string = process.cwd(), home: string = homedir()): ProjectRef {
  const app = appContaining(home, cwd);
  if (app) {
    return { projectRoot: app.projectRoot, contextRoot: `${app.projectRoot}/_dream_context`, vault: app.vault, app };
  }
  const contextRoot = resolveContextRoot(cwd);
  if (!contextRoot) throw new AppsClientError('project_not_found', 'No dreamcontext project here: run this inside a project or one of its apps.');
  const projectRoot = basename(contextRoot) === '_dream_context' ? dirname(contextRoot) : contextRoot;
  const vault = vaultNameForContextRoot(contextRoot, home);
  if (!vault) throw new AppsClientError('project_not_registered', `${projectRoot} is not a registered project: open it once in the dreamcontext app.`);
  return { projectRoot, contextRoot, vault, app: null };
}

/** Is an app with this bundle id running? (`lsappinfo` exits 0 either way; empty = no.) */
export function bundleRunning(bundleId: string): boolean {
  return bundleRunState(bundleId) === true;
}

export interface Answer {
  status: number;
  body: unknown;
}

function request(port: number, method: string, path: string, vault: string | null, body: unknown, timeoutMs: number, extra: Record<string, string> = {}): Promise<Answer> {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf-8');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path, agent: false, timeout: timeoutMs,
      headers: {
        host: `127.0.0.1:${port}`,
        accept: 'application/json',
        ...(vault ? { 'x-dreamcontext-vault': vault } : {}),
        ...extra,
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* text */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new AppsClientError('timeout', `dreamcontext did not answer within ${Math.round(timeoutMs / 1000)} s`)); });
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}

async function serverPort(opts: { launch: boolean; home: string }): Promise<number> {
  const probe = async (): Promise<number | null> => {
    const f = readDesktopServerFile(opts.home);
    if (!f) return null;
    try {
      const r = await request(f.port, 'GET', '/api/health', null, undefined, 3000);
      return r.status === 200 ? f.port : null;
    } catch {
      return null;
    }
  };
  const first = await probe();
  if (first) return first;
  if (!opts.launch || process.platform !== 'darwin') {
    throw new AppsClientError('dreamcontext_not_running', 'The dreamcontext desktop app is not running. Open it, then retry.');
  }
  const shell = shellBundleId();
  if (!bundleRunning(shell)) {
    try {
      execFileSync('/usr/bin/open', ['-g', '-b', shell, '--args', '--background'], { timeout: 10_000, stdio: 'ignore' });
    } catch {
      throw new AppsClientError('dreamcontext_not_installed', 'Could not start the dreamcontext desktop app. Is it installed?');
    }
  }
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    const p = await probe();
    if (p) return p;
  }
  throw new AppsClientError('dreamcontext_not_running', 'dreamcontext did not come up within 20 s. Open it, then retry.');
}

/** One call to the desktop server for this project. Throws AppsClientError on a refusal. */
export async function appsApi(
  project: ProjectRef,
  method: string,
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; launch?: boolean; home?: string; headers?: Record<string, string> } = {},
): Promise<Record<string, unknown>> {
  const home = opts.home ?? homedir();
  const port = await serverPort({ launch: opts.launch ?? true, home });
  const r = await request(port, method, path, project.vault, body, opts.timeoutMs ?? 30_000, opts.headers);
  const b = (r.body && typeof r.body === 'object' ? r.body : { message: String(r.body) }) as Record<string, unknown>;
  if (r.status >= 400) {
    throw new AppsClientError(String(b.error ?? `http_${r.status}`), String(b.message ?? `HTTP ${r.status}`), r.status);
  }
  return b;
}

/**
 * The `x-dc-run` header of an app tool call (app-araclari plan r3 §4.2): the most restricted
 * class this process's env names, plus its conversation ids so the server can tell a Super
 * child that kept an older mark. The server only ever narrows rights by it.
 */
export function runHeader(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const c = callClaim(env);
  const sessions = [env.DREAMCONTEXT_TAB_SESSION, env.CLAUDE_CODE_SESSION_ID].map((x) => (x ?? '').trim()).filter((x) => /^[0-9a-fA-F-]{8,64}$/.test(x));
  const value = JSON.parse(encodeClaim(c)) as Record<string, unknown>;
  if (sessions.length) value.sessions = sessions;
  return { [RUN_HEADER]: JSON.stringify(value) };
}
