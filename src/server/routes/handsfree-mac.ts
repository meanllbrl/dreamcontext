import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type { PowerRunner } from '../../lib/handsfree/mac/power.js';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import type { Router } from '../router.js';
import { isDesktop } from '../desktop.js';
import { isLoopback } from './agent-spawn-shared.js';
import { AUTH_COOKIE } from '../network-auth.js';
import { notifyViaBundle } from '../../lib/automations/notifier.js';
import { listVaults } from '../../lib/vaults.js';
import { superIndex } from '../../lib/super/store.js';
import { deviceIdHash, ensureMacHandsfreeDir, generatePassphrase, hashPassphrase, macHandsfreeAuth, onDeviceSessionsChanged, onMacSignIn } from '../handsfree-auth.js';
import { isPhoneSocket, macExposedVaults, macPublicOrigin, setMacExposedVaults, setMacProbeNonce, setMacPublicOrigin } from '../phone-origin.js';
import { setMacPhoneSource } from '../handsfree-login.js';
import { phoneDeviceShowing, releasePhoneSessions } from './agent-chat.js';
import { landPhoneRosterOnDesktop } from './agent-sessions.js';
import { onChatChange } from '../../lib/assistant/chat-registry.js';
import { loadOrCreateVapid, sendPush, type VapidKeys } from '../../lib/handsfree/mac/push.js';
import { PushStore, setVerifyPushOrigin, subscriptionRefusal } from '../../lib/handsfree/mac/push-store.js';
import { PushNotifier, type PushNotifierDeps } from '../../lib/handsfree/mac/push-notifier.js';
import { setOwnerQuestionSinks } from '../../lib/super/owner-question.js';
import { MacModeError, MacSession, type MacSessionDeps } from '../../lib/handsfree/mac/session.js';
import { isValidHostname } from '../../lib/handsfree/mac/tunnel.js';
import { MAC_THERMAL_STATES, type MacErrorCode, type MacThermalState } from '../../lib/handsfree/mac/contract.js';
import { PHONE_LOG_INTERVAL_MS, PHONE_LOG_MAX_BYTES, parsePhoneLog, writePhoneLog } from '../../lib/handsfree/mac/phone-log.js';

/**
 * Mac mode's routes (`/api/handsfree/mac/*`): the desktop's Hands-free sheet and the CLI drive
 * the session through these. MAIN listener only — the phone listener's allow-list never names
 * them — and behind the laptop gate (desktop, loopback, loopback Host, same-site, no forwarded
 * header, no credential). Secrets: the passphrase is returned ONCE (setup, password) and the QR
 * URL on demand; the tunnel credentials are never returned at all.
 */

// ─── The laptop gate ────────────────────────────────────────────────────────

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function carriesNetworkToken(req: IncomingMessage): boolean {
  const cookie = req.headers.cookie ?? '';
  if (cookie.split(';').some((p) => p.split('=')[0].trim() === AUTH_COOKIE)) return true;
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams.has('token');
  } catch {
    return true;
  }
}

/** Why a laptop hands-free request is refused, or null when it may pass. */
export function laptopRouteRefusal(req: IncomingMessage): { status: number; code: string; message: string } | null {
  if (!isDesktop()) return { status: 403, code: 'desktop_only', message: 'Hands-free mode is driven from the desktop app.' };
  if (!isLoopback(req)) return { status: 403, code: 'loopback_only', message: 'Hands-free mode is only reachable from this machine.' };
  if (carriesNetworkToken(req)) return { status: 403, code: 'loopback_only', message: 'Hands-free routes refuse network-token requests.' };
  if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip']) {
    return { status: 403, code: 'loopback_only', message: 'Hands-free routes refuse forwarded (tailnet or proxy) requests.' };
  }
  if (typeof req.headers.authorization === 'string' && req.headers.authorization.trim()) {
    return { status: 403, code: 'loopback_only', message: 'Hands-free routes take no credential.' };
  }
  const host = req.headers.host ?? '';
  if (!LOCAL_HOST_RE.test(host)) return { status: 403, code: 'loopback_only', message: 'Hands-free routes answer only on a loopback host name.' };
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN_RE.test(origin)) return { status: 403, code: 'forbidden', message: 'Cross-site request blocked.' };
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return { status: 403, code: 'forbidden', message: 'Cross-site request blocked.' };
  }
  return null;
}

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
function homeInTmp(): boolean {
  try { return resolve(realpathSync(homedir())).startsWith(resolve(realpathSync(tmpdir())) + '/'); } catch { return false; }
}

/**
 * VERIFY SEAM: `DREAMCONTEXT_MAC_VERIFY_PUSH_ORIGIN=http://127.0.0.1:<port>` lets the verify's
 * local fake push service be subscribed (the store accepts only real push services otherwise).
 * Honoured only for a scratch HOME under the temp dir, like the power seam.
 */
function verifyPushSeam(): void {
  const origin = process.env.DREAMCONTEXT_MAC_VERIFY_PUSH_ORIGIN;
  if (!origin || !homeInTmp()) return;
  try { if (/^http:\/\/127\.0\.0\.1:\d+$/.test(new URL(origin).origin)) setVerifyPushOrigin(new URL(origin).origin); } catch { /* not a URL */ }
}

export function verifyPowerSeam(): Partial<MacSessionDeps> {
  const log = process.env.DREAMCONTEXT_MAC_VERIFY_POWER_LOG;
  if (!log) return {};
  if (!homeInTmp()) return {};
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
  // A verify must never slow the owner's real processes: the reading is `<log>.thermal` when that
  // holds exactly one of the four states (the verify flips it to `serious`), else nominal, and no
  // real process may ever become a root (no `taskpolicy -b`), whatever the reading.
  return {
    powerRun: run, batteryPollMs: 2000, sudoersInstalled: () => true, installSudoers: async () => 'ok', removeSudoers: async () => 'ok',
    readThermal: async () => verifyThermalReading(log),
    thermalFilter: () => false,
    thermalPollMs: 2000,
    ...verifyFakeTunnelSeam(),
  };
}

/** The verify's thermal reading: `<log>.thermal`, one of the four states exactly, else nominal. */
export function verifyThermalReading(log: string): MacThermalState {
  let t = '';
  try { t = readFileSync(`${log}.thermal`, 'utf8').trim(); } catch { /* missing: nominal */ }
  return (MAC_THERMAL_STATES as readonly string[]).includes(t) ? t as MacThermalState : 'nominal';
}

/**
 * VERIFY SEAM: `DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL=1` (with the power seam, so a scratch HOME
 * only) replaces cloudflared with a loopback stand-in: the address is the phone listener itself
 * and the probe passes. It brings the panel's running state up without a Cloudflare tunnel (a
 * quick tunnel can be rate-limited); nothing leaves the machine.
 */
function verifyFakeTunnelSeam(): Partial<MacSessionDeps> {
  if (process.env.DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL !== '1') return {};
  return {
    ensureBinary: async () => '/usr/bin/true',
    probe: async () => true,
    makeSupervisor: (o, e) => ({
      pid: null,
      url: null,
      start: async () => {
        const url = `http://127.0.0.1:${o.phonePort}`;
        e.onUrl(url, false);
        return { child: new EventEmitter() as never, url, mode: 'quick' as const };
      },
      stop: async () => {},
    }),
  };
}

/** Return: each exposed project's phone tabs move into its desktop roster. A registered NAME
 *  only (never a path); a project that fails is logged and the others still land. */
async function landPhoneTabs(vaults: readonly string[], o: { waitMs: number }): Promise<number> {
  const registered = new Map(listVaults().map((v) => [v.name, v.path]));
  let n = 0;
  for (const name of vaults) {
    const path = registered.get(name);
    if (!path) continue;
    try { n += await landPhoneRosterOnDesktop(join(path, '_dream_context'), o); } catch (err) {
      console.warn(`[handsfree-mac] the phone's tabs of ${name} did not land: ${(err as Error).message}`);
    }
  }
  return n;
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
      setExposedVaults: setMacExposedVaults,
      releasePhoneSessions,
      landPhoneTabs,
      notify,
      // The first very-hot reading of a run: one phone push (the owner-question pattern below).
      onHeat: (_s, run) => {
        try {
          const r = armPushNotifier().pushMacHeat({
            key: `heat:${run.startedAt}`,
            title: 'Mac is very hot',
            body: run.bagMode
              ? 'Heavy steps now run one at a time. If you can, take the Mac out of the bag.'
              : 'Heavy steps now run one at a time; nothing was stopped.',
          });
          void r.done.catch((err) => { console.warn('[handsfree-push] heat push failed:', (err as Error)?.message ?? err); });
          return r.targeted;
        } catch (err) {
          console.warn('[handsfree-push] heat push failed:', (err as Error)?.message ?? err);
          return 0;
        }
      },
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

/** Is Mac mode on in this process? */
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
  mac_not_setup: 409, mac_sudo_missing: 409, mac_already_on: 409, mac_not_on: 409,
  mac_tunnel_failed: 502, mac_probe_failed: 502, mac_binary_failed: 502, mac_admin_cancelled: 409,
  mac_fixed_not_setup: 409, mac_unsupported_platform: 400, mac_hostname_in_use: 409, mac_no_project: 400, mac_unknown_project: 400,
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
  start: guarded(async (req, res) => {
    // The start names the projects it exposes (registered vault names whose folder exists).
    const b = await parseJsonBody(req);
    const raw: unknown[] = Array.isArray(b?.vaults) ? b.vaults : [];
    const vaults = [...new Set(raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean))];
    if (!vaults.length) {
      sendError(res, 400, 'mac_no_project', 'Choose at least one project (body: { vaults: [name, ...] }).');
      return;
    }
    const registered = new Map(listVaults().map((v) => [v.name, v.path]));
    const unknown = vaults.filter((v) => !registered.has(v) || !existsSync(registered.get(v)!));
    if (unknown.length) {
      sendError(res, 400, 'mac_unknown_project', `Not a registered project: ${unknown.join(', ')}.`);
      return;
    }
    // Bag mode: true / false, or omitted = the remembered choice.
    if (b?.bagMode !== undefined && typeof b.bagMode !== 'boolean') {
      sendError(res, 400, 'invalid_bag_mode', 'bagMode must be true or false.');
      return;
    }
    sendJson(res, 200, await macSession().start({ vaults, ...(typeof b?.bagMode === 'boolean' ? { bagMode: b.bagMode } : {}) }));
  }, 5 * 60_000),
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
  uninstall: guarded(async (_req, res) => {
    await macSession().uninstall();
    // The Mac dir is gone with vapid.json and push.json: the next setup makes a new pair, never the cached one.
    pushStore = null;
    vapid = null;
    sendJson(res, 200, { ok: true });
  }, 5 * 60_000),
};

// ─── Push (the phone's notifications) ───────────────────────────────────────

let pushStore: PushStore | null = null;
let vapid: VapidKeys | null = null;
let pushSendOverride: PushNotifierDeps['send'] | null = null;

/** The phones' subscriptions (`~/.dreamcontext/handsfree-mac/push.json`, 0600). */
export function macPushStore(): PushStore {
  if (!pushStore) pushStore = new PushStore({ dir: ensureMacHandsfreeDir() });
  return pushStore;
}

function macVapid(): VapidKeys {
  if (!vapid) vapid = loadOrCreateVapid(ensureMacHandsfreeDir());
  return vapid;
}

/** Tests only: a store over a scratch dir, and a fake push service. */
export function setPushForTests(next: { store?: PushStore | null; vapid?: VapidKeys | null; send?: PushNotifierDeps['send'] | null }): void {
  if (next.store !== undefined) pushStore = next.store;
  if (next.vapid !== undefined) vapid = next.vapid;
  if (next.send !== undefined) pushSendOverride = next.send;
}

let notifier: PushNotifier | null = null;

/** The three pushes, fed by the chat registry. Armed once per process; inert while Mac mode is off. */
export function armPushNotifier(): PushNotifier {
  if (notifier) return notifier;
  verifyPushSeam();
  notifier = new PushNotifier({
    exposed: () => (session?.isOn() ? macExposedVaults() : []),
    store: () => macPushStore(),
    deviceValid: (h) => macHandsfreeAuth().store.isValidDeviceHash(h),
    showingDevice: (sid) => phoneDeviceShowing(sid),
    superSession: (vault) => {
      const v = listVaults().find((x) => x.name === vault);
      if (!v) return null;
      const idx = superIndex(join(v.path, '_dream_context'));
      return idx.enabled && idx.session ? idx.session : null;
    },
    send: (sub, payload) => (pushSendOverride ?? ((x, p) => sendPush(x, p, { vapid: macVapid(), contact: macPublicOrigin() ?? 'mailto:handsfree@dreamcontext.ai' })))(sub, payload),
  });
  const n = notifier;
  onChatChange((c) => { void n.onChange(c).catch((err) => { console.warn('[handsfree-push] notifier failed:', (err as Error)?.message ?? err); }); });
  // A question the Super Agent put to the owner has no registry edge: it pushes from here.
  setOwnerQuestionSinks({
    push: (q) => {
      const r = n.pushOwnerQuestion(q);
      void r.done.catch((err) => { console.warn('[handsfree-push] owner question failed:', (err as Error)?.message ?? err); });
      return r.targeted;
    },
  });
  // A signed-out device loses its subscription with it (logout, revoke, revoke-all, a password).
  onDeviceSessionsChanged(() => { try { macPushStore().prune((h) => macHandsfreeAuth().store.isValidDeviceHash(h)); } catch (err) { console.warn('[handsfree-push] prune failed:', (err as Error)?.message ?? err); } });
  return n;
}

/** Read a JSON body of at most `max` bytes, or null (too big, not JSON). */
function readSmallJson(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: unknown) => { if (!done) { done = true; resolveBody(v); } };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { finish(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(null); } });
    req.on('error', () => finish(null));
  });
}

/** Like {@link readSmallJson}, but says WHY it has nothing: a body over `max` (413) is not a
 *  body that is not JSON (400). */
function readBoundedJson(req: IncomingMessage, max: number): Promise<{ ok: true; value: unknown } | { ok: false; tooLarge: boolean }> {
  return new Promise((resolveBody) => {
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > max) { resolveBody({ ok: false, tooLarge: true }); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: { ok: true; value: unknown } | { ok: false; tooLarge: boolean }) => { if (!done) { done = true; resolveBody(v); } };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { finish({ ok: false, tooLarge: true }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { finish({ ok: false, tooLarge: false }); } });
    req.on('error', () => finish({ ok: false, tooLarge: false }));
  });
}

/** The phone's own push routes: a Mac-mode phone socket only (the gate demanded a device session);
 *  the device is the cookie's, never anything in the body. */
function phoneOnly(fn: (req: IncomingMessage, res: ServerResponse, device: string) => Promise<void>): Handler {
  return async (req, res) => {
    const device = isPhoneSocket(req) ? deviceIdHash(req) : null;
    if (!device || !macHandsfreeAuth().store.isValidDeviceHash(device)) { sendError(res, 404, 'not_found', 'Only a signed-in phone has push routes.'); return; }
    res.setHeader('Cache-Control', 'no-store');
    try { await fn(req, res, device); } catch (err) { fail(res, err); }
  };
}

export const handsfreePushRoutes = {
  key: phoneOnly(async (_req, res) => { sendJson(res, 200, { publicKey: macVapid().publicKey }); }),
  subscribe: phoneOnly(async (req, res, device) => {
    const body = await readSmallJson(req, 4096);
    const refusal = body === null ? 'The body must be a JSON push subscription of at most 4 KB.' : subscriptionRefusal(body);
    if (refusal) { sendError(res, 400, 'invalid_subscription', refusal); return; }
    macPushStore().put(device, body as { endpoint: string; keys: { p256dh: string; auth: string } });
    sendJson(res, 200, { ok: true });
  }),
  unsubscribe: phoneOnly(async (_req, res, device) => { sendJson(res, 200, { ok: true, removed: macPushStore().remove(device) }); }),
};

/** When each device last sent its log (device hash → epoch ms). */
const phoneLogStamps = new Map<string, number>();

/** Tests only. */
export function resetPhoneLogStampsForTests(): void { phoneLogStamps.clear(); }

/**
 * `POST /api/handsfree/phone-log`: the phone's connection log, for the agent to read when the
 * owner says the phone misbehaved (lib/handsfree/mac/phone-log.ts). A signed-in phone only, one
 * upload per device per 10 s, 64 KB, the shape checked key by key.
 */
export const handsfreePhoneLogRoute = phoneOnly(async (req, res, device) => {
  // Stamped BEFORE any await: two quick taps are one upload and one 429, never two files.
  const now = Date.now();
  const last = phoneLogStamps.get(device);
  if (last !== undefined && now - last < PHONE_LOG_INTERVAL_MS) { sendError(res, 429, 'too_soon', 'One log every 10 seconds.'); return; }
  phoneLogStamps.set(device, now);
  const body = await readBoundedJson(req, PHONE_LOG_MAX_BYTES);
  if (!body.ok) {
    phoneLogStamps.delete(device);
    if (body.tooLarge) sendError(res, 413, 'too_large', 'The log must be at most 64 KB.');
    else sendError(res, 400, 'invalid_log', 'The body must be JSON.');
    return;
  }
  const parsed = parsePhoneLog(body.value);
  if (!parsed.ok) { phoneLogStamps.delete(device); sendError(res, 400, 'invalid_log', `Refused: ${parsed.reason}.`); return; }
  writePhoneLog(parsed.log, device, homedir());
  sendJson(res, 201, { ok: true, events: parsed.log.events.length });
});

export function registerHandsfreeMacRoutes(router: Router): void {
  armPushNotifier();
  router.get('/api/handsfree/push/key', handsfreePushRoutes.key);
  router.put('/api/handsfree/push/subscription', handsfreePushRoutes.subscribe);
  router.delete('/api/handsfree/push/subscription', handsfreePushRoutes.unsubscribe);
  router.post('/api/handsfree/phone-log', handsfreePhoneLogRoute);
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
