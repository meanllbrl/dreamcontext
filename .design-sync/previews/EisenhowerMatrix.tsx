import { EisenhowerMatrix } from 'dreamcontext-dashboard';

// EisenhowerMatrix buckets active tasks into a 2x2 priority/urgency grid,
// rendering a TaskCard per task. Omitting onTaskMove renders the read-only
// matrix (no drag/undo chrome). Tasks below spread across all four quadrants.
const noop = () => {};
const mk = (over: Record<string, unknown>) => ({
  slug: String(Math.random()), id: '1', name: 'Task', description: '', priority: 'medium',
  urgency: 'medium', status: 'todo', created_at: '2026-06-20', updated_at: '2026-06-24',
  tags: [] as string[], parent_task: null, related_feature: null, version: 'S7',
  start_date: null, due_date: null, assignee: null, custom_fields: {}, rice: null,
  why: '', user_stories: '', acceptance_criteria: '', constraints: '',
  technical_details: '', notes: '', changelog: '', sections: [] as string[], body: '',
  ...over,
}) as any;

const tasks = [
  mk({ slug: 'recall-regression', name: 'Token-burn regression in recall', priority: 'critical', urgency: 'critical', tags: ['recall', 'perf'] }),
  mk({ slug: 'sleep-cycle', name: 'Harden RemSleep federation drain', priority: 'high', urgency: 'critical', tags: ['sleep'] }),
  mk({ slug: 'taxonomy-fix', name: 'taxonomy audit --fix normalizer', priority: 'high', urgency: 'low', tags: ['taxonomy'] }),
  mk({ slug: 'knowledge-index', name: 'Rebuild knowledge index on rename', priority: 'critical', urgency: 'low', tags: ['knowledge'] }),
  mk({ slug: 'triage-issues', name: 'Triage stale GitHub issues', priority: 'low', urgency: 'high', tags: ['ops'] }),
  mk({ slug: 'empty-states', name: 'Polish dashboard empty states', priority: 'low', urgency: 'low', tags: ['ui'] }),
];

export const ReadOnly = () => (
  <div style={{ width: 560 }}>
    <EisenhowerMatrix tasks={tasks} onTaskClick={noop} />
  </div>
);
