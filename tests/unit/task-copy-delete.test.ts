/**
 * The task page's copy and delete (owner, 2026-11-16):
 *   1. Copy puts the slug on the clipboard and nothing else: a subtask copies its OWN slug.
 *   2. The delete dialog names the task, lists every subtask that goes with it ("This task and
 *      its 3 subtasks"), warns about ClickUp only when the task is on it, and offers Cancel
 *      beside a red Delete.
 *   3. No delete without the dialog: the delete mutation lives ONLY in TaskDeleteDialog, and no
 *      task surface calls a browser confirm or the mutation directly.
 *   4. After a delete: a subtask goes back to its parent, a task to the list.
 * The server half (subtasks deleted with the parent, a tombstone each, nothing on a refusal) is
 * in tasks-route-parent.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { I18nProvider } from '../../dashboard/src/context/I18nContext.js';
import { COPIED_MS, afterDeleteTarget, copyTaskSlug, deleteReason, deleteScope } from '../../dashboard/src/lib/taskDelete.js';
import { TaskDeleteView, type TaskDeleteViewProps } from '../../dashboard/src/components/tasks/TaskDeleteDialog.js';

const tasks = [
  { slug: 'android-compose-refaktoru', name: 'Android Compose refactor', parent_task: null },
  { slug: 'compose-ekran-a', name: 'Screen A', parent_task: 'android-compose-refaktoru' },
  { slug: 'compose-ekran-b', name: 'Screen B', parent_task: 'android-compose-refaktoru' },
  { slug: 'compose-ekran-c', name: 'Screen C', parent_task: 'android-compose-refaktoru' },
  { slug: 'unrelated', name: 'Unrelated', parent_task: null },
];

describe('copy', () => {
  it('writes exactly the slug, no prefix or suffix', async () => {
    const write = vi.fn(async () => true);
    expect(await copyTaskSlug('android-compose-refaktoru', write)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('android-compose-refaktoru');
  });

  it('a subtask copies its own slug, never its parent', async () => {
    const write = vi.fn(async () => true);
    await copyTaskSlug(tasks[1].slug, write);
    expect(write).toHaveBeenCalledWith('compose-ekran-a');
  });

  it('shows the Copied mark for 1.5 s', () => {
    expect(COPIED_MS).toBe(1500);
  });
});

describe('delete scope and where the page goes', () => {
  it('a parent takes its subtasks; a subtask and a lone task take nothing else', () => {
    expect(deleteScope(tasks[0], tasks).map((t) => t.slug)).toEqual(['compose-ekran-a', 'compose-ekran-b', 'compose-ekran-c']);
    expect(deleteScope(tasks[1], tasks)).toEqual([]);
    expect(deleteScope(tasks[4], tasks)).toEqual([]);
  });

  it('a subtask returns to its parent, a task to the list', () => {
    expect(afterDeleteTarget(tasks[1])).toBe('android-compose-refaktoru');
    expect(afterDeleteTarget(tasks[0])).toBeNull();
  });

  it('the reason is trimmed and folded; an empty one is not sent', () => {
    expect(deleteReason('  merged   into X \n')).toBe('merged into X');
    expect(deleteReason('   ')).toBeUndefined();
  });
});

function render(p: Partial<TaskDeleteViewProps>): string {
  const props: TaskDeleteViewProps = {
    name: 'Android Compose refactor', isSubtask: false, subtasks: [], remote: null, reason: '',
    onReason: () => {}, pending: false, error: null, onCancel: () => {}, onConfirm: () => {}, ...p,
  };
  return renderToStaticMarkup(h(I18nProvider, null, h(TaskDeleteView, props)));
}

describe('the delete dialog', () => {
  it('names the task, lists all 3 subtasks and says they go with it', () => {
    const html = render({ subtasks: deleteScope(tasks[0], tasks) });
    expect(html).toContain('Android Compose refactor');
    expect(html).toMatch(/This task and its 3 subtasks will be deleted/);
    for (const n of ['Screen A', 'Screen B', 'Screen C']) expect(html).toContain(n);
    expect(html).toContain('data-testid="task-delete-confirm"');
    expect(html).toContain('task-delete-confirm');
    expect(html).toContain('data-testid="task-delete-reason"');
  });

  it('warns about ClickUp only when the task is on ClickUp', () => {
    expect(render({ remote: 'clickup' })).toContain('It will be deleted from ClickUp too.');
    expect(render({ remote: null })).not.toContain('task-delete-remote');
  });

  it('Delete is held until the task read lands (its ClickUp warning depends on it)', () => {
    expect(render({ ready: false })).toMatch(/data-testid="task-delete-confirm"[^>]*disabled=""|disabled=""[^>]*data-testid="task-delete-confirm"/);
    expect(render({ ready: true })).not.toMatch(/disabled=""[^>]*data-testid="task-delete-confirm"/);
    // ...and says why while it waits.
    expect(render({ ready: false })).toContain('Checking whether this task is on the connected task app');
    expect(render({ ready: true })).not.toContain('task-delete-checking');
  });

  it('a subtask says its parent stays; an error is shown in place', () => {
    const html = render({ isSubtask: true, error: 'ClickUp said no' });
    expect(html).toContain('This subtask will be deleted. Its parent task stays.');
    expect(html).toContain('ClickUp said no');
  });
});

describe('no delete without the dialog', () => {
  const root = fileURLToPath(new URL('../../dashboard/src/', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e)) files.push(p);
    }
  };
  walk(root);

  it('only TaskDeleteDialog calls the delete mutation', () => {
    const callers = files.filter((f) => !f.endsWith(join('hooks', 'useTasks.ts')) && /useDeleteTask\s*\(/.test(readFileSync(f, 'utf-8')));
    expect(callers.map((f) => f.slice(root.length))).toEqual([join('components', 'tasks', 'TaskDeleteDialog.tsx')]);
  });

  it('no task surface deletes behind a browser confirm', () => {
    const taskDir = join(root, 'components', 'tasks');
    for (const f of files.filter((x) => x.startsWith(taskDir))) {
      const src = readFileSync(f, 'utf-8');
      expect(src, f).not.toMatch(/window\.confirm\(/);
      expect(src, f).not.toMatch(/api\.del<[^>]*>\(`\/tasks\//);
    }
  });
});
