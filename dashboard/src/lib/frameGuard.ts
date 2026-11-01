/**
 * The SPA's fail-closed frame fallback (T1b in the super-agent-mode threat model). The server
 * refuses a foreign frame by Fetch Metadata (`refuseForeignFrame`); an old WebKit sends none,
 * so the page itself checks where it is drawn: framed by a parent it cannot prove is this
 * origin = draw nothing. Reading a cross-origin parent's `location` throws, and a throw is
 * foreign too.
 */
export function isFramedByForeignParent(win: Pick<Window, 'top' | 'self' | 'parent' | 'location'>): boolean {
  let framed: boolean;
  try {
    framed = win.top !== win.self;
  } catch {
    return true;
  }
  if (!framed) return false;
  try {
    return win.parent.location.origin !== win.location.origin;
  } catch {
    return true;
  }
}

/** What the server's frame check granted this page: one app's screen, in that app's window. */
export interface EmbedGrant {
  tk: string;
  view: string;
  slug: string;
  vault: string;
  member: string | null;
  insight: string | null;
}

let grant: EmbedGrant | null = null;

/** The grant the check below won, or null in every ordinary window. */
export function embedGrant(): EmbedGrant | null {
  return grant;
}

/**
 * Framed by a foreign parent, with a token in the URL: ask the server before drawing anything.
 * The server's own frame check (`embedFrameGrant`) is the first wall; this one is what an old
 * WebKit meets. On success the token leaves the URL, so a screen cannot leak it onward.
 */
export async function checkEmbedFrame(win: Window, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const params = new URLSearchParams(win.location.search);
  const tk = params.get('tk');
  const view = params.get('embed');
  const vault = params.get('vault');
  if (!tk || !view || !vault) return false;
  try {
    const r = await fetchImpl('/api/apps/embed-check', { method: 'POST', headers: { 'x-dc-embed': tk } });
    if (!r.ok) return false;
    const body = await r.json() as { slug?: unknown; vault?: unknown };
    if (typeof body.slug !== 'string' || body.vault !== vault) return false;
    const theme = params.get('theme');
    if (theme === 'light' || theme === 'dark' || theme === 'system') win.localStorage.setItem('dreamcontext-theme', theme);
    grant = { tk, view, slug: body.slug, vault, member: params.get('member'), insight: params.get('insight') };
    lockEmbedWrites(win, body.slug);
    const url = new URL(win.location.href);
    url.searchParams.delete('tk');
    win.history.replaceState(win.history.state, '', url.toString());
    return true;
  } catch {
    return false;
  }
}

/** The one write an embedded screen makes: its chat's send, as the app. */
export function embedWriteAllowed(method: string, url: string, base: string, slug: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  let path: string;
  try { path = new URL(url, base).pathname; } catch { return false; }
  return m === 'POST' && (path === `/api/apps/${encodeURIComponent(slug)}/say` || path === '/api/apps/embed-check');
}

/**
 * An embedded screen shows the work; it never acts as the owner. The app's page frames it and can
 * overlay or steer clicks (clickjacking), and the screen's own calls reach the server as ordinary
 * owner requests. So in the frame every write is refused HERE, before it leaves, whatever control
 * issued it: fetch and XMLHttpRequest alike. Hidden buttons are the courtesy; this is the wall.
 */
export function lockEmbedWrites(win: Window, slug: string): void {
  const base = win.location.href;
  const refused = () => new Error('An app window shows dreamcontext; changes are made in the main app.');
  const realFetch = win.fetch.bind(win);
  win.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!embedWriteAllowed(method, url, base, slug)) return Promise.reject(refused());
    return realFetch(input, init);
  }) as typeof fetch;
  const X = (win as Window & { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
  if (X) {
    const open = X.prototype.open;
    const send = X.prototype.send;
    const blocked = new WeakSet<XMLHttpRequest>();
    X.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      if (!embedWriteAllowed(method, String(url), base, slug)) blocked.add(this);
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof X.prototype.open;
    X.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      if (blocked.has(this)) throw refused();
      return send.call(this, body);
    };
  }
}
