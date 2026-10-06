import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SANDBOX_ALLOW } from '../../../lib/sandboxHtml';
import { HEIGHT_REQUEST_KEY, resolveChatKitTokens } from '../../sleepy/chat/chatHtmlKit';
import { BOARD_HTML_SANDBOX, buildBoardHtmlSrcdoc, fitScale, readBoardFrameMessage } from '../htmlWidgetFrame';
import { useDataTheme, useWbText, useWhiteboardHost } from '../whiteboardHost';
import { WidgetButton, WidgetFrame, WidgetNotice, useOpenEditorWhenEmpty } from './WidgetFrame';
import type { WidgetProps } from './types';

/**
 * An HTML block on the board (D6). The security argument lives in `htmlWidgetFrame.ts`: the
 * srcdoc is `buildSandboxSrcdoc` + kit CSS + `HEIGHT_BRIDGE` only, under `SANDBOX_CSP`, in an
 * `allow-scripts`-only sandbox with an empty permissions policy. The host listens for one
 * thing, the height, from this frame's own window; nothing the frame posts is replayed as an
 * event, so a block cannot type into the board around it.
 *
 * Detect-and-cut, as in `lab/LabAppFrame.tsx`: a srcdoc frame loads exactly once, so a second
 * `load` can only be the document navigating itself (`location.href = …`). The frame is torn
 * down on the spot and a card says why.
 */
export function HtmlWidget({ elementId, payload, active, size }: WidgetProps) {
  const tx = useWbText();
  const host = useWhiteboardHost();
  const html = payload.html ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const title = payload.title || tx('whiteboard.kind.html', 'HTML block');
  const editing = active && draft !== null;
  useOpenEditorWhenEmpty(active, !html.trim(), draft, setDraft);

  const save = () => {
    if (draft === null) return;
    const next = draft;
    host.commitWidget(elementId, (cur) => ({ ...cur, html: next }));
    setDraft(null);
  };

  return (
    <WidgetFrame
      kind="html"
      title={title}
      active={active}
      size={size}
      actions={!editing && (
        <WidgetButton onClick={() => setDraft(html)}>{tx('whiteboard.widget.edit', 'Edit')}</WidgetButton>
      )}
    >
      {editing ? (
        <div className="wb-editor wb-html-body">
          <textarea
            className="wb-textarea"
            value={draft ?? ''}
            autoFocus
            spellCheck={false}
            placeholder="<div class=&quot;dc-card&quot;>…</div>"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="wb-editor-actions">
            <WidgetButton onClick={() => setDraft(null)}>{tx('whiteboard.widget.cancel', 'Cancel')}</WidgetButton>
            <WidgetButton onClick={save}>{tx('whiteboard.widget.save', 'Save')}</WidgetButton>
          </div>
        </div>
      ) : html.trim() ? (
        // Keyed by the markup: an edited block is a new document with a fresh load count.
        <BoardHtmlFrame key={html} html={html} title={title} />
      ) : (
        <WidgetNotice tone="empty" onClick={() => setDraft('')}>{tx('whiteboard.html.emptyAction', 'Empty HTML block. Click to write.')}</WidgetNotice>
      )}
    </WidgetFrame>
  );
}

/**
 * The block, fitted to its card (owner, 2026-10-05: content was cut at the bottom, or sat
 * small in a big card). The frame always spans the card's body; a block taller than that is
 * drawn smaller (`fitScale`, down to half size, then it scrolls once the card is active), and
 * a lone root element stretches to the card's height (BOARD_HTML_CSS).
 */
function BoardHtmlFrame({ html, title }: { html: string; title: string }) {
  const tx = useWbText();
  const theme = useDataTheme();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loads = useRef(0);
  const [torn, setTorn] = useState(false);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  const boxSizeRef = useRef<{ width: number; height: number } | null>(null);

  // The card body's layout size (Excalidraw's zoom is a transform above it, so this is the
  // card's own px). A new box starts the fit again from full size.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const prev = boxSizeRef.current;
      if (prev && Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1) return;
      boxSizeRef.current = { width, height };
      scaleRef.current = 1;
      setScale(1);
      setBox({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ask for the height only once the frame is laid out at the new box: asked from the observer,
  // the answer was measured at the OLD width, and the fit only ever shrinks, so a widened card
  // could stay too small. Committed by now; one frame later it is laid out too.
  useEffect(() => {
    if (!box) return undefined;
    const raf = requestAnimationFrame(() => {
      frameRef.current?.contentWindow?.postMessage({ [HEIGHT_REQUEST_KEY]: true }, '*');
    });
    return () => cancelAnimationFrame(raf);
  }, [box]);

  // Rebuilt on a theme flip with freshly resolved tokens and the matching color-scheme (a
  // mismatch paints an opaque white canvas behind the body under the dark theme).
  const srcDoc = useMemo(
    () => buildBoardHtmlSrcdoc({ html, tokens: resolveChatKitTokens(), scheme: theme }),
    [html, theme],
  );

  // Layout effect so the listener is in place before the frame's parser can post its height.
  useLayoutEffect(() => {
    function onMessage(event: MessageEvent) {
      const next = readBoardFrameMessage(event, frameRef.current?.contentWindow ?? null);
      const size = boxSizeRef.current;
      if (next === null || !size) return;
      const fitted = fitScale(scaleRef.current, size, next);
      if (fitted !== scaleRef.current) {
        scaleRef.current = fitted;
        setScale(fitted);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // A theme flip swaps the srcdoc, which is a legitimate second load: reset the count with it.
  // New markup is measured from full size again.
  useLayoutEffect(() => { loads.current = 0; scaleRef.current = 1; setScale(1); }, [srcDoc]);

  const onLoad = useCallback(() => {
    loads.current += 1;
    if (loads.current >= 2) { setTorn(true); return; }
    // "Tell me again": the bridge's first report can race this listener.
    frameRef.current?.contentWindow?.postMessage({ [HEIGHT_REQUEST_KEY]: true }, '*');
  }, []);

  if (torn) {
    return (
      <div className="wb-widget-notice wb-widget-notice--error" role="alert">
        {tx('whiteboard.html.navigated', 'This block tried to open a web page')}
      </div>
    );
  }

  return (
    <div ref={boxRef} className="wb-html-fit">
      <iframe
        ref={frameRef}
        className="wb-html-frame"
        title={title}
        sandbox={BOARD_HTML_SANDBOX}
        allow={SANDBOX_ALLOW}
        srcDoc={srcDoc}
        onLoad={onLoad}
        data-scale={scale < 1 ? scale.toFixed(3) : undefined}
        style={{
          width: box ? box.width / scale : '100%',
          height: box ? box.height / scale : '100%',
          transform: scale < 1 ? `scale(${scale})` : undefined,
          colorScheme: theme,
        }}
      />
    </div>
  );
}
