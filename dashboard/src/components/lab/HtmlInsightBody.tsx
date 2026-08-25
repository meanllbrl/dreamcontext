import { useMemo } from 'react';
import { useTheme } from '../../context/ThemeContext';
import { buildSrcdoc, resolveKitTokens, HTML_KIT_SANDBOX } from './labHtmlKit';

/**
 * The html/v1 card body: `cache.html` drawn in a NETWORK-LESS sandboxed iframe.
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` + the srcdoc's
 * `default-src 'none'` CSP (labHtmlKit.ts) means the body can animate and
 * compute but cannot make a single network request or reach the parent origin
 * — the data it presents was embedded at sync time. The srcdoc is rebuilt when
 * the resolved theme flips, re-inlining the token values (CSS variables do not
 * cross the iframe document boundary).
 *
 * This is the card's BODY only — the chrome (title, staleness, Refresh,
 * RangeControl, click-to-detail) stays the platform's, and the detail panel
 * always shows the typed data twin next to this (a11y — see InsightDetailPanel).
 */
export function HtmlInsightBody({ html, title, full = false }: {
  html: string;
  title: string;
  full?: boolean;
}) {
  const { resolved } = useTheme();
  // `resolved` is the rebuild key: same html, freshly resolved token values.
  const srcdoc = useMemo(() => buildSrcdoc(html, resolveKitTokens()), [html, resolved]);

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
        colorScheme: resolved,
      }}
    />
  );
}
