/**
 * Which agent session a CLI command runs in, whatever the tool (row 29). Claude Code exports
 * `CLAUDE_CODE_SESSION_ID`; a Codex chat's shell has `CODEX_THREAD_ID` (measured on a real turn,
 * 2026-11-02, with `CODEX_SESSION_ID` beside it); every bridge chat, Codex or Antigravity, has
 * `DREAMCONTEXT_AGENT_TOOL` (stdio.ts). Under a bridge tool `CLAUDE_CODE_SESSION_ID` is not the
 * chat's own: it is whatever the server's parent had (the same real turn carried this lead's id),
 * so it is never read there.
 *
 * The id becomes part of file names and records, so anything that is not a plain id is refused.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

const safe = (raw: string | undefined): string | null => {
  const v = (raw ?? '').trim();
  return v && SAFE_ID.test(v) && v !== '.' && v !== '..' ? v : null;
};

/** The bridge tool this command runs under, or null on Claude and in a terminal. */
export function sessionTool(env: NodeJS.ProcessEnv = process.env): 'codex' | 'antigravity' | null {
  const t = env.DREAMCONTEXT_AGENT_TOOL;
  return t === 'codex' || t === 'antigravity' ? t : null;
}

/**
 * This session's id, or null. Codex: its thread. Antigravity has no id of its own in the shell
 * that is known; the chat tab's (`DREAMCONTEXT_TAB_SESSION`) stands in when the app set one.
 */
export function agentSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  const tool = sessionTool(env);
  if (tool === 'codex') return safe(env.CODEX_THREAD_ID) ?? safe(env.DREAMCONTEXT_TAB_SESSION);
  if (tool === 'antigravity') return safe(env.DREAMCONTEXT_TAB_SESSION);
  return safe(env.CLAUDE_CODE_SESSION_ID);
}

/**
 * True when an agent, not the owner at a terminal, runs this command. A bridge chat is an agent
 * even when it has no id to give: before this, a Codex or Antigravity chat read as the owner.
 */
export function inAgentSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return sessionTool(env) !== null || !!(env.CLAUDE_CODE_SESSION_ID ?? '').trim();
}
