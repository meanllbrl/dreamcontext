import { listAgents } from './store.js';

/**
 * WHICH EXISTING MEMBERS A NEW AUTOMATION'S TEXT NAMES (owner 2026-11-17).
 *
 * `automations create` without `--agent` makes a NEW AI Team member. An agent asked to give an
 * existing member more work kept forgetting `--agent`, wrote "You are Ada, your identity is in
 * _dream_context/agents/ada.md" into the prompt, and the owner saw a second Ada on his team. The
 * create refuses when its title or prompt names a member, and suggests the member's routine.
 *
 * Exact matching only, never fuzzy: the member's slug or its display name as a whole word
 * (case-insensitive; letters, digits, `_` and `-` are word characters, so `ada-notes` does not
 * name `ada`, while `Ada's` does), or its file path `agents/<slug>.md`. A slug or name shorter
 * than 3 characters is matched only through its path: two letters are too often a plain word.
 */

export interface MemberMention {
  slug: string;
  title: string;
  /** What in the text named it. */
  via: 'slug' | 'name' | 'path';
}

const MIN_WORD = 3;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namesWord(text: string, word: string): boolean {
  const w = word.trim();
  if (w.length < MIN_WORD) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(w)}(?![\\p{L}\\p{N}_-])`, 'iu').test(text);
}

/** Every member of this project (and this Mac's global agents) that `texts` name, by slug order. */
export function membersNamedIn(contextRoot: string, texts: readonly string[], home?: string): MemberMention[] {
  const text = texts.filter(Boolean).join('\n');
  if (!text.trim()) return [];
  const out: MemberMention[] = [];
  for (const agent of listAgents(contextRoot, home)) {
    const title = (agent.title ?? '').trim();
    const via: MemberMention['via'] | null = text.includes(`agents/${agent.slug}.md`)
      ? 'path'
      : namesWord(text, agent.slug)
        ? 'slug'
        : title && namesWord(text, title)
          ? 'name'
          : null;
    if (via) out.push({ slug: agent.slug, title: title || agent.slug, via });
  }
  return out;
}
