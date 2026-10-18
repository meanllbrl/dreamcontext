import { existsSync } from 'node:fs';
import fg from 'fast-glob';
import { readTaskCardMemo } from './task-backend/local.js';
import type { TaskListItem } from './task-backend/types.js';
import { buildFamily, rollupOf, type TaskBrief } from './task-parent.js';
import type { StatusDef } from './task-status.js';

/**
 * The cards `GET /api/tasks` returns (plan r3 § W4): every top-level `state/*.md` as a
 * {@link TaskListItem}, with each parent's roll-up of its non-cancelled children.
 *
 * Bodies, sections and journals stay out on purpose. The list is polled by every open
 * window, and with a 300 KB legacy card and its journal in it, every poll re-sent the
 * whole history of every task; the task page reads one task by slug instead. Reads go
 * through the task read memo, so an unchanged card is not re-read.
 */
export function listTaskCards(stateDir: string, defs: readonly StatusDef[]): TaskListItem[] {
  if (!existsSync(stateDir)) return [];
  const items: TaskListItem[] = [];
  for (const file of fg.sync('*.md', { cwd: stateDir, absolute: true })) {
    try {
      items.push(readTaskCardMemo(file));
    } catch { /* an unreadable card is skipped, as backend.list() skips it */ }
  }
  const family = buildFamily(items.map(toBrief));
  for (const item of items) {
    const kids = family.children.get(item.slug);
    if (!kids || kids.length === 0) continue;
    const r = rollupOf(kids, defs);
    item.children = { total: r.total, done: r.done };
  }
  return items;
}

function toBrief(item: TaskListItem): TaskBrief {
  return {
    slug: item.slug,
    id: item.id || null,
    name: item.name,
    status: item.status,
    parent: item.parent_task,
    rank: item.rank,
    cycle: item.cycle,
    queue: item.queue,
  };
}
