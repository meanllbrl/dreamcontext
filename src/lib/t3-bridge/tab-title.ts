/**
 * A Codex tab's name. It used to name itself like a Claude chat: a line on the first turn, then
 * ONE hidden follow-up turn when a turn ended with the tab unnamed. Both are retired (2026-11-12):
 * the chat server now names every chat tab from the owner's first message
 * (`titleFromOwnerMessage`, chat-tab-title-nudge.ts), and a hidden turn re-read the whole context
 * to write a few words. An agent's own `title` block still renames the tab.
 *
 * The prompt is `<tag>`-wrapped, so a reopened pane that holds an old hidden turn never shows it
 * as the owner's text (`isInjectedUserText`).
 */
import { CHAT_TAB_TITLE_STOP_REASON } from '../chat-tab-title-nudge.js';

export const HIDDEN_TITLE_PROMPT =
  `<dreamcontext_tab_title>\n${CHAT_TAB_TITLE_STOP_REASON}\nRun no tools.\n</dreamcontext_tab_title>`;

const TITLE_RE = /\{\s*"type"\s*:\s*"title"\s*,\s*"text"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}/;

/** The name inside a `title` view in this text, or null. */
export function titleIn(text: string): string | null {
  const m = TITLE_RE.exec(text);
  if (!m) return null;
  try {
    const t = JSON.parse(m[1]!) as unknown;
    return typeof t === 'string' && t.trim() ? t.trim().slice(0, 80) : null;
  } catch {
    return null;
  }
}

export const titleBlock = (title: string): string =>
  `\`\`\`dream-view\n${JSON.stringify({ type: 'title', text: title })}\n\`\`\``;

type Frame = Record<string, unknown>;

function assistantText(frame: Frame): string {
  if (frame.type !== 'assistant') return '';
  const content = (frame.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('');
}

export class TabTitler {
  /** The tab has a name, or its first turn has ended. */
  private settled = false;

  /** `wanted` (does the tab still want a name) is kept in the signature for the bridge's call. */
  constructor(_wanted: () => boolean) { /* nothing to keep: no turn is spent on a name */ }

  /** App context for a turn about to start. Retired: the server names the tab (see the header). */
  nudge(): Array<{ key: string; text: string }> {
    return [];
  }

  /** Every frame the pane receives. Never asks for the hidden turn any more (see the header). */
  observe(frame: Frame): boolean {
    if (this.settled) return false;
    if (titleIn(assistantText(frame))) { this.settled = true; return false; }
    if (frame.type === 'result' && !frame.dc_synthetic && !frame.is_error && frame.subtype === 'success') {
      this.settled = true;
    }
    return false;
  }
}
