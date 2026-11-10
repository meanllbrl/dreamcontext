/**
 * Opening a project is slow (owner, 2026-11-10). The screens that show a task as a name, a status
 * and a progress bar read the LIGHT list (`/tasks?view=summary`), never the full one (the whole
 * text of every task, 19.9 MB for 867 tasks, refetched every 15 s while an agent works); and the
 * composer's connected-projects list is one request per open, not one per pane (22 for 11 chats).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../dashboard/src/${rel}`, import.meta.url)), 'utf8');

const LIGHT_SURFACES = [
  'components/sleepy/super/SuperSurface.tsx',
  'components/sleepy/super/SuperTiles.tsx',
  'components/sleepy/super/MemberStage.tsx',
  'components/whiteboard/widgets/TaskWidget.tsx',
  'components/whiteboard/WidgetPickers.tsx',
  'components/whiteboard/PagePopup.tsx',
  'components/theses/ThesisDetailModal.tsx',
  'components/theses/ThesisCreateModal.tsx',
];

describe('the light task list', () => {
  it('is what the Super screen and the other summary surfaces read', () => {
    for (const rel of LIGHT_SURFACES) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/\buseTasks\(\)/);
      expect(src, rel).toMatch(/\buseTaskList\(\)/);
    }
  });

  it('asks the summary view, under the tasks key so every task write refreshes it', () => {
    const hook = read('hooks/useTasks.ts');
    const body = hook.slice(hook.indexOf('export function useTaskList'), hook.indexOf('export function useTask('));
    expect(body).toContain("'/tasks?view=summary'");
    expect(body).toContain('queryKey: TASK_LIST_KEY');
    expect(hook).toMatch(/TASK_LIST_KEY = \['tasks', \{ view: 'summary' \}\]/);
    // The board keeps the full list.
    expect(read('components/tasks/KanbanBoard.tsx')).toMatch(/\buseTasks\(\)/);
  });
});

describe('connected projects for the composer', () => {
  it('is one shared query per vault, not a fetch per pane', () => {
    const src = read('hooks/usePeerMentions.ts');
    expect(src).toContain('queryKey: PEER_MENTIONS_KEY');
    expect(src).not.toMatch(/useEffect\(/);
    expect(src).toContain('staleTime: PEERS_FRESH_MS');
    // A failure is not cached as "no projects": the next mount retries it.
    expect(src).not.toMatch(/\.catch\(/);
  });

  it('is refreshed when a connection is added or removed', () => {
    const src = read('hooks/useConnections.ts');
    expect(src.match(/invalidateQueries\(\{ queryKey: PEER_MENTIONS_KEY \}\)/g)?.length).toBe(2);
  });
});
