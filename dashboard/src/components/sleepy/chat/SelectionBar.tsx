import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import { copyPreservingUnicode } from '../../../lib/clipboard';
import {
  FRAME_BAR_ARM_MS, SELECTION_CLEAR_KEY, placeBar, readSelectionMessage, type SelectionBox,
} from '../../../lib/textSelection';
import './SelectionBar.css';

/**
 * Copy and Comment under selected text (owner 2026-10-31). One bar for the window, drawn by the
 * host. A SCOPE says where a selection counts and what Comment does there: a chat's transcript,
 * a stage card. A selection anywhere else draws nothing.
 *
 * `comment` gets the selected text and the transcript row it started in (null on a card).
 * Only staging happens here: the chip goes in the composer and the owner decides to send it.
 */
export interface SelectionScopeHandler {
  comment: (text: string, itemId: string | null) => void;
  /** Whether Comment means anything for this row. Copy is always offered. */
  canComment?: (itemId: string | null) => boolean;
}

interface Scope { handler: RefObject<SelectionScopeHandler> }
const scopes = new Map<string, Scope>();

const ScopeContext = createContext<string | null>(null);
/** The transcript row a frame sits in, for a frame taken full screen out of it. */
export const SelectionItemContext = createContext<string | null>(null);

/** Marks its children as a place a selection counts. No box of its own (`display: contents`). */
export function SelectionScope({ handler, children }: { handler: SelectionScopeHandler; children: ReactNode }) {
  const id = useId();
  const ref = useRef(handler);
  ref.current = handler;
  useLayoutEffect(() => {
    scopes.set(id, { handler: ref });
    return () => { scopes.delete(id); };
  }, [id]);
  return (
    <ScopeContext.Provider value={id}>
      <div data-sel-scope={id} style={{ display: 'contents' }}>{children}</div>
    </ScopeContext.Provider>
  );
}

interface Shown {
  text: string;
  scope: string;
  itemId: string | null;
  /** The frame it was reported from. */
  frame: HTMLIFrameElement | null;
  /** That frame's last line, in the frame's own pixels. */
  line: SelectionBox | null;
  at: number;
  /** Comment taken: a full-screen view gets out of the way of the composer. */
  onCommented?: () => void;
}

// The one selection a frame reported. Lives while its frame does (`useFrameSelection` clears it).
let framed: Shown | null = null;
const listeners = new Set<() => void>();
const notify = () => { listeners.forEach((l) => l()); };
/** Until this time an Esc is the one a frame already spent on closing its bar. */
let frameEscUntil = 0;
/** The bar is drawn, not waiting out of sight. */
let barInSight = false;
/** That Esc arrived: true once, for the listener that would otherwise act on it. */
export function frameEscSpent(): boolean {
  const spent = Date.now() < frameEscUntil;
  if (spent) frameEscUntil = 0;
  return spent;
}

const PRESS_HOLD_MS = 1000;
const coarse = () => !!window.matchMedia?.('(pointer: coarse)').matches;

/** A sandboxed frame's half on the host: its reports, from its own window only. A desktop frame
 *  must also hold the focus, as one the owner just selected in does; a touch does not move focus. */
export function useFrameSelection(frameRef: RefObject<HTMLIFrameElement | null>, onCommented?: () => void): void {
  const scope = useContext(ScopeContext);
  const item = useContext(SelectionItemContext);
  const commented = useRef(onCommented);
  commented.current = onCommented;
  useLayoutEffect(() => {
    if (!scope) return undefined;
    function onMessage(event: MessageEvent) {
      const frame = frameRef.current;
      if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
      const report = readSelectionMessage(event.data);
      if (!report) return;
      if (report.kind === 'clear' || (document.activeElement !== frame && !coarse())) {
        if (framed?.frame === frame) {
          if (report.kind === 'clear' && report.esc && barInSight) frameEscUntil = Date.now() + 300;
          framed = null;
          notify();
        }
        return;
      }
      const row = item ?? frame.closest('[data-item-id]')?.getAttribute('data-item-id') ?? null;
      const same = framed?.frame === frame && framed.text === report.text;
      framed = {
        text: report.text, scope: scope as string, itemId: row, frame, line: report.line,
        at: same ? (framed as Shown).at : Date.now(), onCommented: () => commented.current?.(),
      };
      notify();
    }
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (framed?.frame && framed.frame === frameRef.current) { framed = null; notify(); }
    };
  }, [frameRef, scope, item]);
}

function domSelection(): Shown | null {
  const s = window.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return null;
  const range = s.getRangeAt(0);
  const elementOf = (n: Node) => (n.nodeType === 1 ? n as Element : n.parentElement);
  const common = elementOf(range.commonAncestorContainer);
  if (!common || common.closest('[data-sel-bar], textarea, input, [contenteditable="true"]')) return null;
  const scope = common.closest('[data-sel-scope]')?.getAttribute('data-sel-scope');
  if (!scope || !scopes.has(scope)) return null;
  const text = s.toString();
  if (!text.trim()) return null;
  const itemId = elementOf(range.startContainer)?.closest('[data-item-id]')?.getAttribute('data-item-id') ?? null;
  return { text, scope, itemId, frame: null, line: null, at: 0 };
}

function domLine(): SelectionBox | null {
  const s = window.getSelection();
  if (!s?.rangeCount) return null;
  const rects = s.getRangeAt(0).getClientRects();
  for (let i = rects.length - 1; i >= 0; i--) if (rects[i].width > 0) return rects[i];
  return null;
}

/** The box a bar stays in: the scope cut to the visible window (a short block's bar hangs below it). */
function boundsOf(shown: Shown) {
  const vv = window.visualViewport;
  const view = { left: 8, top: 8, right: (vv?.width ?? window.innerWidth) - 8, bottom: (vv?.height ?? window.innerHeight) - 8 };
  const el = document.querySelector(`[data-sel-scope="${CSS.escape(shown.scope)}"]`)?.firstElementChild;
  // A frame taken full screen is out of its scope's box.
  if (!el || (shown.frame && !el.contains(shown.frame))) return view;
  const r = el.getBoundingClientRect();
  return { left: view.left, right: view.right, top: Math.max(view.top, r.top), bottom: Math.min(view.bottom, r.bottom) };
}

/** Where the selection's last line is now, in the window's pixels (a frame may be scaled). */
function lineNow(shown: Shown): SelectionBox | null {
  if (!shown.frame) return domLine();
  const line = shown.line as SelectionBox;
  const r = shown.frame.getBoundingClientRect();
  const k = shown.frame.offsetWidth > 0 ? r.width / shown.frame.offsetWidth : 1;
  // A page's numbers never reach past its own frame.
  const x = Math.max(r.left, Math.min(r.left + line.x * k, r.right));
  const y = Math.max(r.top, Math.min(r.top + line.y * k, r.bottom));
  return { x, y, width: Math.min(line.width * k, r.right - x), height: Math.min(line.height * k, r.bottom - y) };
}

export function SelectionBar() {
  const { t } = useI18n();
  const [shown, setShown] = useState<Shown | null>(null);
  const [copied, setCopied] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  /** A press on the bar, while a phone's tap may drop the selection before its click lands.
   *  It expires: a release over a frame is never seen here. */
  const pressedAt = useRef(0);
  const dragging = useRef(false);
  /** Esc closed the bar on this selection; the next one opens it again. */
  const dismissed = useRef<string | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const placeRef = useRef(place);
  placeRef.current = place;
  /** When the bar last came into sight or moved, read off where it is drawn (never the page's
   *  numbers, which can step or resize past any comparison of them): a frame's bar wakes from then. */
  const sightedAt = useRef(0);
  const anchor = useRef<{ left: number; top: number } | null>(null);

  const refresh = useCallback(() => {
    if (Date.now() - pressedAt.current < PRESS_HOLD_MS) return;
    const next = framed ?? domSelection();
    if (!next) dismissed.current = null;
    const closed = next && dismissed.current === next.text;
    if (!next || closed) { setShown(null); setCopied(false); return; }
    dismissed.current = null;
    setShown((cur) => {
      if (cur?.text !== next.text) setCopied(false);
      return next;
    });
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => { if (!dragging.current) refresh(); }, ms); };
    const onChange = () => soon(coarse() ? 350 : 120);
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-sel-bar]')) return;
      pressedAt.current = 0;
      if (e.pointerType !== 'touch') dragging.current = true;
      // A press out here leaves a frame's selection painted, so it is cleared with the bar.
      if (framed) {
        framed.frame?.contentWindow?.postMessage({ [SELECTION_CLEAR_KEY]: true }, '*');
        framed = null;
        notify();
      }
    };
    const onUp = (e: PointerEvent) => {
      // Pressed on the bar, released off it: no click is coming.
      if (pressedAt.current && !(e.target instanceof Element && e.target.closest('[data-sel-bar]'))) {
        pressedAt.current = 0;
        setTimeout(refresh, 0);
      }
      if (dragging.current) { dragging.current = false; soon(10); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (frameEscSpent()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (!shownRef.current || !placeRef.current) return;
      // The bar takes this Esc; a running turn or an open overlay keeps its own for the next one.
      e.preventDefault();
      e.stopImmediatePropagation();
      dismissed.current = shownRef.current.text;
      setShown(null);
    };
    document.addEventListener('selectionchange', onChange);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('keydown', onKey, true);
    listeners.add(refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      listeners.delete(refresh);
    };
  }, [refresh]);

  // Stays under the words while anything scrolls or resizes; gone while they are out of sight.
  useLayoutEffect(() => {
    if (!shown) { setPlace(null); anchor.current = null; barInSight = false; return undefined; }
    let raf = 0;
    const read = () => {
      raf = 0;
      const bar = barRef.current;
      const line = lineNow(shown);
      if (!bar || !line) { setPlace(null); barInSight = false; anchor.current = null; return; }
      const bounds = boundsOf(shown);
      const off = line.y + line.height < bounds.top || line.y > bounds.bottom;
      const next = off ? null : placeBar(line, { width: bar.offsetWidth, height: bar.offsetHeight }, bounds);
      const a = anchor.current;
      if (next && (!a || Math.abs(a.left - next.left) >= 2 || Math.abs(a.top - next.top) >= 2)) {
        anchor.current = next;
        sightedAt.current = Date.now();
      }
      if (!next) anchor.current = null;
      barInSight = !!next;
      setPlace(next);
    };
    read();
    const queue = () => { if (!raf) raf = requestAnimationFrame(read); };
    window.addEventListener('scroll', queue, true);
    window.addEventListener('resize', queue);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', queue, true);
      window.removeEventListener('resize', queue);
    };
  }, [shown]);

  if (!shown) return null;
  const handler = scopes.get(shown.scope)?.handler.current ?? null;
  const armed = () => !shown.frame || Date.now() - Math.max(shown.at, sightedAt.current) >= FRAME_BAR_ARM_MS;
  const canComment = !!handler && (handler.canComment?.(shown.itemId) ?? true);
  const close = () => {
    const frame = shown.frame;
    framed = null;
    if (frame) frame.contentWindow?.postMessage({ [SELECTION_CLEAR_KEY]: true }, '*');
    else window.getSelection()?.removeAllRanges();
    setShown(null);
  };
  return createPortal(
    <div
      ref={barRef}
      className="sel-bar"
      role="toolbar"
      aria-label={t('chat.select.bar')}
      data-sel-bar
      data-testid="selection-bar"
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={() => { pressedAt.current = Date.now(); setTimeout(() => { if (!dragging.current) refresh(); }, PRESS_HOLD_MS + 20); }}
      onPointerCancel={() => { pressedAt.current = 0; refresh(); }}
    >
      <button
        type="button"
        className="sel-bar-btn"
        data-testid="selection-copy"
        onClick={() => {
          pressedAt.current = 0;
          if (!armed()) return;
          // The copy's fallback selects a textarea of its own: the owner's selection comes back.
          const sel = window.getSelection();
          const range = !shown.frame && sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
          void copyPreservingUnicode(shown.text).then((ok) => {
            if (range && window.getSelection()?.toString() !== range.toString()) {
              window.getSelection()?.removeAllRanges();
              window.getSelection()?.addRange(range);
            }
            setCopied(ok);
          });
        }}
      >
        {copied ? t('chat.select.copied') : t('chat.select.copy')}
      </button>
      {canComment && (
        <button
          type="button"
          className="sel-bar-btn sel-bar-btn--main"
          data-testid="selection-comment"
          onClick={() => {
            pressedAt.current = 0;
            if (!armed()) return;
            handler?.comment(shown.text, shown.itemId);
            shown.onCommented?.();
            close();
          }}
        >
          {t('chat.select.comment')}
        </button>
      )}
    </div>,
    document.body,
  );
}
