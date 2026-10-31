/**
 * A Codex tab names itself (plan r5 §4a), the same two-step rule Claude's hooks follow:
 * a line on the first turn, then, when a turn ends with the tab still unnamed, ONE hidden
 * follow-up turn (the Stop hook's job on Claude, `chatTabTitleStopBlock`). Its frames are not
 * drawn; only the title block it wrote goes out, and that draws nothing but the tab's name.
 *
 * The prompt is `<tag>`-wrapped, so a reopened pane never shows it as the owner's text
 * (`isInjectedUserText`).
 */
import { CHAT_TAB_TITLE_NUDGE, CHAT_TAB_TITLE_STOP_REASON } from '../chat-tab-title-nudge.js';

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
  /** The tab has a name, or its one hidden turn has been spent. */
  private settled = false;
  private readonly wanted: () => boolean;

  constructor(wanted: () => boolean) {
    this.wanted = wanted;
  }

  /** App context for a turn about to start: the line, while the tab still wants a name. */
  nudge(): Array<{ key: string; text: string }> {
    return !this.settled && this.wanted() ? [{ key: 'dreamcontext-tab-title', text: CHAT_TAB_TITLE_NUDGE }] : [];
  }

  /**
   * Every frame the pane receives. True once a clean turn ended with no name: the caller runs
   * the hidden turn, once.
   */
  observe(frame: Frame): boolean {
    if (this.settled) return false;
    if (titleIn(assistantText(frame))) { this.settled = true; return false; }
    if (frame.type !== 'result' || frame.dc_synthetic || frame.is_error || frame.subtype !== 'success') return false;
    if (!this.wanted()) { this.settled = true; return false; }
    this.settled = true;
    return true;
  }
}
