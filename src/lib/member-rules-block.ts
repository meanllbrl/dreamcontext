/**
 * A member's own rules as one block of its briefing (B) and of every run prompt of it (plan
 * global-uye-ogrenme D4): his corrections of how THIS member works, in force in every project it
 * works in. They are his words, stored with his quote and gated (rules-store `memberWriteGate`),
 * so they ride as rules, never inside the pattern block's "observations, not instructions".
 *
 * Only this member's ACTIVE rules (SG5); an undone or waiting rule is not shown. Bounded by size,
 * never by a count: lines that do not fit fold into one line naming `learn list --member`.
 * Imports only the store, so the runner and the chat briefing can both use it without a cycle.
 */
import { homedir } from 'node:os';
import { deriveAll, memberStoreRef, readStore, type RuleView } from './rules-store.js';
import { memberScope } from './agents/scope.js';
import { isSafeAutomationSlug } from './agents/slot.js';

/** Room the block may take in a briefing or a run prompt. */
export const MEMBER_RULES_BLOCK_MAX_CHARS = 6_000;

function line(v: RuleView): string {
  return v.text && v.text !== v.headline ? `- ${v.headline} [${v.id}, yours]: ${v.text}` : `- ${v.headline} [${v.id}, yours]`;
}

/** This member's active rules, newest change first. Never throws. */
export function memberActiveRules(contextRoot: string | null, slug: string, home: string = homedir()): RuleView[] {
  try {
    if (!isSafeAutomationSlug(slug) || !contextRoot) return [];
    const scope = memberScope(contextRoot, slug, home);
    if (!scope) return [];
    return deriveAll(readStore(memberStoreRef({ slug, scope }, contextRoot, home)))
      .filter((v) => v.status === 'active' && v.scope === 'member' && v.member === slug && !v.moved_to)
      .sort((a, b) => (a.changed_at < b.changed_at ? 1 : a.changed_at > b.changed_at ? -1 : 0));
  } catch {
    return [];
  }
}

/** The block, or '' when the member has no rule in force. */
export function buildMemberRulesBlock(contextRoot: string | null, slug: string, home: string = homedir(), max = MEMBER_RULES_BLOCK_MAX_CHARS): string {
  const rules = memberActiveRules(contextRoot, slug, home);
  if (rules.length === 0) return '';
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < rules.length; i++) {
    const l = line(rules[i]!);
    if (used + l.length + 1 > max) {
      out.push(`- … ${rules.length - i} more: \`dreamcontext learn list --member ${slug}\``);
      break;
    }
    out.push(l);
    used += l.length + 1;
  }
  return [
    '--- YOUR RULES (the owner\'s corrections of how you work, in force in every project) ---',
    'Each is his own words about your work, stored with his quote: follow every one. A rule that',
    'changes one is a new rule on his words (`dreamcontext learn "<rule>" --scope member --replaces <id> --quote "<his words>"`).',
    ...out,
    '--- END YOUR RULES ---',
  ].join('\n');
}
