/**
 * Mirror of `src/lib/handsfree/mac/contract.ts` (hands-free Mac mode). The dashboard cannot
 * import from `src/` (separate bundle), so the values the client relies on are copied here and
 * `tests/unit/mac-contract-mirror.test.ts` fails when the two disagree.
 */

/** Signed out (revoke-all, logout, new password) or Mac mode ended (Return). */
export const MAC_CLOSE_SIGNED_OUT = 4401;
/** Another screen took this chat: stop reconnecting, offer "Buraya al". */
export const MAC_CLOSE_TAKEN_OVER = 4409;

/** An explicit tap: take the chat from whichever screen holds it. */
export const REATTACH_EVICT = '1';
/** Every automatic open: adopt a detached chat, never evict a live screen. */
export const REATTACH_PASSIVE = 'passive';

/** The longest a passive upgrade waits on the holder's pong (under the 15 s connect timeout). */
export const HOLDER_PROBE_MS = 3000;

/** Dashboard-only: the desktop's status poller (`macStore.ts`) fires this on `window` when a run
 *  ends, whoever pressed Return: a chat pane the phone had taken over reattaches by itself and
 *  the agent surface re-reads its roster, where Return put the tabs the phone had open. */
export const MAC_MODE_ENDED_EVENT = 'dc:mac-mode-ended';

export type MacTunnelMode = 'quick' | 'fixed';
export type MacPhase = 'off' | 'starting' | 'on' | 'stopping';

export interface MacBattery { percent: number | null; charging: boolean }

/** macOS thermalState, 0..3. */
export const MAC_THERMAL_STATES = ['nominal', 'fair', 'serious', 'critical'] as const;
export type MacThermalState = typeof MAC_THERMAL_STATES[number];
export const MAC_THERMAL_POLL_MS = 20_000;
export const MAC_THERMAL_RELEASE_TICKS = 6;
/** The last reading (null before the first / unreadable) and how many processes are slowed now. */
export interface MacThermal { state: MacThermalState | null; slowed: number }

/** Bag mode never chosen: on (the governor may slow heavy processes while hot). */
export const MAC_BAG_MODE_DEFAULT = true;

export interface MacStatus {
  phase: MacPhase;
  setup: { sudoers: boolean; passphrase: boolean };
  mode: MacTunnelMode;
  fixedHostname: string | null;
  url: string | null;
  startedAt: string | null;
  battery: MacBattery;
  sleepAllowed: boolean;
  deviceCount: number;
  lastError: string | null;
  /** The projects this run exposes (chosen at start); empty while off. */
  exposedVaults: string[];
  thermal: MacThermal;
  /** While on, this run's Bag mode; while off, the remembered choice the switch pre-sets from. */
  bagMode: boolean;
}

export interface MacDevice { id: string; label: string; createdAt: string }

export interface MacPhonePayload { mode: 'mac'; battery: MacBattery; sleepAllowed: boolean; thermal: MacThermal; bagMode: boolean; startedAt: string | null }

/** The readings that mean "very hot": the panel's hot line and the phone's hot chip. */
export const HEAT_HOT = ['serious', 'critical'] as const;
export function isHotState(s: MacThermalState | null | undefined): boolean {
  return s != null && (HEAT_HOT as readonly string[]).includes(s);
}

export interface LiveChatWire { conversationId: string; vault: string | null; title: string | null; busy: boolean; state: 'working' | 'asking' | 'idle'; lastLine: string | null; updatedAt: number | null }

export interface LiveChatsWire {
  chats: LiveChatWire[];
  draining: string[];
  /** A project whose Super Agent is handed over: ONE row here, none of its chats under `chats`. */
  supers?: SuperChatWire[];
}

/** The Super Agent row of a handed-over project; `live` false = the Mac runs no super chat now. */
export interface SuperChatWire extends LiveChatWire { vault: string; live: boolean }

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
