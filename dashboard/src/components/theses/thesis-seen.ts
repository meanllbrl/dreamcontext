import type { ThesisView } from '../../hooks/useTheses';

/**
 * Client-side "seen" state for the Hypotheses surfaces (inbox semantics, PO
 * design session 08-08). Per thesis we persist a tiny snapshot of what the user
 * last LOOKED at (detail modal open = looked). Diffing the live thesis against
 * that snapshot yields the card's unread dot + one-line "what changed" summary.
 * Pure functions here; the persisted map itself lives in ThesisBoard via
 * usePersistedState so board + modal share ONE instance (two hook instances on
 * the same key would not see each other's writes until reload).
 */

export interface SeenSnapshot {
  /** updated_at at look time — equality means nothing changed since. */
  u: string;
  status: string;
  /** confidence as a 0–100 integer (avoids float-noise diffs). */
  pct: number;
  /** evidence ledger length at look time. */
  ev: number;
}

export type SeenMap = Record<string, SeenSnapshot>;

export interface ThesisDelta {
  unread: boolean;
  /** One-line summary of what changed since the last look; null when read. */
  summary: string | null;
}

export function snapshotOf(t: ThesisView): SeenSnapshot {
  return {
    u: t.updated_at,
    status: t.status,
    pct: Math.round(Math.max(0, Math.min(1, t.confidence)) * 100),
    ev: t.evidence.length,
  };
}

export function diffThesis(t: ThesisView, seen: SeenSnapshot | undefined): ThesisDelta {
  if (!seen) return { unread: true, summary: 'New — not opened yet' };
  if (seen.u === t.updated_at) return { unread: false, summary: null };

  const parts: string[] = [];
  if (seen.status !== t.status) {
    if (t.status === 'validated' || t.status === 'invalidated') parts.push(`Flipped ${t.status}`);
    else parts.push(`${cap(seen.status)} → ${cap(t.status)}`);
  }
  const pct = Math.round(Math.max(0, Math.min(1, t.confidence)) * 100);
  if (pct !== seen.pct) parts.push(`${pct > seen.pct ? '↑' : '↓'} confidence ${seen.pct}→${pct}`);
  const dEv = t.evidence.length - seen.ev;
  if (dEv > 0) parts.push(`+${dEv} evidence`);
  if (parts.length === 0) parts.push('Updated');
  return { unread: true, summary: parts.join(' · ') };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
