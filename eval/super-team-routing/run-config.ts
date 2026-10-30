/**
 * What the live runner hands `claude`: pinned here, as pure data, so a unit test can assert it.
 * The isolation is eval/super-orchestration's (its run-config.ts): the real HOME for `claude`
 * only, project settings only (no user CLAUDE.md, hooks or MCP), the sandbox on with no network.
 * The tools are the real Super Agent's plus the Agent tool, so the before arm's sub-agent door
 * (`--agents`) is a real door and the scorer can see a chat that walks through it.
 */

export const TEAM_ALLOWED_TOOLS = 'Bash(dreamcontext:*) Read Grep Glob Agent';
export const TEAM_EVAL_MODEL = 'sonnet';
export const TEAM_EVAL_EFFORT = 'medium';
/** Per `claude` call, and for the whole run across every arm (the owner's cap, 2026-10-29). */
export const MAX_USD_PER_CALL = 1;
export const MAX_USD_PER_RUN = 12;

export interface TeamClaudeArgsInput {
  /** Omitted with `streamInput`: the turn arrives on stdin as one stream-json user message. */
  prompt?: string;
  briefing: string;
  /** The `--agents` file (a chat's, or a Super born before this change). */
  agentsFile?: string;
  resume?: string;
  streamInput?: boolean;
}

export function teamClaudeArgs(i: TeamClaudeArgsInput): string[] {
  return [
    '-p', ...(i.streamInput ? [] : [i.prompt ?? '']),
    ...(i.streamInput ? ['--input-format', 'stream-json'] : []),
    ...(i.resume ? ['--resume', i.resume] : []),
    '--model', TEAM_EVAL_MODEL,
    '--effort', TEAM_EVAL_EFFORT,
    '--append-system-prompt', i.briefing,
    ...(i.agentsFile ? ['--agents', i.agentsFile] : []),
    '--output-format', 'stream-json',
    '--verbose',
    '--max-budget-usd', String(MAX_USD_PER_CALL),
    '--permission-mode', 'acceptEdits',
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--allowedTools', TEAM_ALLOWED_TOOLS,
  ];
}
