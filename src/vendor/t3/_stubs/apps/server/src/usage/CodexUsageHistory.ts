/*! @license MIT — stub at a T3 Code (https://github.com/pingdotgg/t3code) seam, Copyright (c) 2026 T3 Tools Inc. and dreamcontext. See src/vendor/t3/LICENSE. */
// T3 STUB: T3 reads past Codex service tiers from its orchestration SQLite store, which dreamcontext does not have; it answers with no history.
import type { UsageSpeed } from "@t3tools/provider-core/server/usage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class CodexUsageHistoryReadError extends Schema.TaggedError<CodexUsageHistoryReadError>()(
  "CodexUsageHistoryReadError",
  { requestedTurnCount: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read historical Codex usage tiers.";
  }
}

export interface CodexUsageHistoryRequest {
  readonly sessionId: string;
  readonly nativeTurnId: string;
  readonly model: string;
}

export class CodexUsageHistory extends Context.Service<
  CodexUsageHistory,
  {
    readonly resolve: (
      requests: readonly CodexUsageHistoryRequest[],
    ) => Effect.Effect<
      ReadonlyMap<CodexUsageHistoryRequest, UsageSpeed>,
      CodexUsageHistoryReadError
    >;
  }
>()("t3/usage/CodexUsageHistory") {}

export const layer = Layer.succeed(
  CodexUsageHistory,
  CodexUsageHistory.of({ resolve: () => Effect.succeed(new Map()) }),
);
