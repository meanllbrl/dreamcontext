import { SubGroupSection } from 'dreamcontext-dashboard';

// SubGroupSection is a collapsible, labelled bucket of TaskCards with an optional
// color dot, a label and a live count. It reads label, color, the tasks array, and
// the drag/click callbacks. `mk` builds realistic dreamcontext work items; each
// task needs a UNIQUE slug (React key).
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

export const SprintBucket = () => (
  <div style={{ width: 300 }}>
    <SubGroupSection
      label="Sprint S7"
      color="var(--color-status-in-progress)"
      onTaskClick={noop}
      onDragStart={noop}
      tasks={[
        mk({ slug: 'sb-remsleep', name: 'Wire up the RemSleep consolidation cycle', priority: 'high', urgency: 'high', description: 'Fold novel session patterns into long-term knowledge before reload.', tags: ['sleep', 'backend'], updated_at: '2026-06-25' }),
        mk({ slug: 'sb-federation', name: 'Drain peer-digest inbox on federation sync', priority: 'high', urgency: 'medium', tags: ['federation', 'sync'], updated_at: '2026-06-24' }),
        mk({ slug: 'sb-snapshot', name: 'Behavioral bootstrap in context snapshot', priority: 'medium', urgency: 'high', tags: ['snapshot', 'onboarding'], updated_at: '2026-06-23' }),
      ]}
    />
  </div>
);

export const CriticalBucket = () => (
  <div style={{ width: 300 }}>
    <SubGroupSection
      label="Critical"
      color="var(--color-priority-critical)"
      onTaskClick={noop}
      onDragStart={noop}
      tasks={[
        mk({ slug: 'cb-token-burn', name: 'Token-burn regression in recall spiral', priority: 'critical', urgency: 'critical', description: 'Sessions re-explore structure they already knew, doubling recall budget.', tags: ['recall', 'perf'], updated_at: '2026-06-26' }),
        mk({ slug: 'cb-leak', name: 'Memory leak in sleep-state writer', priority: 'critical', urgency: 'high', tags: ['sleep', 'backend'], updated_at: '2026-06-25' }),
      ]}
    />
  </div>
);
