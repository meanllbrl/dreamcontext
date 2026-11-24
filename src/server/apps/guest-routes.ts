/**
 * What a live-link guest reaches on an app's gateway (tunel-paylasim C6, D4). A CLOSED table,
 * default deny: the app's own page, static files and backend (any path outside `/__dc`), and of
 * the gateway's own paths only the four a page needs to run: the SDK, the theme, the secret-free
 * config and the app's own data store (its writes stay backend-only by that handler's own check).
 *
 * Refused: the brain (`/__dc/api`), the owner's Claude chat (`/__dc/embed`), ringing his Mac
 * (`/__dc/notify`), his schedules, the window's door and runner, and every backend-only path.
 * A prefix registered through `registerGatewayRoute` with no row here fails the drift test
 * (`app-share-guest.test.ts`), so a new gateway path is shut to guests until someone decides.
 */

export type GuestRule = 'allow' | 'deny';

/** Every gateway `/__dc/*` prefix, built-in and registered, with its guest rule. */
export const GUEST_GATEWAY_ROUTES: Readonly<Record<string, GuestRule>> = {
  // Built into gateway.ts.
  '/__dc/enter': 'deny',
  '/__dc/runner': 'deny',
  '/__dc/api': 'deny',
  '/__dc/theme': 'allow',
  // Registered by gateway-w3.ts.
  '/__dc/sdk.js': 'allow',
  '/__dc/config': 'allow',
  '/__dc/data': 'allow',
  '/__dc/notify': 'deny',
  '/__dc/learn': 'deny',
  '/__dc/mcp': 'deny',
  '/__dc/schedules': 'deny',
  '/__dc/automations': 'deny',
  '/__dc/team/say': 'deny',
  '/__dc/ask': 'deny',
  '/__dc/embed': 'deny',
};

export type GuestDecision =
  | { kind: 'app' }
  | { kind: 'theme' }
  | { kind: 'gateway'; prefix: string }
  | { kind: 'deny' };

/** Where a guest's request goes. `path` is the URL's pathname. */
export function guestRoute(path: string): GuestDecision {
  if (path !== '/__dc' && !path.startsWith('/__dc/')) return { kind: 'app' };
  for (const [prefix, rule] of Object.entries(GUEST_GATEWAY_ROUTES)) {
    if (path === prefix || path.startsWith(prefix + '/')) {
      if (rule !== 'allow') return { kind: 'deny' };
      return prefix === '/__dc/theme' ? { kind: 'theme' } : { kind: 'gateway', prefix };
    }
  }
  return { kind: 'deny' };
}
