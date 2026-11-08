/**
 * The ONE way a question card becomes a Telegram message (every sender: the Super's own ask, a
 * child's escalated question, the Super chat's AskUserQuestion, the rich multi-question asks, a
 * member routine's question). The owner decides from his phone cold, so the message carries
 * what the Mac card shows, in this order:
 *
 *   ❓ <b>title</b>
 *   lead (who asks, when a sender has one)
 *   question
 *
 *   question description
 *
 *   • label: option description   (only options that HAVE one)
 *
 * Buttons keep only the labels (the caller's keyboard). Every text is redacted and HTML-escaped
 * here; the whole message stays under Telegram's 4096 characters by trimming the descriptions
 * (never the question, never a label).
 */
import { TG_TEXT_MAX } from './contract.js';
import { escapeHtml, redactSecrets } from './format.js';

export interface AskCardQuestion {
  question: string;
  description?: string;
  options?: readonly { label: string; description?: string }[];
}

export interface AskCardOpts {
  /** The card's title, drawn bold. */
  title?: string;
  /** A plain line before the question (who asks: a job's name). */
  lead?: string;
  /** Raw HTML before the ❓ (a caller's own marker; already safe). */
  prefix?: string;
  /** Plain text right after the question (" (1/3)"). */
  suffix?: string;
  /** Raw HTML after everything (a hint line; already safe). */
  footer?: string;
  /** Test seam: the message limit. */
  max?: number;
}

const QUESTION_MAX = 1500;
const TITLE_MAX = 200;
const LEAD_MAX = 300;
const DESC_MAX = 1000;
const OPTION_DESC_MAX = 300;

/** Plain text, redacted, cut on a code point (Turkish and emoji survive) with an ellipsis. */
function clip(raw: string | undefined, max: number): string {
  const s = redactSecrets(String(raw ?? '')).trim();
  const cps = [...s];
  if (cps.length <= max) return s;
  return max <= 1 ? '' : `${cps.slice(0, max - 1).join('').trimEnd()}…`;
}

/** The question message as Telegram HTML (see the module doc). */
export function formatAskQuestionHtml(q: AskCardQuestion, opts: AskCardOpts = {}): string {
  const max = opts.max ?? TG_TEXT_MAX;
  const head: string[] = [];
  const title = clip(opts.title, TITLE_MAX);
  if (title) head.push(`<b>${escapeHtml(title)}</b>`);
  const lead = clip(opts.lead, LEAD_MAX);
  if (lead) head.push(escapeHtml(lead));
  head.push(`${escapeHtml(clip(q.question, QUESTION_MAX))}${opts.suffix ? escapeHtml(opts.suffix) : ''}`);
  const top = `${opts.prefix ?? ''}❓ ${head.join('\n')}`;
  const foot = opts.footer ? `\n${opts.footer}` : '';
  const described = (q.options ?? []).filter((o) => typeof o.description === 'string' && o.description.trim());

  const build = (descMax: number, optMax: number): string => {
    const parts = [top];
    const d = descMax > 0 ? clip(q.description, descMax) : '';
    if (d) parts.push(escapeHtml(d));
    const rows = optMax > 0
      ? described.map((o) => ({ l: clip(o.label, 60), d: clip(o.description, optMax) })).filter((r) => r.d).map((r) => `• ${escapeHtml(r.l)}: ${escapeHtml(r.d)}`)
      : [];
    if (rows.length) parts.push(rows.join('\n'));
    return `${parts.join('\n\n')}${foot}`;
  };

  // Shrink the descriptions until the message fits; the question and the buttons never go.
  let descMax = DESC_MAX;
  let optMax = OPTION_DESC_MAX;
  let html = build(descMax, optMax);
  while (html.length > max && (descMax > 0 || optMax > 0)) {
    descMax = descMax > 40 ? Math.floor(descMax * 0.7) : 0;
    optMax = optMax > 20 ? Math.floor(optMax * 0.7) : 0;
    html = build(descMax, optMax);
  }
  return html;
}

/**
 * A whole card with no buttons (answered on the Mac): one message per question, the title and
 * lead on the first, " (i/n)" on each when there are several, the footer on the last.
 */
export function formatAskCardMessages(questions: readonly AskCardQuestion[], opts: Omit<AskCardOpts, 'suffix'> = {}): string[] {
  const n = questions.length;
  return questions.map((q, i) => formatAskQuestionHtml(q, {
    ...(i === 0 ? { title: opts.title, lead: opts.lead, prefix: opts.prefix } : { prefix: opts.prefix }),
    ...(n > 1 ? { suffix: ` (${i + 1}/${n})` } : {}),
    ...(i === n - 1 && opts.footer ? { footer: opts.footer } : {}),
    ...(opts.max ? { max: opts.max } : {}),
  }));
}
