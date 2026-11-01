/*! @license MIT — stub at a T3 Code (https://github.com/pingdotgg/t3code) seam, Copyright (c) 2026 T3 Tools Inc. and dreamcontext. See src/vendor/t3/LICENSE. */
// T3 STUB: T3's managed Codex runtime (hosted token broker, cloud config, telemetry); dreamcontext never runs Codex in managed mode, so only the runtime shape the adapters type against remains.
import { ProviderSetupError, type CodexSettings, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export interface CodexEffectiveRuntime {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
}

export const makeCodexManagedRuntime = Effect.fn("makeCodexManagedRuntime")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly config: CodexSettings;
}) {
  return yield* new ProviderSetupError({
    instanceId: options.instanceId,
    operation: "runtime",
    detail: "Managed Codex is not available in dreamcontext.",
  });
});
