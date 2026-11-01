/**
 * The bridge's `ProviderHost`, the one T3 service a driver reads its paths and settings from. T3's
 * own `ProviderHostLive` pulls its secret store, background policy and document pipeline; none of
 * those exist here, so this keeps T3's contract with our paths: everything under the T3 state root
 * (`bridgeServerConfig`), settings fixed at T3's defaults, background work always allowed (a bridge
 * child lives only while its pane does), credentials in 0600 files.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SERVER_SETTINGS } from '@t3tools/contracts';
import { ProviderCredentialError } from '@t3tools/provider-core/server/errors';
import * as ProviderHost from '@t3tools/provider-core/server/ProviderHost';
import { resolveAttachmentPath } from '@t3tools/server/attachmentStore';
import type * as ServerConfig from '@t3tools/server/config';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';

const attempt = <A>(operation: 'get' | 'set' | 'remove', run: () => A) =>
  Effect.try({ try: run, catch: (cause) => new ProviderCredentialError({ operation, cause }) });

export function fileCredentials(secretsDir: string, namespace: string, bindingId: string) {
  const key = createHash('sha256').update(`${namespace}\0${bindingId}`).digest('hex');
  const file = join(secretsDir, key);
  return {
    binding: { owner: 't3' as const, key },
    get: attempt('get', () => {
      try {
        return Option.some(new Uint8Array(readFileSync(file)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Option.none<Uint8Array>();
        throw err;
      }
    }),
    set: (credentials: Uint8Array) => attempt('set', () => {
      mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, credentials, { mode: 0o600 });
      chmodSync(file, 0o600);
    }),
    remove: attempt('remove', () => rmSync(file, { force: true })),
  };
}

export function providerHostLayer(config: ServerConfig.ServerConfig['Service']) {
  return Layer.succeed(ProviderHost.ProviderHost, ProviderHost.ProviderHost.of({
    paths: {
      cwd: config.cwd,
      baseDir: config.baseDir,
      stateDir: config.stateDir,
      providerStatusCacheDir: config.providerStatusCacheDir,
      attachmentsDir: config.attachmentsDir,
    },
    settings: {
      get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    shouldRunBackgroundWork: () => Effect.succeed(true),
    resolveAttachmentPath: (attachment) => resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
    credentials: (namespace, bindingId) => Effect.succeed(fileCredentials(config.secretsDir, namespace, bindingId)),
  }));
}
