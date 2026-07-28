import { RoadmapBoard } from '../components/roadmap/RoadmapBoard';
import type { Page } from '../components/layout/Sidebar';
import type { FocusTarget } from '../hooks/useFocusTarget';

interface RoadmapPageProps {
  /** Forwarded to the Learning section's cross-page navigation (open a thesis, or the Hypotheses board pre-filtered to an objective). Optional — defaults to no-op when the Shell hasn't wired navigation in. */
  onNavigate?: (page: Page, id?: string) => void;
  /** Shell navigation focus — opens that objective's detail panel (⌘K recall hit). */
  focus?: FocusTarget;
}

/**
 * Roadmap — the PO-authored OKR board (objectives, task↔objective links,
 * dependency-cascade forecasting, target-vs-forecast slip detection).
 *
 * Currently ships the top chrome only (view tabs + toolbar), mirroring the Tasks
 * board; the timeline/board renderer lands next against `buildRoadmapModel`
 * (GET /api/roadmap). See `knowledge/features/okr-roadmap.md`.
 */
export function RoadmapPage({ onNavigate, focus }: RoadmapPageProps = {}) {
  // Fill the shell-main content height so the board card is full-height, matching
  // TasksPage (the board root is height:100%; this wrapper completes the chain).
  return (
    <div style={{ height: '100%', minHeight: 0 }}>
      <RoadmapBoard onNavigate={onNavigate} focus={focus} />
    </div>
  );
}
