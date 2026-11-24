/**
 * The `app` kind of a live link (tunel-paylasim C6, C9): `{vault, slug}` resolves synchronously
 * to the registered app (key `app:<hash>`, D9); while the share lives it holds a runtime lease so
 * the backend keeps running with the owner's window closed; a guest's request and WebSocket go to
 * the app's gateway through `serveGuest` / `upgradeGuest`, never through its loopback door.
 *
 * Registered by `routes/apps.ts`, which hands in its own home and runtime factory (so this module
 * never imports the route file, and the tests' scratch home is the one used).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { basename, dirname } from 'node:path';
import { getApp, listApps, real, type AppRecord } from '../../lib/apps/registry.js';
import type { AppRuntime } from '../../lib/apps/supervisor.js';
import { listVaults } from '../../lib/vaults.js';
import { gatewayFor } from '../apps/gateway.js';
import { appShareKey, registerShareKind, ShareError, type Share } from './registry.js';
import { sendUnavailable } from './door.js';

export interface AppKindDeps {
  home: () => string;
  runtime: (rec: AppRecord) => AppRuntime;
}

const projectRootOf = (p: string): string => (basename(p) === '_dream_context' ? dirname(p) : p);

/** The share's app, read again from the registry (null once it was removed). */
function recordOf(deps: AppKindDeps, share: Share): AppRecord | null {
  const hash = share.key.startsWith('app:') ? share.key.slice(4) : '';
  if (!hash) return null;
  return listApps(deps.home()).find((a) => a.hash === hash) ?? null;
}

export function registerAppShareKind(deps: AppKindDeps): void {
  registerShareKind('app', {
    resolve({ vault, slug }) {
      const v = listVaults(deps.home()).find((x) => x.name === vault);
      if (!v) throw new ShareError(404, 'vault_not_found', `No project named "${vault}".`);
      const rec = getApp(deps.home(), real(projectRootOf(v.path)), slug);
      if (!rec) throw new ShareError(404, 'app_not_found', `No app "${slug}" in this project.`);
      return {
        name: rec.name,
        key: appShareKey(rec.hash),
        hold: () => deps.runtime(rec).acquireShare(),
      };
    },
    async serve(share: Share, req: IncomingMessage, res: ServerResponse) {
      const rec = recordOf(deps, share);
      if (!rec) { req.resume(); sendUnavailable(req, res, 410); return; }
      const gw = await gatewayFor(deps.runtime(rec));
      await gw.serveGuest(req, res, share);
    },
    upgrade(share: Share, req: IncomingMessage, sock: Duplex, head: Buffer) {
      const rec = recordOf(deps, share);
      const refuse = (): void => {
        try { sock.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); } catch { /* gone */ }
        sock.destroy();
      };
      if (!rec) { refuse(); return; }
      void gatewayFor(deps.runtime(rec)).then((gw) => {
        // The share may have closed while the gateway was looked up.
        if (share.state !== 'open') { refuse(); return; }
        gw.upgradeGuest(req, sock, head, share);
      }).catch(refuse);
    },
  });
}
