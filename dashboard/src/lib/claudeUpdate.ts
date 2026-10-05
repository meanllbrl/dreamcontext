import type { Capabilities } from '../components/sleepy/agentSession';

/**
 * What the System doctor and the Chat surface say about the installed Claude Code CLI's
 * VERSION. Every claude dreamcontext spawns is headless (`claude -p`) and Claude Code's own
 * updater only runs inside its interactive TUI, so an app user's CLI froze on whatever
 * version it was installed at, and every session ran the models that version knew about.
 * The server now checks and updates it (`Capabilities.claudeUpdate` ← src/lib/claude-update.ts);
 * this is how the answer is shown.
 */

export type ClaudeUpdateInfo = NonNullable<Capabilities['claudeUpdate']>;

export interface ClaudeUpdateRow {
  tone: 'ok' | 'warn' | 'muted';
  /** i18n key for the status phrase; `{installed}` / `{latest}` are filled from `vars`. */
  statusKey: string;
  vars: { installed: string; latest: string };
  /** Raw text under the status: the tail of a failed update's output. */
  detail?: string;
  /** Where the user turned auto-updates off, when they did. */
  disabledBy?: string;
  /** Offer Update now? Only when there is something to update and nothing running. */
  offerUpdate: boolean;
}

/**
 * Map the updater's state onto the doctor's row. Driven by `state`, not `outdated`, so the
 * row and the Chat warning can never disagree about the same machine.
 *
 * null when there is nothing honest to say: no CLI or not the desktop app (absent), a check
 * that couldn't answer (`unknown`, e.g. offline), or a current CLI whose version we don't know.
 */
export function claudeUpdateRow(u: ClaudeUpdateInfo | undefined): ClaudeUpdateRow | null {
  if (!u || u.state === 'unknown') return null;
  const vars = { installed: u.installed ?? '?', latest: u.latest ?? '?' };
  switch (u.state) {
    case 'failed':
      return {
        tone: 'warn', statusKey: 'system.update.failed', vars,
        detail: u.error?.trim() || undefined, offerUpdate: true,
      };
    case 'outdated':
    case 'disabled':
      return {
        tone: 'warn', statusKey: 'system.update.outdated', vars,
        disabledBy: u.state === 'disabled' ? (u.disabledBy || 'settings') : undefined,
        offerUpdate: true,
      };
    case 'updating':
      return { tone: 'muted', statusKey: 'system.update.updating', vars, offerUpdate: false };
    case 'updated':
      return { tone: 'ok', statusKey: 'system.update.updated', vars, offerUpdate: false };
    case 'current':
      return u.installed
        ? { tone: 'muted', statusKey: 'system.update.current', vars, offerUpdate: false }
        : null;
  }
  return null;
}

/**
 * Should the Chat surface warn? Only when the CLI is known to be behind (including behind
 * with auto-updates turned off) or the last update failed. An `unknown` check stays quiet:
 * a chat that nags about a version it couldn't read is noise on a machine that may be fine.
 */
export function shouldWarnInChat(u: ClaudeUpdateInfo | undefined): boolean {
  return !!u && (u.state === 'failed' || u.state === 'outdated' || u.state === 'disabled');
}
