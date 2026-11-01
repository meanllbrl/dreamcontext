/*! @license MIT — vendored from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc. See src/vendor/t3/LICENSE. */
export function beginAcpMockPrompt(cancelledSessions: Set<string>, sessionId: string): void {
  cancelledSessions.delete(sessionId);
}
