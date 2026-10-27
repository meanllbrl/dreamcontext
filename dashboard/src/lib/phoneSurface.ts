/**
 * Is this page the phone's view of Mac mode (hands-free), and may it call a given `/api` route?
 *
 * The phone listener serves the whole dashboard API to a device cookie except the laptop-only
 * rows of its route policy, which are 403 `phone_unavailable`. The dashboard is the same bundle
 * on the laptop and on the phone, so a surface that calls a laptop-only route must not send it
 * there at all (no refused request in the phone's network log).
 *
 * The signal is SYNCHRONOUS and present before the first render: the phone listener injects
 * `<meta name="dreamcontext-surface" content="mac">` into index.html (`src/server/static.ts`);
 * the laptop's HTML never carries it.
 *
 * The two route lists below have ONE owner: `MAC_PUBLIC_ROUTES` and `MAC_DEVICE_API_ROUTES` in
 * `src/lib/handsfree/mac/contract.ts`. The dashboard cannot import from `src/` (separate
 * bundle), so this MIRRORS them, and `tests/unit/phone-surface.test.ts` fails when the copies
 * disagree.
 */

export const SURFACE_META_NAME = 'dreamcontext-surface';

/** Mirror of `MAC_PUBLIC_ROUTES` (src/lib/handsfree/mac/contract.ts). Same order, same values. */
export const MAC_PUBLIC_ROUTES: readonly string[] = [
  'GET /login',
  'POST /api/handsfree/login',
  'GET /api/health',
  'GET /manifest.webmanifest',
  'GET /handsfree-sw.js',
  'GET /handsfree-offline.html',
  'GET /icons/icon-192.png',
  'GET /icons/icon-512.png',
  'GET /icons/apple-touch-icon-180.png',
];

/**
 * Mirror of every DENIED row of `ROUTE_POLICY` (src/lib/handsfree/mac/route-policy.ts), keyed
 * exactly as the router registers them (`:name` one segment, `*name` the rest). Everything else
 * the phone may call; the server stays the judge. Regenerated, never hand-edited: the drift test
 * prints the list when it changes.
 */
export const MAC_DENIED_API_ROUTES: readonly string[] = [
  'GET /api/handsfree/mac/status',
  'POST /api/handsfree/mac/setup',
  'POST /api/handsfree/mac/start',
  'POST /api/handsfree/mac/stop',
  'POST /api/handsfree/mac/qr',
  'POST /api/handsfree/mac/password',
  'GET /api/handsfree/mac/devices',
  'POST /api/handsfree/mac/devices/revoke-all',
  'POST /api/handsfree/mac/tunnel/fixed',
  'DELETE /api/handsfree/mac/tunnel/fixed',
  'POST /api/handsfree/mac/uninstall',
  'POST /api/admin/shutdown',
  'POST /api/tasks/token',
  'POST /api/tasks/:slug/assets',
  'POST /api/embeddings/download',
  'POST /api/recall/prompt',
  'GET /api/recall/options',
  'GET /api/recall/cloud/status',
  'POST /api/recall/cloud/key',
  'POST /api/recall/cloud/key/copy-voice',
  'POST /api/recall/cloud/enable',
  'POST /api/recall/cloud/disable',
  'POST /api/recall/cloud/index',
  'GET /api/recall/cloud/index/status',
  'POST /api/brain/auth/device/start',
  'POST /api/brain/auth/device/poll',
  'POST /api/brain/auth/token',
  'POST /api/brain/auth/logout',
  'POST /api/brain/team/fetch',
  'POST /api/brain/sync',
  'POST /api/brain/settings',
  'POST /api/brain/origin/create',
  'POST /api/brain/origin/preview',
  'POST /api/brain/origin/attach',
  'POST /api/brain/origin/update',
  'POST /api/brain/origin/detach',
  'POST /api/brain/scrub/ignore',
  'POST /api/linked-repos/link',
  'POST /api/linked-repos/clone',
  'POST /api/linked-repos/unlink',
  'PATCH /api/config',
  'GET /api/launcher/discover',
  'GET /api/launcher/detect',
  'GET /api/launcher/defaults',
  'GET /api/launcher/catalog',
  'GET /api/launcher/global-agents',
  'POST /api/launcher/global-agents',
  'POST /api/launcher/register',
  'POST /api/launcher/scaffold',
  'POST /api/launcher/agent-settings',
  'POST /api/launcher/ui-settings',
  'GET /api/launcher/status',
  'GET /api/launcher/logo',
  'POST /api/launcher/logo',
  'POST /api/launcher/touch',
  'POST /api/launcher/unregister',
  'POST /api/launcher/update',
  'POST /api/launcher/upgrade',
  'GET /api/launcher/upgrade/status',
  'GET /api/launcher/self-update',
  'POST /api/launcher/self-update',
  'POST /api/launcher/relaunch',
  'GET /api/launcher/federation-graph',
  'POST /api/launcher/connection',
  'POST /api/launcher/connection/remove',
  'POST /api/launcher/sync',
  'POST /api/launcher/sync/remove',
  'GET /api/launcher/github/repos',
  'POST /api/launcher/clone',
  'GET /api/launcher/clone/status',
  'POST /api/launcher/clone/cancel',
  'GET /api/assistant/status',
  'GET /api/assistant/rollup',
  'GET /api/assistant/glance',
  'POST /api/assistant/answer',
  'POST /api/assistant/delegations/dismiss',
  'GET /api/assistant/inbox',
  'POST /api/assistant/inbox/dismiss',
  'POST /api/assistant/inbox/seen',
  'POST /api/assistant/inbox/mute',
  'POST /api/assistant/presence',
  'POST /api/assistant/create',
  'GET /api/assistant/profile',
  'POST /api/assistant/profile',
  'GET /api/assistant/avatar',
  'POST /api/assistant/avatar',
  'GET /api/assistant/proposals',
  'POST /api/assistant/proposals/:id',
  'POST /api/assistant/windows',
  'POST /api/assistant/windows/release',
  'GET /api/assistant/windows',
  'POST /api/assistant/open',
  'POST /api/assistant/commands/:id/bind',
  'POST /api/assistant/commands/:id/claim',
  'POST /api/assistant/commands/:id/result',
  'GET /api/assistant/projects',
  'GET /api/assistant/sessions',
  'GET /api/assistant/watch',
  'GET /api/assistant/recall',
  'GET /api/assistant/index',
  'GET /api/assistant/read',
  'POST /api/assistant/broadcast',
  'POST /api/assistant/ui/:verb',
  'POST /api/assistant/look',
  'POST /api/window/:verb',
  'POST /api/super/v/:verb',
  'GET /api/super/state',
  'POST /api/super/enable',
  'POST /api/super/disable',
  'POST /api/super/layout',
  'POST /api/super/activity',
  'POST /api/super/recap',
  'POST /api/super/fresh',
  'POST /api/super/end',
  'POST /api/super/seen',
  'POST /api/agent/accounts/adopt',
  'POST /api/agent/accounts/login',
  'POST /api/agent/accounts/relogin',
  'POST /api/agent/accounts/remove',
  'POST /api/agent/mcp/login',
  'POST /api/agent/mcp/logout',
  'POST /api/agent/mcp/project/adopt',
  'POST /api/agent/mcp/project/remove',
  'POST /api/agent/reveal',
  'POST /api/agent/grant',
  'GET /api/agent/loopback-grants',
  'POST /api/agent/loopback-grant',
  'POST /api/agent/web-session',
  'POST /api/agent/open-terminal',
  'POST /api/agent/install',
  'GET /api/agent/install/status',
  'GET /api/onboarding/readiness',
  'POST /api/onboarding/fix',
  'POST /api/onboarding/fix/cancel',
  'GET /api/notifications',
  'POST /api/notify',
  'POST /api/agent/secret',
  'POST /api/agent/voice/tts',
  'POST /api/agent/voice/warm',
  'POST /api/agent/voice/retranscribe',
  'POST /api/agent/voice/log',
  'POST /api/agent/voice/focus',
  'GET /api/agent/voice/status',
  'GET /api/agent/voice/dictation',
  'POST /api/agent/voice/dictation',
  'PUT /api/agent/voice/config',
  'POST /api/agent/download',
  'POST /api/connections',
  'DELETE /api/connections/:vault',
  'POST /api/peer/send',
  'POST /api/federation/sync',
  'POST /api/packs/:name/install',
  'DELETE /api/packs/:name',
  'GET /api/lab/credentials',
  'POST /api/lab/credentials',
  'POST /api/agents/sync/confirm',
  'POST /api/agents/:slug/bring-here',
  'POST /api/automations/dispatcher/install',
  'POST /api/automations/dispatcher/uninstall',
  'GET /api/automations/:slug/telegram',
  'POST /api/automations/:slug/telegram',
  'GET /api/app/machine',
  'GET /api/sleep-eval/labels',
  'POST /api/sleep-eval/labels',
];

/** A registered pattern as a matcher (the router's own rule). */
function patternRe(path: string): RegExp {
  const body = path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/([:*])([a-zA-Z_]+)/g, (_m, kind: string) => (kind === '*' ? '(.+)' : '([^/]+)'));
  return new RegExp(`^${body}$`);
}

const DENIED = MAC_DENIED_API_ROUTES.map((r) => {
  const [method, path] = r.split(' ');
  return { method, re: patternRe(path) };
});
const PUBLIC = new Set(MAC_PUBLIC_ROUTES);

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

/** True on a phone reaching THIS laptop through Mac mode's tunnel (`content="mac"`). Read once:
 *  the document's flag never changes. */
export function isMacPhoneSurface(): boolean {
  return surfaceFlag() === 'mac';
}

/** The phone surface (today: Mac mode's phone listener). */
export function isPhoneSurface(): boolean {
  return isMacPhoneSurface();
}

/** Tests only: pin the answer (`'mac'` = the phone, `null` = read the document again). */
export function setPhoneSurfaceForTests(v: 'mac' | null): void {
  cached = v === null ? undefined : v;
}

/**
 * May this page send `method path`? Always on the laptop. On the phone: a public route, any
 * non-API path (the SPA, assets), and every API route but the laptop-only ones.
 */
export function phoneAllows(method: string, path: string): boolean {
  if (!isMacPhoneSurface()) return true;
  const pathname = path.split('?')[0].split('#')[0];
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return true;
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  if (PUBLIC.has(`${m} ${pathname}`)) return true;
  return !DENIED.some((d) => d.method === m && d.re.test(pathname));
}
