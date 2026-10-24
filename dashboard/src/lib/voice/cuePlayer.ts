/**
 * Plays the "Anlayamadım, tekrar eder misin?" cue (`src/lib/voice/cue.ts` renders it on the
 * Mac) when a take could not be understood and nothing was sent.
 *
 * ── WHY ITS OWN AudioContext ────────────────────────────────────────────────────────────
 * The answer arrives seconds after the press, and by then the capture's own context has been
 * closed (`useVoiceCapture` teardown) and the native desktop path never had one. WebKit only
 * starts a context inside a real gesture, so {@link unlock} is called synchronously from the
 * capture's `start()`, on BOTH paths, and this context is never closed by a take's teardown.
 *
 * ── WHEN IT CANNOT PLAY ──────────────────────────────────────────────────────────────────
 * A desktop take started from the shell's hotkey has no DOM gesture, so a fresh context may
 * stay suspended in WKWebView. Then a context lent by the speech queue (unlocked by an earlier
 * click) is used when it is running; otherwise `resume()` is tried once, and if it stays
 * suspended the cue is skipped and logged (`cue: suspended`) — the written notice still shows.
 * The iPhone's silent switch mutes Web Audio entirely; the notice covers that too.
 */

let ctx: AudioContext | null = null;
/** Bumped by every press and every cue: a cue still waiting when a newer one (or a new take)
 *  arrives is dropped, so an old "Anlayamadım" never plays over the next recording. */
let gen = 0;
/** How long a suspended context is given to start. A `resume()` outside a gesture stays PENDING
 *  (Web Audio spec), so it is never simply awaited. */
const RESUME_WAIT_MS = 250;
const lenders = new Set<() => AudioContext | null>();

export type CueOutcome = 'started' | 'suspended' | 'failed';

/** What happened to the cues so far — the verify script's probe. */
export const cueStats = { starts: 0, last: null as CueOutcome | null };
// Readable by a headless check (scripts/verify/handsfree-phone-voice.mjs) without a module import.
(globalThis as { __dcCue?: typeof cueStats }).__dcCue = cueStats;

/** Open (or wake) the cue's context. Call synchronously inside the press. Never throws. */
export function unlock(): void {
  gen += 1;
  try {
    if (!ctx || ctx.state === 'closed') ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  } catch {
    ctx = null;
  }
}

/** A speech queue lends its (already unlocked) context; returns the unlend. */
export function lendContext(get: () => AudioContext | null): () => void {
  lenders.add(get);
  return () => { lenders.delete(get); };
}

function running(): AudioContext | null {
  if (ctx?.state === 'running') return ctx;
  for (const get of lenders) {
    const c = get();
    if (c?.state === 'running') return c;
  }
  return null;
}

function report(outcome: CueOutcome): CueOutcome {
  cueStats.last = outcome;
  if (outcome === 'started') cueStats.starts += 1;
  if (outcome === 'suspended') console.info('[voice] cue: suspended');
  return outcome;
}

/** Play the cue (base64 WAV). Resolves with what happened; never throws. */
export async function play(b64: string): Promise<CueOutcome> {
  const mine = ++gen;
  try {
    let target = running();
    if (!target && ctx) {
      const c = ctx;
      await Promise.race([c.resume().catch(() => {}), new Promise((r) => setTimeout(r, RESUME_WAIT_MS))]);
      target = running();
    }
    if (!target) return report('suspended');
    if (mine !== gen) return report('failed');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buffer = await target.decodeAudioData(bytes.buffer);
    if (mine !== gen) return report('failed');           // a newer take superseded this cue
    const source = target.createBufferSource();
    source.buffer = buffer;
    source.connect(target.destination);
    source.start();
    return report('started');
  } catch {
    return report('failed');
  }
}

/** Tests only: forget the context and the stats. */
export function resetCuePlayerForTests(): void {
  ctx = null;
  gen = 0;
  lenders.clear();
  cueStats.starts = 0;
  cueStats.last = null;
}
