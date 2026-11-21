import { createHash } from 'node:crypto';
import type { SuperAskSpec } from './types.js';

/**
 * Two checks on a question card the Super sends with `super ask`, `super queue ask` or
 * `super team ask` (plan iyilesme-360 D6, D7). Pure. AskUserQuestion frames never pass here.
 */

/** Case and spacing folded, Turkish casing first: the same card typed again reads the same. */
const fold = (s: string | undefined): string => (s ?? '').toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim();

/**
 * C4: the card's content key: its title, each question and each option label, folded. The same
 * decision sent again (plain, `--show`, `--json @file`) has the same key; a different decision
 * has another.
 */
export function cardKey(spec: Pick<SuperAskSpec, 'title' | 'questions'>): string {
  const body = fold(spec.title) + '\n' + spec.questions
    .map((q) => fold(q.question) + '|' + q.options.map((o) => fold(o.label)).join('|'))
    .join('\n');
  return createHash('sha1').update(body).digest('hex');
}

/** What a repeat of the open card is told (D6): the open one stands, nothing was sent again. */
export const REPEATED_NOTE = 'attachments of the open card kept';

/**
 * D7: a price the shell ate (`$6,99` sent inside double quotes arrives as `,99`): a comma or dot
 * and two digits, standing alone after a space, a bracket or the start.
 */
const SHELL_ATE_RE = /(^|[\s(])[,.]\d{2}(?=\s|$|[.,!?;:'’])/u;

/** The first card text field that reads like text the shell ate, as its path, or null. */
export function shellAteField(spec: SuperAskSpec): string | null {
  const hit = (v: string | undefined) => !!v && SHELL_ATE_RE.test(v);
  if (hit(spec.title)) return 'title';
  for (const [i, q] of spec.questions.entries()) {
    const at = `questions[${i}]`;
    if (hit(q.question)) return `${at}.question`;
    if (hit(q.header)) return `${at}.header`;
    if (hit(q.description)) return `${at}.description`;
    for (const [j, o] of q.options.entries()) {
      if (hit(o.label)) return `${at}.options[${j}].label`;
      if (hit(o.description)) return `${at}.options[${j}].description`;
    }
  }
  return null;
}

/** The refusal's text, naming the field and both ways out. */
export function shellAteMessage(field: string): string {
  return `${field} reads like text the shell ate: a \`$\` may have been eaten by the shell: send the card with \`--json @file\`, or reword it`;
}
