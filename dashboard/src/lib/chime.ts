/**
 * A tiny WebAudio "Claude needs you" chime — two quick rising sine notes (A5 → E6),
 * the auditory pair of the dock chip's shake when an agent asks a question. Synthesized
 * (no asset, no network) and soft: short envelope, low gain. A shared AudioContext is
 * created lazily on first play; if the webview's autoplay policy blocks audio before any
 * user gesture, the play is silently skipped (the visual signals still fire).
 *
 * Deliberately un-throttled: this is one voice of the three-part alarm in `attention.ts`
 * (chime + notification + Dock bounce), and the rate limit lives THERE so all three stay
 * one interruption. Don't call this directly from a session — call `raiseAskAttention`.
 */

let ctx: AudioContext | null = null;

function note(at: number, freq: number, dur: number) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.09, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

export function playAskChime(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    note(t, 880, 0.16);          // A5
    note(t + 0.11, 1318.5, 0.22); // E6 — the rising second reads as a question
  } catch {
    /* audio unavailable (headless / blocked autoplay) — visuals carry the signal */
  }
}

/**
 * The microphone's earcons (owner, 2026-10-04: "make it way more understandable that you
 * listen"): a soft rising pair when the mic OPENS, a falling pair when the take is handed off.
 * Quieter and lower than the ask chime, so "I am listening" never reads as "someone needs you".
 * Plays through the same shared context; a blocked context just stays silent.
 */
export function playMicEarcon(edge: 'open' | 'close'): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    const [a, b] = edge === 'open' ? [587.3, 880] : [880, 587.3];   // D5 ↔ A5
    quietNote(t, a, 0.12);
    quietNote(t + 0.08, b, 0.16);
  } catch {
    /* audio unavailable — the listening state on screen still says it */
  }
}

function quietNote(at: number, freq: number, dur: number) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.05, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

/**
 * The notch's notification tick (owner, 2026-10-04: "a small sound with notch notifications"):
 * ONE short, soft high note (C6, a drop-of-water ping) when a peek drops by itself. Quieter and
 * shorter than the ask chime — a peek is something to glance at, not an alarm. A blocked
 * context stays silent; the peek itself still drops.
 */
export function playNotchTick(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    quietNote(ctx.currentTime, 1046.5, 0.14);   // C6
  } catch {
    /* audio unavailable — the peek on screen still says it */
  }
}
