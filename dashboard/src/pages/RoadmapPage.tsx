import { RoadmapBoard } from '../components/roadmap/RoadmapBoard';

/**
 * Roadmap — the PO-authored OKR board (objectives, task↔objective links,
 * dependency-cascade forecasting, target-vs-forecast slip detection).
 *
 * Currently ships the top chrome only (view tabs + toolbar), mirroring the Tasks
 * board; the timeline/board renderer lands next against `buildRoadmapModel`
 * (GET /api/roadmap). See `core/features/okr-roadmap.md`.
 */
export function RoadmapPage() {
  // Fill the shell-main content height so the board card is full-height, matching
  // TasksPage (the board root is height:100%; this wrapper completes the chain).
  return (
    <div style={{ height: '100%', minHeight: 0 }}>
      <RoadmapBoard />
    </div>
  );
}
