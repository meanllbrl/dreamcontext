/**
 * Is this page the phone's view of the hands-free CLOUD, and may it call a given `/api` route?
 *
 * The cloud serves only a static allow-list of API routes to a device cookie; every other
 * `/api/*` is 403 `cloud_unavailable` by design (AC4). The dashboard is the same bundle on the
 * laptop and in the cloud, so a surface that calls a laptop-only route (the task board, sleep,
 * the brain status, …) must not send it there at all.
 *
 * The signal is SYNCHRONOUS and present before the first render: the cloud server injects
 * `<meta name="dreamcontext-surface" content="cloud">` into index.html (`src/server/static.ts`,
 * only when `isCloud()`); the laptop's HTML never carries it.
 *
 * The two route lists below have ONE owner: `CLOUD_PUBLIC_ROUTES` and `CLOUD_DEVICE_API_ROUTES`
 * in `src/server/cloud-mode.ts`. The dashboard cannot import from `src/` (separate bundle), so
 * this MIRRORS them, and `tests/unit/cloud-surface.test.ts` fails when the copies disagree.
 */

export const SURFACE_META_NAME = 'dreamcontext-surface';

/** Mirror of `CLOUD_PUBLIC_ROUTES` (src/server/cloud-mode.ts). Same order, same values. */
export const CLOUD_PUBLIC_ROUTES: readonly string[] = [
  'GET /login',
  'POST /api/handsfree/login',
  'GET /api/health',
  'GET /handsfree-sw.js',
  'GET /handsfree-offline.html',
  'GET /manifest.webmanifest',
];

/** Mirror of `CLOUD_DEVICE_API_ROUTES` (src/server/cloud-mode.ts). Same order, same values. */
export const CLOUD_DEVICE_API_ROUTES: readonly string[] = [
  // Chat, history and the session roster
  'GET /api/agent/chat-history',
  'GET /api/agent/chat-sessions',
  'GET /api/agent/sessions',
  'PUT /api/agent/sessions',
  'GET /api/agent/slash-commands',
  'GET /api/agent/bg-output',
  'POST /api/agent/prompt',
  // Shelf
  'GET /api/agent/task-progress',
  'GET /api/agent/session-facts',
  // Usage and accounts (list, switch, preferred)
  'GET /api/agent/usage-limits',
  'GET /api/agent/accounts',
  'POST /api/agent/accounts/preferred',
  'POST /api/agent/accounts/auto-switch',
  // Files the chat renders (project root only; grants stay refused)
  'GET /api/agent/file',
  'GET /api/agent/board-assets',
  // Teammates
  'GET /api/agent/teammates',
  'GET /api/agent/teammate-history',
  // Read-only GETs of the mobile chat surface
  'GET /api/agent/capabilities',
  'GET /api/agent/model-config',
  'GET /api/agent/session-model',
  'GET /api/agent/session-stats',
  'GET /api/vaults',
  'GET /api/config',
  'GET /api/chat/html-kit',
  // The phone signs itself out
  'POST /api/handsfree/logout',
  // The phone's chip and quiesce overlay (a pure read: never an owner action)
  'GET /api/handsfree/phone',
];

/** Mirror of `MAC_PUBLIC_ROUTES` (src/lib/handsfree/mac/contract.ts). Same order, same values. */
export const MAC_PUBLIC_ROUTES: readonly string[] = [
  'GET /login',
  'POST /api/handsfree/login',
  'GET /api/health',
  'GET /manifest.webmanifest',
];

/** Mirror of `MAC_DEVICE_API_ROUTES` (src/server/cloud-mode.ts): the cloud's device list plus
 *  the drawer's live chats. */
export const MAC_EXTRA_DEVICE_API_ROUTES: readonly string[] = [
  'GET /api/agent/live-chats',
];

const ALLOWED = new Set([...CLOUD_PUBLIC_ROUTES, ...CLOUD_DEVICE_API_ROUTES]);
const MAC_ALLOWED = new Set([...MAC_PUBLIC_ROUTES, ...CLOUD_DEVICE_API_ROUTES, ...MAC_EXTRA_DEVICE_API_ROUTES]);

let cached: string | null | undefined;

function surfaceFlag(): string | null {
  if (cached !== undefined) return cached;
  try {
    cached = typeof document !== 'undefined'
      ? document.querySelector(`meta[name="${SURFACE_META_NAME}"]`)?.getAttribute('content') ?? null
      : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** True on the cloud's page (read once: the document's flag never changes). */
export function isCloudSurface(): boolean {
  return surfaceFlag() === 'cloud';
}

/**
 * True on a phone reaching THIS laptop through Mac mode's tunnel (`content="mac"`): the phone
 * surface minus everything about a trip (no phase, no quiesce, no offline worker).
 */
export function isMacPhoneSurface(): boolean {
  return surfaceFlag() === 'mac';
}

/** Either phone surface: the cloud, or the Mac's phone listener. */
export function isPhoneSurface(): boolean {
  const f = surfaceFlag();
  return f === 'cloud' || f === 'mac';
}

/** Tests only: pin the answer (`true` = cloud, `'mac'`, `false`/`null` as before). */
export function setCloudSurfaceForTests(v: boolean | 'mac' | null): void {
  cached = v === null ? undefined : v === true ? 'cloud' : v === 'mac' ? 'mac' : null;
}

/**
 * May this page send `method path`? Always on the laptop. On the cloud: only the allow-listed
 * API routes (exactly as the server's `classifyCloudRoute` decides; the transfer routes take a
 * laptop HMAC, never a device cookie); a non-API path (the SPA, assets) always.
 */
export function cloudAllows(method: string, path: string): boolean {
  const flag = surfaceFlag();
  if (flag !== 'cloud' && flag !== 'mac') return true;
  const pathname = path.split('?')[0].split('#')[0];
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return true;
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return (flag === 'mac' ? MAC_ALLOWED : ALLOWED).has(`${m} ${pathname}`);
}
