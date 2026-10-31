/*! @license MIT — stub at a T3 Code (https://github.com/pingdotgg/t3code) seam, Copyright (c) 2026 T3 Tools Inc. and dreamcontext. See src/vendor/t3/LICENSE. */
// T3 STUB: T3's settings service persists to SQLite and pulls the source-control registry; dreamcontext keeps its settings in agent-ui.json, so the bridge hands T3 a fixed, read-only snapshot.
import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsError,
  type ProviderInstanceMutation,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { type DeepPartial, deepMerge } from "@t3tools/shared/Struct";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    readonly start: Effect.Effect<void, ServerSettingsError>;
    readonly ready: Effect.Effect<void, ServerSettingsError>;
    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    readonly updateProviderInstance: (
      mutation: ProviderInstanceMutation,
      patch?: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    readonly withSettingsSnapshot: <A, E, R>(
      use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ServerSettingsError, R>;
    readonly streamChanges: Stream.Stream<ServerSettings>;
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
  }
>()("t3/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) => layerTest(overrides);
}

const readOnly = Effect.fail(
  new ServerSettingsError({ settingsPath: "<dreamcontext>", operation: "normalize" }),
);

export const make = (settings: ServerSettings) =>
  ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.succeed(settings),
    updateSettings: () => readOnly,
    updateProviderInstance: () => readOnly,
    withSettingsSnapshot: (use) => use(settings),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  });

export const layerFrom = (settings: ServerSettings) => Layer.succeed(ServerSettingsService, make(settings));

export const layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  layerFrom(deepMerge(DEFAULT_SERVER_SETTINGS as ServerSettings & Record<string, unknown>, overrides as never));

export const layer = layerFrom(DEFAULT_SERVER_SETTINGS);
