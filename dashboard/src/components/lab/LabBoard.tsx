import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLabInsights, useSyncAll } from '../../hooks/useLab';
import { useLabPrefs } from '../../hooks/useLabPrefs';
import { InsightCard } from './InsightCard';
import { InsightDetailPanel } from './InsightDetailPanel';
import { pushLabPath } from './funnel/labRoute';
import { LabCredentialsBanner } from './LabCredentialsBanner';
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

/** Apply a persisted manual order to one group's items: listed slugs first (in
 *  saved order), unlisted ones (new insights) after, in API order. */
function applyOrder<T extends { slug: string }>(items: T[], order: string[] | undefined): T[] {
  if (!order || order.length === 0) return items;
  const pos = new Map(order.map((slug, i) => [slug, i]));
  return items
    .map((item, apiIdx) => ({ item, key: pos.get(item.slug) ?? order.length + apiIdx }))
    .sort((a, b) => a.key - b.key)
    .map((e) => e.item);
}

export function LabBoard() {
  const { data: insights, isLoading, isError, error } = useLabInsights();
  const syncAll = useSyncAll();
  const { prefs, toggleCollapsed, setGroupOrder } = useLabPrefs();
  const [toast, setToast] = useState<string | null>(null);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  // Card being dragged (with its group — reordering is within-group only) and
  // the card it currently hovers. Cleared on drop/dragend, never on dragleave
  // (per-item dragleave flickers in WKWebView — see KanbanBoard).
  const [drag, setDrag] = useState<{ slug: string; group: string } | null>(null);
  const [dragOverSlug, setDragOverSlug] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const grouped = useMemo(() => {
    return groupInsights(insights ?? []).map(([group, items]) =>
      [group, applyOrder(items, prefs.order[group])] as const,
    );
  }, [insights, prefs.order]);

  // Multi-page insights (funnel) route to their overview page — the card is
  // page 1's entry. Everything else opens the detail slide-over as before.
  const openInsight = useCallback((slug: string) => {
    const summary = (insights ?? []).find((s) => s.slug === slug);
    if (summary?.render === 'funnel') pushLabPath(slug, null);
    else setOpenSlug(slug);
  }, [insights]);
  // Re-derive the open summary from the live list so the panel header (staleness,
  // latest, error) refreshes after a sync instead of showing a stale snapshot.
  const openSummary = openSlug ? (insights ?? []).find((s) => s.slug === openSlug) ?? null : null;

  const endDrag = useCallback(() => {
    setDrag(null);
    setDragOverSlug(null);
  }, []);

  /** Drop the dragged card at `targetSlug`'s position (or at the end when null). */
  const dropInGroup = useCallback((group: string, displayed: { slug: string }[], targetSlug: string | null) => {
    if (!drag || drag.group !== group) { endDrag(); return; }
    const slugs = displayed.map((s) => s.slug).filter((s) => s !== drag.slug);
    const at = targetSlug === null ? slugs.length : slugs.indexOf(targetSlug);
    slugs.splice(at === -1 ? slugs.length : at, 0, drag.slug);
    setGroupOrder(group, slugs);
    endDrag();
  }, [drag, setGroupOrder, endDrag]);

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
        <LabCredentialsBanner onToast={setToast} />
        <LabEmptyState />
        {toast && <div className="lab-toast">{toast}</div>}
      </div>
    );
  }

  return (
    <div className="lab-board">
      {/* Missing-credentials warning sits above all chrome — insights that need
          an absent key can't sync until the user fills it in (here or the CLI). */}
      <LabCredentialsBanner onToast={setToast} />

      {/* No page title — the sidebar already names the active page. The toolbar
          keeps only the Sync-all action, aligned right. */}
      <div className="lab-board-toolbar">
        <button className="lab-board-sync-all" onClick={handleSyncAll} disabled={syncAll.isPending}>
          {syncAll.isPending ? 'Syncing…' : 'Sync all'}
        </button>
      </div>

      <div className="lab-board-sections">
        {grouped.map(([group, items]) => {
          const collapsed = prefs.collapsed.includes(group);
          return (
            <section key={group} className="lab-board-section">
              <button
                className="lab-board-section-header"
                onClick={() => toggleCollapsed(group)}
                aria-expanded={!collapsed}
              >
                <svg
                  className={`lab-board-section-chevron ${collapsed ? '' : 'lab-board-section-chevron--open'}`}
                  width="10" height="10" viewBox="0 0 10 10" fill="none"
                >
                  <path d="M3 2L7 5L3 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="lab-board-section-title">{group}</span>
                <span className="lab-board-section-count">{items.length}</span>
              </button>
              {!collapsed && (
                <div
                  className="lab-board-grid"
                  // Grid-level drop = append to the end of this group (fires only
                  // in the gaps — cards stop propagation of their own drops).
                  onDragOver={(e) => {
                    if (drag?.group !== group) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(e) => {
                    if (drag?.group !== group) return;
                    e.preventDefault();
                    dropInGroup(group, items, null);
                  }}
                >
                  {items.map((summary) => (
                    <InsightCard
                      key={summary.slug}
                      summary={summary}
                      onToast={setToast}
                      onOpen={openInsight}
                      dragging={drag?.slug === summary.slug}
                      dropTarget={dragOverSlug === summary.slug && drag?.slug !== summary.slug}
                      onDragStart={(e) => {
                        setDrag({ slug: summary.slug, group });
                        try { e.dataTransfer.effectAllowed = 'move'; } catch { /* noop */ }
                      }}
                      onDragOver={(e) => {
                        if (drag?.group !== group) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        setDragOverSlug(summary.slug);
                      }}
                      onDrop={(e) => {
                        if (drag?.group !== group) return;
                        e.preventDefault();
                        e.stopPropagation();
                        dropInGroup(group, items, summary.slug);
                      }}
                      onDragEnd={endDrag}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {openSummary && (
        <InsightDetailPanel
          summary={openSummary}
          onClose={() => setOpenSlug(null)}
          onToast={setToast}
        />
      )}

      {toast && <div className="lab-toast">{toast}</div>}
    </div>
  );
}
