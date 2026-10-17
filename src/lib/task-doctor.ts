import { readFileSync } from 'node:fs';
import matter from 'gray-matter';
import { CARD_CEILING, NAME_SOFT_LIMIT, WHY_SOFT_LIMIT, isTemplateComment } from './task-card.js';
import { criteriaOfBody, gateStatus, isTypedOwnerDate } from './task-evidence.js';
import { statusKind, type StatusDef } from './task-status.js';

/**
 * The card-standard checks `tasks doctor` reports (pure: one card in, its
 * issues out). They name what keeps a card from being loadable whole and its
 * status from being believable.
 */

export type CardIssueCode =
  | 'template-comment'
  | 'name-long'
  | 'why-long'
  | 'card-size'
  | 'no-criteria'
  | 'review-unproven'
  | 'review-stale'
  | 'owner-typed-date';

export interface CardIssue {
  code: CardIssueCode;
  message: string;
}

export const REVIEW_STALE_DAYS = 7;

function daysBetween(fromIso: string, now: Date): number | null {
  const t = Date.parse(fromIso.length === 10 ? `${fromIso}T00:00:00Z` : fromIso);
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / 86_400_000);
}

export function cardIssues(raw: string, statuses: readonly StatusDef[], now: Date = new Date()): CardIssue[] {
  const issues: CardIssue[] = [];
  let data: Record<string, unknown> = {};
  let body = raw;
  try {
    const parsed = matter(raw);
    data = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch { /* unparseable frontmatter: body checks still run */ }

  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (!inFence && isTemplateComment(line)) {
      issues.push({ code: 'template-comment', message: 'carries an old template HTML comment (run `dreamcontext tasks migrate-journal`)' });
      break;
    }
  }
  const name = typeof data.name === 'string' ? data.name : '';
  if (name.length > NAME_SOFT_LIMIT) {
    issues.push({ code: 'name-long', message: `name is ${name.length} chars (> ${NAME_SOFT_LIMIT}): a name, not a summary — \`tasks rename\`` });
  }
  const why = /^##\s+Why\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(body)?.[1]?.trim() ?? '';
  if (why.length > WHY_SOFT_LIMIT) {
    issues.push({ code: 'why-long', message: `Why is ${why.length} chars (> ${WHY_SOFT_LIMIT}): two or three sentences; detail goes to Notes or the journal` });
  }
  if (raw.length > CARD_CEILING) {
    issues.push({ code: 'card-size', message: `card is ${raw.length} chars (> ${CARD_CEILING}): move history to the journal and long material to knowledge` });
  }

  const kind = statusKind(statuses, data.status);
  const criteria = criteriaOfBody(body);
  if ((kind === 'open' || kind === 'active') && criteria.length === 0) {
    issues.push({ code: 'no-criteria', message: 'open task with no acceptance criteria: nothing says when it is done' });
  }
  if (kind === 'review') {
    const gate = gateStatus(body, 'review');
    if (!gate.ok) {
      issues.push({
        code: 'review-unproven',
        message: `in review with ${gate.unproven.length} criterion(s) unproven: ${gate.unproven.map((c) => c.n).join(', ')}`,
      });
    }
    const updated = typeof data.updated_at === 'string' ? data.updated_at : '';
    const age = updated ? daysBetween(updated, now) : null;
    if (age !== null && age > REVIEW_STALE_DAYS) {
      issues.push({ code: 'review-stale', message: `in review for ${age} days (> ${REVIEW_STALE_DAYS}): approve it or send it back` });
    }
  }
  const typed = criteria.filter((c) => isTypedOwnerDate(c.evidence));
  if (typed.length > 0) {
    issues.push({ code: 'owner-typed-date', message: `criterion ${typed.map((c) => c.n).join(', ')} names a typed owner date; an owner ref names its approval entry` });
  }
  return issues;
}

export function cardIssuesOfFile(file: string, statuses: readonly StatusDef[], now?: Date): CardIssue[] {
  return cardIssues(readFileSync(file, 'utf-8'), statuses, now);
}
