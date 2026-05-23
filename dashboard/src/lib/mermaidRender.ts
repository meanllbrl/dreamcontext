import { useEffect, type RefObject } from 'react';
import mermaid from 'mermaid';

type ThemeMode = 'light' | 'dark';

let lastTheme: ThemeMode | null = null;

function getMermaidConfig(theme: ThemeMode) {
  const fontFamily = "'Plus Jakarta Sans', 'Inter', ui-sans-serif, system-ui, sans-serif";
  if (theme === 'dark') {
    return {
      startOnLoad: false,
      securityLevel: 'strict' as const,
      theme: 'base' as const,
      themeVariables: {
        background: '#1c1f2a',
        primaryColor: 'rgba(157, 140, 255, 0.18)',
        primaryTextColor: '#f5f6fa',
        primaryBorderColor: '#9d8cff',
        secondaryColor: 'rgba(96, 165, 250, 0.18)',
        secondaryBorderColor: '#93c5fd',
        secondaryTextColor: '#f5f6fa',
        tertiaryColor: 'rgba(74, 222, 128, 0.16)',
        tertiaryBorderColor: '#86efac',
        tertiaryTextColor: '#f5f6fa',
        noteBkgColor: 'rgba(251, 191, 36, 0.18)',
        noteBorderColor: '#fcd34d',
        noteTextColor: '#fcd34d',
        lineColor: '#9aa0b3',
        textColor: '#f5f6fa',
        mainBkg: 'rgba(157, 140, 255, 0.18)',
        nodeBorder: '#9d8cff',
        clusterBkg: 'rgba(255, 255, 255, 0.04)',
        clusterBorder: '#3d4358',
        edgeLabelBackground: '#1c1f2a',
        fontFamily,
      },
      flowchart: { htmlLabels: true, curve: 'basis' as const, nodeSpacing: 48, rankSpacing: 64, padding: 12 },
      sequence: { actorFontFamily: fontFamily, noteFontFamily: fontFamily, messageFontFamily: fontFamily },
    };
  }
  return {
    startOnLoad: false,
    securityLevel: 'strict' as const,
    theme: 'base' as const,
    themeVariables: {
      background: '#ffffff',
      primaryColor: '#ede9fe',
      primaryTextColor: '#5b21b6',
      primaryBorderColor: '#7b68ee',
      secondaryColor: '#dbeafe',
      secondaryBorderColor: '#1d4ed8',
      secondaryTextColor: '#1d4ed8',
      tertiaryColor: '#dcfce7',
      tertiaryBorderColor: '#15803d',
      tertiaryTextColor: '#15803d',
      noteBkgColor: '#fef3c7',
      noteBorderColor: '#a16207',
      noteTextColor: '#a16207',
      lineColor: '#646464',
      textColor: '#292d34',
      mainBkg: '#ede9fe',
      nodeBorder: '#7b68ee',
      clusterBkg: '#f7f8f8',
      clusterBorder: '#e8e8e8',
      edgeLabelBackground: '#ffffff',
      fontFamily,
    },
    flowchart: { htmlLabels: true, curve: 'basis' as const, nodeSpacing: 48, rankSpacing: 64, padding: 12 },
    sequence: { actorFontFamily: fontFamily, noteFontFamily: fontFamily, messageFontFamily: fontFamily },
  };
}

export function initMermaid(theme: ThemeMode) {
  if (lastTheme === theme) return;
  mermaid.initialize(getMermaidConfig(theme));
  lastTheme = theme;
}

/**
 * Remove inline fill/stroke/color declarations from an element's style attribute.
 * Required because mermaid emits classDef colors as `style="fill:#xxx !important"`,
 * which beats any stylesheet rule. Stripping these lets our CSS layer apply.
 */
function stripPaintProps(el: Element) {
  const s = el.getAttribute('style');
  if (!s) return;
  const remaining = s
    .split(';')
    .filter((p) => {
      const k = p.trim().split(':')[0]?.trim().toLowerCase();
      return k && k !== 'fill' && k !== 'stroke' && k !== 'color';
    })
    .join(';');
  if (remaining.trim()) el.setAttribute('style', remaining);
  else el.removeAttribute('style');
}

/**
 * Strip inline paint (fill/stroke/color) from every paintable mermaid element
 * inside `svg`. The selectors cover both flowchart classDef nodes and the
 * surrounding chrome (clusters, edges, labels) so the stylesheet can rule.
 *
 * Also strips the classDef-injected rules from the SVG's internal <style>
 * element, since mermaid emits them as `#id .className>*{...!important}` —
 * an ID-scoped `!important` declaration that beats any external stylesheet.
 */
export function normalizeMermaidSvg(svg: SVGElement) {
  const selectors = [
    '.node > rect',
    '.node > polygon',
    '.node > path',
    '.node > circle',
    '.node .label',
    '.node .label *',
    '.node foreignObject *',
    '.cluster > rect',
    '.cluster > polygon',
    '.cluster-label',
    '.cluster-label *',
    '.cluster-label foreignObject *',
    '.edgeLabel',
    '.edgeLabel rect',
    '.edgeLabel foreignObject *',
    '.edgePath path',
    '.marker',
    '.arrowheadPath',
  ];
  svg.querySelectorAll(selectors.join(', ')).forEach(stripPaintProps);

  // Strip classDef rules from the SVG-internal <style>. Mermaid's pattern:
  //   #mmd-id .className>*{fill:...!important;stroke:...!important;color:...!important;}
  //   #mmd-id .className span{...}
  //   #mmd-id .className tspan{...}
  // Keep all other rules (animations, markers, edge thickness, font).
  const styleEl = svg.querySelector('style');
  if (styleEl && styleEl.textContent) {
    const cleaned = styleEl.textContent.replace(
      /#[\w-]+\s+\.[\w-]+\s*(?:>\s*\*|\s+span|\s+tspan)\s*\{[^}]*\}/g,
      '',
    );
    styleEl.textContent = cleaned;
  }
}

/**
 * Find every <pre><code class="language-mermaid"> in `root` and replace with
 * a rendered SVG wrapped in a stage. Idempotent — re-renders cleanly when
 * called again (clears stale `data-mermaid-rendered` and replaces).
 */
export async function renderMermaidIn(root: HTMLElement, idPrefix: string) {
  // First, restore any previously-rendered blocks back to <pre><code> form so we
  // can re-render with the new theme. We stash the source on the wrapper.
  const rendered = root.querySelectorAll<HTMLElement>('.mermaid-rendered');
  rendered.forEach((wrap) => {
    const src = wrap.dataset.mermaidSource;
    if (!src) return;
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-mermaid';
    code.textContent = src;
    pre.appendChild(code);
    wrap.replaceWith(pre);
  });

  const blocks = root.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
  if (blocks.length === 0) return;

  let i = 0;
  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre) continue;
    const source = (code.textContent ?? '').trim();
    if (!source) continue;
    const id = `${idPrefix}-${i++}-${Date.now().toString(36)}`;

    const wrap = document.createElement('div');
    wrap.className = 'mermaid-rendered';
    wrap.dataset.mermaidSource = source;

    const stage = document.createElement('div');
    stage.className = 'mermaid-stage';
    wrap.appendChild(stage);

    pre.replaceWith(wrap);

    try {
      const { svg } = await mermaid.render(id, source);
      stage.innerHTML = svg;
      const svgEl = stage.querySelector('svg') as SVGSVGElement | null;
      if (svgEl) {
        svgEl.removeAttribute('height');
        svgEl.style.maxWidth = '100%';
        svgEl.style.height = 'auto';
        normalizeMermaidSvg(svgEl);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stage.innerHTML = `<div class="mermaid-error">Diagram error: ${msg.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c)}</div>`;
    }
  }
}

/**
 * React hook: renders every mermaid code block inside `rootRef` whenever
 * `content` or `theme` changes. Theme switches trigger a clean re-render.
 */
export function useMermaidRender(
  rootRef: RefObject<HTMLElement | null>,
  content: string | null | undefined,
  theme: ThemeMode,
  idPrefix = 'mmd',
) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !content) return;
    initMermaid(theme);
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      renderMermaidIn(root, idPrefix);
    });
    return () => {
      cancelled = true;
    };
  }, [rootRef, content, theme, idPrefix]);
}
