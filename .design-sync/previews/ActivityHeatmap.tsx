import { ActivityHeatmap } from 'dreamcontext-dashboard';

// ActivityHeatmap is a GitHub-style 53-week calendar. The default metric is
// "Updated", so cell intensity is driven by how many tasks share each
// `updated_at` date (level = ceil(count / maxCount * 4)). The grid only shows
// the trailing 53 weeks ending at the render-time "today", so we generate dates
// as day-offsets from `new Date()` (evaluated in the render runtime) — this
// keeps every cell inside the window regardless of the sandbox clock.
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

const pad = (x: number) => String(x).padStart(2, '0');
const TODAY = new Date();
const daysAgo = (n: number) => {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const NAMES = [
  'Recall BM25 weight tune', 'Snapshot payload trim', 'Sleep consolidation cycle',
  'Taxonomy vocab normalize', 'Knowledge index rebuild', 'Federation digest drain',
  'Dashboard token sync', 'Context-gate hook wiring', 'Curator refactor batch',
  'Changelog reconcile', 'Release readiness check', 'Feature PRD scaffold',
  'Task status reconcile', 'Memory recall latency fix', 'ClickUp sync patch',
  'GitHub issue triage', 'Brain doctor sweep', 'Goal-skill orchestration',
  'Initializer ingest run', 'Deep-research session',
];
const STATUSES = ['completed', 'in_review', 'in_progress', 'todo'] as const;

let seq = 0;
// entries: [daysAgo, tasksOnThatDay]
function expand(entries: [number, number][]) {
  const out: ReturnType<typeof mk>[] = [];
  for (const [offset, count] of entries) {
    const date = daysAgo(offset);
    for (let i = 0; i < count; i++) {
      const n = seq++;
      out.push(mk({
        slug: `hm-${offset}-${i}-${n}`,
        name: NAMES[n % NAMES.length],
        status: STATUSES[n % STATUSES.length],
        created_at: daysAgo(offset + 4),
        updated_at: date,
        tags: ['recall', 'sleep', 'taxonomy', 'knowledge'].slice(0, (n % 3) + 1),
      }));
    }
  }
  return out;
}

// Steady cadence spanning the full ~52 weeks, peaks of 4 — a year of activity.
const yearTasks = expand([
  [3, 2], [5, 1], [8, 3], [12, 2], [15, 1], [18, 2], [21, 4], [25, 1], [29, 2],
  [33, 3], [37, 1], [41, 2], [45, 1], [49, 3], [53, 2], [58, 1], [62, 2],
  [66, 4], [70, 1], [75, 2], [80, 3], [85, 1], [90, 2], [96, 1], [102, 3],
  [108, 2], [114, 1], [121, 2], [128, 4], [135, 1], [142, 2], [149, 3],
  [156, 1], [163, 2], [170, 1], [178, 3], [186, 2], [194, 1], [203, 2],
  [212, 4], [221, 1], [230, 2], [240, 3], [251, 1], [262, 2], [274, 1],
  [287, 3], [300, 2], [314, 1], [329, 2], [345, 1], [358, 2],
]);

// Periodic release bursts pulsing across the whole year: dense dark clusters at
// each release, separated by quiet gaps — peaks of 6.
const sprintTasks = expand([
  [5, 5], [6, 4], [7, 6], [9, 3],
  [47, 4], [48, 5], [50, 6], [52, 3],
  [96, 5], [98, 4], [99, 6], [101, 3],
  [145, 4], [147, 6], [148, 3], [150, 5],
  [194, 5], [196, 4], [197, 6], [199, 3],
  [243, 4], [245, 5], [247, 6], [249, 3],
  [292, 5], [294, 4], [296, 6], [298, 3],
  [341, 4], [343, 6], [345, 3], [347, 5],
]);

export const EngineeringActivity = () => (
  <div style={{ width: 880 }}>
    <ActivityHeatmap tasks={yearTasks} onSelectDay={noop} />
  </div>
);

export const ReleaseCrunch = () => (
  <div style={{ width: 880 }}>
    <ActivityHeatmap tasks={sprintTasks} onSelectDay={noop} />
  </div>
);
