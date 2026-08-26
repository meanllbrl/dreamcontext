import { useEffect, useMemo, useState } from 'react';
import { buildSrcdoc, resolveKitTokens, HTML_KIT_SANDBOX } from './labHtmlKit';

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
 * This is the card's BODY only — the chrome (title, staleness, Refresh,
 * RangeControl, click-to-detail) stays the platform's, and the detail panel
 * always shows the typed data twin next to this (a11y — see InsightDetailPanel).
 */

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

export function HtmlInsightBody({ html, title, full = false }: {
  html: string;
  title: string;
  full?: boolean;
}) {
  const theme = useDataTheme();
  const scheme = theme === 'dark' ? 'dark' : 'light';
  // `theme` is the rebuild key: same html, freshly resolved token values, and
  // the matching color-scheme (a mismatch makes the iframe backdrop opaque white).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const srcdoc = useMemo(() => buildSrcdoc(html, resolveKitTokens(), scheme), [html, theme]);

  return (
    <iframe
      className="lab-html-body"
      title={`${title} — script-rendered body`}
      sandbox={HTML_KIT_SANDBOX}
      srcDoc={srcdoc}
      style={{
        width: '100%',
        height: full ? 420 : 232,
        border: 'none',
        display: 'block',
        colorScheme: scheme,
      }}
    />
  );
}
