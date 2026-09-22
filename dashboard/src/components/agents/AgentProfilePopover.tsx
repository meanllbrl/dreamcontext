import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { AutomationSummary } from '../../hooks/useAutomations';
import { useSetAutomationEnabled } from '../../hooks/useAutomations';
import { AgentAvatar } from './AgentAvatar';
import './AgentProfilePopover.css';

/**
 * The description, as the DOCUMENT it actually is.
 *
 * The card shows prose (`markdownToText`) because two clamped lines have no
 * room for a blockquote rule and a bold run. The popover is where an agent's
 * prompt gets to be what it is — headings, lists, emphasis — so this is the
 * surface that renders the markdown the owner correctly pointed out was being
 * dumped raw. Sanitized before it reaches the document, same discipline as
 * `MarkdownPreview`; that component is not reused here because it carries
 * mermaid, code highlighting and table decoration, none of which belong in a
 * 300px popover.
 */
function useDescriptionHtml(md: string): string {
  return useMemo(
    () => (md.trim() ? DOMPurify.sanitize(marked.parse(md, { async: false, gfm: true, breaks: true }) as string) : ''),
    [md],
  );
}

/** Popover width, in px — also the number the clamp below uses to keep the
 *  card on screen when the anchor sits near the right edge. */
const POPOVER_WIDTH = 340;

/**
 * The agent's profile card, opened from its name or its photo.
 *
 * The answer to "who is this, and what can I do with it right now" —
 * deliberately NOT a second detail panel: run history, the approval review and
 * the pending question all still live in `AutomationDetailPanel`, which the
 * card's own "Runs & review" button opens.
 *
 * Pause/Resume is offered ONLY for a scheduled agent, for the same reason the
 * card's switch is: an on-call agent is never fired by the dispatcher, so
 * pausing one would promise to stop something that was never running.
 *
 * There is no "Run now" here. An agent is called by mentioning it in its
 * thread (owner, 2026-09-20) — until that lands in step 4, a manual run is
 * `dreamcontext automations run <slug>` from the terminal.
 */
export function AgentProfilePopover({
  summary,
  anchor,
  onClose,
  onEdit,
  onToast,
}: {
  summary: AutomationSummary;
  /** Bounding box of whatever was clicked. The popover sits under it, clamped
   *  into the viewport so an agent near the right edge is still fully readable. */
  anchor: DOMRect;
  onClose: () => void;
  onEdit: (slug: string) => void;
  onToast: (msg: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const descriptionHtml = useDescriptionHtml(summary.description);
  const setEnabled = useSetAutomationEnabled();
  const scheduled = summary.mode === 'sched';

  // Dismiss on an outside click or Escape. Registered on the NEXT tick via
  // `mousedown` rather than `click`, so the very click that opened this
  // popover cannot also close it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - POPOVER_WIDTH - 8));
  const top = anchor.bottom + 8;

  const togglePause = () => {
    const next = !summary.enabled;
    setEnabled.mutate({ slug: summary.slug, enabled: next }, {
      onSuccess: () => { onToast(`${summary.title}: ${next ? 'resumed' : 'paused'}.`); onClose(); },
      onError: (err) => onToast(`${summary.title}: could not ${next ? 'resume' : 'pause'} — ${(err as Error).message}`),
    });
  };

  const cadence = summary.mode === 'call'
    ? 'Runs when you call it'
    : summary.enabled ? `Runs ${summary.cadenceLabel.toLowerCase()}` : `Paused · ${summary.cadenceLabel.toLowerCase()}`;

  return (
    <div className="agent-pop" ref={ref} style={{ left, top, width: POPOVER_WIDTH }} role="dialog" aria-label={`${summary.title} profile`}>
      <div className="agent-pop-head">
        <AgentAvatar
          slug={summary.slug}
          title={summary.title}
          hasPhoto={summary.hasPhoto}
          size={44}
          version={summary.cache?.lastRunAt ?? undefined}
        />
        <div className="agent-pop-id">
          <b>{summary.title}</b>
          <small>{cadence} · {summary.model ?? 'default model'}, {summary.effort ?? 'default'} effort</small>
        </div>
      </div>

      {descriptionHtml
        ? <div className="agent-pop-desc" dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
        : <p className="agent-pop-desc agent-pop-desc--empty">No description yet.</p>}

      <div className="agent-pop-actions">
        {/* "Run now" USED to lead this row and is deliberately gone (owner,
            2026-09-20): an agent is called by mentioning it in its thread, so a
            button that starts the same run from a profile card is a second,
            differently-worded way to say the same thing. */}
        <button type="button" className="agent-btn" onClick={() => { onEdit(summary.slug); onClose(); }}>Edit</button>
        {scheduled && (
          <button type="button" className="agent-btn" onClick={togglePause} disabled={setEnabled.isPending}>
            {summary.enabled ? 'Pause' : 'Resume'}
          </button>
        )}
      </div>
    </div>
  );
}
