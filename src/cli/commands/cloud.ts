import type { Command } from 'commander';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Hidden: the hands-free cloud's own server and its dcuser worker. Never run by a person.
 *
 *  - `cloud serve` is what the root supervisor (`cloud/supervisor.mjs`) starts as dcserver,
 *    handing it the listening socket on fd 3 (`--listen-fd 3`): the dashboard server in cloud
 *    mode, its trip state, its transfer routes and the D14/D15 sleep clock.
 *  - `cloud worker <op>` is what dcserver spawns as dcuser for every git, pack and transcript
 *    operation (framed stdin, binary stdout, JSON result on fd 3; see cloud-worker.ts).
 *
 * Two test seams for wave 3's round trip on a Mac (a scratch HOME, no setpriv, no codespace):
 * `--same-uid-worker` (plain spawn instead of setpriv) and `--mirror-prefix <dir>` (the cloud
 * keeps laptop path P at <dir>P). Both are refused inside a codespace and as root.
 */

/** Env the server process never keeps: the codespace's own, GitHub's tokens. */
const STRIP_ENV_RE = /^(GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|CODESPACE.*|GITHUB_CODESPACE.*|DREAMCONTEXT_DESKTOP|DREAMCONTEXT_REMOTE)$/;

const ORIGIN_RE = /^https:\/\/[a-z0-9-]{1,100}-8080\.[a-z0-9.-]{1,100}$/;

interface ServeOpts {
  listenFd?: string;
  port?: string;
  sameUidWorker?: boolean;
  mirrorPrefix?: string;
}

/** The CLI entry the worker runs: this bundle when built, else whatever started us. */
function cliEntry(): string {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith('.js') ? here : process.argv[1];
}

export function seamRefusal(env: NodeJS.ProcessEnv, uid: number | null): string | null {
  if (env.CODESPACES) return 'test seams are refused inside a codespace';
  if (uid === 0) return 'test seams are refused as root';
  return null;
}

async function serve(opts: ServeOpts): Promise<void> {
  // DC_HF_ORIGIN was computed by the root entrypoint from the codespace env, which is gone by
  // now; it is read (and checked) before anything else is stripped.
  const origin = process.env.DC_HF_ORIGIN ?? '';
  if (origin && !ORIGIN_RE.test(origin) && !opts.sameUidWorker) {
    console.error('cloud serve: DC_HF_ORIGIN is not a forwarded-port origin');
    process.exit(2);
  }
  const seams = !!opts.sameUidWorker || !!opts.mirrorPrefix;
  if (seams) {
    const why = seamRefusal(process.env, typeof process.getuid === 'function' ? process.getuid() : null);
    if (why) {
      console.error(`cloud serve: ${why}`);
      process.exit(2);
    }
  }
  for (const k of Object.keys(process.env)) if (STRIP_ENV_RE.test(k)) delete process.env[k];
  process.env.DREAMCONTEXT_CLOUD = '1';
  process.env.DREAMCONTEXT_AUTO_DASHBOARD = '0';
  process.env.SHELL = '/bin/bash';

  const cloudMode = await import('../../server/cloud-mode.js');
  if (opts.sameUidWorker) cloudMode.setSameUidWorkerForTests(true);
  if (opts.mirrorPrefix) cloudMode.setCloudMirrorPrefix(resolve(opts.mirrorPrefix));

  const { setWorkerEntry } = await import('../../server/cloud-worker.js');
  setWorkerEntry(cliEntry());

  const routes = await import('../../server/routes/handsfree-cloud.js');
  cloudMode.setCloudPhaseSource(routes.cloudPhaseFromStore);
  // Smoke #5: agents run only inside the trip's roots (read live: the trip changes over a run).
  cloudMode.setCloudTripRootsSource(() => {
    const go = routes.cloudServices().state.get().go as { roots?: Array<{ absPath?: unknown; kind?: unknown }> } | null;
    return (go?.roots ?? []).filter((r) => r.kind !== 'transcripts' && typeof r.absPath === 'string').map((r) => r.absPath as string);
  });

  // The bootstrap verifiers the root entrypoint copied from the private repo (a stale or equal
  // generation is a no-op inside installVerifiers).
  const { handsfreeAuth } = await import('../../server/handsfree-auth.js');
  const bootstrap = resolve(cloudMode.cloudServerDir(), 'bootstrap-verifiers.json');
  if (existsSync(bootstrap)) {
    try {
      const r = handsfreeAuth().store.installVerifiers(JSON.parse(readFileSync(bootstrap, 'utf-8')));
      if (!r.ok && r.error !== 'stale_generation') console.warn(`cloud serve: bootstrap verifiers not installed (${r.error})`);
    } catch {
      console.warn('cloud serve: bootstrap verifiers unreadable');
    }
  }

  // A recorded trip: its orchestration git config must exist before any worker git runs.
  const rec = routes.cloudServices().state.get();
  if (rec.go && rec.tripId) {
    try {
      const go = routes.parseGoManifest(rec.go, rec.tripId, rec.laptopId ?? '');
      routes.writeOrchestrationGitConfig(go);
      routes.adoptMirrorHome(go);
    } catch (err) {
      console.warn(`cloud serve: stored trip unusable (${(err as Error).message})`);
    }
  }

  const idleMod = await import('../../server/cloud-idle.js');
  const idle = routes.createCloudIdle(idleMod.currentBootId());
  idleMod.setCloudIdle(idle);
  idle.start();
  // One tick now, so the phone's chip knows the planned stop time from the first request.
  try { idle.tick(); } catch { /* the interval ticks again */ }
  const sweep = setInterval(() => { try { routes.cloudServices().transfers.sweep(); } catch { /* next hour */ } }, 60 * 60_000);
  sweep.unref?.();
  try { routes.cloudServices().transfers.sweep(); } catch { /* next hour */ }

  // A runtime request left by a swap that already happened is not ours to keep.
  rmSync(resolve(cloudMode.cloudServerDir(), routes.RUNTIME_REQUEST_NAME), { force: true });

  const { startDashboardServer } = await import('../../server/index.js');
  const listenFd = opts.listenFd !== undefined ? Number(opts.listenFd) : undefined;
  if (listenFd !== undefined && (!Number.isInteger(listenFd) || listenFd < 3)) {
    console.error('cloud serve: --listen-fd must be an inherited fd (>= 3)');
    process.exit(2);
  }
  const port = Number(opts.port ?? '8080');
  await startDashboardServer({
    port,
    contextRoot: null,
    open: false,
    // Without a handed-over socket (the Mac test seam) bind loopback only.
    host: listenFd === undefined ? '127.0.0.1' : '0.0.0.0',
    listenFd,
  });
}

export function registerCloudCommand(program: Command): void {
  const cloud = program
    .command('cloud', { hidden: true })
    .description('Hands-free cloud internals (run by the codespace, never by hand)');

  cloud
    .command('serve')
    .description('Serve the hands-free cloud (started by the root supervisor)')
    .option('--listen-fd <fd>', 'serve on this inherited listening socket')
    .option('--port <port>', 'bind this loopback port instead (test seam only)')
    .option('--same-uid-worker', 'test seam: run the worker without the uid switch')
    .option('--mirror-prefix <dir>', 'test seam: keep laptop path P at <dir>P')
    .action(async (opts: ServeOpts) => {
      await serve(opts);
    });

  cloud
    .command('worker <op>')
    .description('One dcuser worker operation (spawned by the cloud server)')
    .action(async (op: string) => {
      const { workerMain } = await import('../../server/cloud-worker.js');
      await workerMain(op);
    });
}
