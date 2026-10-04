/**
 * What a composer's microphone is doing, for surfaces that draw it BIGGER than the composer can.
 *
 * Owner, 2026-10-04: "when I talk make it way more understandable that you listen." The
 * composer's own meter is a strip inside the input; the notch wants a large listening state
 * (`components/assistant/ListeningOverlay.tsx`). The composer PUBLISHES here; whoever draws
 * subscribes. A plain module bus rather than React state: the level arrives every ~21 ms and
 * must never re-render a tree (see `VoiceMeter`), and the notch's overlay and the composer are
 * not parent and child.
 *
 * Keyed by vault, so the notch only listens to its own `__assistant__` composer.
 */

export type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'too-short' | 'silent' | 'error' | 'unconfigured';

export interface VoiceActivity {
  vault: string;
  phase: VoicePhase;
  /** Seconds into the take while recording. */
  elapsed: number;
  /** 0 on the first transcription attempt, 1..n while retrying. */
  attempt: number;
  /** The owner-facing reason, when `phase` is a failure. */
  error: string;
}

const stateSubs = new Set<(a: VoiceActivity) => void>();
const levelSubs = new Set<(vault: string, level: number) => void>();
const latest = new Map<string, VoiceActivity>();

export function publishVoiceActivity(a: VoiceActivity): void {
  const prev = latest.get(a.vault);
  if (prev && prev.phase === a.phase && prev.elapsed === a.elapsed && prev.attempt === a.attempt
    && prev.error === a.error) return;
  latest.set(a.vault, a);
  for (const fn of [...stateSubs]) {
    try { fn(a); } catch { /* a drawer's failure is its own */ }
  }
}

export function publishVoiceLevel(vault: string, level: number): void {
  if (!levelSubs.size) return;
  for (const fn of [...levelSubs]) {
    try { fn(vault, level); } catch { /* a drawer's failure is its own */ }
  }
}

/** Subscribe to one vault's capture state; fires at once with the last one known. */
export function onVoiceActivity(vault: string, fn: (a: VoiceActivity) => void): () => void {
  const wrapped = (a: VoiceActivity) => { if (a.vault === vault) fn(a); };
  stateSubs.add(wrapped);
  const now = latest.get(vault);
  if (now) fn(now);
  return () => { stateSubs.delete(wrapped); };
}

export function onVoiceLevel(vault: string, fn: (level: number) => void): () => void {
  const wrapped = (v: string, level: number) => { if (v === vault) fn(level); };
  levelSubs.add(wrapped);
  return () => { levelSubs.delete(wrapped); };
}
