import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SANDBOX_ALLOW } from '../../../lib/sandboxHtml';
import { HEIGHT_REQUEST_KEY, resolveChatKitTokens } from '../../sleepy/chat/chatHtmlKit';
import { BOARD_HTML_SANDBOX, buildBoardHtmlSrcdoc, readBoardFrameMessage } from '../htmlWidgetFrame';
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

function BoardHtmlFrame({ html, title }: { html: string; title: string }) {
  const tx = useWbText();
  const theme = useDataTheme();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loads = useRef(0);
  const [torn, setTorn] = useState(false);
  const [height, setHeight] = useState<number | null>(null);

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
      if (next !== null) setHeight(next);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // A theme flip swaps the srcdoc, which is a legitimate second load: reset the count with it.
  useLayoutEffect(() => { loads.current = 0; }, [srcDoc]);

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
    <iframe
      ref={frameRef}
      className="wb-html-frame"
      title={title}
      sandbox={BOARD_HTML_SANDBOX}
      allow={SANDBOX_ALLOW}
      srcDoc={srcDoc}
      onLoad={onLoad}
      style={{ height: height ?? '100%', colorScheme: theme }}
    />
  );
}
