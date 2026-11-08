/*! @license MIT — stub at a T3 Code (https://github.com/pingdotgg/t3code) seam, Copyright (c) 2026 T3 Tools Inc. and dreamcontext. See src/vendor/t3/LICENSE. */
// T3 STUB: T3's hosted ChatGPT token-sharing broker; dreamcontext signs each Codex account in with its own `codex login`, so there is no broker to start.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

class BrokerStartError extends Schema.TaggedError<BrokerStartError>()(
  "ManagedTokenBrokerStartError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Managed Codex is not available in dreamcontext.";
  }
}

export class CodexManagedTokenBroker extends Context.Service<
  CodexManagedTokenBroker,
  {
    readonly endpoint: Effect.Effect<string, BrokerStartError>;
    readonly awaitIdle: Effect.Effect<void>;
  }
>()("t3/provider/CodexManagedTokenBroker") {}

export const layer = Layer.succeed(
  CodexManagedTokenBroker,
  CodexManagedTokenBroker.of({
    endpoint: Effect.fail(new BrokerStartError({ cause: "not managed" })),
    awaitIdle: Effect.void,
  }),
);
