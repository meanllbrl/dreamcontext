/**
 * Runs before any dashboard module (W4 run/secret cards harness). `?host=mac` believes it is the
 * desktop shell; `?host=phone` is the hands-free phone page (the surface meta, no shell). The
 * card records come from a fake `GET /api/agent/cards` keyed by `?view=`; every terminal socket
 * is a fake that records its URL in `window.__sockets` and plays a little output (`?sock=refuse`:
 * the server refuses the upgrade, it never opens; `?sock=exit`: the process exits 0 after its
 * output); every secret POST body is recorded in `window.__posts`.
 */
const w = window as unknown as Record<string, unknown>;
const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'idle';
const host = params.get('host') ?? 'mac';
const sock = params.get('sock') ?? 'live';
export const SID = '11111111-2222-4333-8444-555555555555';
export const RUN_SPEC = { type: 'run', id: 'gh-login', command: 'gh auth login --web', why: 'GitHub girişini senin yapman gerekiyor.' };
export const SECRET_SPEC = { type: 'secret', id: 'stripe', title: 'Stripe test key', file: '.env.local', fields: [{ key: 'STRIPE_SECRET_KEY', label: 'Secret key', hint: 'sk_test_ ile başlar' }] };

if (host === 'mac') {
  w.__TAURI_INTERNALS__ = {
    invoke: async () => null,
    transformCallback: () => 0,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
} else {
  const meta = document.createElement('meta');
  meta.name = 'dreamcontext-surface';
  meta.content = 'mac';
  document.head.appendChild(meta);
}
localStorage.setItem('dreamcontext-theme', params.get('theme') === 'dark' ? 'dark' : 'light');

const RUN_REF = 'a'.repeat(32);
const SECRET_REF = 'b'.repeat(32);
function records(): unknown[] {
  if (view === 'unrecorded') return [];
  const run = view === 'live-telegram' ? { runId: 'r1', owner: 'telegram' } : null;
  // done: both finished by their own end; superseded: the agent posted both again further down;
  // interrupted: the app stopped mid-run (the secret is still open).
  const runClosedBy = view === 'done' ? 'done' : view === 'superseded' ? 'superseded' : view === 'interrupted' ? 'interrupted' : null;
  const secretClosedBy = view === 'done' ? 'done' : view === 'superseded' ? 'superseded' : null;
  const closed = (by: string | null) => (by ? { state: 'closed', closedBy: by } : { state: 'open' });
  return [
    { id: RUN_SPEC.id, cardRef: RUN_REF, kind: 'run', spec: RUN_SPEC, ...closed(runClosedBy), run, ...(view === 'done' ? { exit: 0 } : {}) },
    { id: SECRET_SPEC.id, cardRef: SECRET_REF, kind: 'secret', spec: SECRET_SPEC, ...closed(secretClosedBy), run: null },
  ];
}

const posts: unknown[] = [];
w.__posts = posts;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
  const method = (init?.method ?? 'GET').toUpperCase();
  if (!path.startsWith('/api/')) return realFetch(input, init);
  if (path === '/api/agent/cards' && method === 'GET') return json({ session: SID, cards: records() });
  if (path === '/api/agent/secret' && method === 'POST') {
    posts.push(JSON.parse(String(init?.body ?? '{}')));
    return json({ file: '.env.local', written: [{ key: 'STRIPE_SECRET_KEY', chars: 24, fingerprint: '3f2a91c0', action: 'added' }], receipt: '[secret submitted · Stripe test key]' });
  }
  return json({});
}) as typeof window.fetch;

const sockets: string[] = [];
w.__sockets = sockets;
class FakeSocket extends EventTarget {
  static OPEN = 1;
  readonly OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  url: string;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(url: string) {
    super();
    this.url = url;
    sockets.push(url.replace(/^wss?:\/\/[^/]+/, ''));
    if (sock === 'refuse') {
      setTimeout(() => {
        this.readyState = 3;
        this.onerror?.(new Event('error'));
        this.onclose?.(new CloseEvent('close', { code: 1006 }));
      }, 50);
      return;
    }
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
      const lines = ['! First copy your one-time code: 4F2A-9C1D\r\n', 'Press Enter to open github.com in your browser... '];
      lines.forEach((l, i) => setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: l })), 80 * (i + 1)));
      if (sock === 'exit') {
        setTimeout(() => {
          this.onmessage?.(new MessageEvent('message', { data: new TextEncoder().encode(JSON.stringify({ type: 'exit', code: 0 })).buffer }));
          this.readyState = 3;
          this.onclose?.(new CloseEvent('close', { code: 1000 }));
        }, 400);
      }
    }, 50);
  }
  send(): void { /* keystrokes and resizes go nowhere */ }
  close(): void { this.readyState = 3; }
}
w.WebSocket = FakeSocket;
