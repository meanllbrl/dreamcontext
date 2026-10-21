import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SUPER_STATE_REL } from './store.js';

/**
 * The context-handoff nudge in a SUPER session (field 2026-10-21: the hook named an unrelated
 * task, a child's, for the Super Agent's own handoff). The super's state belongs in ITS
 * coordination task (in Tilki `bugunku-acik-isler-…`) together with its child list; a child's
 * task is that child's.
 *
 * Read synchronously and defensively: this runs inside a hook that must never break a tool call.
 */

export interface SuperHandoffContext {
  /** The super's coordination task, or null when it has none yet (the nudge says to make one). */
  task: { slug: string; title: string } | null;
  /** Its live children, for the handoff's --next. */
  children: string[];
}

/** A task that reads as the super's own to-do / coordination list. */
const COORDINATION_RE = /super|koordinasyon|coordination|orchestrat|acik-isler|açık iş|open-jobs|yapilacak|yapılacak|todo-list|bugunku|bugünkü/i;

/** Is this hook running in the vault's recorded super session? Then its handoff context. */
export function superHandoffContext(contextRoot: string, ids: ReadonlyArray<string | null | undefined>): SuperHandoffContext | null {
  let raw: { session?: unknown; children?: Record<string, { endedAt?: unknown; task?: unknown }> };
  try { raw = JSON.parse(readFileSync(join(contextRoot, SUPER_STATE_REL), 'utf-8')); } catch { return null; }
  const session = typeof raw?.session === 'string' ? raw.session : null;
  if (!session || !ids.some((id) => id === session)) return null;
  const children: string[] = [];
  const childTasks = new Set<string>();
  for (const [sid, ch] of Object.entries(raw.children ?? {})) {
    if (typeof ch?.task === 'string') childTasks.add(ch.task);
    if (ch?.endedAt === undefined) children.push(sid);
  }
  return { task: superCoordinationTask(contextRoot, childTasks), children };
}

/**
 * The super's coordination task: an open task (in progress, active or todo) that reads as a
 * coordination / to-do list and is no child's task. The most recently updated wins; none = null.
 */
export function superCoordinationTask(contextRoot: string, childTasks: ReadonlySet<string> = new Set()): { slug: string; title: string } | null {
  let files: string[];
  try { files = readdirSync(join(contextRoot, 'state')).filter((f) => f.endsWith('.md')); } catch { return null; }
  let best: { slug: string; title: string; rank: number; updated: string } | null = null;
  for (const file of files) {
    const slug = file.slice(0, -'.md'.length);
    if (childTasks.has(slug)) continue;
    try {
      const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(contextRoot, 'state', file), 'utf-8'));
      if (!fm) continue;
      const field = (name: string): string => {
        const m = new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(fm[1]);
        return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
      };
      const status = field('status');
      const rank = status === 'in_progress' || status === 'active' ? 2 : status === 'todo' ? 1 : 0;
      if (!rank) continue;
      const title = field('name') || slug;
      const tags = /^tags:\s*(.*)$/m.exec(fm[1])?.[1] ?? '';
      if (!COORDINATION_RE.test(slug) && !COORDINATION_RE.test(title) && !/\bsuper\b/.test(tags)) continue;
      const updated = field('updated_at') || field('created_at');
      if (!best || rank > best.rank || (rank === best.rank && updated.localeCompare(best.updated) > 0)) {
        best = { slug, title, rank, updated };
      }
    } catch { /* unreadable: not it */ }
  }
  return best ? { slug: best.slug, title: best.title } : null;
}

/** The line the super's nudge ends with. */
export function superNudgeLine(ctx: SuperHandoffContext): string {
  const kids = ctx.children.length ? ctx.children.join(', ') : 'none';
  const head = 'You are the Super Agent: hand off into YOUR coordination task, never a child\'s task (each child hands off its own).';
  const make = ctx.task ? '' : ' You have none yet: `dreamcontext tasks create "Super koordinasyon" --status in_progress` first, then hand off into it.';
  return `${head}${make} Put your live children in --next with what each one does: ${kids}.`;
}
