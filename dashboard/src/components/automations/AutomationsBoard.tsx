import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAutomations, useAutomationRunJob } from '../../hooks/useAutomations';
import { usePersistedState } from '../../hooks/usePersistedState';
import { AutomationCard } from './AutomationCard';
import { AutomationDetailPanel } from './AutomationDetailPanel';
import { AutomationsEmptyState } from './AutomationsEmptyState';
import './AutomationsBoard.css';

/** Apply a persisted manual order: listed slugs first (in saved order),
 *  unlisted ones (new automations) after, in API order. Mirrors Lab's
 *  `applyOrder` — automations have no category/group fields, so there is only
 *  one flat section here, not Lab's per-group sectioning. */
function applyOrder<T extends { slug: string }>(items: T[], order: string[]): T[] {
  if (order.length === 0) return items;
  const pos = new Map(order.map((slug, i) => [slug, i]));
  return items
    .map((item, apiIdx) => ({ item, key: pos.get(item.slug) ?? order.length + apiIdx }))
    .sort((a, b) => a.key - b.key)
    .map((e) => e.item);
}

export function AutomationsBoard() {
  const { data: automations, isLoading, isError, error } = useAutomations();
  const { data: runJob } = useAutomationRunJob();
  const [order, setOrder] = usePersistedState<string[]>('automations:order:v1', []);
  const [toast, setToast] = useState<string | null>(null);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [dragOverSlug, setDragOverSlug] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const ordered = useMemo(() => applyOrder(automations ?? [], order), [automations, order]);
  // Re-derive from the live list so the panel header (approval, cache state)
  // refreshes after a run/approve instead of showing a stale snapshot.
  const openSummary = openSlug ? (automations ?? []).find((s) => s.slug === openSlug) ?? null : null;
  // The server allows exactly ONE run-now job per project (any slug) — every
  // card's "Run now" button needs to know if a DIFFERENT one is mid-run.
  const runningSlug = runJob?.status === 'running' ? runJob.slug : null;

  const endDrag = useCallback(() => {
    setDrag(null);
    setDragOverSlug(null);
  }, []);

  const dropAt = useCallback((targetSlug: string | null) => {
    if (!drag) { endDrag(); return; }
    const slugs = ordered.map((s) => s.slug).filter((s) => s !== drag);
    const at = targetSlug === null ? slugs.length : slugs.indexOf(targetSlug);
    slugs.splice(at === -1 ? slugs.length : at, 0, drag);
    setOrder(slugs);
    endDrag();
  }, [drag, ordered, setOrder, endDrag]);

  if (isLoading) {
    return (
      <div className="auto-board">
        <div className="auto-board-loading">Loading automations…</div>
      </div>
    );
  }

  // A fetch failure is an outage, not onboarding — never show the "no
  // automations yet" explainer over an error (mirrors LabBoard's isError branch).
  if (isError) {
    return (
      <div className="auto-board">
        <div className="auto-board-error">Failed to load automations. {(error as Error)?.message}</div>
      </div>
    );
  }

  if (!automations || automations.length === 0) {
    return (
      <div className="auto-board auto-board--empty">
        <AutomationsEmptyState />
      </div>
    );
  }

  return (
    <div className="auto-board">
      <div
        className="auto-board-grid"
        onDragOver={(e) => {
          if (!drag) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          if (!drag) return;
          e.preventDefault();
          dropAt(null);
        }}
      >
        {ordered.map((summary) => (
          <AutomationCard
            key={summary.slug}
            summary={summary}
            runningSlug={runningSlug}
            onToast={setToast}
            onOpen={setOpenSlug}
            dragging={drag === summary.slug}
            dropTarget={dragOverSlug === summary.slug && drag !== summary.slug}
            onDragStart={(e) => {
              setDrag(summary.slug);
              try { e.dataTransfer.effectAllowed = 'move'; } catch { /* noop */ }
            }}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDragOverSlug(summary.slug);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              dropAt(summary.slug);
            }}
            onDragEnd={endDrag}
          />
        ))}
      </div>

      {openSummary && (
        <AutomationDetailPanel
          // Keyed by slug so the panel's own state (which run's session is
          // open) can never carry over from one automation to another.
          key={openSummary.slug}
          summary={openSummary}
          runningSlug={runningSlug}
          onClose={() => setOpenSlug(null)}
          onToast={setToast}
        />
      )}

      {toast && <div className="auto-toast">{toast}</div>}
    </div>
  );
}
