import { useVault } from '../../../context/VaultContext';
import { isDesktop, openChecklistWindow } from '../../../lib/desktop';
import { writeEnvelope } from '../../../lib/checklistStore';
import type { ChatViewSpec, ChecklistViewSpec } from '../../../lib/chatViewSpec';
import type { ChatBlock } from './chatActions';
import { HtmlView } from './HtmlView';
import { InsightView } from './InsightView';
import './ChatViews.css';

/**
 * The block host — the seam between what `parseChatActions` extracted from an answer
 * (`blocks`/`notices`/`pendingView`, see `chatActions.ts`) and the actual rich objects.
 *
 * `blocks` is rendered in WRITTEN order and mixes two kinds: the agent's own HTML
 * (`dream-html`, the surface's main expressive channel since 2026-08-26) and the typed
 * `dream-view` payloads that survived the retirement of `chart`/`page` — the three things
 * HTML cannot be (a tracked metric's canonical rendering, an OS window, a shelf row).
 *
 * Per the degradation contract: the prose this sits below ALWAYS survives — `notices` are
 * additive, never a replacement for it — and nothing here ever throws, since every block
 * arrived pre-validated from `lib/chatViewSpec.ts` (views) or capped by byte size (html).
 */
export function ChatViews({
  blocks, notices, pendingView, conversationId,
}: {
  blocks: ChatBlock[];
  notices: string[];
  pendingView: boolean;
  conversationId: string;
}) {
  if (blocks.length === 0 && notices.length === 0 && !pendingView) return null;

  return (
    <div className="chat-views">
      {blocks.map((block, i) => (
        block.kind === 'html'
          ? <HtmlView key={i} html={block.html} />
          : <ChatViewItem key={i} view={block.view} conversationId={conversationId} />
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

function ChatViewItem({ view, conversationId }: {
  view: ChatViewSpec;
  conversationId: string;
}) {
  switch (view.type) {
    case 'insight':
      return <InsightView spec={view} />;
    case 'checklist':
      return <ChecklistCard spec={view} conversationId={conversationId} />;
    // Hoisted OUT of the transcript: a pin and a progress row live on the shelf docked to
    // the composer, which is the whole point of them — drawn here as well, they would scroll
    // away exactly like the inline card they exist to replace. `PinShelf` collects them.
    // Their `notices` still render above, so a degraded block stays visible either way.
    case 'pin':
    case 'progress':
      return null;
  }
}

/** A still-open `dream-view` or `dream-html` fence hasn't closed yet — either can run
 *  10-20KB and take seconds to stream, so this stands in for it rather than showing
 *  nothing. Same dots-and-pill shape as `WorkingIndicator`'s `.chat-working`
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
 * the envelope this writes. The vault comes from THIS subtree's `useVault()` (never a module
 * global — several projects are live in one window) and is `string | null`: off-desktop, or
 * with no vault pinned (shouldn't happen for a mounted Chat view, but never assumed), the
 * button is disabled rather than falling back to an invented vault, which would risk
 * writing into the wrong project's checklist (the exact defect this design fixed).
 */
function ChecklistCard({ spec, conversationId }: { spec: ChecklistViewSpec; conversationId: string }) {
  const desktop = isDesktop();
  const { vault: activeVault } = useVault();
  const vault = desktop ? activeVault : null;
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
