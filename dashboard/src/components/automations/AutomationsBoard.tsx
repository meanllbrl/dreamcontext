import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAutomations, useAutomationRunJob } from '../../hooks/useAutomations';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useVault } from '../../context/VaultContext';
import { openAutomationCreateChat } from '../../lib/automationCreateChat';
import { AutomationCard } from './AutomationCard';
import { AutomationDetailPanel } from './AutomationDetailPanel';
import { AutomationsDispatcherBar } from './AutomationsDispatcherBar';
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
  const { vault, bus } = useVault();
  const [order, setOrder] = usePersistedState<string[]>('automations:order:v1', []);
  const [toast, setToast] = useState<string | null>(null);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  // D5: a card's own "open chat" button skips straight to that automation's
  // latest run instead of landing on the history list first — see
  // `AutomationDetailPanel`'s `autoOpenLatestRun` prop. Reset alongside
  // `openSlug` on close so the NEXT open (a plain card click) never inherits a
  // stale "jump straight to the run" intent from a previous one.
  const [openIntent, setOpenIntent] = useState<'detail' | 'run'>('detail');
  const [drag, setDrag] = useState<string | null>(null);
  const [dragOverSlug, setDragOverSlug] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const ordered = useMemo(() => applyOrder(automations ?? [], order), [automations, order]);
  // Re-derive from the live list so the panel header (approval, cache state)
  // refreshes after a run/approve instead of showing a stale snapshot.
  const openSummary = openSlug ? (automations ?? []).find((s) => s.slug === openSlug) ?? null : null;
  // Automations that have NEVER been approved on this machine — nothing will
  // run for them until a human reviews and approves. `approved` and
  // `approvalReason` are both live-computed server-side (`checkApproval`), so
  // this list is never stale the way a cached run status would be.
  const neverApproved = useMemo(
    () => (automations ?? []).filter((s) => !s.approved && s.approvalReason === 'never-approved'),
    [automations],
  );
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

  const handleOpenDetail = useCallback((slug: string) => {
    setOpenIntent('detail');
    setOpenSlug(slug);
  }, []);

  const handleOpenRun = useCallback((slug: string) => {
    setOpenIntent('run');
    setOpenSlug(slug);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setOpenSlug(null);
    setOpenIntent('detail');
  }, []);

  /**
   * D3: "New automation" opens a chat session whose agent interviews the user then writes
   * the manifest. `creatingChat` only guards against a double-click firing two sessions in
   * the gap before the surface's ACK returns — it is not a loading state for the chat itself
   * (that lives in the opened tab, not here).
   */
  const handleCreateAutomation = () => {
    if (creatingChat) return;
    setCreatingChat(true);
    void openAutomationCreateChat(bus, vault)
      .then((accepted) => {
        if (!accepted) {
          setToast('Could not open a new automation chat — this needs the desktop app with the claude CLI, and Agents enabled in Settings.');
        }
      })
      .catch((err) => setToast(`Could not open a new automation chat — ${(err as Error).message}`))
      .finally(() => setCreatingChat(false));
  };

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

  // The zero-state carries the scheduler switch too: "there is nothing here
  // yet" and "nothing would fire if there were" are two different problems, and
  // a user who only ever creates automations from the CLI would otherwise never
  // meet the switch at all.
  if (!automations || automations.length === 0) {
    return (
      <div className="auto-board auto-board--empty">
        <AutomationsEmptyState onToast={setToast} />
        {toast && <div className="auto-toast">{toast}</div>}
      </div>
    );
  }

  return (
    <div className="auto-board">
      <div className="auto-board-toolbar">
        <AutomationsDispatcherBar onToast={setToast} />
        {/* D3: the one place on the (non-empty) board a human reaches for a fresh
            automation — the CLI scaffold command still works and stays documented
            on the empty state, this is the chat-authored path. */}
        <button
          type="button"
          className="auto-board-new-btn"
          onClick={handleCreateAutomation}
          disabled={creatingChat}
        >
          + New automation
        </button>
      </div>
      {/* Above the grid, under the scheduler switch: the switch says whether
          automations CAN run at all, this says which ones have never been
          reviewed on this machine, so nothing has run for them yet. Renders
          nothing when every automation has been approved at least once. */}
      {neverApproved.length > 0 && (
        <div className="auto-never-approved">
          <span className="auto-never-approved-label">Never approved on this machine:</span>
          {neverApproved.map((s) => (
            <button
              key={s.slug}
              type="button"
              className="auto-badge auto-badge--blocked auto-never-approved-chip"
              onClick={() => handleOpenDetail(s.slug)}
              title={`Review and approve ${s.title}`}
            >
              {s.title}
            </button>
          ))}
        </div>
      )}

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
            onOpen={handleOpenDetail}
            onOpenRun={handleOpenRun}
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
          autoOpenLatestRun={openIntent === 'run'}
          onClose={handleCloseDetail}
          onToast={setToast}
        />
      )}

      {toast && <div className="auto-toast">{toast}</div>}
    </div>
  );
}
