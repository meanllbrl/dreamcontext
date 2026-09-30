/**
 * The whiteboard page's save + poll loop (D5, D11): coalescing, a single PUT in flight, the
 * backoff sequence, terminal versus retryable failures, the deleted state, and the rev
 * ordering that keeps the poller from refetching our own write or adopting a stale rev.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WhiteboardSaveLoop, classifySaveFailure, fitWhenReady, reasonOf, retryDelay, SAVE_DEBOUNCE_MS,
  type FitTarget, type SaveResponse, type SaveState, type SceneResponse, type TimerApi,
} from '../../dashboard/src/hooks/whiteboardSaveLoop.js';

interface El { id: string; version: number }

/** Manual timers: `advance(ms)` fires whatever is due, in order. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const api: TimerApi = {
    set: (fn, ms) => { seq += 1; pending.set(seq, { at: now + ms, fn }); return seq; },
    clear: (h) => { pending.delete(h as number); },
  };
  return {
    api,
    delays: () => [...pending.values()].map((p) => p.at - now),
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, p]) => p.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** The API client's RequestError shape: the route's sentence as `message`, its slug as `code`. */
function httpError(status: number, message = '', code = '') {
  return Object.assign(new Error(message || `Request failed: ${status}`), { status, code });
}

function harness(initialRev = 'r0') {
  const timers = fakeTimers();
  const scene = { elements: [{ id: 'a', version: 1 }] as El[], version: 1 };
  const puts: { elements: readonly El[]; d: ReturnType<typeof deferred<SaveResponse>> }[] = [];
  const revs: ReturnType<typeof deferred<string>>[] = [];
  const scenes: ReturnType<typeof deferred<SceneResponse>>[] = [];
  const applied: (readonly unknown[])[] = [];
  const states: SaveState[] = [];
  const loop = new WhiteboardSaveLoop<El>({
    snapshot: () => ({ elements: scene.elements, version: scene.version }),
    put: (elements) => { const d = deferred<SaveResponse>(); puts.push({ elements, d }); return d.promise; },
    getRev: () => { const d = deferred<string>(); revs.push(d); return d.promise; },
    getScene: () => { const d = deferred<SceneResponse>(); scenes.push(d); return d.promise; },
    applyRemote: (els) => { applied.push(els); scene.version += 100; },
    onState: (s) => states.push(s),
    timers: timers.api,
  }, initialRev);
  const edit = () => { scene.version += 1; scene.elements = [{ id: 'a', version: scene.version }]; loop.notifyChange(); };
  return { loop, timers, scene, puts, revs, scenes, applied, states, edit };
}

describe('retryDelay / classifySaveFailure', () => {
  it('backs off 1s, 2s, 4s, 8s and caps at 15s', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it('retries 5xx, network and lock failures; stops on 400/413/422; 404 is deleted', () => {
    for (const s of [undefined, 0, 500, 502, 503, 409, 423, 429, 408]) expect(classifySaveFailure(s)).toBe('retry');
    for (const s of [400, 413, 422]) expect(classifySaveFailure(s)).toBe('terminal');
    expect(classifySaveFailure(404)).toBe('deleted');
  });
});

describe('reasonOf', () => {
  it("shows the route's sentence, the slug only when there is none, and names a network failure", () => {
    expect(reasonOf(httpError(413, 'The scene is over 5MB.', 'too_large'))).toBe('The scene is over 5MB.');
    expect(reasonOf(httpError(400, '', 'invalid'))).toBe('invalid');
    expect(reasonOf(new TypeError('Failed to fetch'))).toBe('Failed to fetch');
    expect(reasonOf(null)).toBe('network error');
  });
});

describe('WhiteboardSaveLoop — debounce and coalescing', () => {
  it('debounces edits into one PUT after 800ms', () => {
    const h = harness();
    h.edit(); h.timers.advance(500); h.edit(); h.timers.advance(500);
    expect(h.puts).toHaveLength(0);
    h.timers.advance(SAVE_DEBOUNCE_MS);
    expect(h.puts).toHaveLength(1);
    expect(h.states.at(-1)).toEqual({ kind: 'saving' });
  });

  it('sends nothing when the scene version has not moved since the last save', async () => {
    const h = harness();
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    h.puts[0].d.resolve({ rev: 'r1' }); await flush();
    h.loop.notifyChange(); // onChange without a version change
    h.timers.advance(SAVE_DEBOUNCE_MS);
    expect(h.puts).toHaveLength(1);
    expect(h.loop.state).toEqual({ kind: 'saved' });
  });

  it('keeps exactly one PUT in flight and coalesces later saves into ONE follow-up with the latest scene', async () => {
    const h = harness();
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    expect(h.puts).toHaveLength(1);
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    h.loop.flush();
    expect(h.puts).toHaveLength(1);
    h.puts[0].d.resolve({ rev: 'r1' }); await flush();
    expect(h.puts).toHaveLength(2);
    expect(h.puts[1].elements).toEqual([{ id: 'a', version: h.scene.version }]);
    h.puts[1].d.resolve({ rev: 'r2' }); await flush();
    expect(h.puts).toHaveLength(2);
    expect(h.loop.currentRev).toBe('r2');
    expect(h.loop.state).toEqual({ kind: 'saved' });
  });

  it('flush sends a pending debounce at once', () => {
    const h = harness();
    h.edit();
    h.loop.flush();
    expect(h.puts).toHaveLength(1);
  });

  it('dispose flushes the pending edit and then stops', () => {
    const h = harness();
    h.edit();
    h.loop.dispose();
    expect(h.puts).toHaveLength(1);
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS * 2);
    expect(h.puts).toHaveLength(1);
  });

  it.each([
    ['resolves', (d: ReturnType<typeof deferred<SaveResponse>>) => d.resolve({ rev: 'r1' })],
    ['fails', (d: ReturnType<typeof deferred<SaveResponse>>) => d.reject(httpError(503))],
  ] as const)('an edit made mid-flight is still sent after dispose, when the in-flight PUT %s', async (_label, settle) => {
    const h = harness();
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    expect(h.puts).toHaveLength(1);
    h.edit();                     // edited while the PUT is out…
    const edited = h.scene.elements;
    h.loop.dispose();             // …then left the board before it landed
    expect(h.puts).toHaveLength(1);
    settle(h.puts[0].d); await flush(); await flush();
    expect(h.puts).toHaveLength(2);
    expect(h.puts[1].elements).toEqual(edited);
    // Exactly one best-effort attempt: no retry timers, nothing folded back in.
    h.puts[1].d.reject(httpError(503)); await flush();
    h.timers.advance(60_000);
    expect(h.puts).toHaveLength(2);
    expect(h.timers.delays()).toEqual([]);
    expect(h.applied).toHaveLength(0);
  });
});

describe('WhiteboardSaveLoop — failures', () => {
  it('stays dirty and retries a 5xx / network failure on 1s, 2s, 4s, showing Not saved', async () => {
    const h = harness();
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    h.puts[0].d.reject(httpError(503)); await flush();
    expect(h.loop.state).toMatchObject({ kind: 'retrying', attempt: 1, delayMs: 1000 });
    expect(h.timers.delays()).toEqual([1000]);
    h.timers.advance(1000);
    expect(h.puts).toHaveLength(2);
    h.puts[1].d.reject(new TypeError('Failed to fetch')); await flush();
    expect(h.timers.delays()).toEqual([2000]);
    h.timers.advance(2000);
    h.puts[2].d.reject(httpError(500)); await flush();
    expect(h.timers.delays()).toEqual([4000]);
    expect(h.loop.state.kind).toBe('retrying');
    h.timers.advance(4000);
    h.puts[3].d.resolve({ rev: 'r9' }); await flush();
    expect(h.loop.state).toEqual({ kind: 'saved' });
    expect(h.loop.currentRev).toBe('r9');
  });

  it('an edit during backoff does not skip the backoff, and the retry carries it', async () => {
    const h = harness();
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    h.puts[0].d.reject(httpError(502)); await flush();
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    expect(h.puts).toHaveLength(1);
    h.timers.advance(1000);
    expect(h.puts).toHaveLength(2);
    expect(h.puts[1].elements).toEqual([{ id: 'a', version: h.scene.version }]);
  });

  it('flush on hide skips a pending backoff', async () => {
    const h = harness();
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    h.puts[0].d.reject(httpError(500)); await flush();
    h.loop.flush();
    expect(h.puts).toHaveLength(2);
    expect(h.timers.delays()).toEqual([]);
  });

  it.each([400, 413, 422])('%i is terminal: sticky Not saved with the reason, no retry', async (status) => {
    const h = harness();
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    h.puts[0].d.reject(httpError(status, 'Images are not supported yet.', 'invalid')); await flush();
    expect(h.loop.state).toEqual({ kind: 'failed', reason: 'Images are not supported yet.' });
    expect(h.timers.delays()).toEqual([]);
    h.edit(); h.timers.advance(60_000); h.loop.flush();
    expect(h.puts).toHaveLength(1);
    expect(h.loop.state.kind).toBe('failed');
  });

  it('404 on a PUT is "deleted": no retry, no more polling, the scene is left alone', async () => {
    const h = harness();
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    h.puts[0].d.reject(httpError(404)); await flush();
    expect(h.loop.state).toEqual({ kind: 'deleted' });
    await h.loop.poll();
    expect(h.revs).toHaveLength(0);
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    expect(h.puts).toHaveLength(1);
  });

  it('404 on a rev poll is "deleted" too', async () => {
    const h = harness();
    const p = h.loop.poll();
    h.revs[0].reject(httpError(404));
    await p;
    expect(h.loop.state).toEqual({ kind: 'deleted' });
  });
});

describe('WhiteboardSaveLoop — rev ordering and remote scenes', () => {
  it('a poll that sees our own adopted rev fetches nothing', async () => {
    const h = harness();
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    h.puts[0].d.resolve({ rev: 'r1' }); await flush();
    const p = h.loop.poll();
    h.revs[0].resolve('r1');
    await p;
    expect(h.scenes).toHaveLength(0);
  });

  it('a changed rev fetches the scene, folds it in and adopts its rev', async () => {
    const h = harness();
    const p = h.loop.poll();
    h.revs[0].resolve('r5'); await flush();
    h.scenes[0].resolve({ rev: 'r5', elements: [{ id: 'cli', version: 1 }] });
    await p;
    expect(h.applied).toEqual([[{ id: 'cli', version: 1 }]]);
    expect(h.loop.currentRev).toBe('r5');
  });

  it('does not poll while a PUT is in flight', async () => {
    const h = harness();
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    await h.loop.poll();
    expect(h.revs).toHaveLength(0);
  });

  it('discards a poll whose rev request started before a PUT landed (never adopts the older rev)', async () => {
    const h = harness();
    const p = h.loop.poll();          // rev request out…
    h.edit(); h.loop.flush();         // …a PUT starts and lands
    h.puts[0].d.resolve({ rev: 'r2' }); await flush();
    h.revs[0].resolve('r1');          // the stale answer arrives late
    await p;
    expect(h.scenes).toHaveLength(0);
    expect(h.loop.currentRev).toBe('r2');
  });

  it('a scene fetched across a PUT is folded in but its rev is not adopted', async () => {
    const h = harness();
    const p = h.loop.poll();
    h.revs[0].resolve('r1'); await flush();
    h.edit(); h.loop.flush();
    h.puts[0].d.resolve({ rev: 'r2' }); await flush();
    h.scenes[0].resolve({ rev: 'r1', elements: [{ id: 'cli', version: 1 }] });
    await p;
    expect(h.applied).toHaveLength(1);
    expect(h.loop.currentRev).toBe('r2');
  });

  it('merged elements in a PUT response are reconciled at once, and the rev adopted', async () => {
    const h = harness();
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    h.puts[0].d.resolve({ rev: 'r3', elements: [{ id: 'a', version: 2 }, { id: 'cli', version: 1 }] });
    await flush();
    expect(h.applied).toEqual([[{ id: 'a', version: 2 }, { id: 'cli', version: 1 }]]);
    expect(h.loop.currentRev).toBe('r3');
    // The merged scene is what disk holds: a flush without a new edit sends nothing.
    h.loop.flush();
    expect(h.puts).toHaveLength(1);
    expect(h.loop.state).toEqual({ kind: 'saved' });
  });

  it('an edit made during the flight is saved after it, even when the response merged', async () => {
    const h = harness();
    h.edit(); h.timers.advance(SAVE_DEBOUNCE_MS);
    h.edit();
    h.puts[0].d.resolve({ rev: 'r3', elements: [{ id: 'cli', version: 1 }] }); await flush();
    expect(h.loop.state.kind).toBe('saving');
    h.timers.advance(SAVE_DEBOUNCE_MS);
    expect(h.puts).toHaveLength(2);
  });

  it('only reports a state when it changes', () => {
    const onState = vi.fn();
    const timers = fakeTimers();
    const loop = new WhiteboardSaveLoop<El>({
      snapshot: () => null, put: vi.fn(), getRev: vi.fn(), getScene: vi.fn(), applyRemote: vi.fn(),
      onState, timers: timers.api,
    }, 'r0');
    loop.notifyChange(); loop.notifyChange(); loop.notifyChange();
    expect(onState).toHaveBeenCalledTimes(1);
  });
});

describe('useWhiteboards request paths', () => {
  // The hook imports React and the API client, so this pins its SOURCE: the `api` client
  // prefixes `/api` itself, and a `/api/…` literal handed to it requests `/api/api/whiteboards`
  // (caught live by verify:whiteboard).
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'dashboard/src/hooks/useWhiteboards.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('never hands the api client a path that starts with /api', () => {
    expect(src).not.toMatch(/['"`]\/api\//);
    expect(src).toMatch(/const LIST_PATH = '\/whiteboards';/);
    expect(src).toMatch(/const boardUrl = \(slug: string\) => `\$\{LIST_PATH\}\/\$\{encodeURIComponent\(slug\)\}`;/);
  });

  it('routes list, create, get, rev, put, delete and the default board through those two paths', () => {
    const calls = [...src.matchAll(/\bapi\.(get|post|put|del)<[^(]*>\(([^,)]+)/g)].map((m) => `${m[1]} ${m[2].trim()}`);
    expect(calls).toEqual(expect.arrayContaining([
      'get LIST_PATH', 'post LIST_PATH', 'del boardUrl(slug', 'get boardUrl(slug', 'get `${url}/rev`', 'put url', 'get url',
      // A15: the server ensures the default board and returns its slug.
      'get `${LIST_PATH}/default`',
    ]));
    for (const call of calls) expect(call, call).toMatch(/ (LIST_PATH|boardUrl\(slug|url|`\$\{url\}\/rev`|`\$\{LIST_PATH\}\/default`)$/);
  });
});

describe('fit on open (A15/A16 gate): once per board open, never on polls or saves', () => {
  /** A manual frame queue standing in for requestAnimationFrame. */
  function frames() {
    const queue = new Map<number, () => void>();
    let seq = 0;
    return {
      schedule: (cb: () => void) => { seq += 1; queue.set(seq, cb); return seq; },
      cancel: (id: number) => { queue.delete(id); },
      tick(n = 1) {
        for (let i = 0; i < n; i++) {
          const next = [...queue.entries()][0];
          if (!next) return;
          queue.delete(next[0]);
          next[1]();
        }
      },
      get pending() { return queue.size; },
    };
  }
  function target(state: { sized: boolean; live: number }) {
    const fit = vi.fn();
    const t: FitTarget = { viewportReady: () => state.sized, liveCount: () => state.live, fit };
    return { t, fit };
  }

  it('waits for a sized viewport and the loaded content, then fits exactly once', () => {
    const f = frames();
    const state = { sized: false, live: 0 };
    const { t, fit } = target(state);
    fitWhenReady(t, true, f.schedule, f.cancel);
    f.tick(3);
    expect(fit).not.toHaveBeenCalled(); // 0x0 canvas: a fit now would land at 100%, off-centre
    state.sized = true;
    f.tick(2);
    expect(fit).not.toHaveBeenCalled(); // initialData not in the scene yet
    state.live = 5;
    f.tick();
    expect(fit).toHaveBeenCalledTimes(1);
    expect(f.pending).toBe(0);
    // Later scene changes (a poll's remote elements, a save) schedule nothing: no re-fit.
    state.live = 9;
    f.tick(10);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('leaves an empty board alone and stops', () => {
    const f = frames();
    const { t, fit } = target({ sized: true, live: 0 });
    fitWhenReady(t, false, f.schedule, f.cancel);
    f.tick(5);
    expect(fit).not.toHaveBeenCalled();
    expect(f.pending).toBe(0);
  });

  it('gives up after its frame budget instead of looping forever', () => {
    const f = frames();
    const { t, fit } = target({ sized: false, live: 3 });
    fitWhenReady(t, true, f.schedule, f.cancel, 10);
    f.tick(50);
    expect(fit).not.toHaveBeenCalled();
    expect(f.pending).toBe(0);
  });

  it('cancels cleanly when the canvas goes away before it is ready', () => {
    const f = frames();
    const { t, fit } = target({ sized: false, live: 0 });
    const cancel = fitWhenReady(t, true, f.schedule, f.cancel);
    cancel();
    expect(f.pending).toBe(0);
    f.tick(5);
    expect(fit).not.toHaveBeenCalled();
  });

  it('the editor hook fits once per open and only from onApi, never from the poll or save path', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'dashboard/src/hooks/useWhiteboards.ts'), 'utf-8');
    expect([...src.matchAll(/fitWhenReady\(/g)]).toHaveLength(1);
    expect(src).toMatch(/if \(canvas && !fittedRef\.current\) \{\s*fittedRef\.current = true;/);
    const loop = src.slice(src.indexOf('new WhiteboardSaveLoop'), src.indexOf('const onApi'));
    expect(loop).not.toMatch(/scrollToContent|fitWhenReady/);
  });
});

describe('WhiteboardSaveLoop — a board switch never loses the last edit (A16, D11)', () => {
  /** A canvas whose scene Excalidraw swaps for an empty one on unmount, BEFORE the page's
   *  final save runs (`this.scene = new Scene()`), then drops the handle (snapshot → null). */
  function tornDown() {
    const timers = fakeTimers();
    const canvas = { phase: 'live' as 'live' | 'emptied' | 'gone', elements: [{ id: 'a', version: 1 }] as El[] };
    const version = () => canvas.elements.reduce((s, el) => s + el.version, 0);
    const puts: (readonly El[])[] = [];
    const loop = new WhiteboardSaveLoop<El>({
      snapshot: () => {
        if (canvas.phase === 'gone') return null;
        if (canvas.phase === 'emptied') return { elements: [], version: 0 };
        return { elements: canvas.elements, version: version() };
      },
      put: (elements) => { puts.push(elements); return Promise.resolve({ rev: 'r1' }); },
      getRev: () => Promise.resolve('r0'),
      getScene: () => Promise.resolve({ rev: 'r0', elements: [] }),
      applyRemote: () => {},
      timers: timers.api,
    }, 'r0');
    /** The user draws a rectangle; the canvas delivers the changed scene with the change. */
    const draw = () => {
      canvas.elements = [...canvas.elements, { id: 'rect', version: 1 }];
      loop.notifyChange({ elements: canvas.elements, version: version() });
    };
    return { loop, canvas, puts, draw, timers };
  }

  it('dispose after the scene was emptied sends the last delivered scene, not []', () => {
    const h = tornDown();
    h.draw();
    h.timers.advance(300); // switched well inside the 800ms debounce
    h.canvas.phase = 'emptied';
    h.loop.dispose();
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0].map((el) => el.id)).toEqual(['a', 'rect']);
  });

  it('a flush after the handle is gone still sends the last delivered scene', () => {
    const h = tornDown();
    h.draw();
    h.canvas.phase = 'gone';
    h.loop.flush();
    expect(h.puts.map((p) => p.map((el) => el.id))).toEqual([['a', 'rect']]);
  });

  it('never PUTs an empty list over a board that had elements', async () => {
    const h = tornDown();
    // The first save reads the live scene (no scene came with that change).
    h.canvas.elements = [{ id: 'a', version: 2 }];
    h.loop.notifyChange();
    h.timers.advance(SAVE_DEBOUNCE_MS);
    // The next edit arrives the way the hook delivers every edit: with its scene.
    h.canvas.elements = [{ id: 'a', version: 3 }];
    h.loop.notifyChange({ elements: h.canvas.elements, version: 3 });
    h.canvas.phase = 'emptied';
    h.loop.dispose(); // a PUT is in flight: the follow-up goes out once it settles
    await flush(); await flush();
    expect(h.puts).toHaveLength(2);
    for (const p of h.puts) expect(p.length).toBeGreaterThan(0);
    expect(h.puts[1]).toEqual([{ id: 'a', version: 3 }]);
  });

  it('the hook runs the final save in a layout cleanup and hands the loop the changed scene', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'dashboard/src/hooks/useWhiteboards.ts'), 'utf-8');
    expect(src).toMatch(/useLayoutEffect\(\(\) => \(\) => \{ loopRef\.current\?\.dispose\(\); \}, \[\]\);/);
    expect(src).toMatch(/loopRef\.current\?\.notifyChange\(\{ elements: kept, version \}\)/);
  });
});
