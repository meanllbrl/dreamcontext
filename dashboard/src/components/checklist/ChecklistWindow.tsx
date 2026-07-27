import { useCallback, useEffect, useState } from 'react';
import { closeCurrentWindow, isDesktop, startTitleBarDrag } from '../../lib/desktop';
import {
  readEnvelope, writeState, readState, clearChecklist, checklistEnvelopeKey,
  type ChecklistEnvelope,
} from '../../lib/checklistStore';
import { checklistReducer, emptyState, type ChecklistAction, type ChecklistState } from '../../lib/checklistState';
import type { ChecklistViewSpec } from '../../lib/chatViewSpec';
import { buildSubmitMarkdown } from '../../lib/checklistMarkdown';
import { submitChecklist } from '../../lib/checklistBridge';
import { MarkdownPreview } from '../core/MarkdownPreview';
import { ChecklistBody } from './ChecklistBody';
import './ChecklistWindow.css';

interface Props {
  id: string | null;
  vault: string | null;
}

/** `sent`/`closing` are the two states in which this window is on its way out. They exist
 *  because CLOSING IS NOT FREE — see `useDeferredClose`. */
type SubmitPhase = 'idle' | 'sending' | 'failed' | 'sent' | 'closing';

/** Never actually rendered — only backs the reducer's type while `envelope` is null, so
 *  hooks stay unconditional even for the "this checklist is no longer available" branch. */
const EMPTY_SPEC: ChecklistViewSpec = { type: 'checklist', id: '', title: '', items: [] };

function loadEnvelope(id: string | null, vault: string | null): ChecklistEnvelope | null {
  if (!id || !vault) return null;
  return readEnvelope(vault, id);
}

/**
 * Close the OS window a couple of frames AFTER the render that took the scroller down, never
 * in the same tick as the action that asked for it.
 *
 * Issue #234: submitting a checklist whose item list had grown scrollable (expanded note +
 * file rows) segfaulted the WHOLE app — `EXC_BAD_ACCESS` in
 * `WebCore::ScrollingTree::takePendingScrollUpdates()`, reached from
 * `RemoteLayerTreeDrawingAreaProxy::didRefreshDisplay()`. No app frames in the stack: WebKit
 * servicing a display-link refresh against a webview that was already being destroyed. The
 * non-scrollable case submitted cleanly, which is what points at the scrolling tree.
 *
 * So the fix is a sequencing one, and it has two halves — the caller flips to a phase that
 * UNMOUNTS the scrollable list (removing the scrolling node from the layer tree), and this
 * hook then lets a couple of display-link cycles service that update before the window goes
 * away. The timeout is not belt-and-braces: an occluded or backgrounded window throttles
 * `requestAnimationFrame` to a crawl or stops it entirely, and a checklist window that never
 * closes would be a worse bug than the one being fixed.
 *
 * Honest limitation: the fault is inside WebKit's own teardown, so this removes the
 * documented trigger rather than proving the race can never be lost.
 */
function useDeferredClose(armed: boolean): void {
  useEffect(() => {
    if (!armed) return;
    let done = false;
    const frames: number[] = [];
    const close = () => {
      if (done) return;
      done = true;
      void closeCurrentWindow();
    };
    frames.push(requestAnimationFrame(() => { frames.push(requestAnimationFrame(close)); }));
    const timer = window.setTimeout(close, 400);
    return () => {
      done = true;
      frames.forEach(cancelAnimationFrame);
      window.clearTimeout(timer);
    };
  }, [armed]);
}

/**
 * Per-item state survives a re-issued checklist (same `id`, new/changed items) for every
 * item whose id still exists in the new spec; anything else is dropped rather than lingering
 * forever under a stale id (plan §1.2). Reconciles from the CURRENT in-memory state, not a
 * fresh `readState` off localStorage — the debounced write may not have flushed yet, and the
 * in-memory value is always the freshest one this window actually knows about.
 */
function reconcileForSpec(prev: ChecklistState, spec: ChecklistViewSpec): ChecklistState {
  const checked: Record<string, boolean> = {};
  const notes: Record<string, string> = {};
  const files: Record<string, string[]> = {};
  for (const item of spec.items) {
    if (prev.checked[item.id]) checked[item.id] = true;
    const note = prev.notes[item.id];
    if (note) notes[item.id] = note;
    const attached = prev.files[item.id];
    if (attached?.length) files[item.id] = attached;
  }
  return { v: 1, updatedAt: Date.now(), checked, notes, files };
}

/**
 * The pinned always-on-top checklist window (chat-interactive-views plan §1.9/§1.10/§1.13):
 * a frameless window this component draws its own title bar, content and footer for. Loads
 * its `ChecklistEnvelope` from the vault-scoped localStorage entry `ChatViews`'s "Open pinned
 * checklist" button wrote, and REFUSES to render the checklist itself if that envelope is
 * missing or doesn't match this window's own `vault` — the exact cross-project leak three
 * independent reviewers found in the first pass of this design (plan §1.10), so it is a
 * security boundary here, not a friendliness check.
 */
export function ChecklistWindow({ id, vault }: Props) {
  const [envelope, setEnvelope] = useState<ChecklistEnvelope | null>(() => loadEnvelope(id, vault));

  const [state, setState] = useState<ChecklistState>(() =>
    id && vault && envelope && envelope.vault === vault
      ? readState(vault, id, envelope.spec)
      : emptyState(EMPTY_SPEC),
  );
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [pinned, setPinned] = useState(true);
  const [phase, setPhase] = useState<SubmitPhase>('idle');
  const [failedMarkdown, setFailedMarkdown] = useState('');
  const [copied, setCopied] = useState(false);

  const valid = !!(id && vault && envelope && envelope.vault === vault);

  const dispatch = useCallback((action: ChecklistAction) => {
    setState((s) => checklistReducer(s, action));
  }, []);

  const setSecret = useCallback((itemId: string, value: string) => {
    setSecrets((prev) => ({ ...prev, [itemId]: value }));
  }, []);

  // Persist on every change. `writeState` debounces internally (300ms) and never writes a
  // `wants:'secret'` value, so this is cheap to call on every keystroke and never risks the
  // secret leaking into localStorage.
  useEffect(() => {
    if (!valid || !envelope) return;
    writeState(envelope.vault, envelope.spec.id, envelope.spec, state);
  }, [state, valid, envelope]);

  // Cross-window re-issue: the chat window overwrote this checklist's envelope (same `id`,
  // possibly changed items) and focused THIS window instead of opening a duplicate — the only
  // way this window learns about that is the cross-window `storage` event (plan §1.2).
  useEffect(() => {
    if (!id || !vault) return;
    const envKey = checklistEnvelopeKey(vault, id);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== envKey) return;
      const next = loadEnvelope(id, vault);
      setEnvelope(next);
      if (!next) return;
      setState((prev) => reconcileForSpec(prev, next.spec));
      setSecrets((prev) => {
        const kept: Record<string, string> = {};
        for (const item of next.spec.items) if (prev[item.id]) kept[item.id] = prev[item.id];
        return kept;
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [id, vault]);

  const togglePin = useCallback(async () => {
    const next = !pinned;
    setPinned(next);
    if (!isDesktop()) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setAlwaysOnTop(next);
    } catch { /* ACL / non-desktop — the toggle still flips visually, matches desktop.ts's own discipline */ }
  }, [pinned]);

  const handleSubmit = useCallback(async () => {
    // Only an idle or previously-failed checklist may be sent: `sending` is in flight, and
    // `sent`/`closing` belong to a window that is already on its way out.
    if (!valid || !envelope || (phase !== 'idle' && phase !== 'failed')) return;
    setPhase('sending');
    const markdown = buildSubmitMarkdown(envelope.spec, state, secrets);
    const ok = await submitChecklist({
      vault: envelope.vault,
      conversationId: envelope.conversationId,
      checklistId: envelope.spec.id,
      markdown,
    });
    if (ok) {
      clearChecklist(envelope.vault, envelope.spec.id);
      // NOT `closeCurrentWindow()` here: the submit succeeded, and killing the webview in the
      // same tick is what segfaulted the whole app (#234). `sent` unmounts the scroller and
      // the close happens a couple of frames later — see `useDeferredClose`.
      setPhase('sent');
      return;
    }
    // Nothing the user typed is lost: the failure strip stays up with the exact markdown one
    // Copy click away, and every tick/note/file/secret already typed stays right where it was.
    setFailedMarkdown(markdown);
    setPhase('failed');
  }, [valid, envelope, state, secrets, phase]);

  /** The ✕ takes the same road as a successful submit. The crash in #234 was not about
   *  submitting — it was about closing a window whose list had been scrolled, and the title
   *  bar's ✕ can do that just as easily. */
  const requestClose = useCallback(() => {
    setPhase((p) => (p === 'sent' || p === 'closing' ? p : 'closing'));
  }, []);

  useDeferredClose(phase === 'sent' || phase === 'closing');

  const copyMarkdown = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(failedMarkdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard permission denied — the markdown is still visible via the strip's own text */ }
  }, [failedMarkdown]);

  const title = envelope?.spec.title || 'Checklist';

  return (
    <div className="checklist-window">
      {/* No `data-tauri-drag-region` — these windows are created with `dragDropEnabled: false`,
          which (per desktop.ts) also disables Tauri's built-in drag-region handler. Same
          `startTitleBarDrag` gesture the vault Header uses: a 4px-threshold manual drag so a
          plain click on the pin/close buttons is never mistaken for a drag. */}
      <div className="checklist-titlebar" onMouseDown={startTitleBarDrag}>
        <button
          type="button"
          className={`checklist-pin${pinned ? ' is-on' : ''}`}
          onClick={() => void togglePin()}
          title={pinned ? 'Turn off always-on-top' : 'Turn on always-on-top'}
          aria-pressed={pinned}
          aria-label={pinned ? 'Turn off always-on-top' : 'Turn on always-on-top'}
        >
          <span aria-hidden>📌</span>
        </button>
        <span className="checklist-titlebar-title">{title}</span>
        <button
          type="button"
          className="checklist-close"
          onClick={requestClose}
          title="Close"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {phase === 'sent' || phase === 'closing' ? (
        // The scroller is GONE from this render on purpose (see `useDeferredClose`) — this is
        // the state the window dies in, and it must hold no scrollable content.
        <div className="checklist-gone">
          <p>{phase === 'sent' ? 'Sent ✓' : 'Closing…'}</p>
        </div>
      ) : !valid || !envelope ? (
        <div className="checklist-gone">
          <p>This checklist is no longer available.</p>
        </div>
      ) : (
        <>
          <div className="checklist-content">
            {envelope.spec.intro && (
              <div className="checklist-intro">
                <MarkdownPreview content={envelope.spec.intro} />
              </div>
            )}
            <ChecklistBody
              spec={envelope.spec}
              state={state}
              dispatch={dispatch}
              secrets={secrets}
              setSecret={setSecret}
            />
          </div>

          <div className="checklist-footer">
            {phase === 'failed' && (
              <div className="checklist-fail-strip" role="alert">
                <p>Couldn't reach the chat — that conversation may have been closed.</p>
                <button type="button" className="checklist-copy-btn" onClick={() => void copyMarkdown()}>
                  {copied ? 'Copied ✓' : 'Copy to clipboard'}
                </button>
              </div>
            )}
            <button
              type="button"
              className="checklist-submit-btn"
              onClick={() => void handleSubmit()}
              disabled={phase === 'sending'}
            >
              {phase === 'sending' ? 'Sending…' : envelope.spec.submitLabel || 'Submit'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
