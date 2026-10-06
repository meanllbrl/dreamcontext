/**
 * The whiteboard page's save + poll loop (D5, D11), as a plain class with injected I/O so the
 * contract is unit-testable without React, a DOM or a server.
 *
 * What it guarantees:
 * - Saves are debounced ({@link SAVE_DEBOUNCE_MS}) and only sent when the scene version moved.
 * - Exactly one PUT is in flight. A save asked for meanwhile is coalesced into ONE follow-up
 *   PUT carrying the latest scene, so an out-of-order response can never hand us an older rev.
 * - A PUT's `rev` is adopted, so the poller does not refetch our own write. A PUT's merged
 *   `elements` (disk had something we did not) are folded into the scene straight away.
 * - A poll whose request started before a PUT landed is discarded, for the same reason.
 * - 5xx / network / lock failures keep the scene dirty and retry with backoff
 *   (1s, 2s, 4s … capped at {@link RETRY_CAP_MS}). 400/413/422 are terminal: sticky, no retry.
 *   404 means the board was deleted: saving and polling stop, the local scene stays.
 */

export const SAVE_DEBOUNCE_MS = 800;
export const POLL_INTERVAL_MS = 2000;
export const RETRY_BASE_MS = 1000;
export const RETRY_CAP_MS = 15_000;

/** Backoff before retry number `attempt` (1-based): 1s, 2s, 4s, 8s, 15s, 15s … */
export function retryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_CAP_MS);
}

export type SaveFailureKind = 'retry' | 'terminal' | 'deleted';

/**
 * How a failed PUT is handled, from its HTTP status. No status is a network failure.
 * The server refuses a bad body with 400/413 and a corrupt board with 422: sending the same
 * scene again cannot succeed, so those stop. Any other 4xx is treated the same way, except
 * the ones that mean "not now" (a timeout, a lock, a rate limit), which retry like a 5xx.
 */
export function classifySaveFailure(status: number | undefined): SaveFailureKind {
  if (status === undefined || status === 0) return 'retry';
  if (status === 404) return 'deleted';
  if (status >= 500) return 'retry';
  if (status === 408 || status === 409 || status === 423 || status === 429) return 'retry';
  return 'terminal';
}

export type SaveState =
  /** Everything on screen is on disk. */
  | { kind: 'saved' }
  /** A save is waiting on the debounce or in flight. */
  | { kind: 'saving' }
  /** The last save failed and a retry is scheduled: the header says "Not saved". */
  | { kind: 'retrying'; reason: string; attempt: number; delayMs: number }
  /** Refused for good (400/413/422): "Not saved: <reason>" and an Export button. */
  | { kind: 'failed'; reason: string }
  /** The board is gone from disk. The local scene is kept so it can be exported. */
  | { kind: 'deleted' };

export interface SaveResponse {
  rev: string;
  elements?: readonly unknown[];
}

export interface SceneResponse {
  rev: string;
  elements: readonly unknown[];
}

export interface TimerApi {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface SceneSnapshot<E> {
  elements: readonly E[];
  version: number;
}

export interface SaveLoopDeps<E> {
  /** The scene to save: every element (tombstones included, images already removed) and its
   *  scene version. Null while no canvas is mounted. May read EMPTY while the canvas is being
   *  torn down (Excalidraw swaps in a fresh Scene on unmount); the loop never trusts that. */
  snapshot: () => SceneSnapshot<E> | null;
  put: (elements: readonly E[]) => Promise<SaveResponse>;
  getRev: () => Promise<string>;
  getScene: () => Promise<SceneResponse>;
  /** Fold a remote element list into the live scene (restore with null + reconcile). */
  applyRemote: (elements: readonly unknown[]) => void;
  onState?: (state: SaveState) => void;
  timers?: TimerApi;
}

const defaultTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * The words a failure is shown with. The routes answer `{error: <slug>, message: <sentence>}`
 * and the API client keeps the sentence as `message`; its own "Request failed: <status>" only
 * stands in when the body had none, and then the slug says more.
 */
export function reasonOf(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const message = e && typeof e.message === 'string' ? e.message : '';
  const code = e && typeof e.code === 'string' ? e.code : '';
  if (message && !/^Request failed: \d+$/.test(message)) return message;
  return code || message || 'network error';
}

export class WhiteboardSaveLoop<E> {
  private readonly deps: SaveLoopDeps<E>;
  private readonly timers: TimerApi;
  private rev: string;
  /** Bumped whenever a PUT's rev is adopted; a poll started under an older epoch is stale. */
  private revEpoch = 0;
  /** The scene version known to be on disk. Null until the first save or clean poll. */
  private savedVersion: number | null = null;
  /** Local changes not yet included in a sent PUT. */
  private dirty = false;
  private inFlight = false;
  /** A save was asked for while one was in flight: send one more when it lands. */
  private queued = false;
  /** The PUT currently in flight, settled either way: what a final save on dispose waits for. */
  private flight: Promise<unknown> | null = null;
  private debounceHandle: unknown = null;
  private retryHandle: unknown = null;
  private attempt = 0;
  private lastReason = '';
  private stopped: { kind: 'failed'; reason: string } | { kind: 'deleted' } | null = null;
  private polling = false;
  private disposed = false;
  private lastState: SaveState = { kind: 'saved' };
  /** The newest non-empty scene seen, from a live snapshot or `notifyChange`. What a save
   *  sends when the live canvas reads empty or gone during teardown. */
  private latest: SceneSnapshot<E> | null = null;

  constructor(deps: SaveLoopDeps<E>, initialRev: string) {
    this.deps = deps;
    this.timers = deps.timers ?? defaultTimers;
    this.rev = initialRev;
  }

  get currentRev(): string {
    return this.rev;
  }

  get state(): SaveState {
    return this.lastState;
  }

  /** The scene changed locally. Restarts the debounce. `scene` is the changed scene as the
   *  canvas delivered it: kept, so a save after the canvas is torn down still has it. */
  notifyChange(scene?: SceneSnapshot<E>): void {
    if (this.disposed) return;
    if (scene) this.remember(scene);
    this.dirty = true;
    if (!this.stopped && this.retryHandle === null) {
      this.clearDebounce();
      this.debounceHandle = this.timers.set(() => {
        this.debounceHandle = null;
        this.requestSave();
      }, SAVE_DEBOUNCE_MS);
    }
    // While a retry is scheduled the edit rides along with it: the backoff is not skipped.
    this.emit();
  }

  /** Save now: the page is being hidden, left or unmounted. Skips a pending backoff too. */
  flush(): void {
    if (this.disposed || this.stopped) return;
    const hadDebounce = this.debounceHandle !== null;
    this.clearDebounce();
    if (!this.dirty && !hadDebounce && this.retryHandle === null) return;
    this.clearRetry();
    this.requestSave();
  }

  /** Flush, then stop every timer. Responses that land after this change nothing on screen. */
  dispose(): void {
    if (this.disposed) return;
    const flight = this.inFlight ? this.flight : null;
    if (flight && !this.stopped && (this.dirty || this.debounceHandle !== null || this.queued)) {
      // A PUT is in flight and the user edited after it left. The queued follow-up would never
      // run (a disposed loop ignores the response), so take the scene NOW, while the canvas
      // still exists, and send it once when the current PUT settles. Best effort: no retry,
      // no remote fold-in, no state (nothing is on screen any more).
      const snap = this.takeSnapshot();
      if (snap) {
        const put = this.deps.put;
        void flight.then(() => put(snap.elements)).catch(() => { /* nowhere left to report it */ });
      }
    } else {
      this.flush();
    }
    this.disposed = true;
    this.clearDebounce();
    this.clearRetry();
  }

  /** One poll tick: has the file changed under us? Folds the remote scene in when it has. */
  async poll(): Promise<void> {
    if (this.disposed || this.polling || this.inFlight) return;
    if (this.stopped?.kind === 'deleted') return;
    this.polling = true;
    const epoch = this.revEpoch;
    try {
      const rev = await this.deps.getRev();
      // A PUT started or landed meanwhile: its rev is the fresher answer.
      if (this.disposed || this.inFlight || epoch !== this.revEpoch) return;
      if (rev === this.rev) return;
      const scene = await this.deps.getScene();
      if (this.disposed) return;
      // Reconciling is safe whatever happened meanwhile (it keeps the higher version per
      // element), but the rev is only ours to adopt if no PUT moved it in the meantime.
      this.deps.applyRemote(scene.elements);
      if (!this.inFlight && epoch === this.revEpoch) this.rev = scene.rev;
      this.markCleanIfIdle();
    } catch (err) {
      if (statusOf(err) === 404) this.markDeleted();
      // Anything else: the next tick tries again.
    } finally {
      this.polling = false;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────

  private requestSave(): void {
    if (this.disposed || this.stopped) return;
    if (this.inFlight) {
      this.queued = true;
      this.emit();
      return;
    }
    void this.runSave();
  }

  private async runSave(): Promise<void> {
    const snap = this.takeSnapshot();
    if (!snap) { this.emit(); return; }
    if (snap.version === this.savedVersion) {
      this.dirty = false;
      this.emit();
      return;
    }
    this.dirty = false;
    this.inFlight = true;
    this.clearRetry();
    this.emit();
    let res: SaveResponse;
    try {
      const pending = this.deps.put(snap.elements);
      this.flight = pending.then(() => undefined, () => undefined);
      res = await pending;
    } catch (err) {
      this.inFlight = false;
      this.onFailure(err);
      return;
    }
    this.inFlight = false;
    this.attempt = 0;
    this.lastReason = '';
    this.rev = res.rev;
    this.revEpoch += 1;
    if (this.disposed) return;
    if (res.elements) this.deps.applyRemote(res.elements);
    if (this.dirty) {
      // Edited during the flight: what we sent is on disk, the newer edits are not.
      this.savedVersion = snap.version;
    } else {
      // The merged scene IS the file: note its version so an unchanged flush sends nothing.
      this.savedVersion = res.elements ? (this.takeSnapshot()?.version ?? snap.version) : snap.version;
    }
    if (this.queued) {
      this.queued = false;
      this.requestSave();
      return;
    }
    this.emit();
  }

  private onFailure(err: unknown): void {
    this.dirty = true;
    // A save queued behind this one is dropped: the retry sends the latest scene anyway.
    this.queued = false;
    const kind = classifySaveFailure(statusOf(err));
    const reason = reasonOf(err);
    if (kind === 'deleted') { this.markDeleted(); return; }
    if (kind === 'terminal') {
      this.stopped = { kind: 'failed', reason };
      this.clearDebounce();
      this.clearRetry();
      this.emit();
      return;
    }
    this.attempt += 1;
    this.lastReason = reason;
    this.clearDebounce();
    this.clearRetry();
    if (this.disposed) return;
    this.retryHandle = this.timers.set(() => {
      this.retryHandle = null;
      this.requestSave();
    }, retryDelay(this.attempt));
    this.emit();
  }

  private markDeleted(): void {
    this.stopped = { kind: 'deleted' };
    this.clearDebounce();
    this.clearRetry();
    this.emit();
  }

  /** After folding a remote scene in with nothing of ours pending, the screen equals disk. */
  private markCleanIfIdle(): void {
    if (this.dirty || this.inFlight || this.debounceHandle !== null || this.retryHandle !== null) return;
    const snap = this.takeSnapshot();
    if (snap) this.savedVersion = snap.version;
  }

  private remember(scene: SceneSnapshot<E>): void {
    if (scene.elements.length > 0) this.latest = scene;
  }

  /**
   * The scene a save sends. A live read with elements wins (and becomes `latest`). An EMPTY or
   * missing live read is what a torn-down canvas looks like: Excalidraw replaces its scene
   * before the unmount's final save runs, and deletions stay in the scene as tombstones, so a
   * board that ever had an element never legitimately reads as `[]`. Then the last known scene
   * is sent instead, so an edit made just before a board switch is never lost and an empty
   * list is never PUT in its place.
   */
  private takeSnapshot(): SceneSnapshot<E> | null {
    const live = this.deps.snapshot();
    if (live && live.elements.length > 0) {
      this.latest = live;
      return live;
    }
    if (this.latest) return this.latest;
    return live;
  }

  private clearDebounce(): void {
    if (this.debounceHandle !== null) this.timers.clear(this.debounceHandle);
    this.debounceHandle = null;
  }

  private clearRetry(): void {
    if (this.retryHandle !== null) this.timers.clear(this.retryHandle);
    this.retryHandle = null;
  }

  private computeState(): SaveState {
    if (this.stopped) return this.stopped;
    if (this.attempt > 0) {
      return { kind: 'retrying', reason: this.lastReason, attempt: this.attempt, delayMs: retryDelay(this.attempt) };
    }
    if (this.dirty || this.inFlight || this.queued || this.debounceHandle !== null) return { kind: 'saving' };
    return { kind: 'saved' };
  }

  private emit(): void {
    if (this.disposed) return;
    const next = this.computeState();
    const prev = this.lastState;
    this.lastState = next;
    if (JSON.stringify(prev) !== JSON.stringify(next)) this.deps.onState?.(next);
  }
}

// ── fit on open ──────────────────────────────────────────────────────────────────────────────

/** How long a freshly opened board waits for its canvas to be sized and its scene loaded
 *  before fitting anyway (frames, ~2s at 60fps). */
export const FIT_MAX_FRAMES = 120;

/** What the one-time fit needs from the canvas. */
export interface FitTarget {
  /** The canvas has a non-zero size (Excalidraw measured its container). */
  viewportReady: () => boolean;
  /** Live (non-deleted) elements now in the scene. */
  liveCount: () => number;
  /** Fit + centre the content in the viewport. */
  fit: () => void;
  /** The wait is over, fitted or not (nothing to fit, or out of patience). Never on a cancel. */
  settled?: () => void;
}

/**
 * Fit a just-opened board to its content, ONCE (A15/A16). Excalidraw hands out its API before
 * it has measured its container or loaded `initialData`, so a fit at that moment lands on an
 * empty 0×0 scene and the board opens at 100% off to one side. This waits, frame by frame,
 * until the viewport has a size and (when the loaded scene had content) that content is in the
 * scene, then fits and stops for good. Polls and saves never call this, so the user's viewport
 * is never yanked after the open. An empty board is left where Excalidraw put it.
 *
 * Returns a cancel for the canvas going away first.
 */
export function fitWhenReady(
  target: FitTarget,
  expectContent: boolean,
  schedule: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
  maxFrames: number = FIT_MAX_FRAMES,
): () => void {
  let frames = 0;
  let handle: number | null = null;
  const step = () => {
    handle = null;
    frames += 1;
    const sized = target.viewportReady();
    const loaded = !expectContent || target.liveCount() > 0;
    if (sized && loaded) {
      if (expectContent) target.fit();
      target.settled?.();
      return;
    }
    // Out of patience: fit what is there if we can, never loop forever.
    if (frames >= maxFrames) {
      if (sized && target.liveCount() > 0) target.fit();
      target.settled?.();
      return;
    }
    handle = schedule(step);
  };
  handle = schedule(step);
  return () => { if (handle !== null) cancel(handle); handle = null; };
}
