import { sortElements } from './format.js';
import type { WhiteboardElement } from './widgets.js';

/**
 * Element-level merge (D4), following Excalidraw's own reconcile rule per element id:
 * the higher `version` wins; on equal versions the LOWER `versionNonce` wins. A deletion is a
 * tombstone (`isDeleted: true`) and merges like any other edit, so a stale copy can never
 * resurrect an element whose deletion carries a higher version.
 *
 * Output is sorted by `(index, id)` — Excalidraw orders by fractional index, not array position.
 */

function nonceOf(el: WhiteboardElement): number {
  return typeof el.versionNonce === 'number' ? el.versionNonce : 0;
}

/** True when `a` beats `b` under Excalidraw's rule. Ties (same version AND nonce) do not beat. */
export function beats(a: WhiteboardElement, b: WhiteboardElement): boolean {
  if (a.version !== b.version) return a.version > b.version;
  return nonceOf(a) < nonceOf(b);
}

export interface MergeOutcome {
  elements: WhiteboardElement[];
  /**
   * True when `disk` contributed something `incoming` did not already have: an id incoming
   * lacks, or a winning copy whose `(version, versionNonce)` differs from incoming's. Decided
   * by identity, never content, so a tombstone stripped on disk but whole in the browser does
   * not count (D11: the PUT response then omits `elements`).
   */
  diskContributed: boolean;
}

export function mergeElements(
  disk: readonly WhiteboardElement[],
  incoming: readonly WhiteboardElement[],
): MergeOutcome {
  const byId = new Map<string, WhiteboardElement>();
  for (const el of disk) byId.set(el.id, el);
  const incomingById = new Map<string, WhiteboardElement>();
  for (const el of incoming) {
    incomingById.set(el.id, el);
    const cur = byId.get(el.id);
    // On a full tie the disk copy is kept: same identity, and it is the one already stripped.
    if (!cur || beats(el, cur)) byId.set(el.id, el);
  }
  let diskContributed = false;
  for (const el of byId.values()) {
    const inc = incomingById.get(el.id);
    if (!inc || inc.version !== el.version || nonceOf(inc) !== nonceOf(el)) {
      diskContributed = true;
      break;
    }
  }
  return { elements: sortElements([...byId.values()]), diskContributed };
}

/**
 * D14: a tombstone keeps every Excalidraw schema field and loses only its heavy payload —
 * `text`/`originalText`, and the widget's `html`, `markdown`, `items` and a wiki card's
 * `sections`. Applied on EVERY
 * write, so a browser echoing the unstripped copy back at an equal version stays a no-op.
 */
export function stripTombstone(el: WhiteboardElement): WhiteboardElement {
  if (el.isDeleted !== true) return el;
  const textKeys = (['text', 'originalText', 'rawText'] as const).filter((k) => typeof el[k] === 'string' && el[k] !== '');
  const cd = el.customData;
  const dc = cd && typeof cd.dc === 'object' && cd.dc !== null ? (cd.dc as Record<string, unknown>) : null;
  const heavyDc = dc && ('html' in dc || 'markdown' in dc || 'items' in dc || 'sections' in dc);
  if (textKeys.length === 0 && !heavyDc) return el;
  const out: WhiteboardElement = { ...el };
  // Emptied, not removed: `text` is a required field of Excalidraw's text schema.
  for (const k of textKeys) out[k] = '';
  if (heavyDc && dc) {
    const { html: _h, markdown: _m, items: _i, sections: _s, ...rest } = dc;
    out.customData = { ...cd, dc: rest };
  }
  return out;
}

export function stripTombstones(elements: readonly WhiteboardElement[]): WhiteboardElement[] {
  return elements.map(stripTombstone);
}
