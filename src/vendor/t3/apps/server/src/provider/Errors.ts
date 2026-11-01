/*! @license MIT — vendored from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc. See src/vendor/t3/LICENSE. */
import * as Schema from "effect/Schema";

export class ProviderInstanceNotFoundError extends Schema.TaggedError<ProviderInstanceNotFoundError>()(
  "ProviderInstanceNotFoundError",
  {
    instanceId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No provider instance bound to id '${this.instanceId}'`;
  }
}

export { ProviderDriverError } from "@t3tools/provider-core/server/errors";

export class ProviderWorkspaceMissingError extends Schema.TaggedError<ProviderWorkspaceMissingError>()(
  "ProviderWorkspaceMissingError",
  {
    threadId: Schema.String,
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return `This thread's workspace folder no longer exists or is not a directory: ${this.cwd}. Restore the folder at this path before retrying.`;
  }
}
