import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  RECALL_KEY_ENV,
  readRecallCloudConfig,
  readVaultTier,
  rollingIndexSpendUsd,
} from './recall-cloud-config.js';
import { AUTO_THROTTLE_MS, readVectorMeta } from './embeddings/vector-store.js';
import { noteIndexStop } from './embeddings/index-stop.js';

export type SpawnSkipReason = 'tier_local' | 'throttled' | 'daily_index_cap' | 'lock_busy';

export interface SpawnCloudIndexResult {
  spawned: boolean;
  reason: null | SpawnSkipReason;
}

export interface SpawnCloudIndexDeps {
  home?: string;
  /** Starts the detached child. Tests inject a recorder; the default launches `recall cloud index --auto`. */
  launch?: (cliEntry: string, cwd: string, env: NodeJS.ProcessEnv) => void;
  /** CLI entry script. Default: the running CLI (`process.argv[1]`). */
  cliEntry?: string;
}

/** A build lock younger than this belongs to a live build (the build itself reclaims older, dead ones). */
const BUILD_LOCK_FRESH_MS = 30 * 60_000;

function buildLockFresh(contextRoot: string): boolean {
  const lock = join(contextRoot, '.embeddings', 'voyage-4.build.lock');
  try {
    return existsSync(lock) && Date.now() - statSync(lock).mtimeMs < BUILD_LOCK_FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * The child's environment: ours, minus anything that identifies a human tab, and minus the recall
 * key. The child reads the key from the recall cloud config file itself, so the key is never
 * on the argv or in the env of a process listing; an env-sourced key therefore cannot feed an
 * automatic build (an explicit `index` from a shell with that env set can).
 */
export function cloudIndexChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out[RECALL_KEY_ENV];
  delete out.DREAMCONTEXT_TAB_SESSION;
  delete out.CLAUDE_CODE_SESSION_ID;
  return out;
}

function defaultLaunch(cliEntry: string, cwd: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, [cliEntry, 'recall', 'cloud', 'index', '--auto'], {
    detached: true,
    stdio: 'ignore',
    cwd,
    env,
  });
  child.unref();
}

/**
 * Refresh the cloud index after a sleep, detached and never awaited. Only a vault that consented to
 * a cloud tier gets one; the same guards the build enforces (throttle, rolling 24 h cap, one build per
 * vault) are checked here too so a skipped run costs no process. The hook never calls
 * this: index refresh happens at `sleep done` and through an explicit `recall cloud index`.
 */
export function spawnCloudIndexRefresh(
  contextRoot: string,
  _trigger: 'sleep',
  deps: SpawnCloudIndexDeps = {},
): SpawnCloudIndexResult {
  const home = deps.home ?? homedir();
  if (readVaultTier(contextRoot, home) === 'local') return { spawned: false, reason: 'tier_local' };

  const meta = readVectorMeta(contextRoot, 'voyage-4');
  const last = meta?.lastAutoStartAt ? Date.parse(meta.lastAutoStartAt) : NaN;
  if (Number.isFinite(last) && Date.now() - last < AUTO_THROTTLE_MS) return { spawned: false, reason: 'throttled' };
  if (rollingIndexSpendUsd({}, home) >= readRecallCloudConfig(home).spend.maxIndexUsd24h) {
    // The index goes stale until the window rolls: said to the owner once, never silent.
    noteIndexStop(contextRoot, { reason: 'daily_index_cap' }, home);
    return { spawned: false, reason: 'daily_index_cap' };
  }
  if (buildLockFresh(contextRoot)) return { spawned: false, reason: 'lock_busy' };

  const cliEntry = deps.cliEntry ?? process.argv[1];
  if (!cliEntry) return { spawned: false, reason: 'tier_local' };
  (deps.launch ?? defaultLaunch)(cliEntry, dirname(contextRoot), cloudIndexChildEnv(process.env));
  return { spawned: true, reason: null };
}
