/**
 * The LAPTOP side of the hands-free round trip (scripts/verify/handsfree-roundtrip.mjs), run
 * with `npx tsx` exactly like scripts/verify/automations.mjs drives the real TS functions:
 * one process per orchestrator call, so the parent can kill one mid-journal (case 8).
 *
 *   npx tsx driver.ts <command> '<json args>'     (HFRT_CONFIG = the harness config file)
 *
 * The cloud is a REAL `dreamcontext cloud serve` (the built CLI, its own scratch HOME, the
 * `--same-uid-worker --mirror-prefix --port` seams), started and stopped by the
 * FakeCloudProvider's onStart/onStop hooks. The provider's machine table is persisted in the
 * scratch dir so every driver process sees the same machine.
 *
 * Writes `{ ok: true, value }` or `{ ok: false, error }` as JSON to $HFRT_RESULT.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeCloudProvider, type MachineInfo } from '../../../src/lib/handsfree/provider.js';
import { HttpCloudClient } from '../../../src/lib/handsfree/cloud-client.js';
import { createSpawnRunner } from '../../../src/lib/handsfree/git-snapshot.js';
import { readTemplateFiles } from '../../../src/lib/handsfree/laptop-env.js';
import {
  abandonTrip, go, readReceipt, resumeTrip, returnTrip, rollbackTrip, setup, status, type HandsfreeEnv,
} from '../../../src/lib/handsfree/orchestrator.js';
import { computeScope } from '../../../src/lib/handsfree/scope.js';
import { NO_TURNS } from '../../../src/lib/handsfree/turns.js';
import { readRosterSurface, writeMergedRosterSurfaceAsync } from '../../../src/server/routes/agent-sessions.js';
import { readTripState } from '../../../src/lib/handsfree/trip-state.js';
import { readConfig } from '../../../src/lib/handsfree/local-store.js';

interface HarnessConfig {
  repo: string;            // dreamcontext checkout
  pkg: string;             // the frozen copy of the built package (dist/, cloud/)
  cli: string;             // <pkg>/dist/index.js: the real built CLI
  laptopHome: string;
  gitConfig: string;       // scratch GIT_CONFIG_GLOBAL for every laptop git
  scratch: string;
  cloud: {
    port: number;
    home: string;          // the cloud server's own HOME before it adopts the mirror
    serverDir: string;     // DC_HF_SERVER_DIR
    publicDir: string;     // DC_HF_PUBLIC_DIR
    mirror: string;        // --mirror-prefix
    stubBin: string;       // the stub `claude` dir, first on the cloud's PATH
    log: string;
    pidFile: string;
  };
}

const cfg = JSON.parse(readFileSync(process.env.HFRT_CONFIG!, 'utf8')) as HarnessConfig;
const origin = `http://127.0.0.1:${cfg.cloud.port}`;
const providerFile = join(cfg.scratch, 'provider.json');

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function cloudPid(): number | null {
  try { const p = Number(readFileSync(cfg.cloud.pidFile, 'utf8')); return alive(p) ? p : null; } catch { return null; }
}

async function waitHealth(ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(`${origin}/api/health`); if (r.status < 500) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Start the cloud server (the "machine boot"): detached, so it outlives this driver. */
async function startCloud(): Promise<void> {
  if (cloudPid()) return;
  for (const d of [cfg.cloud.home, cfg.cloud.serverDir, cfg.cloud.publicDir, cfg.cloud.mirror]) mkdirSync(d, { recursive: true });
  // The root entrypoint's job at every boot (cloud/entrypoint.sh): copy the repo checkout's
  // bootstrap verifiers into the dcserver dir ONLY when it holds none or a lower generation.
  const repoCopy = provider.repoFiles.get('.devcontainer/bootstrap/verifiers.json');
  if (repoCopy) {
    const dest = join(cfg.cloud.serverDir, 'bootstrap-verifiers.json');
    const genOf = (b: Buffer | null) => { try { return Number(JSON.parse(String(b)).generation) || 0; } catch { return 0; } };
    const cur = existsSync(dest) ? readFileSync(dest) : null;
    if (!cur || genOf(cur) < genOf(repoCopy)) writeFileSync(dest, repoCopy, { mode: 0o600 });
  }
  const fd = openSync(cfg.cloud.log, 'a');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(DREAMCONTEXT_|DC_HF_|GIT_|HFRT_|CLAUDE)/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    HOME: cfg.cloud.home,
    PATH: [cfg.cloud.stubBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin', join(process.execPath, '..')].join(':'),
    DC_HF_SERVER_DIR: cfg.cloud.serverDir,
    DC_HF_PUBLIC_DIR: cfg.cloud.publicDir,
    DC_HF_ORIGIN: origin,
  });
  const child = spawn(process.execPath, [cfg.cli, 'cloud', 'serve', '--same-uid-worker', '--mirror-prefix', cfg.cloud.mirror, '--port', String(cfg.cloud.port)], {
    cwd: cfg.cloud.home, env, stdio: ['ignore', fd, fd], detached: true,
  });
  closeSync(fd);
  writeFileSync(cfg.cloud.pidFile, String(child.pid));
  child.unref();
  if (!(await waitHealth(60_000))) throw new Error(`the cloud server did not answer /api/health (log: ${cfg.cloud.log})`);
}

async function stopCloud(): Promise<void> {
  const pid = cloudPid();
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  const end = Date.now() + 10_000;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(cfg.cloud.pidFile, { force: true });
}

/** The fake provider with its machine table persisted across driver processes. */
class PersistentFakeProvider extends FakeCloudProvider {
  load(): void {
    if (!existsSync(providerFile)) return;
    const raw = JSON.parse(readFileSync(providerFile, 'utf8')) as { machines: MachineInfo[]; repoFiles: Record<string, string>; calls: string[] };
    for (const m of raw.machines) this.machines.set(m.name, m);
    for (const [p, b] of Object.entries(raw.repoFiles)) this.repoFiles.set(p, Buffer.from(b, 'base64'));
    this.calls = raw.calls;
    (this as unknown as { seq: number }).seq = raw.machines.length;
  }
  // Persist after every mutation: a driver killed mid-journal (case 8) never reaches the end.
  override async create(o: { machine: string }): Promise<MachineInfo> { try { return await super.create(o); } finally { this.save(); } }
  override async start(name: string): Promise<void> { try { await super.start(name); } finally { this.save(); } }
  override async stop(name: string): Promise<void> { try { await super.stop(name); } finally { this.save(); } }
  override async delete(name: string): Promise<void> { try { await super.delete(name); } finally { this.save(); } }
  override async writeFiles(files: Record<string, Buffer>): Promise<Record<string, string>> { try { return await super.writeFiles(files); } finally { this.save(); } }

  save(): void {
    writeFileSync(providerFile, JSON.stringify({
      machines: [...this.machines.values()],
      repoFiles: Object.fromEntries([...this.repoFiles].map(([p, b]) => [p, b.toString('base64')])),
      calls: this.calls,
    }, null, 2));
  }
}

const provider = new PersistentFakeProvider({ url: origin, onStart: startCloud, onStop: stopCloud });
provider.load();
// A machine the table says is up must have its server running (a killed driver never stops it).
for (const m of provider.machines.values()) if (m.state === 'available' && !cloudPid()) await startCloud();

const gitEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) gitEnv[k] = v;
Object.assign(gitEnv, { HOME: cfg.laptopHome, GIT_CONFIG_GLOBAL: cfg.gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
const run = createSpawnRunner({ baseEnv: gitEnv });

const killAt = process.env.HFRT_KILL_AT ?? '';
const pauseAt = process.env.HFRT_PAUSE_AT ?? '';
const frozenVersion = (JSON.parse(readFileSync(join(cfg.pkg, 'package.json'), 'utf8')) as { version: string }).version;
const env: HandsfreeEnv = {
  home: cfg.laptopHome,
  run,
  provider,
  repo: provider,
  connect: (o, secret) => new HttpCloudClient({ origin: o, secret }),
  turns: NO_TURNS,
  roster: { read: readRosterSurface, write: (c, s) => writeMergedRosterSurfaceAsync(c, s) },
  templateFiles: () => readTemplateFiles(cfg.pkg),
  // D25: the cloud serve here runs the frozen LOCAL build, and the laptop reports that same
  // version, so no parity install is requested (the Mac seam has no root install loop). The
  // registry is injected: it "publishes" exactly this version; npm is never asked.
  localVersion: () => frozenVersion,
  registryFetch: (async (url: string) => {
    const want = `/dreamcontext/${encodeURIComponent(frozenVersion)}`;
    if (new URL(url).pathname !== want) return new Response('{}', { status: 404 });
    const integrity = `sha512-${createHash('sha512').update(`round trip ${frozenVersion}`).digest('base64')}`;
    return new Response(JSON.stringify({ name: 'dreamcontext', version: frozenVersion, dist: { integrity } }), { status: 200 });
  }) as unknown as typeof fetch,
  claudeProjectsDir: join(cfg.laptopHome, '.claude', 'projects'),
  healthTimeoutMs: 60_000,
  // Case 8: die hard (no finally, no lock release) right before the named journal op.
  beforeOp: async (op) => {
    // AC11 run lock: hold this go/return inside its lock at the named op until released.
    if (pauseAt && op.kind === pauseAt && !existsSync(join(cfg.scratch, 'paused.json'))) {
      writeFileSync(join(cfg.scratch, 'paused.json'), JSON.stringify({ id: op.id, pid: process.pid }));
      const release = join(cfg.scratch, 'release');
      const end = Date.now() + 120_000;
      while (!existsSync(release) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    }
    if (!killAt) return;
    const [kind, nth] = killAt.split('#');
    if (op.kind !== kind) return;
    const counter = join(cfg.scratch, `kill-count-${kind}`);
    const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
    writeFileSync(counter, String(n));
    if (n >= Number(nth || 1)) {
      writeFileSync(join(cfg.scratch, 'killed-at.json'), JSON.stringify({ id: op.id, kind: op.kind }));
      process.kill(process.pid, 'SIGKILL');
    }
  },
};

const [cmd, rawArgs] = process.argv.slice(2);
const args = rawArgs ? JSON.parse(rawArgs) : {};

async function main(): Promise<unknown> {
  switch (cmd) {
    case 'setup': return setup(env, { token: 'gho_fake_roundtrip_token', login: 'kerem' });
    case 'scope': return computeScope({ run, home: cfg.laptopHome, contextRoot: args.contextRoot, claudeProjectsDir: env.claudeProjectsDir! });
    case 'go': return go(env, { contextRoot: args.contextRoot, cutRunning: !!args.cutRunning });
    case 'return': return returnTrip(env, { cutRunning: !!args.cutRunning });
    case 'resume': return resumeTrip(env, { cutRunning: !!args.cutRunning });
    case 'rollback': return rollbackTrip(env);
    case 'abandon': return abandonTrip(env);
    case 'status': return status(env);
    case 'receipt': return readReceipt(env, args.tripId);
    case 'state': return { trip: readTripState(cfg.laptopHome), config: readConfig(cfg.laptopHome), calls: provider.calls, machines: [...provider.machines.values()] };
    case 'start-cloud': await provider.start([...provider.machines.keys()][0]); return { pid: cloudPid() };
    case 'stop-cloud': await provider.stop([...provider.machines.keys()][0]); return { pid: cloudPid() };
    case 'kill-cloud': await stopCloud(); return {};
    case 'cloud-health': {
      const c = readConfig(cfg.laptopHome)!;
      const { ensureTransferSecret } = await import('../../../src/lib/handsfree/local-store.js');
      return new HttpCloudClient({ origin: c.codespace!.url, secret: await ensureTransferSecret(cfg.laptopHome), attempts: 2 }).health();
    }
    default: throw new Error(`unknown command ${cmd}`);
  }
}

/** The result goes to a file: a large JSON on a pipe is cut short by process.exit. */
function emit(r: unknown): never {
  writeFileSync(process.env.HFRT_RESULT!, JSON.stringify(r));
  process.exit(0);
}

try {
  const value = await main();
  provider.save();
  emit({ ok: true, value });
} catch (err) {
  provider.save();
  const e = err as Error & { code?: string; detail?: unknown };
  emit({ ok: false, error: { name: e.name, code: e.code ?? null, message: e.message, detail: e.detail ?? null, stack: e.stack } });
}
