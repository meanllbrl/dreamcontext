/**
 * A tiny WebAudio "Claude needs you" chime — two quick rising sine notes (A5 → E6),
 * the auditory pair of the dock chip's shake when an agent asks a question. Synthesized
 * (no asset, no network) and soft: short envelope, low gain. A shared AudioContext is
 * created lazily on first play; if the webview's autoplay policy blocks audio before any
 * user gesture, the play is silently skipped (the visual signals still fire).
 */

let ctx: AudioContext | null = null;
let lastPlay = 0;

/** Several agents asking in the same breath must not stack into a klaxon. */
const MIN_INTERVAL_MS = 1500;

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
  const now = Date.now();
  if (now - lastPlay < MIN_INTERVAL_MS) return;
  lastPlay = now;
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
