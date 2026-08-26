import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { FullscreenOverlay } from '../../layout/FullscreenOverlay';
import {
  buildChatSrcdoc, resolveChatKitTokens, readHeightMessage,
  CHAT_HTML_SANDBOX, MIN_HTML_HEIGHT,
} from './chatHtmlKit';
import './HtmlView.css';

/**
 * A ```dream-html block — HTML the AGENT wrote, drawn in a network-less sandboxed iframe.
 *
 * This is the Chat surface's main expressive channel since 2026-08-26, when the typed
 * `chart`/`page` payloads retired. The trade it makes is deliberate: we stop constraining
 * WHAT can be said (a flow, a tabbed comparison, a timeline, two candidate designs side by
 * side — none of which a fixed widget vocabulary could reach) and constrain instead what the
 * markup can DO. It can draw and compute; it cannot fetch, beacon, or touch the app.
 *
 * SECURITY: `sandbox="allow-scripts"` with NO `allow-same-origin`, plus the srcdoc's
 * `default-src 'none'` CSP — see `lib/sandboxHtml.ts` for the full argument, including why
 * the markup is deliberately NOT sanitized (the sandbox is the boundary, not a filter).
 *
 * THREE THINGS THIS ADDS over just dropping markup in an iframe, each fixing a defect the
 * Lab's html/v1 card shipped with:
 *
 *   1. HEIGHT FOLLOWS CONTENT. The Lab hardcoded 232px and cropped anything taller. Here the
 *      body measures itself and posts the number out; until the first message arrives the
 *      frame sits at a small placeholder rather than a tall empty gap.
 *   2. FULLSCREEN IS A MODE, NOT A ZOOM. `mode="full"` also reaches the kit (`html[data-dc-
 *      mode]`), so a deck's slides become real viewport-height pages instead of the stacked
 *      sections they are inline.
 *   3. THE BRAND OVERRIDE. The vault's own CSS rides in after the kit, so a project's HTML
 *      answers can look like that project without the agent writing a single color.
 *
 * The block wears CARD CHROME (`HtmlView.css`) rather than sitting loose in the transcript —
 * see that file's header for why the original chrome-less version was wrong.
 */

/** The live value of `<html data-theme>`.
 *
 *  Watching the ATTRIBUTE rather than `useTheme().resolved` is the Lab's hard-won lesson
 *  (2026-08-25): the attribute is what actually restyles the tokens, and it can change from
 *  outside the theme context (verify harnesses do exactly this). Watching the source of
 *  truth means an iframe can never be left holding the other theme's colors. */
function useDataTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') ?? 'light');
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute('data-theme') ?? 'light');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme === 'dark' ? 'dark' : 'light';
}

interface KitOverride { css: string | null; path: string; notice: string | null }

/**
 * The vault's `_dream_context/overrides/chat-html-kit.css`, if it has one.
 *
 * `retry: false` and a null fallback are the point: an older backend has no such route, and
 * a missing override must degrade to "the base kit" silently rather than to a broken block.
 * Cached indefinitely per vault — a brand sheet is a file a human edits between sessions,
 * not something worth polling on every message.
 */
function useChatKitOverride() {
  const api = useApi();
  return useQuery({
    queryKey: ['chat-html-kit'],
    queryFn: () => api.get<KitOverride>('/chat/html-kit'),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * The iframe itself. `mode` decides both the kit's slide behaviour and who owns the height:
 * inline the CONTENT does (via the bridge), fullscreen the OVERLAY does (the frame fills it,
 * and the document scrolls inside).
 */
function HtmlFrame({ html, overrideCss, mode, title }: {
  html: string;
  overrideCss?: string;
  mode: 'card' | 'full';
  title: string;
}) {
  const theme = useDataTheme();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  // Rebuilt on theme flip: same html, freshly resolved token values, and the matching
  // color-scheme (a mismatch makes Chromium paint an opaque white canvas behind the
  // transparent body — under the dark theme, a white slab with near-white text on it).
  const srcdoc = useMemo(
    () => buildChatSrcdoc({ html, tokens: resolveChatKitTokens(), scheme: theme, overrideCss, mode }),
    [html, theme, overrideCss, mode],
  );

  useEffect(() => {
    if (mode !== 'card') return;
    function onMessage(event: MessageEvent) {
      // AUTHENTICATE BY SOURCE, NOT ORIGIN. A frame sandboxed without `allow-same-origin`
      // has the opaque origin "null", so an origin check here would either reject our own
      // frame or accept every other sandboxed frame on the page. Window identity is the
      // thing that actually distinguishes them.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const next = readHeightMessage(event.data);
      if (next !== null) setHeight(next);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [mode]);

  // A fresh body re-measures from scratch — keeping the old height would leave a tall gap
  // under a block that got shorter.
  useEffect(() => { setHeight(null); }, [html, mode]);

  return (
    <iframe
      ref={frameRef}
      className="chat-htmlview-frame"
      title={title}
      sandbox={CHAT_HTML_SANDBOX}
      srcDoc={srcdoc}
      style={{
        height: mode === 'full' ? '100%' : (height ?? MIN_HTML_HEIGHT),
        colorScheme: theme,
      }}
    />
  );
}

function HtmlFullscreen({ html, overrideCss, onClose }: {
  html: string;
  overrideCss?: string;
  onClose: () => void;
}) {
  // Portaled to document.body because `.agent-surface` sets `contain: layout paint`, which
  // makes it the containing block for `position: fixed` — an un-portaled overlay would be
  // clipped to the chat pane instead of covering the window. Same reason `BoardFullscreen`
  // portals; it cost a bug the first time it was learned.
  return createPortal(
    <FullscreenOverlay label="Presentation" onClose={onClose}>
      <div className="chat-htmlview-full">
        <HtmlFrame html={html} overrideCss={overrideCss} mode="full" title="Presentation" />
      </div>
    </FullscreenOverlay>,
    document.body,
  );
}

export function HtmlView({ html }: { html: string }) {
  const [full, setFull] = useState(false);
  const { data } = useChatKitOverride();
  const overrideCss = data?.css ?? undefined;

  return (
    <div className="chat-htmlview">
      <HtmlFrame html={html} overrideCss={overrideCss} mode="card" title="Rendered answer" />
      <button
        type="button"
        className="chat-htmlview-full-btn"
        onClick={() => setFull(true)}
        aria-label="Open full screen"
        title="Open full screen"
      >
        <span aria-hidden>⛶</span>
      </button>
      {data?.notice && <p className="chat-htmlview-notice" role="status">{data.notice}</p>}
      {full && <HtmlFullscreen html={html} overrideCss={overrideCss} onClose={() => setFull(false)} />}
    </div>
  );
}
