import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLabInsights, useLabSyncJob, useStartLabSyncJob } from '../../hooks/useLab';
import { useLabPrefs } from '../../hooks/useLabPrefs';
import { InsightCard } from './InsightCard';
import { InsightDetailPanel } from './InsightDetailPanel';
import { pushLabPath } from './funnel/labRoute';
import { LabCredentialsBanner } from './LabCredentialsBanner';
import { LabEmptyState } from './LabEmptyState';
import { useFocusTarget, type FocusTarget } from '../../hooks/useFocusTarget';
import './LabBoard.css';

const UNGROUPED = 'Ungrouped';
/** Side-menu bucket for insights with no manifest `category`. */
const OTHER = 'Other';

interface Section<T> {
  /** Prefs key (order/collapse). Categorized: "<category> / <group>";
   *  uncategorized keeps the bare group name so pre-category prefs survive. */
  key: string;
  /** Display name — the bare group. */
  title: string;
  items: T[];
}

interface Block<T> {
  /** Category headline shown in the "All" view; null when the board has no
   *  categories at all (single anonymous block — pre-category layout). */
  category: string | null;
  sections: Section<T>[];
}

/** Apply the persisted manual tab order to the category blocks: listed names
 *  first (in saved order), unlisted ones (new categories) after, in the
 *  default order (alphabetical, "Other" last). */
function applyCatOrder<T>(blocks: Block<T>[], order: string[]): Block<T>[] {
  if (order.length === 0 || blocks.some((b) => b.category === null)) return blocks;
  const pos = new Map(order.map((c, i) => [c, i]));
  return blocks
    .map((block, idx) => ({ block, key: pos.get(block.category!) ?? order.length + idx }))
    .sort((a, b) => a.key - b.key)
    .map((e) => e.block);
}

/** Group one category's insights by manifest `group` (null → "Ungrouped"),
 *  preserving the API's slug-sorted order within each section. */
function groupSections<T extends { group: string | null }>(
  items: T[],
  keyPrefix: string | null,
): Section<T>[] {
  const byGroup = new Map<string, T[]>();
  for (const insight of items) {
    const title = insight.group ?? UNGROUPED;
    const bucket = byGroup.get(title);
    if (bucket) bucket.push(insight);
    else byGroup.set(title, [insight]);
  }
  // Named groups first (alphabetical), Ungrouped last.
  const named = [...byGroup.keys()].filter((k) => k !== UNGROUPED).sort();
  const ordered = byGroup.has(UNGROUPED) ? [...named, UNGROUPED] : named;
  return ordered.map((title) => ({
    key: keyPrefix ? `${keyPrefix} / ${title}` : title,
    title,
    items: byGroup.get(title)!,
  }));
}

/** Partition insights into category blocks (named categories alphabetical,
 *  "Other" last). A board with zero categorized insights returns one anonymous
 *  block — the pre-category layout, no side menu, no headlines. */
function buildBlocks<T extends { category: string | null; group: string | null }>(
  insights: T[],
): Block<T>[] {
  const byCat = new Map<string, T[]>();
  for (const insight of insights) {
    const cat = insight.category ?? OTHER;
    const bucket = byCat.get(cat);
    if (bucket) bucket.push(insight);
    else byCat.set(cat, [insight]);
  }
  const named = [...byCat.keys()].filter((c) => c !== OTHER).sort();
  if (named.length === 0) {
    return [{ category: null, sections: groupSections(insights, null) }];
  }
  const ordered = byCat.has(OTHER) ? [...named, OTHER] : named;
  return ordered.map((cat) => ({
    category: cat,
    // "Other" sections keep bare-group keys so pre-category prefs still apply.
    sections: groupSections(byCat.get(cat)!, cat === OTHER ? null : cat),
  }));
}

/** Apply a persisted manual order to one section's items: listed slugs first
 *  (in saved order), unlisted ones (new insights) after, in API order. */
function applyOrder<T extends { slug: string }>(items: T[], order: string[] | undefined): T[] {
  if (!order || order.length === 0) return items;
  const pos = new Map(order.map((slug, i) => [slug, i]));
  return items
    .map((item, apiIdx) => ({ item, key: pos.get(item.slug) ?? order.length + apiIdx }))
    .sort((a, b) => a.key - b.key)
    .map((e) => e.item);
}

interface LabBoardProps {
  /** Shell navigation focus: opens that insight's detail panel (⌘K recall hit). */
  focus?: FocusTarget;
}

export function LabBoard({ focus }: LabBoardProps = {}) {
  const { data: insights, isLoading, isError, error } = useLabInsights();
  const { data: syncJob } = useLabSyncJob();
  const startSyncAll = useStartLabSyncJob();
  const queryClient = useQueryClient();
  const { prefs, toggleCollapsed, setGroupOrder, setCategory, setCategoryOrder } = useLabPrefs();
  const [toast, setToast] = useState<string | null>(null);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  // Card being dragged (with its section — reordering is within-section only)
  // and the card it currently hovers. Cleared on drop/dragend, never on
  // dragleave (per-item dragleave flickers in WKWebView — see KanbanBoard).
  const [drag, setDrag] = useState<{ slug: string; section: string } | null>(null);
  const [dragOverSlug, setDragOverSlug] = useState<string | null>(null);
  // Category tab being dragged (tab-bar reorder) and the tab it hovers.
  const [tabDrag, setTabDrag] = useState<string | null>(null);
  const [tabDragOver, setTabDragOver] = useState<string | null>(null);

  // Opening an `insight` recall hit from the ⌘K palette lands here — open its
  // detail panel instead of dropping the user on the tile grid.
  useFocusTarget(focus, setOpenSlug);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const blocks = useMemo(() => {
    const built = buildBlocks(insights ?? []).map((block) => ({
      ...block,
      sections: block.sections.map((s) => ({ ...s, items: applyOrder(s.items, prefs.order[s.key]) })),
    }));
    return applyCatOrder(built, prefs.catOrder);
  }, [insights, prefs.order, prefs.catOrder]);

  // The side menu exists only once at least one insight declares a category.
  const hasCategories = blocks.some((b) => b.category !== null);
  // A stale persisted selection (category renamed/emptied) falls back to All.
  const activeCategory = hasCategories && blocks.some((b) => b.category === prefs.category)
    ? prefs.category
    : null;
  const visibleBlocks = activeCategory ? blocks.filter((b) => b.category === activeCategory) : blocks;

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

  const endTabDrag = useCallback(() => {
    setTabDrag(null);
    setTabDragOver(null);
  }, []);

  /** Drop the dragged tab at `target`'s position (or at the end when null). */
  const dropTab = useCallback((target: string | null) => {
    if (!tabDrag || tabDrag === target) { endTabDrag(); return; }
    const cats = blocks.map((b) => b.category!).filter((c) => c !== tabDrag);
    const at = target === null ? cats.length : cats.indexOf(target);
    cats.splice(at === -1 ? cats.length : at, 0, tabDrag);
    setCategoryOrder(cats);
    endTabDrag();
  }, [tabDrag, blocks, setCategoryOrder, endTabDrag]);

  /** Drop the dragged card at `targetSlug`'s position (or at the end when null). */
  const dropInSection = useCallback((section: string, displayed: { slug: string }[], targetSlug: string | null) => {
    if (!drag || drag.section !== section) { endDrag(); return; }
    const slugs = displayed.map((s) => s.slug).filter((s) => s !== drag.slug);
    const at = targetSlug === null ? slugs.length : slugs.indexOf(targetSlug);
    slugs.splice(at === -1 ? slugs.length : at, 0, drag.slug);
    setGroupOrder(section, slugs);
    endDrag();
  }, [drag, setGroupOrder, endDrag]);

  const syncRunning = syncJob?.status === 'running';

  const handleSyncAll = () => {
    if (syncRunning) return;
    startSyncAll.mutate(true, {
      onError: (err) => setToast(`Sync all failed to start: ${(err as Error).message}`),
    });
  };

  // Tiles light up AS the run progresses, not all at once at the end: every time
  // the job's settled count moves, refetch the summaries. The old all-or-nothing
  // invalidate meant a five-minute sync showed nothing until it finished — and
  // showed nothing at all when the request died on the way.
  // Keyed on the COUNT, not the polled job object — the poll hands back a fresh
  // object every 800ms and depending on it would refetch the whole board on
  // every tick, sync or no sync.
  const syncDone = syncJob?.done ?? 0;
  const syncJobId = syncJob?.id ?? null;
  useEffect(() => {
    if (!syncJobId || syncDone === 0) return;
    queryClient.invalidateQueries({ queryKey: ['lab'] });
  }, [syncDone, syncJobId, queryClient]);

  // Report the outcome once per job, and only for a job this page actually
  // watched run — re-adopting an hour-old settled job must not re-toast it.
  const watchedJob = useRef<string | null>(null);
  const reportedJob = useRef<string | null>(null);
  useEffect(() => {
    if (!syncJob) return;
    if (syncJob.status === 'running') {
      watchedJob.current = syncJob.id;
      return;
    }
    if (watchedJob.current !== syncJob.id || reportedJob.current === syncJob.id) return;
    reportedJob.current = syncJob.id;
    queryClient.invalidateQueries({ queryKey: ['lab'] });
    if (syncJob.status === 'error') {
      setToast(`Sync all failed: ${syncJob.error ?? 'unknown error'}`);
    } else if (syncJob.failed.length > 0) {
      setToast(`⚠ ${syncJob.failed.length} of ${syncJob.results.length} insight(s) failed: ${syncJob.failed.join(', ')}`);
    } else {
      setToast(`Synced ${syncJob.results.length} insight(s).`);
    }
  }, [syncJob, queryClient]);

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
          holds the category tab bar (left, only when categories exist) and the
          Sync-all action (right). Tabs drag-reorder; the order persists. */}
      <div className="lab-board-toolbar">
        {hasCategories && (
          <nav
            className="lab-cat-tabs"
            aria-label="Insight categories"
            // Bar-level drop = move the dragged tab to the end (fires only in
            // the gaps — tabs stop propagation of their own drops).
            onDragOver={(e) => {
              if (!tabDrag) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
              if (!tabDrag) return;
              e.preventDefault();
              dropTab(null);
            }}
          >
            <button
              className={`lab-cat-tab ${activeCategory === null ? 'lab-cat-tab--active' : ''}`}
              onClick={() => setCategory(null)}
            >
              All
              <span className="lab-cat-tab-count">{insights.length}</span>
            </button>
            {blocks.map((b) => (
              <button
                key={b.category!}
                draggable
                className={[
                  'lab-cat-tab',
                  activeCategory === b.category ? 'lab-cat-tab--active' : '',
                  tabDrag === b.category ? 'lab-cat-tab--dragging' : '',
                  tabDragOver === b.category && tabDrag !== b.category ? 'lab-cat-tab--drop' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => setCategory(b.category)}
                onDragStart={(e) => {
                  setTabDrag(b.category!);
                  try { e.dataTransfer.effectAllowed = 'move'; } catch { /* noop */ }
                }}
                onDragOver={(e) => {
                  if (!tabDrag) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setTabDragOver(b.category);
                }}
                onDrop={(e) => {
                  if (!tabDrag) return;
                  e.preventDefault();
                  e.stopPropagation();
                  dropTab(b.category);
                }}
                onDragEnd={endTabDrag}
              >
                {b.category}
                <span className="lab-cat-tab-count">
                  {b.sections.reduce((n, s) => n + s.items.length, 0)}
                </span>
              </button>
            ))}
          </nav>
        )}
        {/* One button, three states. While the server-owned job runs it becomes a
            determinate chip (n/total + a mini bar) — the run outlives this page,
            so leaving and coming back re-adopts the same live progress. */}
        <button
          className={`lab-board-sync-all ${syncRunning ? 'lab-board-sync-all--running' : ''}`}
          onClick={handleSyncAll}
          disabled={syncRunning || startSyncAll.isPending}
          title={syncRunning ? 'A bulk sync is already running — it keeps going if you navigate away.' : 'Refetch every insight'}
        >
          {syncRunning ? (
            <>
              <span className="lab-sync-progress-text">
                Syncing {syncJob!.done}/{syncJob!.total || '…'}
                {syncJob!.attempt > 1 ? ` · retry ${syncJob!.attempt}` : ''}
              </span>
              <span className="lab-sync-progress-track" aria-hidden="true">
                <span
                  className="lab-sync-progress-fill"
                  style={{ width: `${syncJob!.total > 0 ? Math.round((syncJob!.done / syncJob!.total) * 100) : 0}%` }}
                />
              </span>
            </>
          ) : startSyncAll.isPending ? 'Starting…' : 'Sync all'}
        </button>
      </div>

      <div className="lab-board-sections">
          {visibleBlocks.map((block) => (
            <div key={block.category ?? '(all)'} className="lab-board-block">
              {/* Category headline only in the "All" view — in a filtered view
                  the side menu already names it. */}
              {block.category !== null && activeCategory === null && (
                <button
                  className="lab-board-cat-header"
                  onClick={() => setCategory(block.category)}
                  title={`Show only ${block.category}`}
                >
                  {block.category}
                </button>
              )}
              {block.sections.map(({ key, title, items }) => {
                const collapsed = prefs.collapsed.includes(key);
                return (
                  <section key={key} className="lab-board-section">
                    <button
                      className="lab-board-section-header"
                      onClick={() => toggleCollapsed(key)}
                      aria-expanded={!collapsed}
                    >
                      <svg
                        className={`lab-board-section-chevron ${collapsed ? '' : 'lab-board-section-chevron--open'}`}
                        width="10" height="10" viewBox="0 0 10 10" fill="none"
                      >
                        <path d="M3 2L7 5L3 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="lab-board-section-title">{title}</span>
                      <span className="lab-board-section-count">{items.length}</span>
                    </button>
                    {!collapsed && (
                      <div
                        className="lab-board-grid"
                        // Grid-level drop = append to the end of this section (fires only
                        // in the gaps — cards stop propagation of their own drops).
                        onDragOver={(e) => {
                          if (drag?.section !== key) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                        }}
                        onDrop={(e) => {
                          if (drag?.section !== key) return;
                          e.preventDefault();
                          dropInSection(key, items, null);
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
                              setDrag({ slug: summary.slug, section: key });
                              try { e.dataTransfer.effectAllowed = 'move'; } catch { /* noop */ }
                            }}
                            onDragOver={(e) => {
                              if (drag?.section !== key) return;
                              e.preventDefault();
                              e.dataTransfer.dropEffect = 'move';
                              setDragOverSlug(summary.slug);
                            }}
                            onDrop={(e) => {
                              if (drag?.section !== key) return;
                              e.preventDefault();
                              e.stopPropagation();
                              dropInSection(key, items, summary.slug);
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
          ))}
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
