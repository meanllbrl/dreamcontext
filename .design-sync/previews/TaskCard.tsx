import { TaskCard } from 'dreamcontext-dashboard';

// A realistic Task. TaskCard reads name, priority, urgency, description, tags
// and updated_at; the rest satisfy the shape. `mk` lets each cell vary a few
// fields while staying realistic (real dreamcontext work items).
const noop = () => {};
const mk = (over: Record<string, unknown>) => ({
  slug: 'task', id: '1', name: 'Task', description: '', priority: 'medium',
  urgency: 'medium', status: 'todo', created_at: '2026-06-20', updated_at: '2026-06-24',
  tags: [] as string[], parent_task: null, related_feature: null, version: 'S7',
  start_date: null, due_date: null, assignee: null, custom_fields: {}, rice: null,
  why: '', user_stories: '', acceptance_criteria: '', constraints: '',
  technical_details: '', notes: '', changelog: '', sections: [] as string[], body: '',
  ...over,
}) as any;

export const Default = () => (
  <div style={{ width: 280 }}>
    <TaskCard
      task={mk({
        name: 'Wire up the RemSleep consolidation cycle',
        priority: 'high', urgency: 'high',
        description: 'Drain the session-digest inbox and fold novel patterns into long-term knowledge before the editor reloads.',
        tags: ['backend', 'sleep', 'consolidation'],
        updated_at: '2026-06-24',
      })}
      onClick={noop} onDragStart={noop}
    />
  </div>
);

export const Priorities = () => (
  <div style={{ display: 'grid', gap: 8, width: 280 }}>
    <TaskCard task={mk({ name: 'Token-burn regression in recall spiral', priority: 'critical', urgency: 'critical', description: 'Sessions re-explore structure they already knew.', tags: ['recall', 'perf'], updated_at: '2026-06-25' })} onClick={noop} onDragStart={noop} />
    <TaskCard task={mk({ name: 'Add taxonomy audit --fix bulk normalizer', priority: 'high', urgency: 'medium', tags: ['taxonomy', 'cli'], updated_at: '2026-06-23' })} onClick={noop} onDragStart={noop} />
    <TaskCard task={mk({ name: 'Polish dashboard empty states', priority: 'low', urgency: 'low', tags: ['ui', 'dashboard'], updated_at: '2026-06-18' })} onClick={noop} onDragStart={noop} />
  </div>
);

export const Dragging = () => (
  <div style={{ width: 280 }}>
    <TaskCard
      task={mk({ name: 'Move to In Progress', priority: 'medium', urgency: 'high', tags: ['kanban'], updated_at: '2026-06-24' })}
      onClick={noop} onDragStart={noop} dragging
    />
  </div>
);
