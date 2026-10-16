import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type { PowerRunner } from '../../lib/handsfree/mac/power.js';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import type { Router } from '../router.js';
import { laptopRouteRefusal } from './handsfree.js';
import { isAway } from '../../lib/handsfree/trip-state.js';
import { notifyViaBundle } from '../../lib/automations/notifier.js';
import { generatePassphrase, hashPassphrase, macHandsfreeAuth, onMacSignIn } from '../handsfree-auth.js';
import { setMacProbeNonce, setMacPublicOrigin } from '../phone-origin.js';
import { setMacPhoneSource } from '../handsfree-login.js';
import { releasePhoneSessions } from './agent-chat.js';
import { MacModeError, MacSession, type MacSessionDeps } from '../../lib/handsfree/mac/session.js';
import { isValidHostname } from '../../lib/handsfree/mac/tunnel.js';
import type { MacErrorCode } from '../../lib/handsfree/mac/contract.js';

/**
 * Mac mode's routes (`/api/handsfree/mac/*`): the desktop's Hands-free sheet and the CLI drive
 * the session through these. MAIN listener only — the phone listener's allow-list never names
 * them — and behind the laptop gate (desktop, loopback, loopback Host, same-site, no forwarded
 * header, no credential). Secrets: the passphrase is returned ONCE (setup, password) and the QR
 * URL on demand; the tunnel credentials are never returned at all.
 */

let listener: { start: () => Promise<{ port: number }>; stop: () => Promise<void> } | null = null;

/** index.ts hands in the phone listener's controls once the main server runs. */
export function configureMacListener(next: { start: () => Promise<{ port: number }>; stop: () => Promise<void> } | null): void {
  listener = next;
}

let session: MacSession | null = null;

function notify(title: string, body: string): void {
  try { notifyViaBundle(title, body); } catch { /* a banner never blocks Mac mode */ }
}

/**
 * VERIFY SEAM (scripts/verify/handsfree-mac.mjs): `DREAMCONTEXT_MAC_VERIFY_POWER_LOG=<file>` swaps
 * the pmset/sudo runner for one that only LOGS what it would run (a verify cannot answer an
 * admin prompt). It polls the battery every 2 s and reads it from `<file>.batt` when that exists, so
 * the verify can drain it below the floor (AC13). Honoured only when HOME is inside the OS temp dir, i.e. a scratch vault — never
 * on the owner's real machine state.
 */
function verifyPowerSeam(): Partial<MacSessionDeps> {
  const log = process.env.DREAMCONTEXT_MAC_VERIFY_POWER_LOG;
  if (!log) return {};
  let inTmp = false;
  try { inTmp = resolve(realpathSync(homedir())).startsWith(resolve(realpathSync(tmpdir())) + '/'); } catch { inTmp = false; }
  if (!inTmp) return {};
  const state = { sleep: 0, b: 0, c: 1 };
  const run: PowerRunner = async (file, args) => {
    const line = [file, ...args].join(' ');
    appendFileSync(log, line + '\n');
    const m = /pmset -([abc]) (disablesleep|lowpowermode) ([01])$/.exec(line);
    if (m && !args.includes('-l')) {
      if (m[2] === 'disablesleep') state.sleep = Number(m[3]);
      else if (m[1] === 'b') state.b = Number(m[3]); else state.c = Number(m[3]);
    }
    if (line === '/usr/bin/pmset -g custom') return { code: 0, stdout: `Battery Power:\n lowpowermode         ${state.b}\nAC Power:\n lowpowermode         ${state.c}\n`, stderr: '' };
    if (line === '/usr/bin/pmset -g') return { code: 0, stdout: `System-wide power settings:\n SleepDisabled\t\t${state.sleep}\n`, stderr: '' };
    if (line === '/usr/bin/pmset -g batt') {
      // `<log>.batt`, when present, is the battery reading (the verify drains it for AC13).
      const batt = existsSync(`${log}.batt`) ? readFileSync(`${log}.batt`, 'utf8') : "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t87%; charging; present: true";
      return { code: 0, stdout: batt, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { powerRun: run, batteryPollMs: 2000, sudoersInstalled: () => true, installSudoers: async () => 'ok', removeSudoers: async () => 'ok' };
}

/** The process's Mac session (created on first use) over the real OS adapters. */
export function macSession(): MacSession {
  if (!session) {
    const deps: MacSessionDeps = {
      auth: () => macHandsfreeAuth(),
      hashPassphrase: (p) => hashPassphrase(p),
      generatePassphrase: () => generatePassphrase(),
      startListener: () => { if (!listener) throw new Error('the dashboard server is not running'); return listener.start(); },
      stopListener: () => (listener ? listener.stop() : Promise.resolve()),
      setPublicOrigin: setMacPublicOrigin,
      setProbeNonce: setMacProbeNonce,
      setPhoneSource: setMacPhoneSource,
      releasePhoneSessions,
      cloudTripActive: () => isAway(),
      notify,
      ...verifyPowerSeam(),
    };
    session = new MacSession(deps);
    // AC14: every new phone sign-in posts a notification on the Mac.
    onMacSignIn((label) => notify('Hands-free: a phone signed in', `${label} signed in to this Mac. Not you? Open Hands-free and press "Hepsini çıkar".`));
  }
  return session;
}

/** Tests only. */
export function setMacSessionForTests(next: MacSession | null): void {
  session = next;
}

/** Is Mac mode on in this process? (the cloud's go refuses while it is). */
export function macModeOn(): boolean {
  return session?.isOn() ?? false;
}

/**
 * Where the CLI finds this desktop server: `~/.dreamcontext/handsfree-mac/server.json`
 * `{pid, port}` (0600). Written at boot by the desktop server only.
 */
export function writeMacServerHint(port: number, home: string = homedir()): void {
  try {
    const dir = join(home, '.dreamcontext', 'handsfree-mac');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ pid: process.pid, port }), { mode: 0o600 });
  } catch { /* the CLI then says to open the app */ }
}

const STATUS: Record<MacErrorCode, number> = {
  mac_not_setup: 409, mac_sudo_missing: 409, mac_cloud_trip_active: 409, mac_already_on: 409, mac_not_on: 409,
  mac_tunnel_failed: 502, mac_probe_failed: 502, mac_binary_failed: 502, mac_admin_cancelled: 409,
  mac_fixed_not_setup: 409, mac_unsupported_platform: 400, mac_hostname_in_use: 409,
};

function fail(res: ServerResponse, err: unknown): void {
  if (err instanceof MacModeError) { sendError(res, STATUS[err.code] ?? 409, err.code, err.message); return; }
  console.error('[handsfree-mac] failed:', (err as Error)?.message ?? err);
  sendError(res, 500, 'internal_error', 'Mac mode failed.');
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Every Mac route: the laptop gate first; nothing reaches a handler from a tunnel or a page.
 *  `longMs`: a route that may outlive the server's 30 s socket timeout (start downloads the
 *  pinned binary the first time; setup waits on the admin prompt; the fixed address on a
 *  browser login) extends ITS request's timeout only. */
function guarded(fn: Handler, longMs = 0): Handler {
  return async (req, res) => {
    const r = laptopRouteRefusal(req);
    if (r) { sendError(res, r.status, r.code, r.message); return; }
    if (longMs) { try { req.setTimeout(longMs); res.setTimeout(longMs); } catch { /* a test double */ } }
    res.setHeader('Cache-Control', 'no-store');
    try { await fn(req, res); } catch (err) { fail(res, err); }
  };
}

export const handsfreeMacRoutes = {
  status: guarded(async (_req, res) => { sendJson(res, 200, macSession().status()); }),
  setup: guarded(async (req, res) => {
    const b = await parseJsonBody(req);
    const out = await macSession().setup({ newPassphrase: b?.newPassphrase === true });
    sendJson(res, 200, { ...macSession().status(), passphrase: out.passphrase });
  }, 5 * 60_000),
  start: guarded(async (_req, res) => { sendJson(res, 200, await macSession().start()); }, 5 * 60_000),
  stop: guarded(async (_req, res) => { await macSession().stop(); sendJson(res, 200, macSession().status()); }),
  qr: guarded(async (_req, res) => { sendJson(res, 200, { url: macSession().mintQr() }); }),
  password: guarded(async (_req, res) => { sendJson(res, 200, { passphrase: await macSession().setPassword() }); }),
  devices: guarded(async (_req, res) => { sendJson(res, 200, { devices: macSession().devices() }); }),
  revokeAll: guarded(async (_req, res) => { sendJson(res, 200, { revoked: macSession().revokeAll() }); }),
  fixedSetup: guarded(async (req, res) => {
    const b = await parseJsonBody(req);
    const hostname = typeof b?.hostname === 'string' ? b.hostname.trim().toLowerCase() : '';
    if (!isValidHostname(hostname)) { sendError(res, 400, 'invalid_hostname', 'Give a hostname on a domain in your Cloudflare account, like phone.example.com.'); return; }
    let loginUrl: string | null = null;
    const rec = await macSession().setupFixed(hostname, (u) => {
      loginUrl = u;
      notify('Hands-free: sign in to Cloudflare', 'Your browser opened Cloudflare; pick the domain to authorise this Mac.');
    }, { overwriteDns: b?.overwrite === true });
    sendJson(res, 200, { hostname: rec.hostname, loginUrl });
  }, 15 * 60_000),
  fixedRemove: guarded(async (_req, res) => { macSession().removeFixed(); sendJson(res, 200, macSession().status()); }),
  uninstall: guarded(async (_req, res) => { await macSession().uninstall(); sendJson(res, 200, { ok: true }); }, 5 * 60_000),
};

export function registerHandsfreeMacRoutes(router: Router): void {
  router.get('/api/handsfree/mac/status', handsfreeMacRoutes.status);
  router.post('/api/handsfree/mac/setup', handsfreeMacRoutes.setup);
  router.post('/api/handsfree/mac/start', handsfreeMacRoutes.start);
  router.post('/api/handsfree/mac/stop', handsfreeMacRoutes.stop);
  router.post('/api/handsfree/mac/qr', handsfreeMacRoutes.qr);
  router.post('/api/handsfree/mac/password', handsfreeMacRoutes.password);
  router.get('/api/handsfree/mac/devices', handsfreeMacRoutes.devices);
  router.post('/api/handsfree/mac/devices/revoke-all', handsfreeMacRoutes.revokeAll);
  router.post('/api/handsfree/mac/tunnel/fixed', handsfreeMacRoutes.fixedSetup);
  router.delete('/api/handsfree/mac/tunnel/fixed', handsfreeMacRoutes.fixedRemove);
  router.post('/api/handsfree/mac/uninstall', handsfreeMacRoutes.uninstall);
}
