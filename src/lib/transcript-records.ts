/**
 * transcript-records: record-level provenance for Claude Code JSONL transcripts.
 *
 * A `role:user` record is not proof that a human typed something. The harness writes
 * skill-loader text, peer hand-backs, task notifications and scheduled continuations on
 * the user role too, and a tool result is a user-role record carrying a `tool_result`
 * block. Current Claude Code stamps the injected ones structurally (`isMeta`,
 * `promptSource`, `turnOrigin`), measured across every local transcript on 2026-09-29:
 *
 *   isMeta: true                     skill loaders, peer hand-backs, local-command caveats
 *   promptSource: 'system'           task notifications, peer and scheduled turns
 *   turnOrigin: task_notification | peer | system | scheduled
 *
 * Those fields are what this module trusts first. Older transcripts lack them, so the
 * text shapes in {@link isSystemNoiseMessage} stay as the fallback.
 *
 * A leaf module on purpose: the salience detector (lib) and the distiller (cli) both
 * read it, and neither may depend on the other for it.
 */

/** `turnOrigin` values that mark a user-role record as injected by the harness. */
export const INJECTED_TURN_ORIGINS: ReadonlySet<string> = new Set([
  'task_notification',
  'peer',
  'system',
  'scheduled',
]);

/**
 * True when a user-role transcript record was injected by the harness rather than typed
 * by a person: `isMeta: true`, `promptSource: 'system'`, or an injected `turnOrigin`.
 * A record with none of those fields reads as NOT injected (older transcripts carry
 * none of them; the text fallback handles those).
 */
export function isInjectedUserRecord(rec: object): boolean {
  const r = rec as { isMeta?: unknown; promptSource?: unknown; turnOrigin?: unknown };
  if (r.isMeta === true) return true;
  if (r.promptSource === 'system') return true;
  return typeof r.turnOrigin === 'string' && INJECTED_TURN_ORIGINS.has(r.turnOrigin);
}

/**
 * True when a `role:user` turn's TEXT is system-injected sub-agent / tooling
 * coordination noise rather than a real human message. The text-shape fallback for
 * transcripts written before the harness stamped provenance fields:
 *
 *   1. `<task-notification>` XML blocks (background sub-agent completion pings)
 *   2. agent-resume JSON: `{"success":true,"message":"Agent ... resumed ..."}`
 *   3. skill-loader headers: `Base directory for this skill: ...`
 *
 * Substring-anchored: a turn that merely CONTAINS one of these blocks is treated as
 * noise, because in practice the harness emits each on its own dedicated turn.
 * See task_OwbFN_IV.
 */
export function isSystemNoiseMessage(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // 1. Sub-agent task-notification XML blocks.
  if (/<\/?task-notification\b/i.test(t)) return true;
  // 2. Agent-resume JSON: a success envelope referencing an Agent resume.
  if (
    /"success"\s*:\s*(?:true|false)/.test(t) &&
    /\bAgent\b/.test(t) &&
    /(?:resumed|no active task)/i.test(t)
  ) {
    return true;
  }
  // 3. Skill-loader header echoed verbatim into the turn.
  if (/Base directory for this skill\s*:/i.test(t)) return true;
  return false;
}

/** The record's role, from the flat or the `message`-nested shape. */
function recordRole(rec: object): string | null {
  const r = rec as { role?: unknown; message?: { role?: unknown } };
  if (typeof r.role === 'string') return r.role;
  if (r.message && typeof r.message === 'object' && typeof r.message.role === 'string') {
    return r.message.role;
  }
  return null;
}

/**
 * Collect only typed text from a user record's content. A string is kept whole; an
 * array keeps bare strings and `{type:'text'}` blocks. `tool_result` blocks are machine
 * output and are ignored: folding them in once let Playwright's "No open tabs" seed a
 * false 'User correction' bookmark.
 */
function typedText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (typeof block === 'string') {
      text += block + ' ';
    } else if (block && typeof block === 'object') {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') text += b.text + ' ';
    }
  }
  return text;
}

/**
 * The text a human actually typed in this record, or null when the record is not a
 * human turn: not user-role, injected by the harness, tool results only, empty, or
 * text that matches a known coordination-noise shape. Tolerates the flat and the
 * `message`-nested record shapes. Never throws.
 */
export function humanTurnText(rec: object): string | null {
  if (recordRole(rec) !== 'user') return null;
  if (isInjectedUserRecord(rec)) return null;
  const r = rec as { message?: { content?: unknown }; content?: unknown };
  const content = r.message && typeof r.message === 'object' ? r.message.content : r.content;
  const text = typedText(content).trim();
  if (!text || isSystemNoiseMessage(text)) return null;
  return text;
}
