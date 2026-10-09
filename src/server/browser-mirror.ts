import WebSocket from 'ws';

/**
 * The chat's live browser view: frames read from the session's headless Chrome over CDP and
 * pushed to the pane as `_meta` frames.
 *
 * The browser is the one `@playwright/mcp` launches for this session, made headless and given
 * a loopback CDP port by `src/lib/browser-override.ts`. This module is a SECOND CDP client
 * on that browser: it never navigates, clicks or types, it only watches. Playwright keeps
 * driving over its own pipe.
 *
 * ── When it looks ────────────────────────────────────────────────────────────────────────
 * Chrome does not exist until the agent's first browser tool call launches it, so the mirror
 * attaches when it SEES such a call on the stdout stream: an `assistant` frame carrying a
 * `tool_use` named `mcp__<server>__…`. That is a structured field the CLI writes, not the
 * model's prose and not a command string. It then polls `/json/version` until Chrome answers,
 * and stays attached until the browser goes away; the next browser call attaches again.
 *
 * ── Which page ───────────────────────────────────────────────────────────────────────────
 * Playwright's own "current tab" is invisible to another CDP client. The page shown is the one
 * that most recently appeared or navigated, which is what an agent opening or using a tab does.
 *
 * ── What it refuses ──────────────────────────────────────────────────────────────────────
 * The port was free when it was picked, not necessarily when Chrome came up. Whatever answers
 * there must look like Chrome's DevTools endpoint on that same loopback port, or the mirror
 * stays dark (`unrecognized-shape-returns-null`).
 */

/** What the pane receives. `data` is a base64 JPEG. */
export type BrowserMetaFrame =
  | { subtype: 'browser_frame'; data: string; width: number; height: number; url: string; title: string; at: number }
  | { subtype: 'browser_state'; state: 'closed' };

export interface BrowserMirror {
  /** Every parsed stdout object goes through here. Cheap for the frames that are not ours. */
  observe: (obj: Record<string, unknown>) => void;
  /** The latest frame again, for a socket that just adopted this session. */
  replay: () => void;
  dispose: () => void;
}

export interface BrowserMirrorOptions {
  port: number;
  /** The MCP server's name, so `mcp__<server>__` identifies its tool calls. */
  server: string;
  send: (frame: BrowserMetaFrame) => void;
  /** Injected for tests. */
  fetchJson?: (url: string) => Promise<unknown>;
  connect?: (url: string) => CdpSocket;
  now?: () => number;
}

/** The slice of a WebSocket this module uses, so a test can stand one in. */
export interface CdpSocket {
  send: (data: string) => void;
  close: () => void;
  on: (event: 'open' | 'message' | 'close' | 'error', fn: (data?: unknown) => void) => void;
}

/** Chrome is launched by the first browser call; give it this long to answer. */
const ATTACH_WINDOW_MS = 30_000;
const POLL_MS = 400;
/** At most this often to the pane (~6 fps). Frames in between are replaced, never queued. */
const MIN_FRAME_GAP_MS = 160;
/** How often the shown page's title and address are asked for while it paints. */
const INFO_GAP_MS = 600;
/** A shown page that navigated and painted nothing for this long gets its screencast restarted. */
const STALL_MS = 1500;
const SCREENCAST = { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 } as const;

/** True for an `assistant` frame that calls one of `server`'s tools. */
export function callsServerTool(obj: Record<string, unknown>, server: string): boolean {
  if (obj.type !== 'assistant') return false;
  const content = (obj.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return false;
  const prefix = `mcp__${server}__`;
  return content.some((block) => {
    const b = block as { type?: unknown; name?: unknown } | null;
    return !!b && b.type === 'tool_use' && typeof b.name === 'string' && b.name.startsWith(prefix);
  });
}

/**
 * The browser-level DevTools URL from a `/json/version` answer, or null when the answer is
 * not Chrome's on this exact port.
 */
export function devtoolsUrlFrom(body: unknown, port: number): string | null {
  const url = (body as { webSocketDebuggerUrl?: unknown } | null)?.webSocketDebuggerUrl;
  if (typeof url !== 'string') return null;
  const ok = new RegExp(`^ws://(127\\.0\\.0\\.1|localhost):${port}/devtools/browser/[A-Za-z0-9-]+$`).test(url);
  return ok ? url : null;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return res.ok ? await res.json() : null;
  } finally {
    clearTimeout(timer);
  }
}

function defaultConnect(url: string): CdpSocket {
  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  return {
    send: (data) => { if (ws.readyState === ws.OPEN) ws.send(data); },
    close: () => { try { ws.close(); } catch { /* gone */ } },
    on: (event, fn) => { ws.on(event, (d: unknown) => fn(d)); },
  };
}

interface PageInfo { targetId: string; url: string; title: string }

export function createBrowserMirror(opts: BrowserMirrorOptions): BrowserMirror {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const connect = opts.connect ?? defaultConnect;
  const now = opts.now ?? Date.now;

  let disposed = false;
  let attaching = false;
  let socket: CdpSocket | null = null;
  let nextId = 1;
  const pages = new Map<string, PageInfo>();
  /** Most recent last. The page shown is the tail. */
  let order: string[] = [];
  let shown: { targetId: string; sessionId: string } | null = null;
  const pending = new Map<number, (result: Record<string, unknown> | null) => void>();

  let latest: Extract<BrowserMetaFrame, { subtype: 'browser_frame' }> | null = null;
  let lastSentAt = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let unsent = false;
  let infoTimer: ReturnType<typeof setTimeout> | null = null;
  let lastInfoAt = 0;
  /** Bumped by every announcement Chrome makes, so an answer asked for before it is dropped. */
  let infoVersion = 0;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFrameAt = 0;

  const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown> | null> => {
    if (!socket) return Promise.resolve(null);
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };

  const flush = (): void => {
    flushTimer = null;
    if (!latest || !unsent || disposed) return;
    unsent = false;
    lastSentAt = now();
    opts.send(latest);
  };

  const queueFrame = (): void => {
    unsent = true;
    if (flushTimer) return;
    const wait = Math.max(0, MIN_FRAME_GAP_MS - (now() - lastSentAt));
    if (wait === 0) flush();
    else flushTimer = setTimeout(flush, wait);
  };

  const showPage = async (targetId: string): Promise<void> => {
    if (!socket || shown?.targetId === targetId) return;
    const previous = shown;
    shown = null;
    if (previous) void call('Page.stopScreencast', {}, previous.sessionId);
    const attached = await call('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = typeof attached?.sessionId === 'string' ? attached.sessionId : null;
    if (!sessionId || !socket) return;
    // A newer page may have taken the slot while we waited for the attach.
    if (order[order.length - 1] !== targetId) return;
    shown = { targetId, sessionId };
    await call('Page.startScreencast', { ...SCREENCAST }, sessionId);
  };

  /** A page's address or title changed: the shown frame is re-sent under its new name, since a
   *  still page paints no more frames that would carry it. */
  const rename = (targetId: string, url: string, title: string): void => {
    const before = pages.get(targetId);
    if (!before || (before.url === url && before.title === title)) return;
    pages.set(targetId, { targetId, url, title });
    if (shown?.targetId === targetId && latest) {
      latest = { ...latest, url, title };
      queueFrame();
    }
  };

  /**
   * Chrome announces a page's address at navigation, when its title is still the address, and
   * announces a title set later by script, but NOT the `<title>` the document itself carries
   * (measured 2026-10-08: `targetInfoChanged` fires for `document.title = …`, never for the
   * parsed one). So while frames arrive the shown page's info is asked for directly, at most
   * once per INFO_GAP_MS, plus once after the last frame.
   */
  const refreshInfo = async (): Promise<void> => {
    infoTimer = null;
    const targetId = shown?.targetId;
    if (!targetId || !socket) return;
    lastInfoAt = now();
    const asked = infoVersion;
    const result = await call('Target.getTargetInfo', { targetId });
    // Chrome announced a navigation while we waited: this answer describes the page before it.
    if (asked !== infoVersion) return;
    const info = result?.targetInfo as { url?: unknown; title?: unknown } | undefined;
    if (info && typeof info.url === 'string' && typeof info.title === 'string') rename(targetId, info.url, info.title);
  };
  const scheduleInfoRefresh = (): void => {
    if (infoTimer) return;
    infoTimer = setTimeout(() => { void refreshInfo(); }, Math.max(INFO_GAP_MS - (now() - lastInfoAt), 250));
  };

  /**
   * A navigation that swaps the renderer process can end a screencast without a word: the
   * page paints, nothing arrives. If the shown page goes quiet right after it navigated, the
   * screencast is started again. Measured cost of a restart: one duplicate frame.
   */
  const watchForStall = (targetId: string): void => {
    if (stallTimer) clearTimeout(stallTimer);
    const navigatedAt = now();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (!socket || shown?.targetId !== targetId || lastFrameAt >= navigatedAt) return;
      const { sessionId } = shown;
      void call('Page.stopScreencast', {}, sessionId).then(() => call('Page.startScreencast', { ...SCREENCAST }, sessionId));
    }, STALL_MS);
  };

  const promote = (targetId: string): void => {
    order = [...order.filter((id) => id !== targetId), targetId];
    void showPage(targetId);
  };

  const forget = (targetId: string): void => {
    pages.delete(targetId);
    order = order.filter((id) => id !== targetId);
    if (shown?.targetId === targetId) {
      shown = null;
      const next = order[order.length - 1];
      if (next) void showPage(next);
    }
  };

  const reset = (announce: boolean): void => {
    const had = socket !== null;
    socket = null;
    shown = null;
    pages.clear();
    order = [];
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (infoTimer) { clearTimeout(infoTimer); infoTimer = null; }
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    latest = null;
    unsent = false;
    if (announce && had && !disposed) opts.send({ subtype: 'browser_state', state: 'closed' });
  };

  const onMessage = (raw: unknown): void => {
    let msg: { id?: unknown; result?: unknown; method?: unknown; params?: unknown; sessionId?: unknown };
    try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }
    if (typeof msg.id === 'number') {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg.result && typeof msg.result === 'object' ? msg.result as Record<string, unknown> : null);
      }
      return;
    }
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (msg.method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const info = params.targetInfo as { targetId?: unknown; type?: unknown; url?: unknown; title?: unknown } | undefined;
        if (!info || info.type !== 'page' || typeof info.targetId !== 'string') return;
        const url = typeof info.url === 'string' ? info.url : '';
        const title = typeof info.title === 'string' ? info.title : '';
        infoVersion += 1;
        const before = pages.get(info.targetId);
        if (!before || before.url !== url) {
          pages.set(info.targetId, { targetId: info.targetId, url, title });
          // A new page, or a page that went somewhere, is where the agent is working now.
          promote(info.targetId);
          if (before && shown?.targetId === info.targetId) watchForStall(info.targetId);
        } else {
          rename(info.targetId, url, title);
        }
        return;
      }
      case 'Target.targetDestroyed': {
        if (typeof params.targetId === 'string') forget(params.targetId);
        return;
      }
      case 'Page.screencastFrame': {
        const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
        if (!sessionId) return;
        if (typeof params.sessionId === 'number') void call('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId);
        if (!shown || shown.sessionId !== sessionId || typeof params.data !== 'string') return;
        lastFrameAt = now();
        const meta = (params.metadata ?? {}) as { deviceWidth?: unknown; deviceHeight?: unknown };
        const page = pages.get(shown.targetId);
        latest = {
          subtype: 'browser_frame',
          data: params.data,
          width: typeof meta.deviceWidth === 'number' ? Math.round(meta.deviceWidth) : 0,
          height: typeof meta.deviceHeight === 'number' ? Math.round(meta.deviceHeight) : 0,
          url: page?.url ?? '',
          title: page?.title ?? '',
          at: now(),
        };
        queueFrame();
        scheduleInfoRefresh();
        return;
      }
      default:
    }
  };

  const attach = async (): Promise<void> => {
    if (attaching || socket || disposed) return;
    attaching = true;
    try {
      const deadline = now() + ATTACH_WINDOW_MS;
      let url: string | null = null;
      while (!disposed && now() < deadline) {
        try { url = devtoolsUrlFrom(await fetchJson(`http://127.0.0.1:${opts.port}/json/version`), opts.port); } catch { url = null; }
        if (url) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      if (!url || disposed) return;
      const sock = connect(url);
      const opened = await new Promise<boolean>((resolve) => {
        sock.on('open', () => resolve(true));
        sock.on('error', () => resolve(false));
        sock.on('close', () => resolve(false));
      });
      if (!opened || disposed) { sock.close(); return; }
      socket = sock;
      sock.on('message', onMessage);
      sock.on('close', () => { if (socket === sock) reset(true); });
      sock.on('error', () => { if (socket === sock) { sock.close(); reset(true); } });
      await call('Target.setDiscoverTargets', { discover: true });
    } finally {
      attaching = false;
    }
  };

  return {
    observe: (obj) => {
      if (disposed || socket || attaching) return;
      if (callsServerTool(obj, opts.server)) void attach();
    },
    replay: () => {
      if (latest && !disposed) opts.send(latest);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const sock = socket;
      reset(false);
      sock?.close();
    },
  };
}
