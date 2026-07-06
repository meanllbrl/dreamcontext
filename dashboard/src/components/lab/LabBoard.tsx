import { useEffect, useMemo, useState } from 'react';
import { useLabInsights, useSyncAll } from '../../hooks/useLab';
import { InsightCard } from './InsightCard';
import { LabEmptyState } from './LabEmptyState';
import './LabBoard.css';

const UNGROUPED = 'Ungrouped';

/** Group insight summaries by manifest `group` (null → "Ungrouped"), preserving
 *  the API's slug-sorted order within each section. */
function groupInsights<T extends { group: string | null }>(insights: T[]): [string, T[]][] {
  const byGroup = new Map<string, T[]>();
  for (const insight of insights) {
    const key = insight.group ?? UNGROUPED;
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(insight);
    else byGroup.set(key, [insight]);
  }
  // Named groups first (alphabetical), Ungrouped last.
  const named = [...byGroup.keys()].filter((k) => k !== UNGROUPED).sort();
  const ordered = byGroup.has(UNGROUPED) ? [...named, UNGROUPED] : named;
  return ordered.map((g) => [g, byGroup.get(g)!]);
}

export function LabBoard() {
  const { data: insights, isLoading, isError, error } = useLabInsights();
  const syncAll = useSyncAll();
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const grouped = useMemo(() => groupInsights(insights ?? []), [insights]);

  const handleSyncAll = () => {
    syncAll.mutate(true, {
      onSuccess: (data) => {
        if (data.failed.length > 0) {
          const names = data.failed.map((f) => f.slug).join(', ');
          setToast(`⚠ ${data.failed.length} of ${data.results.length} insight(s) failed: ${names}`);
        } else {
          setToast(`Synced ${data.results.length} insight(s).`);
        }
      },
      onError: (err) => setToast(`Sync all failed: ${(err as Error).message}`),
    });
  };

  // Chrome-free until we know what we have: loading shows no toolbar (so the UI
  // can't flash a clickable Sync-all and then hard-switch layout to the explainer).
  if (isLoading) {
    return (
      <div className="lab-board">
        <div className="lab-board-loading">Loading insights…</div>
      </div>
    );
  }

  // A fetch failure is an outage, not onboarding — never show "scaffold your
  // first insight" over an error (mirrors CouncilPage's explicit isError branch).
  if (isError) {
    return (
      <div className="lab-board">
        <div className="error-state">Failed to load insights. {(error as Error)?.message}</div>
      </div>
    );
  }

  // Empty state mirrors Council: no "Lab" headline, no Sync-all — just the
  // "What is Insights?" explainer. Chrome only appears once there's data to act on.
  if (!insights || insights.length === 0) {
    return (
      <div className="lab-board lab-board--empty">
        <LabEmptyState />
      </div>
    );
  }

  return (
    <div className="lab-board">
      {/* No page title — the sidebar already names the active page. The toolbar
          keeps only the Sync-all action, aligned right. */}
      <div className="lab-board-toolbar">
        <button className="lab-board-sync-all" onClick={handleSyncAll} disabled={syncAll.isPending}>
          {syncAll.isPending ? 'Syncing…' : 'Sync all'}
        </button>
      </div>

      <div className="lab-board-sections">
        {grouped.map(([group, items]) => (
          <section key={group} className="lab-board-section">
            <h3 className="lab-board-section-title">{group}</h3>
            <div className="lab-board-grid">
              {items.map((summary) => (
                <InsightCard key={summary.slug} summary={summary} onToast={setToast} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {toast && <div className="lab-toast">{toast}</div>}
    </div>
  );
}
