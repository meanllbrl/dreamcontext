import { useVault } from '../../../context/VaultContext';
import { isDesktop, openChecklistWindow } from '../../../lib/desktop';
import { writeEnvelope } from '../../../lib/checklistStore';
import type { ChatViewSpec, ChecklistViewSpec } from '../../../lib/chatViewSpec';
import type { ChatSegment } from './chatActions';
import { HtmlView, HtmlPending } from './HtmlView';
import { InsightView } from './InsightView';
import './ChatViews.css';

/**
 * ONE non-prose segment of an answer — the seam between what `parseChatActions` extracted
 * (see `ChatSegment` in `chatActions.ts`) and the actual rich objects.
 *
 * A SEGMENT, not a list, and that is the change of 2026-08-27. This used to be `ChatViews`:
 * a host that rendered every block of a message together, below the message's whole prose.
 * That shape could not put a card between two paragraphs, so the sentence written under a
 * card rendered above it and the card read as an attachment. `TranscriptItem` now walks the
 * segments itself and calls this once per block, in written order.
 *
 * Three kinds reach here: the agent's own HTML (`dream-html`, the surface's main expressive
 * channel since 2026-08-26), the typed `dream-view` payloads that survived the retirement of
 * `chart`/`page` (a tracked metric's canonical rendering, an OS window, a shelf row), and a
 * fence that hasn't closed yet — which now holds its own slot instead of trailing the
 * message as a pill.
 *
 * Nothing here throws: every block arrived pre-validated from `lib/chatViewSpec.ts` (views)
 * or capped by byte size (html).
 */
export function ChatBlockSegment({ segment, conversationId }: {
  segment: Exclude<ChatSegment, { kind: 'prose' }>;
  /**
   * OPTIONAL because two of the three segment kinds have no use for it: `html` is a sandboxed
   * render and `pending` is a skeleton. Only a `view` needs a conversation — a checklist's
   * Submit has to land somewhere — and a host that has none does not reach this component with
   * one (`TranscriptItem` renders a notice in its place instead). So the absent case is
   * unreachable here rather than handled, and this stays a type-level statement of which
   * blocks cost the host anything.
   */
  conversationId?: string;
}) {
  switch (segment.kind) {
    case 'html':
      return <HtmlView html={segment.html} />;
    case 'view':
      return conversationId
        ? <ChatViewItem view={segment.view} conversationId={conversationId} />
        : null;
    // A `dream-html` gets the block-sized slot it is about to fill; a `dream-view` keeps the
    // pill, because what IT resolves into is a small card and a card-sized skeleton would
    // promise more than arrives. Proportion, not inconsistency.
    case 'pending':
      return segment.fence === 'html'
        ? <HtmlPending partial={segment.partial} />
        : <PendingViewPill />;
  }
}

/**
 * The degradation strip — a dropped widget, an unknown view type, a block over its byte
 * cap. Per the degradation contract these are ADDITIVE: the prose always survives, and a
 * block that vanished silently would be the one failure this surface must never have.
 * Rendered once per message, after every segment, because a notice is about the answer
 * rather than about a position in it.
 */
export function ChatViewNotices({ notices }: { notices: string[] }) {
  if (notices.length === 0) return null;
  return (
    <ul className="chat-view-notice">
      {notices.map((n, i) => <li key={i}>{n}</li>)}
    </ul>
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

/** A still-open `dream-view` fence — its JSON payload has nothing legible to show
 *  mid-stream, so this stands in for it rather than showing nothing. (A `dream-html` gets
 *  `HtmlPending` instead, which can read the titles already written into its markup.) Same
 *  dots-and-pill shape as `WorkingIndicator`'s `.chat-working` (`overlays.css`), duplicated
 *  locally so this file has no cross-file class dependency. */
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
