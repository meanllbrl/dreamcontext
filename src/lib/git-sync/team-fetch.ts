import { join } from 'node:path';
import { listVaults } from '../vaults.js';
import { readSetupConfig, readBrainLocal } from '../setup-config.js';
import { resolveBrainSyncEnabled, resolveMode } from './brain-repo.js';
import { runBrainSync } from './sync-engine.js';

/**
 * Cross-vault team-fetch — the "Check now" background action behind the
 * team-updates badge. Loops every registered vault and runs an IN-PROCESS
 * `pull-only` sync (content delivery, never a push). It NEVER spawns the CLI.
 *
 * Cloud-sync-disabled and `in-tree` vaults are skipped SERVER-SIDE (a
 * commit-only in-tree vault has nothing to pull; a disabled vault opted out) —
 * so the caller doesn't have to pre-filter.
 */

export interface TeamFetchVaultResult {
  name: string;
  action: string;
  pulledUpdates?: number;
  pendingAgentMerge?: boolean;
  skipped?: 'disabled' | 'in-tree';
  error?: string;
}

export interface RunTeamFetchOptions {
  /** Restrict the fetch to a single vault by name. Absent ⇒ every vault. */
  vault?: string;
  /** Injectable home for the vault registry (tests). */
  home?: string;
  /** Injectable sync entry point (tests). */
  runBrainSyncImpl?: typeof runBrainSync;
}

/** Absolute `_dream_context/` path for a vault. */
function contextRootFor(vaultPath: string): string {
  return join(vaultPath, '_dream_context');
}

/**
 * Run a `pull-only` sync across the registered vaults (or one), skipping
 * disabled / in-tree vaults. Returns a per-vault result the badge/UI renders.
 * A single vault's failure is captured in its result — it never aborts the loop.
 */
export async function runTeamFetch(opts: RunTeamFetchOptions = {}): Promise<TeamFetchVaultResult[]> {
  const sync = opts.runBrainSyncImpl ?? runBrainSync;
  const all = listVaults(opts.home);
  const targets = opts.vault ? all.filter((v) => v.name === opts.vault) : all;

  const results: TeamFetchVaultResult[] = [];
  for (const vault of targets) {
    const projectRoot = vault.path;
    const config = readSetupConfig(projectRoot);
    const enabled = resolveBrainSyncEnabled(projectRoot, config);
    if (!enabled.enabled) {
      results.push({ name: vault.name, action: 'disabled', skipped: 'disabled' });
      continue;
    }
    if (resolveMode(config) === 'in-tree') {
      results.push({ name: vault.name, action: 'skipped-in-tree', skipped: 'in-tree' });
      continue;
    }
    try {
      const result = await sync({ cwd: contextRootFor(projectRoot), mode: 'pull-only' });
      const local = readBrainLocal(projectRoot);
      results.push({
        name: vault.name,
        action: result.action,
        pulledUpdates: result.pulledUpdates ?? local.pulledUpdates,
        pendingAgentMerge: local.pendingAgentMerge,
      });
    } catch (err) {
      results.push({ name: vault.name, action: 'error', error: (err as Error).message });
    }
  }
  return results;
}
