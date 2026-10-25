/**
 * Hands-free MAC MODE — the pinned contract (W1).
 *
 * The work stays on the laptop. While Mac mode is on, the same server process runs a second
 * HTTP listener (the "phone listener", 127.0.0.1 only) and a Cloudflare tunnel points at it.
 * Every socket that listener accepts is a PHONE socket: never loopback, never trusted for
 * being local, served only what `route-policy.ts` allows, with a Mac device session (its own store,
 * `~/.dreamcontext/handsfree-mac/`).
 *
 * Mirrored for the dashboard in `dashboard/src/components/handsfree/macContract.ts`; a drift
 * test (tests/unit/mac-contract-mirror.test.ts) keeps the two equal.
 */

// ─── WebSocket close codes ──────────────────────────────────────────────────

/** "Your device was signed out" (revoke-all, logout, password change) or "Mac mode ended"
 *  (Return): the phone stops reconnecting and goes to the login page. */
export const MAC_CLOSE_SIGNED_OUT = 4401;
/** "Another screen took this chat": the loser stops its reconnect loop and offers "Buraya al". */
export const MAC_CLOSE_TAKEN_OVER = 4409;

// ─── Reattach values (the chat upgrade's `reattach=` query value) ───────────

/** An explicit tap ("Mac'te açık", "Buraya al"): adopt the live child even when another live
 *  screen holds it; the holder is closed with {@link MAC_CLOSE_TAKEN_OVER}. */
export const REATTACH_EVICT = '1';
/** Every AUTOMATIC open (a backoff reconnect, a page reload's roster restore): adopt a detached
 *  child at once; when a socket still looks open, ping it and wait up to
 *  {@link HOLDER_PROBE_MS} — no pong = half-open → adopt; a pong = a live holder → the NEW
 *  socket is closed with {@link MAC_CLOSE_TAKEN_OVER} and nothing is evicted. */
export const REATTACH_PASSIVE = 'passive';
export type ReattachValue = typeof REATTACH_EVICT | typeof REATTACH_PASSIVE;

/**
 * How long a passive upgrade may wait on the holder's pong. The upgrade can therefore take up
 * to this long to be decided, which must stay well under the client's CONNECT_TIMEOUT_MS
 * (15 000 ms, dashboard/src/components/sleepy/chatSession.ts).
 */
export const HOLDER_PROBE_MS = 3000;

// ─── Status ─────────────────────────────────────────────────────────────────

export type MacTunnelMode = 'quick' | 'fixed';
export type MacPhase = 'off' | 'starting' | 'on' | 'stopping';

export interface MacBattery {
  /** 0-100, null when the machine reports no battery (a desktop Mac). */
  percent: number | null;
  charging: boolean;
}

/** GET /api/handsfree/mac/status. Never carries a secret (no passphrase, no token, no
 *  tunnel credentials); `url` is the public tunnel address, which is not a credential. */
export interface MacStatus {
  /** Mac mode can run on this machine (macOS). False elsewhere: the panel hides the hands-free
   *  button and settings card, and setup, start and the fixed address refuse. */
  supported: boolean;
  phase: MacPhase;
  /** Setup done: the sudoers drop-in is installed and a passphrase verifier exists. */
  setup: { sudoers: boolean; passphrase: boolean };
  mode: MacTunnelMode;
  /** The fixed address's hostname when one is set up, else null. */
  fixedHostname: string | null;
  url: string | null;
  startedAt: string | null;
  battery: MacBattery;
  /** Sleep is allowed again (the battery threshold fired). */
  sleepAllowed: boolean;
  deviceCount: number;
  /** The last start/stop failure, a {@link MacErrorCode}. */
  lastError: MacErrorCode | null;
  /** The projects this run exposes (registered names, chosen at start): the phone sees and
   *  reaches only these. Empty while off. */
  exposedVaults: string[];
  /** The thermal governor: the last reading and how many processes it slows now. */
  thermal: MacThermal;
  /** Bag mode: while Mac mode is on, the mode THIS run uses; while off, the remembered choice
   *  (what the panel's switch is pre-set from and what a start without the field uses). */
  bagMode: boolean;
}

/** One signed-in phone as the sheet lists it (never the session id). */
export interface MacDevice {
  /** A short, stable label of the device record (first 8 hex of its id hash). */
  id: string;
  label: string;
  createdAt: string;
}

/** The phone's own chip: GET /api/handsfree/phone on a phone socket. */
export interface MacPhonePayload {
  mode: 'mac';
  battery: MacBattery;
  sleepAllowed: boolean;
  thermal: MacThermal;
}

/** GET /api/agent/live-chats — names, never paths. */
export interface LiveChatWire {
  conversationId: string;
  /** The registered vault name the child runs in (null when its folder is not registered). */
  vault: string | null;
  title: string | null;
  busy: boolean;
  /** What the drawer says (AC18): a question/permission waiting, a turn running, or idle. */
  state: 'working' | 'asking' | 'idle';
  /** The phone stack's last line (AC19): the question waiting, a permission's TOOL NAME only,
   *  else the newest assistant text's last line; whitespace collapsed, 140 chars. */
  lastLine: string | null;
  /** The list's age (AC21): when the chat last moved, epoch ms; null when unknown. */
  updatedAt: number | null;
}

/** GET /api/agent/live-chats's body: running chats, plus conversations still finishing after a
 *  takeover (`draining`, ids only) so the drawer lists neither of them as a past chat. */
export interface LiveChatsWire {
  chats: LiveChatWire[];
  draining: string[];
  /** A project whose Super Agent is handed over lists ONE row here and none of its chats under
   *  `chats` (the phone talks to the Super Agent only). Absent when no project is handed over. */
  supers?: SuperChatWire[];
}

/** The Super Agent row of a handed-over project. `live` false: the Mac's window is not running
 *  it right now, so the phone cannot open it. */
export interface SuperChatWire extends LiveChatWire { vault: string; live: boolean }

// ─── Error codes ────────────────────────────────────────────────────────────

export const MAC_ERROR_CODES = [
  'mac_not_setup',
  'mac_sudo_missing',
  'mac_already_on',
  'mac_not_on',
  'mac_tunnel_failed',
  'mac_probe_failed',
  'mac_binary_failed',
  'mac_admin_cancelled',
  'mac_fixed_not_setup',
  'mac_unsupported_platform',
  /** The fixed hostname already has a DNS record; setup again with `overwrite: true` to replace it. */
  'mac_hostname_in_use',
  /** Start named no project. */
  'mac_no_project',
  /** Start named a project that is not registered (or whose folder is gone). */
  'mac_unknown_project',
] as const;
export type MacErrorCode = typeof MAC_ERROR_CODES[number];

// ─── Battery ────────────────────────────────────────────────────────────────

/** Discharging and at or below this → sleep is allowed again (disablesleep 0), no re-arm. */
export const MAC_BATTERY_FLOOR_PERCENT = 15;
export const MAC_BATTERY_POLL_MS = 60_000;

// ─── Thermal governor ───────────────────────────────────────────────────────

/** macOS `NSProcessInfo.thermalState`, 0..3. */
export const MAC_THERMAL_STATES = ['nominal', 'fair', 'serious', 'critical'] as const;
export type MacThermalState = typeof MAC_THERMAL_STATES[number];
/** How often the governor reads the thermal state. */
export const MAC_THERMAL_POLL_MS = 20_000;
/** Consecutive nominal (or unreadable) readings before every slowed process is released: 2 min. */
export const MAC_THERMAL_RELEASE_TICKS = 6;

export interface MacThermal {
  /** The last reading; null before the first one or when it could not be read. */
  state: MacThermalState | null;
  /** Processes slowed right now (clamped roots + inherited children). */
  slowed: number;
}

/**
 * Bag mode ("Çanta modu"), chosen at start and remembered: the governor may slow heavy
 * processes while hot. Normal mode reads the heat and slows nothing (keep-awake and Low Power
 * Mode stay on in both). A start that never chose one gets this (today's behaviour).
 */
export const MAC_BAG_MODE_DEFAULT = true;

// ─── The reachability probe ─────────────────────────────────────────────────

/**
 * The phone listener stamps this header (a per-start random value) on `/api/health`. Start
 * fetches `https://<url>/api/health` and requires it, which proves the tunnel reaches THIS
 * listener. It proves routing only: the value is public (any visitor sees it) and is never
 * used as a credential.
 */
export const MAC_PROBE_HEADER = 'X-Dreamcontext-Mac-Probe';
/** Marks every phone-listener response (the login page reads it to tell "refused" from a
 *  network error). */
export const MAC_SURFACE_HEADER = 'X-Dreamcontext-Surface';

// ─── Login token (the QR) ───────────────────────────────────────────────────

export const MAC_LOGIN_TOKEN_TTL_MS = 5 * 60_000;
/** The QR carries `https://<url>/login?t=<token>`. */
export const MAC_LOGIN_TOKEN_PARAM = 't';

// ─── The phone listener's public routes (the API policy: route-policy.ts) ────

/** Reachable with no credential at all. */
export const MAC_PUBLIC_ROUTES: readonly string[] = [
  'GET /login',
  'POST /api/handsfree/login',
  'GET /api/health',
  'GET /manifest.webmanifest',
  // The service worker and its offline page load while signed out (the worker installs before
  // a session exists, and the offline page is what it shows when the Mac is not reachable).
  'GET /handsfree-sw.js',
  'GET /handsfree-offline.html',
  // The icons of the installed app (browsers fetch manifest icons without cookies).
  'GET /icons/icon-192.png',
  'GET /icons/icon-512.png',
  'GET /icons/apple-touch-icon-180.png',
];

/** The only WebSocket the phone opens. PTY, Assistant and browser-mirror are refused. */
export const MAC_WS_PATHS: readonly string[] = ['/api/agent/chat'];

/** The routes the main listener's Mac panel calls (desktop + loopback + same-site only). */
export const MAC_ROUTES = {
  status: 'GET /api/handsfree/mac/status',
  setup: 'POST /api/handsfree/mac/setup',
  start: 'POST /api/handsfree/mac/start',
  stop: 'POST /api/handsfree/mac/stop',
  qr: 'POST /api/handsfree/mac/qr',
  password: 'POST /api/handsfree/mac/password',
  devices: 'GET /api/handsfree/mac/devices',
  revokeAll: 'POST /api/handsfree/mac/devices/revoke-all',
  fixedSetup: 'POST /api/handsfree/mac/tunnel/fixed',
  fixedRemove: 'DELETE /api/handsfree/mac/tunnel/fixed',
  uninstall: 'POST /api/handsfree/mac/uninstall',
} as const;
