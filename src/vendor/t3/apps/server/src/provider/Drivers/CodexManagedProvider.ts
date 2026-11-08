/*! @license MIT — stub at a T3 Code (https://github.com/pingdotgg/t3code) seam, Copyright (c) 2026 T3 Tools Inc. and dreamcontext. See src/vendor/t3/LICENSE. */
// T3 STUB: T3's "managed Codex" signs in through T3's hosted ChatGPT token sharing; dreamcontext accounts use their own `codex login`, so a managed instance is refused.
import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import type { ProviderDriverCreateInput } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import { ProviderDriverError } from "../Errors.ts";

export const makeManagedCodexProvider = Effect.fn("makeManagedCodexProvider")(function* (
  input: ProviderDriverCreateInput<CodexSettings>,
) {
  return yield* new ProviderDriverError({
    driver: ProviderDriverKind.make("codex"),
    instanceId: input.instanceId,
    detail: "Managed Codex is not available in dreamcontext: sign the account in with codex login.",
  });
});
