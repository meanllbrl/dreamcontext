import { KanbanColumn } from 'dreamcontext-dashboard';

// KanbanColumn renders a titled, accent-dotted column of TaskCards (or sub-grouped
// sections). It reads title, status, count, colorVar (a CSS custom-property NAME
// from the bundle tokens — we use the real status accents) and the tasks array.
// `mk` builds realistic dreamcontext work items; each needs a UNIQUE slug (React key).
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

export const Todo = () => (
  <div style={{ width: 300 }}>
    <KanbanColumn
      title="To Do"
      status="todo"
      count={4}
      colorVar="--color-status-todo"
      onTaskClick={noop}
      onDrop={noop}
      tasks={[
        mk({ slug: 'remsleep-cycle', name: 'Wire up the RemSleep consolidation cycle', priority: 'high', urgency: 'high', description: 'Drain the session-digest inbox and fold novel patterns into long-term knowledge before the editor reloads.', tags: ['backend', 'sleep', 'consolidation'], updated_at: '2026-06-25' }),
        mk({ slug: 'token-burn', name: 'Token-burn regression in recall spiral', priority: 'critical', urgency: 'critical', description: 'Sessions re-explore structure they already knew about, doubling the recall budget.', tags: ['recall', 'perf'], updated_at: '2026-06-24' }),
        mk({ slug: 'taxonomy-fix', name: 'Ship taxonomy audit --fix bulk normalizer', priority: 'high', urgency: 'medium', tags: ['taxonomy', 'cli'], updated_at: '2026-06-23' }),
        mk({ slug: 'index-rebuild', name: 'Incremental knowledge-index rebuild', priority: 'medium', urgency: 'low', tags: ['index', 'bm25'], updated_at: '2026-06-21' }),
      ]}
    />
  </div>
);

export const InProgress = () => (
  <div style={{ width: 300 }}>
    <KanbanColumn
      title="In Progress"
      status="in_progress"
      count={3}
      colorVar="--color-status-in-progress"
      onTaskClick={noop}
      onDrop={noop}
      tasks={[
        mk({ slug: 'federation-drain', name: 'Drain peer-digest inbox on federation sync', priority: 'high', urgency: 'high', description: 'Fold consent-gated peer digests into first-class local knowledge.', tags: ['federation', 'sync'], updated_at: '2026-06-26' }),
        mk({ slug: 'curator-merge', name: 'Curator: merge duplicate recall knowledge', priority: 'medium', urgency: 'medium', tags: ['curator', 'knowledge'], updated_at: '2026-06-25' }),
        mk({ slug: 'snapshot-boot', name: 'Behavioral bootstrap in context snapshot', priority: 'medium', urgency: 'high', tags: ['snapshot', 'onboarding'], updated_at: '2026-06-24' }),
      ]}
    />
  </div>
);

export const SubGrouped = () => (
  <div style={{ width: 300 }}>
    <KanbanColumn
      title="Backlog"
      status="todo"
      count={4}
      colorVar="--color-accent"
      onTaskClick={noop}
      onDrop={noop}
      tasks={[]}
      subGroups={[
        {
          key: 'critical',
          label: 'Critical',
          color: 'var(--color-priority-critical)',
          tasks: [
            mk({ slug: 'sg-token-burn', name: 'Token-burn regression in recall', priority: 'critical', urgency: 'critical', tags: ['recall', 'perf'], updated_at: '2026-06-25' }),
            mk({ slug: 'sg-leak', name: 'Memory leak in sleep-state writer', priority: 'critical', urgency: 'high', tags: ['sleep', 'backend'], updated_at: '2026-06-24' }),
          ],
        },
        {
          key: 'high',
          label: 'High',
          color: 'var(--color-priority-high)',
          tasks: [
            mk({ slug: 'sg-taxonomy', name: 'taxonomy audit --fix normalizer', priority: 'high', urgency: 'medium', tags: ['taxonomy', 'cli'], updated_at: '2026-06-23' }),
            mk({ slug: 'sg-federation', name: 'Federation digest consent gate', priority: 'high', urgency: 'medium', tags: ['federation'], updated_at: '2026-06-22' }),
          ],
        },
      ]}
    />
  </div>
);
