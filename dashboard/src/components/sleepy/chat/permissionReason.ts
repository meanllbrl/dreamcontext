/**
 * Why a permission card asks, in ONE short plain line (owner 2026-11-05: a Bypass chat showed a
 * whole heredoc as a code dump under "this one still needs you", and the real reason was never
 * said). Claude Code sends its own reason with every `can_use_tool` request
 * (`decision_reason`, `decision_reason_type`; captured on 2.1.318). That text is written for
 * engineers ("Dangerous rm operation not ruled out — the shell may read this command differently
 * than it was parsed"), so the known shapes map to an i18n key, and anything else falls back to
 * its first sentence, clipped. Pure: the chat's card and the phone's card share it.
 */

export interface PermissionReasonInput {
  /** `request.decision_reason`, verbatim from the CLI. */
  reason?: string;
  /** `request.decision_reason_type` (`safetyCheck`, `rule`, `hook`, `classifier`, `workingDir`…). */
  reasonType?: string;
  /** The pane's mode: the fallback when the CLI said nothing. Absent (a surface that does not
   *  know the child's mode, the phone): no line at all rather than a wrong one. */
  mode?: 'auto' | 'bypass';
}

/** An i18n key, or a plain line already short enough to show. */
export type PermissionReasonLine = { key: string } | { text: string };

const MAX_FALLBACK = 110;

export function permissionReasonLine(p: PermissionReasonInput): PermissionReasonLine | null {
  const reason = (p.reason ?? '').replace(/\s+/g, ' ').trim();
  const type = (p.reasonType ?? '').trim();
  if (reason) {
    if (/\brm\b|delet/i.test(reason)) return { key: 'perm.reason.rm' };
    if (/pars|statically|could not be checked|cannot (?:automatically )?(?:determine|validate)/i.test(reason)) return { key: 'perm.reason.unparsed' };
    if (/working director|outside (?:the|this) project|allowed (?:working )?director/i.test(reason)) return { key: 'perm.reason.outside' };
    if (/\.git\b|\.claude\b|settings|shell config|protected/i.test(reason)) return { key: 'perm.reason.protected' };
  }
  if (type === 'hook') return { key: 'perm.reason.hook' };
  if (type === 'classifier') return { key: 'perm.reason.classifier' };
  if (type === 'rule') return { key: 'perm.reason.rule' };
  if (reason) {
    const first = reason.split(/(?<=[.!?])\s/)[0] ?? reason;
    return { text: first.length > MAX_FALLBACK ? `${first.slice(0, MAX_FALLBACK - 1).trimEnd()}…` : first };
  }
  if (!p.mode) return null;
  return { key: p.mode === 'bypass' ? 'perm.reason.bypass' : 'perm.reason.auto' };
}

/**
 * Does this command look like it ASKS something at the keyboard (a password, a sign-in, a y/n)?
 * Then "Run here" is the card's real answer and sits beside Allow; otherwise it waits inside
 * "Show command", next to the command it would run. A miss only moves the button one tap away.
 */
export function looksInteractive(command: string): boolean {
  return /(?:^|[\s;&|(])(?:sudo|su|ssh|passwd|read\s+-[a-z]*p)\b|\b(?:login|signin|sign-in|adduser)\b|\bauth\s+login\b|\[y\/n\]/i.test(command);
}
