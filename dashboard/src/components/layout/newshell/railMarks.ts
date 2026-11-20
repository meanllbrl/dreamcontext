/**
 * The project rail's marks (navigation B, C6), pure. Every number comes from the drawer's own
 * model: the project's row as `buildDrawerRows` builds it EXPANDED (a folded row has no children),
 * so a badge says exactly what that project's drawer row says, and the card's NEEDS YOU rows are
 * the rows the drawer would list under it, each with its own number and its own intent.
 */
import type { DrawerIntent } from '../../../lib/drawerIntents';
import { foldedMark, type DrawerChild, type DrawerProjectRow } from './drawerModel';

/** One thing waiting on the owner in a project: what it is, its own number, and the drawer intent
 *  its row carries (a click lands exactly where the drawer's row lands). */
export interface NeedsYouRow {
  key: string;
  kind: 'super' | 'window' | 'chat' | 'member';
  /** The row's own name; empty for the Super Agent (the caller names it in the UI language). */
  label: string;
  count: number;
  /** A member's approval card (said as such on the card). */
  approval?: boolean;
  intent: DrawerIntent;
}

export interface RailMarks {
  /** The red number: the sum of the NEEDS YOU rows' own numbers. */
  count: number;
  /** The violet ring: the project's Super Agent is at work (a device shell: any chat at work). */
  working: boolean;
  /** The short bar: replies not read yet. */
  fresh: boolean;
}

/** One member's items waiting on the owner, counted as `ekipAskingCount` counts them. */
function memberWaiting(m: Extract<DrawerChild, { kind: 'team' }>['members'][number]): number {
  let n = m.approval ? 1 : 0;
  if (m.asking && !m.superOnly && m.enabled) n += Math.max(1, m.waiting ?? 0);
  return n;
}

/** The project's NEEDS YOU rows, in the drawer's order (its Super Agent first, members last). */
export function needsYouOf(row: Pick<DrawerProjectRow, 'children'>): NeedsYouRow[] {
  const out: NeedsYouRow[] = [];
  for (const c of row.children) {
    if (c.kind === 'super') {
      // Counted as the drawer's folded mark counts it: one question.
      if (c.asking) out.push({ key: 'super', kind: 'super', label: '', count: 1, intent: { kind: 'super' } });
    } else if (c.kind === 'window') {
      if (c.asking > 0) out.push({ key: `w-${c.id}`, kind: 'window', label: c.name, count: c.asking, intent: { kind: 'open-window', windowId: c.id } });
    } else if (c.kind === 'chat') {
      if (c.state === 'asking') out.push({ key: `c-${c.id}`, kind: 'chat', label: c.title, count: 1, intent: { kind: 'open-chat', row: c.row } });
    } else if (c.kind === 'team') {
      for (const m of c.members) {
        const n = memberWaiting(m);
        if (n > 0) out.push({ key: `m-${m.slug}`, kind: 'member', label: m.title || m.slug, count: n, ...(m.approval ? { approval: true } : {}), intent: { kind: 'member', slug: m.slug, title: m.title } });
      }
    }
  }
  return out;
}

/** The badge's marks from the project's expanded row. */
export function railMarksOf(row: Pick<DrawerProjectRow, 'children'>): RailMarks {
  const count = needsYouOf(row).reduce((n, r) => n + r.count, 0);
  const mark = foldedMark(row.children);
  const superRow = row.children.find((c): c is Extract<DrawerChild, { kind: 'super' }> => c.kind === 'super');
  return {
    count,
    working: superRow ? superRow.working > 0 : !!mark?.working,
    fresh: (mark?.unread ?? 0) > 0,
  };
}
