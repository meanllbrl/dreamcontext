import { basename, dirname } from 'node:path';
import {
  buildCorpus,
  bm25Search,
  isFederated,
  type CorpusType,
  type RecallHit,
} from './recall.js';
import { listConnections } from './connections.js';
import { listVaults, resolveVaultContextRoot, VaultError } from './vaults.js';

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
  /** Minimum derived importance level (see DocLevel); undefined = no filter. */
  minLevel?: number;
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
 *   2. Build the corpus and DROP every `federated: true` doc (serving exclusion —
 *      a third vault must never see content this vault merely ingested).
 *   3. BM25-search per vault, tag each hit with its vault + namespaced key.
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

    // No second gate here. The CONNECTION is the consent: a caller only reaches
    // this point for the current vault or for a peer it deliberately wired up.
    const isCurrent = target.current === true;

    const corpus = buildCorpus(contextRoot, {
      ...(opts.types ? { types: opts.types } : {}),
      ...(opts.minLevel !== undefined ? { minLevel: opts.minLevel } : {}),
    })
      // Serving exclusion: ingested-from-peer docs are first-class locally but
      // must never be served across another vault boundary (transitive-leak).
      .filter((doc) => !isFederated(doc))
      // A PEER's automations are never read across the boundary: `automations/*.md`
      // is gitignored (machine-local), `shared` defaults false, and a manifest body
      // IS the prompt a bypassPermissions session runs. Gated on `!isCurrent` — the
      // user's OWN automations stay first-class here, which matters because plain
      // `memory recall` takes this federated path by default whenever any peer is
      // connected, so an unconditional filter would have made `--types automation`
      // return nothing on exactly the machines that have automations.
      .filter((doc) => isCurrent || doc.type !== 'automation');

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
 * `stale`. The current vault always leads the list.
 *
 * There is no second opt-in: DRAWING the connection is the consent. The old
 * `shareable` flag meant a peer could be wired up and still silently return
 * nothing, which read as "federation is broken" far more often than it read as
 * "privacy" — these are all one person's own projects on one machine.
 *
 * Never throws — connection reads are never-throw, and a peer whose registry
 * entry vanished is skipped.
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
    if (!peer) continue; // registry entry gone — nothing to resolve
    targets.push({ name: peer.name });
  }
  return targets;
}

/**
 * Resolve the `--all-vaults` target set: the current vault plus every other
 * registered vault. `--all-vaults` is an explicit, deliberate flag — it now means
 * exactly what it says rather than "all vaults that happened to have opted in",
 * which was impossible to predict from the outside.
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
    targets.push({ name: v.name });
  }
  return targets;
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
