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

/** Dashboard-only: the desktop's sheet fires this on `window` after a successful Return, so a
 *  chat pane the phone had taken over reattaches by itself. */
export const MAC_MODE_ENDED_EVENT = 'dc:mac-mode-ended';

export type MacTunnelMode = 'quick' | 'fixed';
export type MacPhase = 'off' | 'starting' | 'on' | 'stopping';

export interface MacBattery { percent: number | null; charging: boolean }

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
}

export interface MacDevice { id: string; label: string; createdAt: string }

export interface MacPhonePayload { mode: 'mac'; battery: MacBattery; sleepAllowed: boolean }

export interface LiveChatWire { conversationId: string; vault: string | null; title: string | null; busy: boolean }

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
