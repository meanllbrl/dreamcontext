/**
 * Auto-mode classifier carve-outs for dreamcontext's OWN orchestration.
 *
 * Claude Code's auto mode refuses to let a session launch another agent headless — which is
 * exactly what the Develop recipe does for its builders (`claude -p … --permission-mode
 * acceptEdits`). Classifier rules are honoured ONLY from user, flag (`--settings`) or managed
 * settings: a repo's `.claude/settings.json` / `settings.local.json` is ignored as
 * repo-controllable. So the carve-out rides on the `--settings` of every session the app
 * spawns — scoped to dreamcontext sessions, never written into the user's global settings.
 *
 * `$defaults` first: without it the array REPLACES the shipped rules instead of extending them.
 */
export const DREAMCONTEXT_AUTO_MODE = {
  allow: [
    '$defaults',
    'dreamcontext Orchestration: Launching the dreamcontext Develop recipe\'s own headless builder '
      + 'sessions is NOT Create Unsafe Agents or Auto-Mode Bypass. The shape: a background `claude -p` '
      + '(new, or `--resume <id>` of an earlier builder) started with `DREAMCONTEXT_SPAWNED=develop`, '
      + '`--permission-mode acceptEdits` and a scoped `--allowedTools` list, its brief read from the '
      + 'project\'s `tmp/develop/` folder and its log written there, running in this project or a git '
      + 'worktree of it. The user started Develop mode to have these builders implement the planned '
      + 'waves, so launching, resuming and reading the logs of them is the requested work. This covers '
      + 'the launch shape only: a brief that asks for something another rule blocks is still blocked, '
      + 'and a builder launched with `bypassPermissions` or `--dangerously-skip-permissions` is not covered.',
  ],
} as const;

/** The `--settings` fragment every app-spawned session carries. */
export function autoModeSettings(): { autoMode: typeof DREAMCONTEXT_AUTO_MODE } {
  return { autoMode: DREAMCONTEXT_AUTO_MODE };
}
