import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  buildSrcdoc, resolveKitTokens, readHtmlHeightMessage,
  HTML_KIT_SANDBOX, HTML_KIT_ALLOW, HTML_HEIGHT_REQUEST_KEY,
} from './labHtmlKit';

/**
 * The html/v1 card body: `cache.html` drawn in a NETWORK-LESS sandboxed iframe.
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` + the srcdoc's
 * `default-src 'none'` CSP (labHtmlKit.ts) means the body can animate and
 * compute but cannot make a single network request or reach the parent origin
 * — the data it presents was embedded at sync time. The srcdoc is rebuilt when
 * the theme flips, re-inlining the token values (CSS variables do not cross
 * the iframe document boundary).
 *
 * The rebuild key is the `data-theme` ATTRIBUTE itself (a MutationObserver on
 * <html>), not the ThemeContext value: the attribute is what actually restyles
 * the tokens, and it can change from outside the context (verify harnesses,
 * future theme mechanisms). Watching the source of truth means the iframe can
 * never be left holding the other theme's colors — dark text on a dark card.
 *
 * HEIGHT IS THE CONTENT'S, not this component's — the promise the reference
 * makes to every body author ("no fixed card size to fight"), which `app/v1`
 * kept and this surface did not until 2026-09-08. The frame measures itself and
 * reports one number (labHtmlKit.ts's HTML_HEIGHT_BRIDGE); the host clamps it
 * to where the body is drawn, using the SAME bounds LabAppFrame uses so the two
 * body contracts cannot drift:
 *   - CARD — 120..320px. The cap is the board grid's, not the author's: a card
 *     is a preview, and one 900px tile would set its whole grid row's height
 *     and strand its neighbours in whitespace. A body over the cap keeps its
 *     own scrollbar and reads in full in the detail panel.
 *   - DETAIL (`full`) — 200..20000px, i.e. effectively uncapped. This is where
 *     a long body is READ, so nothing is clipped and there is no inner
 *     scrollbar to fight.
 * A body needing more than one screen should be an `app/v1` — that rule is
 * unchanged; what changed is that fitting one screen no longer means shrinking
 * the type past the kit's scale.
 *
 * This is the card's BODY only — the chrome (title, staleness, Refresh,
 * RangeControl, click-to-detail) stays the platform's, and the detail panel
 * always shows the typed data twin next to this (a11y — see InsightDetailPanel).
 */

/** Shared with LabAppFrame's clampHeightForMode — deliberately the same numbers. */
const CARD_MIN_HEIGHT = 120;
const CARD_MAX_HEIGHT = 320;
const FULL_MIN_HEIGHT = 200;
const FULL_MAX_HEIGHT = 20000;

/** Where the frame stands before its first measurement: the height this body
 *  was hard-coded to, so a card that used to be drawn at 232px does not visibly
 *  jump on every mount — it grows or shrinks out of the slot it already held. */
const PENDING_HEIGHT = 232;

/** How the host recovers a measurement that never reached it: ask again, on a
 *  short beat, until one arrives. Finite on purpose — a body whose bridge
 *  genuinely never ran (an unclosed `<script>` in the author's markup) will
 *  never answer, and a timer that keeps asking it forever is worse than a card
 *  sitting at its pending height. */
const HEIGHT_RETRY_MS = 250;
const HEIGHT_RETRIES = 16;

/** The live value of <html data-theme> — re-renders on every attribute flip. */
function useDataTheme(): string {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') ?? 'light');
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute('data-theme') ?? 'light');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function clampHeight(px: number, full: boolean): number {
  const rounded = Math.max(0, Math.ceil(px));
  return full
    ? Math.min(FULL_MAX_HEIGHT, Math.max(FULL_MIN_HEIGHT, rounded))
    : Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, rounded));
}

export function HtmlInsightBody({ html, title, full = false }: {
  html: string;
  title: string;
  full?: boolean;
}) {
  const theme = useDataTheme();
  const scheme = theme === 'dark' ? 'dark' : 'light';
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // `theme` is the rebuild key: same html, freshly resolved token values, and
  // the matching color-scheme (a mismatch makes the iframe backdrop opaque white).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const srcdoc = useMemo(() => buildSrcdoc(html, resolveKitTokens(), scheme), [html, theme]);

  /**
   * A measurement belongs to the BODY it measured, so it travels WITH that body
   * rather than being reset by an effect when `html` changes (Chat's lesson,
   * HtmlView.tsx): a passive reset runs after paint, so a height the new
   * document reported first got clobbered back to null and the bridge, having
   * already said its piece, never spoke again. Keyed on `html` and not on
   * `srcdoc` on purpose — a theme flip rebuilds the srcdoc around identical
   * content, and a card that collapses and grows back on every theme change is
   * a worse lie than briefly holding the last true height.
   */
  const [measured, setMeasured] = useState<{ html: string; px: number } | null>(null);
  const height = measured?.html === html ? measured.px : null;

  // useLayoutEffect, NOT useEffect: a passive effect is flushed after paint, and
  // on a busy main thread that flush can land AFTER the frame's document has
  // parsed, run the bridge and posted its one height — nobody listening, body
  // never resizes again, card stuck at its pending height for the session.
  useLayoutEffect(() => {
    function onMessage(event: MessageEvent) {
      // AUTHENTICATE BY SOURCE, NOT ORIGIN — a frame sandboxed without
      // `allow-same-origin` has the opaque origin "null", so an origin check
      // would either reject our own frame or accept every other sandboxed
      // frame on the page. Window identity is what actually distinguishes them.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const px = readHtmlHeightMessage(event.data);
      if (px !== null) setMeasured({ html, px });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [html]);

  /** "Tell me again" — answered forcibly, past the bridge's own dedupe. */
  const askForHeight = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ [HTML_HEIGHT_REQUEST_KEY]: true }, '*');
  }, []);

  // Belt and braces, in that order. `load` is the host's own proof the document
  // is parsed and its listener installed; the interval covers every remaining
  // way one message can go missing, and stops the moment a height lands.
  useEffect(() => {
    if (height !== null) return;
    let asked = 0;
    const timer = window.setInterval(() => {
      askForHeight();
      if (++asked >= HEIGHT_RETRIES) window.clearInterval(timer);
    }, HEIGHT_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [height, srcdoc, askForHeight]);

  return (
    <iframe
      ref={frameRef}
      className="lab-html-body"
      title={`${title} — script-rendered body`}
      sandbox={HTML_KIT_SANDBOX}
      allow={HTML_KIT_ALLOW}
      srcDoc={srcdoc}
      onLoad={askForHeight}
      style={{
        width: '100%',
        height: height !== null ? clampHeight(height, full) : PENDING_HEIGHT,
        border: 'none',
        display: 'block',
        colorScheme: scheme,
      }}
    />
  );
}
