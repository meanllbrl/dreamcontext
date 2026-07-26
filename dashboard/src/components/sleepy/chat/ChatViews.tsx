import { getActiveVault } from '../../../api/client';
import { isDesktop, openChecklistWindow } from '../../../lib/desktop';
import { writeEnvelope } from '../../../lib/checklistStore';
import type { ChatViewSpec, ChecklistViewSpec } from '../../../lib/chatViewSpec';
import type { ChatAction } from './chatActions';
import { ChartView } from './ChartView';
import { PageView } from './PageView';
import './ChatViews.css';

/**
 * The view host — the seam between what `parseChatActions` extracted from an answer
 * (`views`/`notices`/`pendingView`, see `chatActions.ts`) and the actual rich objects: a
 * `switch (view.type)` onto `ChartView` (chart), `PageView` (page) or `ChecklistCard`
 * (checklist, defined here), plus the degradation strip and the streaming placeholder.
 *
 * Per the plan's degradation contract (§1.3): the prose this sits below ALWAYS survives —
 * `notices` are additive, never a replacement for it — and nothing here ever throws, since
 * `views`/`notices` already arrived pre-validated from `lib/chatViewSpec.ts`.
 */
export function ChatViews({
  views, notices, pendingView, conversationId, onAction, onOpenFile,
}: {
  views: ChatViewSpec[];
  notices: string[];
  pendingView: boolean;
  conversationId: string;
  onAction: (a: ChatAction) => void;
  onOpenFile?: (path: string) => void;
}) {
  if (views.length === 0 && notices.length === 0 && !pendingView) return null;

  return (
    <div className="chat-views">
      {views.map((view, i) => (
        <ChatViewItem
          key={i}
          view={view}
          conversationId={conversationId}
          onAction={onAction}
          onOpenFile={onOpenFile}
        />
      ))}
      {pendingView && <PendingViewPill />}
      {notices.length > 0 && (
        <ul className="chat-view-notice">
          {notices.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}

function ChatViewItem({
  view, conversationId, onAction, onOpenFile,
}: {
  view: ChatViewSpec;
  conversationId: string;
  onAction: (a: ChatAction) => void;
  onOpenFile?: (path: string) => void;
}) {
  switch (view.type) {
    case 'chart':
      return <ChartView spec={view} onAction={onAction} />;
    case 'page':
      return <PageView spec={view} onAction={onAction} onOpenFile={onOpenFile} />;
    case 'checklist':
      return <ChecklistCard spec={view} conversationId={conversationId} />;
  }
}

/** A still-open `dream-view` fence hasn't closed yet — a large `page` payload can run
 *  10-20KB and take seconds to stream, so this stands in for it rather than showing
 *  nothing (plan §1.1). Same dots-and-pill shape as `WorkingIndicator`'s `.chat-working`
 *  (`overlays.css`), duplicated locally so this file has no cross-file class dependency. */
function PendingViewPill() {
  return (
    <div className="chat-view-pending" role="status" aria-live="polite">
      <span className="chat-view-pending-dots" aria-hidden>
        <span /><span /><span />
      </span>
      <span>Building a view…</span>
    </div>
  );
}

/**
 * The `type:'checklist'` card — title, item count, and the "Open pinned checklist ⇱"
 * button that hands the spec to the pinned OS window (plan §1.9-§1.10).
 *
 * `writeEnvelope` is the single authority for `conversationId` (§1.10): the checklist
 * window's URL carries only `checklist`+`vault`, and reads `conversationId` back out of
 * the envelope this writes. `getActiveVault()` returns `string | null` — off-desktop, or
 * with no vault pinned (shouldn't happen for a mounted Chat view, but never assumed), the
 * button is disabled rather than falling back to an invented vault, which would risk
 * writing into the wrong project's checklist (the exact defect this design fixed).
 */
function ChecklistCard({ spec, conversationId }: { spec: ChecklistViewSpec; conversationId: string }) {
  const desktop = isDesktop();
  const vault = desktop ? getActiveVault() : null;
  const itemCount = spec.items.length;

  const handleOpen = () => {
    if (!vault) return;
    writeEnvelope({ spec, vault, conversationId, createdAt: Date.now() });
    void openChecklistWindow(spec.id, vault);
  };

  const note = !desktop
    ? 'This checklist needs the desktop app.'
    : !vault
      ? 'No project is open — open one to use this checklist.'
      : null;

  return (
    <div className="chat-viewcard chat-checklistcard">
      <div className="chat-checklistcard-head">
        <span className="chat-checklistcard-glyph" aria-hidden>☑</span>
        <div className="chat-checklistcard-titlewrap">
          <span className="chat-checklistcard-title">{spec.title}</span>
          <span className="chat-checklistcard-count">{itemCount} item{itemCount === 1 ? '' : 's'}</span>
        </div>
      </div>
      <button
        type="button"
        className="chat-checklistcard-open"
        onClick={handleOpen}
        disabled={!vault}
      >
        Open pinned checklist <span aria-hidden>⇱</span>
      </button>
      {note && <p className="chat-checklistcard-note">{note}</p>}
    </div>
  );
}
