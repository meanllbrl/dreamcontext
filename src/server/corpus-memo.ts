import { createHash } from 'node:crypto';
import type { CorpusDoc } from '../lib/recall.js';

/**
 * Settings → Recall reads two numbers that are pure functions of the corpus: its Turkish share
 * (`turkishShareOf`, ~350 ms on a 2.7k-doc brain) and the cloud index plan (`planCloudIndex`,
 * ~750 ms: it re-chunks and hashes every doc). Both ran synchronously on every GET, freezing the
 * one server thread for chat streams and hook requests. They are now remembered per vault under
 * an EXACT key, never a TTL: any change to a doc field either function reads gives a new key, so a
 * remembered value is never stale.
 */

/**
 * A content hash of every field the corpus-derived readers look at: identity (type, paths),
 * the text (title, description, body) and the egress flags (capture, cloud opt-out, federated).
 * Hashing ~14 MB of text costs tens of milliseconds, against the hundreds it saves.
 */
export function corpusFingerprint(docs: ReadonlyArray<CorpusDoc>): string {
  const h = createHash('sha1');
  h.update(String(docs.length));
  for (const d of docs) {
    h.update(`\u0001${d.capture === true ? 1 : 0}${d.cloudOptOut === true ? 1 : 0}${d.federated === true ? 1 : 0}`);
    // Each field length-prefixed: no text, whatever characters it holds, can pass for a field boundary.
    for (const raw of [d.type, d.path, d.relPath, d.title, d.description, d.body]) {
      const field = typeof raw === 'string' ? raw : String(raw ?? '');
      h.update(`${field.length}:`);
      h.update(field);
    }
  }
  return h.digest('hex');
}

/** How many vaults one memo remembers; the oldest is dropped past this, so the map cannot grow. */
const MEMO_VAULTS = 8;

export interface CorpusMemo<T> {
  /** The value remembered for `root` under `key`, or `compute()` remembered now. */
  get(root: string, key: string, compute: () => T): T;
  clear(): void;
}

/** One remembered value per vault, replaced when its key changes (every key has a death: the next key, or eviction). */
export function createCorpusMemo<T>(limit: number = MEMO_VAULTS): CorpusMemo<T> {
  const held = new Map<string, { key: string; value: T }>();
  return {
    get(root, key, compute) {
      const hit = held.get(root);
      if (hit && hit.key === key) return hit.value;
      const value = compute();
      held.delete(root);
      held.set(root, { key, value });
      while (held.size > limit) {
        const oldest = held.keys().next().value;
        if (oldest === undefined) break;
        held.delete(oldest);
      }
      return value;
    },
    clear() { held.clear(); },
  };
}
