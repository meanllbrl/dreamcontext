import { RiceScatter } from 'dreamcontext-dashboard';

// RiceScatter plots fully-rated, non-completed tasks: X = effort (log, low on
// the RIGHT, 0.5-8 weeks), Y = impact (1-5), dot radius = reach (1-10), dot
// opacity = confidence (40-100%), dot color = status. Tasks missing any RICE
// field land in the collapsible "Unscored" tray. We spread points across all
// four quadrants (Big Bets / Quick Wins / Time Sinks / Fill-ins).
const noop = () => {};
const base = (over: Record<string, unknown>) => ({
  slug: String(Math.random()), id: '1', name: 'Task', description: '', priority: 'medium',
  urgency: 'medium', status: 'todo', created_at: '2026-06-20', updated_at: '2026-06-24',
  tags: [] as string[], parent_task: null, related_feature: null, version: 'S7',
  start_date: null, due_date: null, assignee: null, custom_fields: {}, rice: null,
  why: '', user_stories: '', acceptance_criteria: '', constraints: '',
  technical_details: '', notes: '', changelog: '', sections: [] as string[], body: '',
  ...over,
}) as any;

// reach 1-10, impact 1-5, confidence 0-100, effort weeks. Score is the classic
// RICE quotient, kept to a tidy magnitude (shown only in tooltip / a11y list).
const r = (reach: number, impact: number, confidence: number, effort: number) => ({
  reach, impact, confidence, effort,
  score: Math.round((reach * impact * confidence) / (effort * 10)),
});

const mkr = (
  slug: string, name: string, status: string,
  rice: Record<string, number> | null, tags: string[] = [],
) => base({ slug, name, status, rice, tags });

const board = [
  // Quick Wins — high impact, low effort (top-right)
  mkr('recall-cache', 'Cache BM25 recall scores', 'in_progress', r(9, 5, 90, 1), ['recall', 'perf']),
  mkr('snapshot-trim', 'Trim snapshot payload', 'todo', r(7, 4, 85, 0.5), ['snapshot']),
  mkr('taxonomy-fix', 'taxonomy audit --fix normalizer', 'in_review', r(6, 4, 80, 1.5), ['taxonomy']),
  // Big Bets — high impact, high effort (top-left)
  mkr('remsleep-fed', 'RemSleep federation drain', 'in_progress', r(8, 5, 70, 6), ['sleep', 'federation']),
  mkr('xproj-recall', 'Cross-project recall index', 'todo', r(10, 5, 60, 8), ['recall', 'architecture']),
  mkr('dash-rewrite', 'Dashboard data-layer rewrite', 'todo', r(5, 4, 65, 5), ['ui']),
  // Fill-ins — low impact, low effort (bottom-right)
  mkr('empty-states', 'Polish dashboard empty states', 'todo', r(3, 2, 90, 0.5), ['ui']),
  mkr('cli-theme', 'CLI color theme tokens', 'in_review', r(4, 1, 95, 1), ['cli']),
  mkr('changelog-fmt', 'Unify changelog format', 'todo', r(2, 2, 85, 1.5), ['ops']),
  // Time Sinks — low impact, high effort (bottom-left)
  mkr('legacy-mig', 'Legacy frontmatter migration', 'in_progress', r(3, 2, 50, 7), ['migration']),
  mkr('gh-sync-refactor', 'GitHub sync refactor', 'todo', r(4, 2, 55, 4), ['sync']),
  mkr('multitenant-poc', 'Multi-tenant POC spike', 'todo', r(2, 1, 40, 6), ['architecture']),
  // Centre — straddling the dividers
  mkr('knowledge-index', 'Knowledge index rebuild', 'in_progress', r(6, 3, 75, 2), ['knowledge']),
  mkr('context-gate', 'Context-gate skill hook', 'in_review', r(7, 3, 70, 3), ['skills', 'hook']),
  // Unscored — no RICE yet, surface in the tray
  mkr('agent-feedback', 'Agent feedback loop', 'todo', null, ['agents']),
  mkr('brain-curator', 'Brain curator skill', 'todo', null, ['skills']),
  mkr('soul-compress', 'Compress soul file', 'in_progress', null, ['onboarding']),
];

// Roadmap planning view: all high-impact, spread between Quick Wins and Big Bets.
const roadmap = [
  mkr('rm-recall-cache', 'Cache BM25 recall scores', 'in_progress', r(9, 5, 90, 1), ['recall']),
  mkr('rm-snapshot', 'Snapshot delta sync', 'todo', r(8, 5, 85, 1.5), ['snapshot']),
  mkr('rm-vocab', 'Taxonomy vocab autosuggest', 'in_review', r(7, 4, 80, 2), ['taxonomy']),
  mkr('rm-xproj', 'Cross-project recall index', 'todo', r(10, 5, 75, 4), ['recall']),
  mkr('rm-fed', 'RemSleep federation drain', 'in_progress', r(8, 4, 70, 5), ['sleep']),
  mkr('rm-gate', 'Context-gate goal skill', 'todo', r(6, 5, 88, 0.5), ['skills']),
  mkr('rm-doctor', 'Brain doctor autofix', 'todo', r(5, 4, 82, 1), ['ops']),
  mkr('rm-curator', 'Curator refactor pass', 'in_progress', r(9, 5, 65, 6), ['skills']),
  mkr('rm-index', 'Knowledge index rebuild', 'in_review', r(7, 3, 78, 2), ['knowledge']),
  mkr('rm-research', 'Deep-research corpus mode', 'todo', r(4, 4, 90, 1.5), ['research']),
];

export const PrioritizationBoard = () => (
  <div style={{ width: 720 }}>
    <RiceScatter tasks={board} onTaskClick={noop} />
  </div>
);

export const RoadmapPlanning = () => (
  <div style={{ width: 720 }}>
    <RiceScatter tasks={roadmap} onTaskClick={noop} />
  </div>
);
