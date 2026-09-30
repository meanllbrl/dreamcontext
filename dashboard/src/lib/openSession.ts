/**
 * "Open this chat": a clicked `dreamcontext://project/<vault>/session/<claudeId>` link asking
 * this project's agent surface for one conversation.
 *
 * On the instance BUS, never `window`, for the reason every bridge into `AgentSurface` is: a
 * conversation belongs to one project, and two surfaces that both heard it would both
 * `--resume` it — two live CLIs on one transcript, the dual-attach the surface's bring-forward
 * guard exists to prevent.
 *
 * The surface sets `accepted` synchronously once it has taken the request (it may still be
 * waiting for its own capabilities before it can act), so the sender knows to stop asking.
 */
export const OPEN_SESSION_EVENT = 'dreamcontext-open-session';

export interface OpenSessionDetail {
  /** The Claude conversation UUID — the tab's `claudeId`, the transcript's file name. */
  claudeId: string;
  accepted?: boolean;
}
