/**
 * What the live runner hands `claude`: pinned here, as pure data, so a unit test can assert it.
 * Nothing in this file touches the disk or starts a process.
 *
 * Isolation (see src/lib/sleep-eval/scratch.ts, the precedent):
 *   - `claude` keeps the REAL HOME (a fake HOME logs it out) and reads only the scratch project's
 *     settings (`--setting-sources project`): no user CLAUDE.md, no user hooks, no user MCP
 *     (`--strict-mcp-config` with no config).
 *   - The tools are the real Super Agent's: `Bash(dreamcontext:*)` plus Read/Grep/Glob. Any other
 *     Bash is denied in `-p`; there is no Edit/Write (an unscoped name would allow every path).
 *   - The scratch settings.json turns the sandbox on with no network allowance and denies the
 *     real brains outright.
 */

export const SUPER_ALLOWED_TOOLS = 'Bash(dreamcontext:*) Read Grep Glob';
export const SUPER_EVAL_MODEL = 'sonnet';
export const SUPER_EVAL_EFFORT = 'medium';
/** Per `claude` call, and for the whole run (O3; the plan's hard stop). */
export const MAX_USD_PER_CALL = 1;
export const MAX_USD_PER_RUN = 12;

export interface ClaudeArgsInput {
  prompt: string;
  /** `superBriefing(...)` for the arm. */
  briefing: string;
  /** Set on turn 2: the session turn 1 returned. */
  resume?: string;
}

export function superClaudeArgs(i: ClaudeArgsInput): string[] {
  return [
    '-p', i.prompt,
    ...(i.resume ? ['--resume', i.resume] : []),
    '--model', SUPER_EVAL_MODEL,
    '--effort', SUPER_EVAL_EFFORT,
    '--append-system-prompt', i.briefing,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-budget-usd', String(MAX_USD_PER_CALL),
    '--permission-mode', 'acceptEdits',
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--allowedTools', SUPER_ALLOWED_TOOLS,
  ];
}

/** The scratch project's `.claude/settings.json`. `denyDirs` are the real brains / repos (absolute). */
export function scratchSettings(denyDirs: readonly string[]): Record<string, unknown> {
  // `//` = an absolute path in Claude Code permission rules.
  const deny = denyDirs.flatMap((d) => [`Edit(/${d}/**)`, `Write(/${d}/**)`, `Read(/${d}/**)`]);
  return {
    permissions: { defaultMode: 'acceptEdits', deny },
    // Sandbox on, escape hatch off, NO network allowance (the shim answers every `super` verb).
    sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false },
  };
}

/** Text of the canned events turn 2 carries: one per code child the first turn started. */
export function childDoneEvents(started: ReadonlyArray<{ id: string; brief: string; branch?: string }>): string {
  return started
    .map((c) => `[super event] ${c.id} finished: ${c.brief || 'its job'}.${c.branch ? ` Its branch ${c.branch} is ready to merge.` : ''}`)
    .join('\n');
}

/** Paths the eval must never leave changed under the real ~/.dreamcontext. */
export const HOME_IGNORE = [/\.log$/, /^models\//, /^claude-accounts\//, /^chat-/, /\.sock$/, /\.lock$/];
