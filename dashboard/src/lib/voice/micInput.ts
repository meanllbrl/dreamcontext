/**
 * The WebKit take's microphone, kept alive for the length of ONE take.
 *
 * ── WHY A TAKE RE-OPENS ITS INPUT ────────────────────────────────────────────────────────
 * Reported 2026-11-13: after the screen was locked or headphones were plugged in or out,
 * dictation stopped typing anything. A take's track ENDS when its device goes away (headphones
 * unplugged, the lid closed, the Mac slept), and an ended track feeds the graph silence for the
 * rest of the hold, which the gate then refuses as a silent take. So when the track ends while
 * the take is still held, the CURRENT default input is opened in its place and wired into the
 * same graph (same context, same rate, same tape). Nothing is held across takes: every take
 * opens the default input afresh, so a device change between takes needs no listener.
 *
 * The AudioContext can be left `interrupted` (WebKit, after sleep or a route change) or
 * `suspended`; a context that is not `running` delivers silence, so it is resumed whenever it
 * says it is anything else.
 *
 * Pure of React and of the real `navigator`, so the rules are tested with a fake MediaDevices.
 */

export interface OpenInputOptions {
  /** The processed-signal constraints (`MIC` in `useVoiceCapture.ts`). */
  constraints: MediaTrackConstraints;
  /** Still the take that asked? Checked after every await. */
  live: () => boolean;
  /** Wire a RE-OPENED stream into the graph in place of the dead one. The first stream is the
   *  caller's to wire (`input.stream`), so a wiring failure there stays the caller's error. */
  onReplace: (stream: MediaStream) => void;
  /** A re-open failed: the take goes on silent, and the gate will say so. */
  onLost?: (err: unknown) => void;
}

export interface LiveInput {
  /** The stream currently wired. */
  readonly stream: MediaStream;
  /** The current input's name, as the OS gives it ('' when it gives none). */
  label(): string;
  /** Stop every track and stop re-opening. Idempotent. */
  close(): void;
}

type Devices = Pick<MediaDevices, 'getUserMedia'>;

/** The wait before a lost input is re-opened. */
export const REOPEN_DELAY_MS = 150;

/** One `getUserMedia`, with the constraint fallback: a constraint this device or engine will
 *  not take must not cost the take, so it is retried ONCE with no constraints at all. */
export async function requestInput(devices: Devices, constraints: MediaTrackConstraints): Promise<MediaStream> {
  try {
    return await devices.getUserMedia({ audio: constraints });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'OverconstrainedError' || name === 'TypeError') {
      return devices.getUserMedia({ audio: true });
    }
    throw err;
  }
}

/** Resume a context that is not running. `interrupted` is WebKit's own state after a sleep or a
 *  route change and is not in the DOM typings, hence the string compare. */
export function keepRunning(ctx: Pick<AudioContext, 'state' | 'resume'>): void {
  if ((ctx.state as string) !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => {});
}

/**
 * Open the default input for a take and keep it open until `close()`. Resolves null when the
 * take was cancelled while the device was opening (its tracks are already stopped). Rejects
 * when the first open fails: that is the caller's "the microphone is not available".
 */
export async function openLiveInput(devices: Devices, o: OpenInputOptions): Promise<LiveInput | null> {
  let closed = false;
  let current = await requestInput(devices, o.constraints);
  if (!o.live()) {
    current.getTracks().forEach((t) => t.stop());
    return null;
  }

  const watch = (stream: MediaStream) => {
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => { void reopen(stream); }, { once: true });
    }
  };

  const reopen = async (dead: MediaStream) => {
    if (closed || dead !== current || !o.live()) return;
    // A beat for the route to settle, so a track that ends again at once costs one request per
    // beat rather than a burst of them for the rest of the hold.
    await new Promise((r) => setTimeout(r, REOPEN_DELAY_MS));
    if (closed || dead !== current || !o.live()) return;
    let next: MediaStream;
    try {
      next = await requestInput(devices, o.constraints);
    } catch (err) {
      o.onLost?.(err);
      return;
    }
    if (closed || dead !== current || !o.live()) {
      next.getTracks().forEach((t) => t.stop());
      return;
    }
    dead.getTracks().forEach((t) => t.stop());
    current = next;
    watch(next);
    try { o.onReplace(next); } catch (err) { o.onLost?.(err); }
  };

  watch(current);
  return {
    get stream() { return current; },
    label: () => current.getAudioTracks()[0]?.label ?? '',
    close: () => {
      if (closed) return;
      closed = true;
      current.getTracks().forEach((t) => t.stop());
    },
  };
}
