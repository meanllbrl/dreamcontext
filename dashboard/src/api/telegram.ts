import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import { isDesktop } from '../lib/desktop';
import { pollMs } from '../lib/windowActivity';
import { PAIRING_ID_RE, type PairingStart, type TelegramStatusRow } from '../../../src/lib/telegram/contract.js';

/**
 * Every Telegram route and shell command the window calls, in ONE place (W3 lane A).
 *
 * Paths and shapes are the plan's (B4, X, Z1, AA1, AB) plus the ones W3 and W2 agreed for what
 * the contract leaves open (`_dream_context/tmp/super/telegram-yapim/w3/route-proposal.md`).
 * Page-called routes are vault-scoped and carry the browser's own Origin + Sec-Fetch-Site; they
 * never carry the owner key. Everything that hands a bot power goes through a shell command,
 * which raises the native confirm and posts with the key itself (desktop/src-tauri/src/
 * telegram_confirm.rs): the page only ever holds a server-minted id.
 *
 * Nothing here writes a token anywhere: `bind` sends it once in a POST body and the caller drops
 * it from its state as soon as the POST answers (W7).
 */

export type { PairingStart, TelegramStatusRow };

/** GET /api/telegram: this vault's Super + members, and the device's manager row. */
export interface TelegramStatus {
  rows: TelegramStatusRow[];
  manager: TelegramStatusRow | null;
}

/** GET /api/telegram-manager/status (device-level). */
export interface TelegramManagerStatus {
  manager: TelegramStatusRow | null;
  bots: { projectName: string; target: string; label: string; botUsername: string; state: TelegramStatusRow['state'] }[];
  alarm?: 'conflict' | 'unauthorized' | 'tamper';
  /** Bot Management Mode looks off in BotFather (X2), when the server can tell. */
  managementOff?: boolean;
}

/** GET /api/telegram/:target/forward: the member's routines in this project and which forward. */
export interface TelegramForwardList {
  routines: { slug: string; title: string; on: boolean }[];
}

/** GET /api/telegram/:target/readopt: may this target bind its earlier bot again? */
export interface TelegramReadopt {
  available: boolean;
  botUsername?: string;
}

const enc = encodeURIComponent;

/** The manager's target in a pairing preview (cannot be a member slug). */
export const MANAGER_TARGET = '@manager';

export function telegramRoutes(api: ReturnType<typeof useApi>) {
  return {
    status: () => api.get<TelegramStatus>('/telegram'),
    bind: (target: string, token: string) => api.post<PairingStart>(`/telegram/${enc(target)}/bind`, { token }),
    unbind: (target: string) => api.del<{ ok: true }>(`/telegram/${enc(target)}`),
    forwardList: (target: string) => api.get<TelegramForwardList>(`/telegram/${enc(target)}/forward`),
    forwardRequest: (target: string, routine: string) =>
      api.post<{ forwardRequestId: string }>(`/telegram/${enc(target)}/forward/request`, { routine }),
    forwardOff: (target: string, routine: string) => api.post<{ ok: true }>(`/telegram/${enc(target)}/forward`, { routine, on: false }),
    creationRequest: (target: string) => api.post<{ creationId: string }>(`/telegram/${enc(target)}/creation/request`, {}),
    readoptInfo: (target: string) => api.get<TelegramReadopt>(`/telegram/${enc(target)}/readopt`),
    readoptRequest: (target: string) => api.post<{ readoptId: string }>(`/telegram/${enc(target)}/readopt/request`, {}),
    managerStatus: () => api.get<TelegramManagerStatus>('/telegram-manager/status'),
    managerBind: (token: string) => api.post<PairingStart>('/telegram-manager/bind', { token }),
    managerUnbind: () => api.del<{ ok: true }>('/telegram-manager'),
  };
}

// ─── Shell commands (macOS app only) ────────────────────────────────────────

/** What a confirm command answers: done, or the owner pressed Vazgeç. */
export type ShellConfirm = { ok: true } | { ok: false; cancelled: true };

/** Why a shell step failed, in words the sheet can pick copy for. */
export type ShellRefusal = 'unsupported' | 'busy' | 'changed' | 'gone' | 'forbidden' | 'not_found' | 'malformed' | 'failed';

export class TelegramShellError extends Error {
  constructor(readonly reason: ShellRefusal) {
    super(reason);
  }
}

const KNOWN_REFUSALS: readonly ShellRefusal[] = ['unsupported', 'busy', 'changed', 'gone', 'forbidden', 'not_found'];

/** A Rust `Err(String)` mapped onto the few reasons the sheet speaks about. */
export function refusalOf(err: unknown): ShellRefusal {
  const s = typeof err === 'string' ? err : err instanceof Error ? err.message : '';
  if ((KNOWN_REFUSALS as readonly string[]).includes(s)) return s as ShellRefusal;
  if (s === 'malformed id') return 'malformed';
  if (/not allowed|not found.*command|unknown command/i.test(s)) return 'unsupported';
  return 'failed';
}

async function shell<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new TelegramShellError('unsupported');
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw new TelegramShellError(refusalOf(err));
  }
}

function checkedId(id: string): string {
  if (!PAIRING_ID_RE.test(id)) throw new TelegramShellError('malformed');
  return id;
}

export const telegramShell = {
  /** The native confirm that turns a pending pairing into a live binding (B4). */
  confirmBinding: (pairingId: string) => shell<ShellConfirm>('confirm_telegram_binding', { pairingId: checkedId(pairingId) }),
  /** The native confirm that turns a routine's forwarding on (W3, Y4). */
  confirmForward: (forwardRequestId: string) => shell<ShellConfirm>('confirm_telegram_forward', { forwardRequestId: checkedId(forwardRequestId) }),
  /** Starts a one-tap creation; the answer's link opens Telegram's own create window (X3). */
  startCreation: (creationId: string) =>
    shell<{ ok: true; link: string; projectName: string }>('start_telegram_creation', { creationId: checkedId(creationId) }),
  /** The native confirm that binds a bot made earlier again (AA2). */
  startReadopt: (readoptId: string) => shell<ShellConfirm>('start_telegram_readopt', { readoptId: checkedId(readoptId) }),
};

// ─── Status, polled while something waits on Telegram ───────────────────────

export const TELEGRAM_STATUS_KEY = ['telegram', 'status'] as const;

/** This vault's bindings. `waiting` polls every 2 s (a sheet waiting for /start or a creation). */
export function useTelegramStatus(opts: { waiting?: boolean; enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: TELEGRAM_STATUS_KEY,
    queryFn: () => telegramRoutes(api).status(),
    retry: 0,
    enabled: opts.enabled ?? true,
    refetchInterval: opts.waiting ? () => pollMs(2_000) : false,
  });
}

export function useTelegramManager(opts: { waiting?: boolean; enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: ['telegram', 'manager'],
    queryFn: () => telegramRoutes(api).managerStatus(),
    retry: 0,
    enabled: opts.enabled ?? true,
    refetchInterval: opts.waiting ? () => pollMs(2_000) : false,
  });
}

export function useInvalidateTelegram(): () => void {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: ['telegram'] }); };
}

/** The row of one target, or null when it has none. */
export function rowOf(status: TelegramStatus | undefined, target: string): TelegramStatusRow | null {
  return status?.rows.find((r) => r.target === target) ?? null;
}

/** `@name` for display, whatever the server sent. */
export function atName(name: string | undefined | null): string {
  const n = (name ?? '').trim();
  if (!n) return '';
  return n.startsWith('@') ? n : `@${n}`;
}

/** `https://t.me/<bot>`: the "Telegram'da aç" link for a bound bot. */
export function botLink(botUsername: string): string | null {
  const n = botUsername.replace(/^@/, '');
  return /^[A-Za-z0-9_]{3,64}$/.test(n) ? `https://t.me/${n}` : null;
}
