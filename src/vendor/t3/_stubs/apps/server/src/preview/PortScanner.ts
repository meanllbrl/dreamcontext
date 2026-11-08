/*! @license MIT — stub at a T3 Code (https://github.com/pingdotgg/t3code) seam, Copyright (c) 2026 T3 Tools Inc. and dreamcontext. See src/vendor/t3/LICENSE. */
// T3 STUB: dev-server preview discovery (lsof/proc walks) is a T3 app feature; dreamcontext scans no ports, so every scan is empty.
import type {
  DiscoveredLocalServer,
  PreviewStopLocalServerError,
  PreviewStopLocalServerInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

export class PortDiscovery extends Context.Service<
  PortDiscovery,
  {
    readonly scan: (
      configuredUrls?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<DiscoveredLocalServer>>;
    readonly subscribe: (
      input: {
        readonly configuredUrls: ReadonlyArray<string>;
        readonly initialSnapshot: ReadonlyArray<DiscoveredLocalServer>;
      },
      listener: (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly retain: Effect.Effect<void, never, Scope.Scope>;
    readonly registerTerminalProcesses: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly processIds: ReadonlyArray<number>;
    }) => Effect.Effect<void>;
    readonly unregisterTerminal: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<void>;
    readonly trackAgent: () => () => void;
    readonly stopServer: (
      input: PreviewStopLocalServerInput,
    ) => Effect.Effect<void, PreviewStopLocalServerError>;
  }
>()("t3/preview/PortScanner/PortDiscovery") {}

export const AGENT_THREAD_ENV = "T3CODE_THREAD_ID";

const none = PortDiscovery.of({
  scan: () => Effect.succeed([]),
  subscribe: () => Effect.void,
  retain: Effect.void,
  registerTerminalProcesses: () => Effect.void,
  unregisterTerminal: () => Effect.void,
  trackAgent: () => () => undefined,
  stopServer: () => Effect.void,
});

export const layer = Layer.succeed(PortDiscovery, none);

export const layerTest = Layer.mock(PortDiscovery)({ trackAgent: () => () => undefined });
