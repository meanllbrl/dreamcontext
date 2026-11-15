/**
 * Every hook text dreamcontext writes into another tool's config (plan npmsiz-beta C6′). One
 * place, because each text is a contract with something we do not control:
 *
 * - **Codex** project hooks and the Mac-wide gate: FROZEN, byte for byte. Codex trusts a hook by
 *   the hash of its text, so any change asks every user to trust it again. They live in
 *   `t3-bridge/codex-user-gate.ts` and are re-exported here; tests/unit/hook-command.test.ts pins
 *   them to literals.
 * - **Claude Code**, two steps. `WRITTEN` is today's text (what an install writes). `RECOGNISED`
 *   is every text an installer ever wrote or will write: today's, the legacy `npx …` one, and the
 *   app-launcher text (D15), which a later release starts writing. Any recognised handler is
 *   rewritten IN PLACE to the written text, never added beside it, so a project a newer release
 *   set up and an older CLI then `update`s still runs each event exactly once.
 */

export { codexHookCommand, CODEX_USER_GATE_COMMAND } from './t3-bridge/codex-user-gate.js';

/**
 * The command Claude Code runs for one hook event (what every installer writes today).
 *
 * A `dreamcontext` on PATH runs directly; only without one does the hook fall back to `npx`,
 * whose package resolution cost ~0.5 s and a second node process (~60 MB) on EVERY event, and
 * with ten agents at work that was the machine's second-largest load. No absolute path: the
 * settings file is committed and shared, so the command must work on any machine. `exec`
 * replaces the shell, so the hook's own exit code and stdout reach Claude Code unchanged.
 *
 * Mirrored in skill/SKILL.md's frontmatter `hooks:` (Claude Code dedupes identical commands, so
 * a skill copy that drifted would run every event twice); tests/unit/install-skill-hooks.test.ts
 * holds the two together.
 */
export function hookCommand(event: string): string {
  return `command -v dreamcontext >/dev/null 2>&1 && exec dreamcontext hook ${event} || exec npx dreamcontext hook ${event}`;
}

/** The command every installer before {@link hookCommand} wrote; rewritten in place on update. */
export function legacyHookCommand(event: string): string {
  return `npx dreamcontext hook ${event}`;
}

/**
 * The app-launcher text (D15 step 2): a `dreamcontext` on PATH, else the launcher the desktop app
 * installs in `~/.dreamcontext/bin/cli/`. Not written by this release; only recognised, so a
 * project a release that writes it set up is rewritten in place here instead of doubled.
 */
export function launcherHookCommand(event: string): string {
  return `command -v dreamcontext >/dev/null 2>&1 && exec dreamcontext hook ${event} || exec "$HOME/.dreamcontext/bin/cli/dreamcontext" hook ${event}`;
}

/** The Claude text this release writes for `event`. */
export const WRITTEN = hookCommand;

/** Every Claude text an installer wrote or will write for `event`, the written one first. */
export function recognisedHookCommands(event: string): string[] {
  return [hookCommand(event), legacyHookCommand(event), launcherHookCommand(event)];
}
