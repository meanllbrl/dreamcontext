/**
 * Integration tests for `dashboard --vault`.
 *
 * Spawns `node dist/index.js` (requires a current build), starts a real server
 * on a free loopback port, and verifies API responses. Always passes `--no-open`
 * and an explicit `--port` to avoid side effects. Child processes are killed in
 * afterEach with a hard-timeout fallback.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, ChildProcess, execSync } from 'node:child_process';
import { createServer } from 'node:net';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const raw = join(tmpdir(), `dc-dv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

/** Creates a minimal valid project directory with _dream_context/ child. */
function makeVaultDir(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(join(dir, '_dream_context'), { recursive: true });
  return realpathSync(dir);
}

/** Find a free TCP port by binding to :0 and reading the assigned port. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Could not get free port'));
        }
      });
    });
    server.on('error', reject);
  });
}

/** Poll /api/health until 200 or timeout (ms). Returns true if ready. */
async function pollHealth(port: number, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.status === 200) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Kill a child process (SIGTERM then SIGKILL after 2s). */
function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    const fallback = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 2000);
    child.once('close', () => {
      clearTimeout(fallback);
      resolve();
    });
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  });
}

// ─── Test state ──────────────────────────────────────────────────────────────

let activeChild: ChildProcess | null = null;
let activeTmpDirs: string[] = [];

afterEach(async () => {
  if (activeChild) {
    await killChild(activeChild);
    activeChild = null;
  }
  for (const dir of activeTmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  activeTmpDirs = [];
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('dashboard --vault (integration)', () => {
  // ─── Case (a): valid --vault path starts server with correct current ──────
  it('starts server with correct /api/vaults.current when --vault <validPath> is given', async () => {
    const base = makeTmpDir();
    activeTmpDirs.push(base);
    const vaultDir = makeVaultDir(base, 'myproject');

    const port = await getFreePort();
    const child = spawn(
      'node',
      [CLI, 'dashboard', '--no-open', '--port', String(port), '--vault', vaultDir],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    activeChild = child;

    const ready = await pollHealth(port);
    expect(ready, 'Server did not become healthy in time').toBe(true);

    const res = await fetch(`http://127.0.0.1:${port}/api/vaults`);
    expect(res.status).toBe(200);
    const body = await res.json() as { current: string };
    expect(body.current).toBe(vaultDir);
  }, 20000);

  // ─── Case (b): --vault dir-without-_dream_context → non-zero, clean msg ──
  it('exits non-zero with a clean message for --vault <dir-without-_dream_context>', () => {
    const base = makeTmpDir();
    activeTmpDirs.push(base);
    const bareDir = join(base, 'nodc');
    mkdirSync(bareDir, { recursive: true });

    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execSync(
        `node ${CLI} dashboard --no-open --port 9999 --vault ${bareDir}`,
        { encoding: 'utf-8', timeout: 10000 },
      );
    } catch (e: any) {
      stdout = (e.stdout ?? '') + (e.stderr ?? '');
      exitCode = typeof e.status === 'number' ? e.status : 1;
    }

    expect(exitCode).not.toBe(0);
    // Must contain a clean message about _dream_context
    expect(stdout).toMatch(/no.*_dream_context|not a dreamcontext project/i);
    // Must NOT contain stack frames
    expect(stdout).not.toContain('at Object.');
    expect(stdout).not.toContain('at Module.');
  }, 15000);

  // ─── Case (c): --vault <nonexistent> → non-zero ───────────────────────────
  it('exits non-zero for --vault <nonexistent path>', () => {
    const base = makeTmpDir();
    activeTmpDirs.push(base);
    const ghost = join(base, 'ghost-project');

    let exitCode = 0;
    try {
      execSync(
        `node ${CLI} dashboard --no-open --port 9999 --vault ${ghost}`,
        { encoding: 'utf-8', timeout: 10000 },
      );
    } catch (e: any) {
      exitCode = typeof e.status === 'number' ? e.status : 1;
    }

    expect(exitCode).not.toBe(0);
  }, 15000);

  // ─── Case (d): no --vault, cwd inside project with _dream_context/ → starts
  it('starts server with cwd project as current when no --vault flag is given', async () => {
    const base = makeTmpDir();
    activeTmpDirs.push(base);
    const projectDir = makeVaultDir(base, 'cwdproject');

    const port = await getFreePort();
    const child = spawn(
      'node',
      [CLI, 'dashboard', '--no-open', '--port', String(port)],
      { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    activeChild = child;

    const ready = await pollHealth(port);
    expect(ready, 'Server did not become healthy in time').toBe(true);

    const res = await fetch(`http://127.0.0.1:${port}/api/vaults`);
    expect(res.status).toBe(200);
    const body = await res.json() as { current: string };
    expect(body.current).toBe(projectDir);
  }, 20000);
});
