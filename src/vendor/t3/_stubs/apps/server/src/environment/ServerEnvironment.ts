/*! @license MIT — stub at a T3 Code (https://github.com/pingdotgg/t3code) seam, Copyright (c) 2026 T3 Tools Inc. and dreamcontext. See src/vendor/t3/LICENSE. */
// T3 STUB: T3's environment service pulls its cloud, self-update and database-migration modules; dreamcontext only needs a stable environment id, which the bridge provides.
import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class ServerEnvironmentIdentity extends Context.Service<
  ServerEnvironmentIdentity,
  {
    readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
  }
>()("t3/environment/ServerEnvironment/ServerEnvironmentIdentity") {}

export const layerIdentity = (environmentId: string) =>
  Layer.succeed(
    ServerEnvironmentIdentity,
    ServerEnvironmentIdentity.of({ getEnvironmentId: Effect.succeed(EnvironmentId.make(environmentId)) }),
  );
