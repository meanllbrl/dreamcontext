/**
 * A tool whose accounts are T3 instances (W5): the driver's own `create` does the install, the
 * Google sign-in, the private profile, usage and models, so the bridge only provides what the
 * driver reads. Account = instance id; nothing here reaches into a profile.
 */
import { AntigravitySettings, ProviderDriverKind, ProviderInstanceId } from '@t3tools/contracts';
import * as ModelCatalog from '@t3tools/provider-core/server/ModelCatalog';
import type { ProviderInstance } from '@t3tools/provider-core/server/driver';
import * as AntigravityInstallation from '@t3tools/server/provider/AntigravityInstallation';
import { AntigravityDriver } from '@t3tools/server/provider/Drivers/AntigravityDriver';
import { BUNDLED_MODEL_MANIFEST, resolveProviderCatalog } from '@t3tools/server/provider/ModelManifest';
import type * as ServerConfig from '@t3tools/server/config';
import * as Effect from 'effect/Effect';
import { FetchHttpClient } from 'effect/http';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { antigravityInstanceId } from '../antigravity-accounts.js';
import type { InstanceTool } from '../instance-accounts.js';
import { providerHostLayer } from './provider-host.js';

const decodeAntigravity = Schema.decodeSync(AntigravitySettings);

const modelCatalogLayer = Layer.succeed(ModelCatalog.ModelCatalog, ModelCatalog.ModelCatalog.of({
  current: (driver: ProviderDriverKind) => Effect.succeed(resolveProviderCatalog(BUNDLED_MODEL_MANIFEST, driver) ?? undefined),
  bundled: (driver: ProviderDriverKind) => resolveProviderCatalog(BUNDLED_MODEL_MANIFEST, driver) ?? undefined,
  refreshInBackground: Effect.void,
}));

/** What the drivers `yield*` beyond the services every bridge session already has. */
export function instanceLayer(config: ServerConfig.ServerConfig['Service']) {
  return Layer.mergeAll(
    providerHostLayer(config),
    modelCatalogLayer,
    Layer.effect(AntigravityInstallation.AntigravityInstallation, AntigravityInstallation.makeAntigravityInstallation({ baseDir: config.baseDir })),
  ).pipe(Layer.provideMerge(FetchHttpClient.layer));
}

export interface InstanceInput {
  readonly tool: InstanceTool;
  readonly accountId: string;
  /** Tests: the fake agent. Production: T3's managed runtime, or the agent on PATH. */
  readonly binaryPath?: string;
}

/** One account's instance. It lives as long as the scope it is created in. */
export const createInstance = (i: InstanceInput) => AntigravityDriver.create({
  instanceId: ProviderInstanceId.make(antigravityInstanceId(i.accountId)),
  displayName: undefined,
  environment: [],
  enabled: true,
  config: decodeAntigravity({ enabled: true, ...(i.binaryPath ? { binaryPath: i.binaryPath } : {}) }),
}) as Effect.Effect<ProviderInstance, unknown, never>;
