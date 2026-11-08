/**
 * Runs before any dashboard module: the page believes it is the desktop shell, and the Telegram
 * routes W2 serves answer from a fake keyed by `?view=` (W3's routes on this branch have no server
 * yet). Every shell command the page invokes is recorded in `window.__invoked`.
 */
const w = window as unknown as Record<string, unknown>;
const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'sheet-manager';
/** `real=1`: no faked routes; /api goes through Vite's proxy to a real server. */
const real = params.get('real') === '1';
const invoked: Array<{ cmd: string; args: unknown }> = [];
w.__invoked = invoked;

if (params.get('browser') !== '1') {
  w.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: unknown) => {
      invoked.push({ cmd, args });
      // `real=1`: the Rust command's stand-in (telegram-manager-real.ts) talks to the REAL server.
      if (cmd === 'confirm_telegram_binding' && real) return (w.__rustConfirm as (id: unknown) => Promise<unknown>)((args as { pairingId: unknown }).pairingId);
      if (cmd === 'confirm_telegram_binding') { state.boundAfterConfirm = true; return { ok: true }; }
      if (cmd === 'confirm_telegram_forward') { state.forwardOn = true; return { ok: true }; }
      if (cmd === 'start_telegram_creation') return { ok: true, link: 'https://t.me/newbot/nm_dc_bot/orbit_super_k3x9_bot?name=Super+%C2%B7+Orbit', projectName: 'Orbit' };
      if (cmd === 'start_telegram_readopt') return { ok: true };
      if (cmd === 'plugin:shell|open' || cmd === 'open_external_url') return null;
      throw new Error(`command ${cmd} not found`);
    },
    transformCallback: () => 0,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}
localStorage.setItem('dreamcontext-theme', params.get('theme') === 'dark' ? 'dark' : 'light');

const state = { boundAfterConfirm: false, forwardOn: false, bindPosted: false, polls: 0 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const superRow = { scope: '0123456789abcdef', target: 'super', state: 'active', botUsername: 'orbit_super_bot', userLabel: 'deniz' };
const memberRow = { scope: '0123456789abcdef', target: 'ua-lead', state: 'active', botUsername: 'orbit_ua_lead_bot', userLabel: 'deniz', managed: true };
const managerRow = { scope: 'manager', target: '@manager', state: 'active', botUsername: 'orbit_manager_bot', userLabel: 'deniz' };

function status(): unknown {
  const manager = view === 'sheet-nomanager' || view === 'member-unbound-nomanager' ? null : managerRow;
  if (view === 'sheet-connected' || view === 'menu-bound') return { rows: [superRow], manager };
  if (view === 'member-bound') return { rows: [memberRow], manager };
  if (view === 'bindflow') {
    state.polls += 1;
    if (state.boundAfterConfirm) return { rows: [superRow], manager: null };
    // After the bind POST, Telegram's /start arrives on the third poll: the row turns pending.
    if (state.bindPosted && state.polls > 2) return { rows: [{ ...superRow, state: 'pending' }], manager: null };
    return { rows: [], manager: null };
  }
  return { rows: [], manager };
}

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
  const method = (init?.method ?? 'GET').toUpperCase();
  if (!path.startsWith('/api/') || real) return realFetch(input, init);
  if (path === '/api/telegram' && method === 'GET') return json(status());
  if (path === '/api/telegram/super/bind' && method === 'POST') {
    state.bindPosted = true; state.polls = 0;
    return json({ pairingId: 'AbCdEfGhIjKlMnOpQrStUv', deepLink: 'https://t.me/orbit_super_bot?start=Zx9Yw8Vu7Ts6Rq5Po4Nm3L', botUsername: 'orbit_super_bot', expiresAt: Date.now() + 600_000 });
  }
  if (/^\/api\/telegram\/[a-z0-9-]+\/forward$/.test(path) && method === 'GET') {
    return json({ routines: [
      { slug: 'daily-budget', title: 'Günlük bütçe kontrolü', on: true },
      { slug: 'weekly-creative', title: 'Haftalık kreatif raporu', on: state.forwardOn },
    ] });
  }
  if (/^\/api\/telegram\/[a-z0-9-]+\/forward\/request$/.test(path)) return json({ forwardRequestId: 'FwdReqAbCdEfGhIjKlMnOp' });
  if (/^\/api\/telegram\/[a-z0-9-]+\/readopt$/.test(path)) return json(view === 'sheet-manager' ? { available: true, botUsername: 'orbit_super_old_bot' } : { available: false });
  if (/^\/api\/telegram\/[a-z0-9-]+\/creation\/request$/.test(path)) return json({ creationId: 'CrtAbCdEfGhIjKlMnOpQrS' });
  if (path === '/api/telegram-manager/status') {
    if (view === 'settings-none') return json({ manager: null, bots: [] });
    if (view === 'settings-alarm') return json({ manager: managerRow, bots: [], alarm: 'conflict' });
    return json({ manager: managerRow, bots: [
      { projectName: 'Orbit', target: 'super', label: 'Super', botUsername: 'orbit_super_bot', state: 'active' },
      { projectName: 'Atlas', target: 'super', label: 'Super', botUsername: 'atlas_super_bot', state: 'active' },
      { projectName: 'Orbit', target: 'ua-lead', label: 'UA Lead', botUsername: 'orbit_ua_lead_bot', state: 'active' },
    ] });
  }
  return json({ error: 'not_found' }, 404);
}) as typeof fetch;
