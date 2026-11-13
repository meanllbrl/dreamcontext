/**
 * The server's own answer to a child's TOOL permission (field 2026-11-13: with the app in the
 * background its window took no `super allow` for minutes, and a Bypass child's permission sat
 * until it went stale). Built from the raw `can_use_tool` line the chat process still holds open,
 * as the window's Allow/Deny `answer` frame: an allow runs the call exactly as it was asked
 * (`updatedInput` = its own input), a deny carries the reason. A question (AskUserQuestion), a
 * line that is no open permission, or another request: null, nothing is written.
 */
export interface PermissionAnswerFrame {
  type: 'answer';
  requestId: string;
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export function permissionAnswerFrame(
  line: string | undefined,
  requestId: string,
  behavior: 'allow' | 'deny',
  message?: string,
): PermissionAnswerFrame | null {
  if (!line || !requestId) return null;
  let o: { type?: unknown; request_id?: unknown; request?: { subtype?: unknown; tool_name?: unknown; input?: unknown } };
  try { o = JSON.parse(line) as typeof o; } catch { return null; }
  if (o?.type !== 'control_request' || o.request_id !== requestId) return null;
  const req = o.request;
  if (req?.subtype !== 'can_use_tool' || typeof req.tool_name !== 'string' || req.tool_name === 'AskUserQuestion') return null;
  if (behavior === 'deny') return { type: 'answer', requestId, behavior, message: message?.trim() ? message : 'Denied' };
  const input = req.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { type: 'answer', requestId, behavior, updatedInput: input as Record<string, unknown> };
}
