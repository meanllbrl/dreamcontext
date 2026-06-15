import { basename, dirname } from 'node:path';
import {
  buildCorpus,
  bm25Search,
  isFederated,
  type CorpusType,
  type RecallHit,
} from './recall.js';
import { isShareable } from './federation-config.js';
import { listConnections } from './connections.js';
import { listVaults, resolveVaultContextRoot, VaultError, type Vault } from './vaults.js';

/**
 * A single cross-vault recall hit: a normal {@link RecallHit} annotated with the
 * vault it came from and a globally-unique namespaced key `<vault>::<type>/<slug>`
 * so the same slug in two vaults never collides (P1.3).
 */
export interface FederatedHit extends RecallHit {
  /** Registered name of the vault this hit was served from. */
  vault: string;
  /** `<vault>::<type>/<slug>` — globally unique across the mesh. */
  key: string;
}

/** Vault that could not be searched (e.g. its path went stale). */
export interface SkippedVault {
  vault: string;
  /** Phase 1 only emits 'stale' (resolution failed). */
  reason: 'stale';
}

export interface CrossVaultRecallResult {
  hits: FederatedHit[];
  /** Peers that were skipped (resolution failed); surfaced as a dim note in the CLI. */
  skipped: SkippedVault[];
}

export interface CrossVaultRecallOptions {
  /**
   * The vaults to search, in priority order. The CURRENT vault — the one the
   * command is run from — should already be present (the caller decides its
   * name); it is ALWAYS searched regardless of its own `shareable` flag. Peer
   * vaults are searched only when `shareable: true` (non-shareable peers are
   * silently excluded — not warned).
   */
  vaults: CrossVaultTarget[];
  /** Injectable home for the vault registry (testability). */
  home?: string;
  topK?: number;
  types?: CorpusType[];
  /** Reference time for the recency multiplier (determinism in tests). */
  now?: Date;
}

/**
 * One vault to search. `current: true` marks the vault the command runs from —
 * it is always included and never gated by `shareable`, and its hits sort first
 * on ties.
 */
export interface CrossVaultTarget {
  /** Resolution key passed to `resolveVaultContextRoot` (registered name OR path). */
  name: string;
  /**
   * Optional display label used to tag hits + build the namespaced key. Defaults
   * to `name`. Used when the current vault is unregistered: we resolve by path
   * but want a clean basename label on the output.
   */
  label?: string;
  current?: boolean;
}

/** `<vault>::<type>/<slug>` — the namespaced key used everywhere a hit is keyed. */
export function namespacedKey(vault: string, type: string, slug: string): string {
  return `${vault}::${type}/${slug}`;
}

/**
 * Cross-vault BM25 recall (P1.2/P1.3). For each target vault:
 *   1. Resolve its context root via `resolveVaultContextRoot` (try/catch — a
 *      `VaultError` means the path went stale; that vault is skipped with reason
 *      'stale', warned ONCE on stderr, and the others continue — never-throw
 *      registry contract).
 *   2. Gate by `shareable`: the current vault is ALWAYS searched; peer vaults
 *      are searched only when shareable. Non-shareable peers are SILENTLY
 *      excluded (no warning — privacy is the default, not an error).
 *   3. Build the corpus and DROP every `federated: true` doc (serving exclusion —
 *      a third vault must never see content this vault merely ingested).
 *   4. BM25-search per vault, tag each hit with its vault + namespaced key.
 *
 * Hits are merged, sorted by `rankScore` descending, and sliced to `topK`. Ties
 * are broken current-vault-first (stable), so the local vault leads on a draw.
 */
export function crossVaultRecall(
  query: string,
  opts: CrossVaultRecallOptions,
): CrossVaultRecallResult {
  const home = opts.home;
  const topK = opts.topK ?? 10;
  const now = opts.now ?? new Date();

  const hits: Array<{ hit: FederatedHit; current: boolean; order: number }> = [];
  const skipped: SkippedVault[] = [];
  let order = 0;

  for (const target of opts.vaults) {
    let contextRoot: string;
    try {
      contextRoot = resolveVaultContextRoot(target.name, home);
    } catch (err) {
      if (err instanceof VaultError) {
        // Never-throw registry contract: a dead peer goes stale, warns once, and
        // the rest of the mesh keeps working.
        console.error(`[dreamcontext] vault "${target.name}" is unreachable — skipping (stale).`);
        skipped.push({ vault: target.name, reason: 'stale' });
        continue;
      }
      throw err;
    }

    // Shareable gate: the current vault is always included; peers must opt in.
    const isCurrent = target.current === true;
    if (!isCurrent) {
      const projectRoot = dirname(contextRoot);
      if (!isShareable(projectRoot)) continue; // silently excluded — not warned
    }

    const corpus = buildCorpus(contextRoot, opts.types ? { types: opts.types } : {})
      // Serving exclusion: ingested-from-peer docs are first-class locally but
      // must never be served across another vault boundary (transitive-leak).
      .filter((doc) => !isFederated(doc));

    const label = target.label ?? target.name;
    const vaultHits = bm25Search(query, corpus, topK, { now });
    for (const h of vaultHits) {
      hits.push({
        hit: {
          ...h,
          vault: label,
          key: namespacedKey(label, h.doc.type, h.doc.slug),
        },
        current: isCurrent,
        order: order++,
      });
    }
  }

  // Merge sort: rankScore desc, current-vault-first on ties, then stable input
  // order (so the merge is deterministic for tests).
  hits.sort((a, b) => {
    if (b.hit.rankScore !== a.hit.rankScore) return b.hit.rankScore - a.hit.rankScore;
    if (a.current !== b.current) return a.current ? -1 : 1;
    return a.order - b.order;
  });

  return { hits: hits.slice(0, topK).map((h) => h.hit), skipped };
}

/**
 * Resolve the `--connected` target set: the current vault plus every peer
 * reachable over an `out`/`both` connection (P1.2/P2.1).
 *
 * Reads the current vault's `.connections.json` and keeps a peer iff its
 * direction is `out` or `both` (this vault reaches across) AND its status is not
 * `stale`. The resulting peer names are then intersected with `shareable`: a
 * peer that has not opted into being read is silently dropped here so the recall
 * never even attempts it (the same fail-closed gate `crossVaultRecall` applies).
 * The current vault always leads the list.
 *
 * Never throws — connection reads are never-throw, and a peer whose registry
 * entry vanished is skipped (it can't be intersected with `shareable`).
 */
export function resolveConnectedVaults(
  current: CrossVaultTarget,
  contextRoot: string,
  home?: string,
): CrossVaultTarget[] {
  const currentLabel = current.label ?? current.name;
  const targets: CrossVaultTarget[] = [current];

  const connections = listConnections(contextRoot).filter(
    (c) => (c.direction === 'out' || c.direction === 'both') && c.status !== 'stale',
  );
  if (connections.length === 0) return targets;

  const vaults = listVaults(home);
  for (const conn of connections) {
    // Never re-add the current vault (a malformed self-link can't sneak in).
    if (conn.vault === current.name || conn.vault === currentLabel) continue;
    const peer = vaults.find((v) => v.name === conn.vault);
    if (!peer) continue; // registry entry gone — nothing to intersect with shareable
    if (!isShareable(peer.path)) continue; // not opted into being read — silently excluded
    targets.push({ name: peer.name });
  }
  return targets;
}

/**
 * Resolve the `--all-vaults` target set: the current vault plus every other
 * registered vault that is `shareable` (P1.2). Non-shareable peers are excluded
 * here so the CLI never even attempts to search them.
 */
export function resolveAllShareableVaults(
  current: CrossVaultTarget,
  home?: string,
): CrossVaultTarget[] {
  const currentLabel = current.label ?? current.name;
  const targets: CrossVaultTarget[] = [current];
  for (const v of listVaults(home)) {
    // Skip the current vault — matched by registered name OR resolution path
    // (the current target's `name` is a path when the current vault is
    // unregistered, so compare both to avoid a duplicate self-entry).
    if (v.name === current.name || v.name === currentLabel || v.path === current.name) continue;
    if (isShareableVault(v)) targets.push({ name: v.name });
  }
  return targets;
}

/** A registered vault is shareable iff its project root opts in. */
function isShareableVault(vault: Vault): boolean {
  return isShareable(vault.path);
}

/**
 * Resolve the display name + recall target for the CURRENT vault from its
 * project root. If the project is in the registry, use its registered name;
 * otherwise fall back to the project's basename so output is still labelled, and
 * pass the project ROOT as the resolution target (which `resolveVaultContextRoot`
 * accepts as a path) so an unregistered current vault is still searchable.
 */
export function currentVaultTarget(
  projectRoot: string,
  home?: string,
): { name: string; target: CrossVaultTarget } {
  const registered = listVaults(home).find((v) => v.path === projectRoot);
  if (registered) {
    return { name: registered.name, target: { name: registered.name, current: true } };
  }
  const name = basename(projectRoot);
  // Use the path itself as the resolution key so an unregistered current vault
  // still resolves; label it with its basename.
  return { name, target: { name: projectRoot, label: name, current: true } };
}
