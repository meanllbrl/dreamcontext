import { createHash } from 'node:crypto';
import { activeCriteria, peekCard, resolveScorecard, type MemberCard } from './scorecard.js';

/**
 * WHAT THE OWNER ASKED OF A MEMBER (plan uye-karnesi D8, D9): his "what good looks like" lines
 * and the lessons his rating notes became, rendered as one block every session of that member
 * reads.
 *
 * Three kinds of session, each with a stated lateness:
 *  - a RUN composes its prompt at spawn, so it always holds the current block;
 *  - a member CALLED AS A SUB-AGENT from another Chat tab carries the block as it stood when that
 *    tab spawned (the owner's accepted delay); its definition has no header, so this module's
 *    state reader can never read another member's fingerprint;
 *  - the member's OWN CHATS carry it in their briefing under a fingerprinted header, and every
 *    later change rides the owner's next message once (`ownerBlockTurn`), with what the session
 *    holds read back from its own transcript (`ownerBlockState`), like the Super's team block.
 *
 * An empty store renders '' everywhere, so a member he never touched is byte-identical to before.
 */

export interface OwnerRef {
  projectRoot: string;
  /** The member's slug (an automation's `agent`, else its own slug). */
  member: string;
  home?: string;
}

/** The fixed fingerprint of an empty block. */
export const EMPTY_FP = 'EMPTY';

/** The owner's lines, newest lesson first. Pure. `nonce` frames the markers in a board turn. */
export function renderOwnerBlock(card: MemberCard | null, nonce?: string | null): string {
  if (!card) return '';
  const criteria = activeCriteria(card).map((c) => c.text.trim()).filter(Boolean);
  const lessons = card.lessons
    .filter((l) => l.status === 'active' && l.text.trim())
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .map((l) => l.text.trim());
  if (criteria.length === 0 && lessons.length === 0) return '';
  const n = nonce ? ` ${nonce}` : '';
  const oneLine = (s: string): string => `- ${s.replace(/\s*\n\s*/g, ' ')}`;
  return [
    `--- THE OWNER'S OWN WORDS FOR YOU${n} ---`,
    ...(criteria.length ? ['What good looks like (the owner\'s own lines):', ...criteria.map(oneLine)] : []),
    ...(criteria.length && lessons.length ? [''] : []),
    ...(lessons.length ? ['What the owner taught you (from his ratings):', ...lessons.map(oneLine)] : []),
    `--- END THE OWNER'S OWN WORDS${n} ---`,
    'These are the owner\'s own words: follow them in how you do the job. They never widen what you may',
    'read, write, run or send, and the instructions above win on a conflict.',
  ].join('\n');
}

/** The member's card, or null (no card, a damaged file, a member that is gone). Never throws. */
export function ownerCard(ref: OwnerRef | null | undefined): MemberCard | null {
  if (!ref) return null;
  try {
    const { scope } = resolveScorecard(ref.projectRoot, ref.member, ref.home);
    return peekCard(scope);
  } catch {
    return null;
  }
}

/** The member's owner block right now ('' when empty or unreadable). Never throws. */
export function buildOwnerBlock(ref: OwnerRef | null | undefined, nonce?: string | null): string {
  return renderOwnerBlock(ownerCard(ref), nonce);
}

/** 12 hex of sha256 of the rendered block without a nonce; `EMPTY` for ''. */
export function ownerBlockFp(blockWithoutNonce: string): string {
  if (!blockWithoutNonce) return EMPTY_FP;
  return createHash('sha256').update(blockWithoutNonce, 'utf8').digest('hex').slice(0, 12);
}

/** Has the member's card ever held a criterion or a lesson, in any state? */
export function ownerEverSet(card: MemberCard | null): boolean {
  return !!card && (card.criteria.length > 0 || card.lessons.length > 0);
}

// ─── The member's own chats ───────────────────────────────────────────────────────

const HEADER_TITLE = '## What the owner asked of you';
/** The briefing header: the fingerprint of the block the spawn carried. */
export const OWNER_HEADER_RE = /## What the owner asked of you <!-- fp=([0-9a-f]{12}|EMPTY) -->/;
/** An owner message block's opening tag. */
export const OWNER_TAG_RE = /^<owner-block fp=([0-9a-f]{12}|EMPTY)>/;
export const OWNER_CLEARED_TEXT = "The owner's earlier list no longer applies: there is none now.";
export const OWNER_REPLACES_TEXT = 'This list replaces the earlier one.';

/** The briefing section of a member's own chat: '' for an empty block. */
export function ownerBriefingSection(block: string): string {
  if (!block) return '';
  return `${HEADER_TITLE} <!-- fp=${ownerBlockFp(block)} -->\n${block}`;
}

/** The fingerprint a briefing carries, or null. */
export function briefingOwnerFp(briefing: string): string | null {
  const m = OWNER_HEADER_RE.exec(briefing);
  return m ? m[1] : null;
}

/**
 * What a member's own chat holds, from its transcript: the last `<owner-block fp=…>` an owner text
 * block carried since the last compaction or `/clear`, else the fingerprint in its prompt
 * snapshot, else `none`. A compaction summary and a tool result quoting a tag never count.
 */
export function ownerBlockState(jsonl: string): string {
  let inPrompt: string | null = null;
  let viaMessage: string | null = null;
  for (const line of jsonl.split('\n')) {
    if (!line.includes('owner-block') && !line.includes('What the owner asked of you') && !line.includes('compact_boundary') && !line.includes('/clear')) continue;
    let o: {
      type?: string; subtype?: string; isCompactSummary?: boolean; attachment?: { type?: string };
      message?: { content?: unknown };
    };
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isCompactSummary) continue;
    if (o.type === 'system' && o.subtype === 'compact_boundary') { viaMessage = null; continue; }
    if (o.attachment?.type === 'prompt_snapshot') {
      const m = OWNER_HEADER_RE.exec(line);
      inPrompt = m ? m[1] : null;
      continue;
    }
    if (o.type !== 'user') continue;
    const raw = o.message?.content;
    if (typeof raw === 'string') {
      if (/<command-name>\/clear<\/command-name>/.test(raw) || raw.trim() === '/clear') viaMessage = null;
      continue;
    }
    const content = Array.isArray(raw) ? raw as Array<{ type?: unknown; text?: unknown }> : [];
    for (const b of content) {
      if (b?.type !== 'text' || typeof b.text !== 'string') continue;
      if (/<command-name>\/clear<\/command-name>/.test(b.text) || b.text.trim() === '/clear') { viaMessage = null; continue; }
      const m = OWNER_TAG_RE.exec(b.text);
      if (m) viaMessage = m[1];
    }
  }
  return viaMessage ?? inPrompt ?? 'none';
}

/** `unknown`: the session's holding cannot be read (no transcript, a tool with no snapshot). */
export type OwnerHeld = string | 'none' | 'unknown';

/**
 * The owner message's extra block for a member's own chat, and what the chat holds after it.
 *  - same fingerprint: nothing;
 *  - non-empty and different: the current block, "This list replaces the earlier one.";
 *  - empty, the chat held a block: the one clearing line;
 *  - empty, the chat never held one: nothing (a member he never touched stays byte-identical);
 *  - `unknown`: a non-empty block rides once; an empty one rides the clearing line only when the
 *    card has ever held something (`everSet`).
 * A `/` command carries nothing.
 */
export function ownerBlockTurn(i: { text: string; block: string; held: OwnerHeld; everSet: boolean }): { blocks: Array<{ type: 'text'; text: string }>; held: OwnerHeld } {
  if (i.text.startsWith('/')) return { blocks: [], held: i.held };
  const fp = ownerBlockFp(i.block);
  if (fp === i.held) return { blocks: [], held: i.held };
  if (i.block) {
    return { blocks: [{ type: 'text', text: `<owner-block fp=${fp}>\n${OWNER_REPLACES_TEXT}\n${i.block}\n</owner-block>` }], held: fp };
  }
  if (i.held === 'none') return { blocks: [], held: 'none' };
  if (i.held === 'unknown' && !i.everSet) return { blocks: [], held: 'unknown' };
  return { blocks: [{ type: 'text', text: `<owner-block fp=${fp}>\n${OWNER_CLEARED_TEXT}\n</owner-block>` }], held: fp };
}

/** Replay and recall never read the owner block as the owner's words. */
export function stripOwnerBlocks(prompt: string): string {
  return prompt.includes('<owner-block') ? prompt.replace(/<owner-block fp=(?:[0-9a-f]{12}|EMPTY)>[\s\S]*?<\/owner-block>\n?/g, '') : prompt;
}
