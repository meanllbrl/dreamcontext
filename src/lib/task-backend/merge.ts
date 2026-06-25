/**
 * Pure 3-way merge primitives for the sync engine — issue #11 merge rules.
 * Provider-free and I/O-free: operates on markdown bodies and scalar fields.
 */

export interface SectionBlock {
  /** '' for the preamble before the first `##` header. */
  name: string;
  content: string;
}

/** Split a markdown body into `##`-level sections (preamble keyed ''). */
export function splitSections(body: string): SectionBlock[] {
  const lines = body.split('\n');
  const blocks: SectionBlock[] = [];
  let current: SectionBlock = { name: '', content: '' };
  let currentLines: string[] = [];

  const flush = () => {
    current.content = currentLines.join('\n');
    if (current.name !== '' || current.content.trim() !== '') blocks.push(current);
  };

  for (const line of lines) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      flush();
      current = { name: h[1].trim(), content: '' };
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return blocks;
}

export function joinSections(blocks: SectionBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.name === '') {
      parts.push(b.content.trimEnd());
    } else {
      parts.push(`## ${b.name}\n${b.content.trimEnd()}`);
    }
  }
  return parts.join('\n\n').trim() + '\n';
}

export interface BodyMergeResult {
  merged: string;
  /** Sections where BOTH sides diverged from base (remote won). */
  conflictSections: string[];
  /** True when any local change survived into `merged`. */
  localChangesKept: boolean;
}

const norm = (s: string) => s.trim();

/**
 * Section-level 3-way merge of prose bodies.
 *  - local untouched (== base) → remote
 *  - remote untouched (== base) → local
 *  - both touched, same result → that result
 *  - both touched, different → REMOTE WINS (source of truth), section recorded
 *    as a conflict so the caller can preserve + surface the local copy.
 */
export function merge3Bodies(base: string, local: string, remote: string): BodyMergeResult {
  const baseS = splitSections(base);
  const localS = splitSections(local);
  const remoteS = splitSections(remote);

  const byName = (blocks: SectionBlock[]) => new Map(blocks.map((b) => [b.name, b.content]));
  const baseMap = byName(baseS);
  const localMap = byName(localS);
  const remoteMap = byName(remoteS);

  // Section order: remote's order first (source of truth), then local-only.
  const order: string[] = [];
  for (const b of remoteS) order.push(b.name);
  for (const b of localS) if (!order.includes(b.name)) order.push(b.name);

  const merged: SectionBlock[] = [];
  const conflictSections: string[] = [];
  let localChangesKept = false;

  for (const name of order) {
    const b = baseMap.get(name);
    const l = localMap.get(name);
    const r = remoteMap.get(name);

    let winner: string | undefined;
    if (l !== undefined && r !== undefined) {
      if (b !== undefined && norm(l) === norm(b)) {
        winner = r;
      } else if (b !== undefined && norm(r) === norm(b)) {
        winner = l;
        if (norm(l) !== norm(r)) localChangesKept = true;
      } else if (norm(l) === norm(r)) {
        winner = r;
      } else if (b === undefined) {
        // Section exists on both sides with no base — treat as conflict.
        winner = r;
        conflictSections.push(name || '(preamble)');
      } else {
        winner = r; // both changed differently → remote wins
        conflictSections.push(name || '(preamble)');
      }
    } else if (r !== undefined) {
      // Section only remote: either remote-added (keep) or locally deleted.
      if (b !== undefined && norm(r) === norm(b)) {
        // local deleted an unchanged section → honor the local deletion
        localChangesKept = true;
        continue;
      }
      winner = r;
      if (b !== undefined && l === undefined && norm(r) !== norm(b)) {
        // deleted locally AND changed remotely → conflict, remote wins
        conflictSections.push(name || '(preamble)');
      }
    } else if (l !== undefined) {
      // Section only local: locally added (keep) unless remote deleted a based section.
      if (b !== undefined) {
        if (norm(l) === norm(b)) continue; // remote deleted, local untouched → delete
        conflictSections.push(name || '(preamble)'); // remote deleted, local changed
        continue; // remote wins → stays deleted
      }
      winner = l;
      localChangesKept = true;
    }

    if (winner !== undefined) merged.push({ name, content: winner });
  }

  return { merged: joinSections(merged), conflictSections, localChangesKept };
}

export interface ScalarMergeResult<T> {
  value: T;
  winner: 'local' | 'remote' | 'none';
}

/**
 * Last-write-wins for scalar fields (status/assignee/priority/name/…).
 *  - only one side moved from base → that side wins
 *  - both moved → timestamps decide (remote carries SERVER time; the local
 *    timestamp is the recorded local-mutation instant)
 */
export function mergeScalar<T>(
  base: T | undefined,
  local: T,
  remote: T,
  localChangedAt: number | null,
  remoteChangedAt: number | null,
): ScalarMergeResult<T> {
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  if (eq(local, remote)) return { value: remote, winner: 'none' };
  if (base !== undefined && eq(local, base)) return { value: remote, winner: 'remote' };
  if (base !== undefined && eq(remote, base)) return { value: local, winner: 'local' };

  // Both changed (or no base): last write wins; ties + unknown local time → remote
  // (the remote is the source of truth and its timestamp is server time).
  if (localChangedAt !== null && remoteChangedAt !== null && localChangedAt > remoteChangedAt) {
    return { value: local, winner: 'local' };
  }
  return { value: remote, winner: 'remote' };
}

export type AssigneeHealDecision = 'heal' | 'in_sync' | 'pending' | 'local_diverged';

/**
 * Decide whether one task's local assignees should be HEALED to the remote set
 * during a `--reconcile` pass (#78). Assignees are remote-authoritative, but a
 * heal must never clobber a local change that simply hasn't pushed yet:
 *   - local == remote          → already in sync, nothing to do
 *   - a local push is pending   → let the normal sync push it first
 *   - local diverged from base  → a genuine two-sided change → leave it for a
 *                                 full sync/merge (surfaced, not silently healed)
 *   - else (local == base, only the remote moved) → safe to adopt the remote set
 *
 * Slug arrays compare order-insensitively (callers already pass them sorted, but
 * we sort defensively so a caller's ordering can never change the decision).
 */
export function planAssigneeHeal(
  local: string[],
  base: string[] | null,
  remote: string[],
  pendingPush: boolean,
): AssigneeHealDecision {
  const eq = (a: string[], b: string[]) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (eq(local, remote)) return 'in_sync';
  if (pendingPush) return 'pending';
  if (base !== null && !eq(local, base)) return 'local_diverged';
  return 'heal';
}

/**
 * Union-merge changelog entries (conflict-free by construction).
 * Remote-only entries stack on top (LIFO), local order preserved below.
 */
export function unionChangelog(localEntries: string[], remoteEntries: string[]): string[] {
  const normalize = (e: string) => e.replace(/\s+/g, ' ').trim();
  const localNorm = new Set(localEntries.map(normalize));
  const remoteOnly = remoteEntries.filter((e) => !localNorm.has(normalize(e)));
  // Dedupe remote-only against each other too.
  const seen = new Set<string>();
  const uniqueRemoteOnly = remoteOnly.filter((e) => {
    const n = normalize(e);
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  return [...uniqueRemoteOnly, ...localEntries];
}
