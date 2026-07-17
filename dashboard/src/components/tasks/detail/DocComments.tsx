import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { SessionStatusKind } from '../../sleepy/agentStatus';
import {
  TASK_MANAGER_STATUS_EVENT, sendToTaskManager, type TaskManagerStatusDetail,
} from '../../../lib/taskManagerAgent';
import './DocComments.css';

/**
 * Anchored comments on the rendered task document — the M2 leg of the curate design
 * (select a span → comment on it → the Task Manager applies the batch).
 *
 * Anchoring is BY QUOTE, not by offset: the agent rewrites the file live, so any anchor
 * pinned to a byte/line position breaks the moment the doc changes under it (a recorded
 * constraint of the curate task). Each comment carries the exact selected text, and the
 * composed message tells the agent each "Re:" quotes the doc text it targets — the same
 * way a human quotes a line in a PR review.
 *
 * Comments are EPHEMERAL until sent (also a recorded decision): the agent's resulting
 * edits and the task changelog ARE the record, so nothing persists in the doc itself.
 *
 * Delivery rides the Task Manager session — this component owns no session. With the pane
 * already open, Send types the batch straight into the live terminal (bracketed paste, so
 * the multiline message survives the readline). With the pane closed, Send opens it and
 * waits for the session's first ready/asking status before flushing — a fresh session's
 * boot would silently drop bytes typed before the readline exists. On a brand-new session
 * the batch becomes the FIRST user message, so the deferred pin context (deferPrompt)
 * arrives with it: one message, fully pinned, nothing spoken before the user.
 */

interface PendingComment {
  id: string;
  /** The selected doc text this comment targets (the anchor). */
  quote: string;
  text: string;
}

/** Cap a quote to something a readline message can carry without drowning the comment. */
const QUOTE_MAX = 220;

function clampQuote(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > QUOTE_MAX ? `${flat.slice(0, QUOTE_MAX - 1)}…` : flat;
}

/** Compose the batch as ONE message; wrapped in bracketed paste by the caller. */
function composeBatch(comments: PendingComment[]): string {
  const lines = comments.map((c, i) => `${i + 1}. Re: "${c.quote}" — ${c.text}`);
  return [
    `Apply ${comments.length === 1 ? 'this comment' : `these ${comments.length} comments`} to the task document. Each "Re:" quotes the exact document text it targets:`,
    ...lines,
  ].join('\n');
}

export function DocComments({ slug, docRef, tmOpen, onOpenTaskManager }: {
  slug: string;
  /** The rendered markdown body — selections outside it are ignored. */
  docRef: RefObject<HTMLDivElement | null>;
  tmOpen: boolean;
  onOpenTaskManager: () => void;
}) {
  const [comments, setComments] = useState<PendingComment[]>([]);
  // The floating affordance: where the current selection ended, and what it holds.
  const [anchor, setAnchor] = useState<{ quote: string; x: number; y: number } | null>(null);
  // Non-null while the comment input popover is open (holds the quote being commented).
  const [draft, setDraft] = useState<{ quote: string; x: number; y: number } | null>(null);
  const [draftText, setDraftText] = useState('');
  const [waiting, setWaiting] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);

  // The session's last reported status (the surface broadcasts it; we only listen).
  const lastStatus = useRef<SessionStatusKind | null>(null);
  const waitingRef = useRef(false);
  waitingRef.current = waiting;
  const commentsRef = useRef<PendingComment[]>([]);
  commentsRef.current = comments;

  const deliver = useCallback(() => {
    const batch = commentsRef.current;
    if (!batch.length) return;
    // Bracketed paste keeps the multiline batch as ONE readline entry (a bare \n would
    // submit a half message); the trailing submit \r comes from sendToTaskManager.
    sendToTaskManager({ slug, text: `\x1b[200~${composeBatch(batch)}\x1b[201~` });
    setComments([]);
    setWaiting(false);
  }, [slug]);

  // Status watcher: flush a held batch the moment a freshly-opened session becomes ready
  // (or immediately asks something — its readline is live either way).
  useEffect(() => {
    const onStatus = (e: Event) => {
      const d = (e as CustomEvent<TaskManagerStatusDetail>).detail;
      if (d?.slug !== slug) return;
      lastStatus.current = d.kind;
      if (waitingRef.current && (d.kind === 'ready' || d.kind === 'asking')) deliver();
    };
    window.addEventListener(TASK_MANAGER_STATUS_EVENT, onStatus);
    return () => window.removeEventListener(TASK_MANAGER_STATUS_EVENT, onStatus);
  }, [slug, deliver]);

  const send = useCallback(() => {
    if (!commentsRef.current.length) return;
    // A live, already-BOOTED session takes the batch NOW — ready/asking obviously, and
    // 'working' too: text typed mid-turn queues as steering (Claude Code's own behavior).
    // 'starting' must wait (boot drops bytes typed before the readline exists), and a
    // closed pane has no status at all — open it and hold for the first ready signal.
    const k = lastStatus.current;
    if (tmOpen && (k === 'ready' || k === 'asking' || k === 'working')) { deliver(); return; }
    onOpenTaskManager();
    setWaiting(true);
  }, [tmOpen, deliver, onOpenTaskManager]);

  // ── Selection tracking over the rendered doc ────────────────────────────────
  useEffect(() => {
    const onMouseUp = () => {
      // Read AFTER the browser settles the selection this mouseup produced.
      setTimeout(() => {
        const sel = window.getSelection();
        const root = docRef.current;
        if (!sel || sel.isCollapsed || !root) return;
        const range = sel.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) return;
        const quote = clampQuote(sel.toString());
        if (!quote) return;
        const rect = range.getBoundingClientRect();
        setAnchor({ quote, x: rect.right, y: rect.bottom });
      }, 0);
    };
    const onSelectionChange = () => {
      const sel = window.getSelection();
      // Selection gone → retire the floating button (the open popover stands on its own).
      if (!sel || sel.isCollapsed) setAnchor(null);
    };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [docRef]);

  // Esc closes the popover; it must not leak into other overlay handlers' way.
  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); setDraftText(''); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [draft]);

  useEffect(() => { if (draft) draftRef.current?.focus(); }, [draft]);

  const openDraft = useCallback(() => {
    if (!anchor) return;
    setDraft(anchor);
    setAnchor(null);
    window.getSelection()?.removeAllRanges();
  }, [anchor]);

  const addComment = useCallback(() => {
    if (!draft) return;
    const text = draftText.trim();
    if (!text) return;
    setComments((prev) => [...prev, { id: crypto.randomUUID(), quote: draft.quote, text }]);
    setDraft(null);
    setDraftText('');
  }, [draft, draftText]);

  // Clamp floating UI into the viewport (the doc scrolls under a fixed overlay).
  const place = (x: number, y: number, w: number): { left: number; top: number } => ({
    left: Math.max(8, Math.min(x - w / 2, window.innerWidth - w - 8)),
    top: Math.min(y + 8, window.innerHeight - 60),
  });

  return (
    <>
      {anchor && !draft && createPortal(
        (() => {
          const p = place(anchor.x, anchor.y, 120);
          return (
            <button
              type="button"
              className="doc-comment-fab"
              style={{ left: p.left, top: p.top }}
              // preventDefault on mousedown: a click would otherwise collapse the selection
              // (and this button with it) before the click handler could run.
              onMouseDown={(e) => e.preventDefault()}
              onClick={openDraft}
            >
              💬 Comment
            </button>
          );
        })(),
        document.body,
      )}

      {draft && createPortal(
        (() => {
          const p = place(draft.x, draft.y, 320);
          return (
            <div className="doc-comment-pop" style={{ left: p.left, top: p.top }}>
              <div className="doc-comment-quote" title={draft.quote}>“{draft.quote}”</div>
              <textarea
                ref={draftRef}
                className="doc-comment-input"
                placeholder="Comment for the Task Manager…"
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(); }
                }}
                rows={2}
              />
              <div className="doc-comment-pop-actions">
                <button type="button" className="doc-comment-btn ghost" onClick={() => { setDraft(null); setDraftText(''); }}>
                  Cancel
                </button>
                <button type="button" className="doc-comment-btn" onClick={addComment} disabled={!draftText.trim()}>
                  Add comment
                </button>
              </div>
            </div>
          );
        })(),
        document.body,
      )}

      {comments.length > 0 && (
        <div className="doc-comment-tray" role="region" aria-label="Pending comments">
          <div className="doc-comment-chips">
            {comments.map((c) => (
              <span key={c.id} className="doc-comment-chip" title={`“${c.quote}” — ${c.text}`}>
                <span className="doc-comment-chip-quote">“{c.quote.length > 34 ? `${c.quote.slice(0, 33)}…` : c.quote}”</span>
                <span className="doc-comment-chip-text">{c.text}</span>
                <button
                  type="button"
                  className="doc-comment-chip-x"
                  aria-label="Remove comment"
                  onClick={() => setComments((prev) => prev.filter((p) => p.id !== c.id))}
                >×</button>
              </span>
            ))}
          </div>
          <button type="button" className="doc-comment-send" onClick={send} disabled={waiting}>
            {waiting
              ? 'Task Manager starting…'
              : `Send ${comments.length === 1 ? 'comment' : `${comments.length} comments`} → Task Manager`}
          </button>
        </div>
      )}
    </>
  );
}
