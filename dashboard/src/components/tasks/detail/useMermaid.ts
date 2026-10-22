import { useEffect, type RefObject } from 'react';
import mermaid from 'mermaid';
import panzoom from 'panzoom';
import { initMermaid, normalizeMermaidSvg } from '../../../lib/mermaidRender';
import { stripBlockedUrls } from './sanitize';

/**
 * Mermaid in the task drawer: every ```mermaid block inside `rootRef` (already sanitized HTML,
 * see sanitize.ts) becomes an SVG on a pan/zoom stage with − ⤢ + controls and click-to-zoom on a
 * node. Carried over unchanged from the old single-blob drawer; it now runs per body section.
 * `html` is the section's sanitized HTML: a new value re-renders.
 */

const CLOSE_FOR: Record<string, string> = { '[': ']', '(': ')', '{': '}' };

// Quote unquoted node labels on a single line. Handles labels containing
// brackets, regex chars, etc. by scanning to the LAST matching close bracket
// on the line (mermaid requires labels on one line anyway).
function quoteLabelsInLine(line: string): string {
  // Skip class/classDef/style/link lines and subgraph headers.
  if (/^\s*(classDef|class|style|linkStyle|click|subgraph)\b/.test(line)) return line;

  let out = '';
  let i = 0;
  const n = line.length;

  while (i < n) {
    // Look for `Id[` / `Id(` / `Id{` starting here.
    const m = line.slice(i).match(/^(\s*[A-Za-z_]\w*\s*)([\[\(\{])/);
    if (!m) {
      out += line[i];
      i++;
      continue;
    }
    const idPart = m[1];
    const open = m[2];
    const close = CLOSE_FOR[open];
    const labelStart = i + idPart.length + 1;

    // Find the LAST matching close bracket on the line (handles nested).
    const lastClose = line.lastIndexOf(close);
    if (lastClose <= labelStart) {
      out += line[i];
      i++;
      continue;
    }
    const label = line.slice(labelStart, lastClose);
    const trimmed = label.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      // Already quoted — leave as is.
      out += line.slice(i, lastClose + 1);
      i = lastClose + 1;
      continue;
    }
    if (trimmed === '') {
      out += line.slice(i, lastClose + 1);
      i = lastClose + 1;
      continue;
    }
    const escaped = trimmed
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    out += `${idPart}${open}"${escaped}"${close}`;
    i = lastClose + 1;
  }
  return out;
}

export function sanitizeMermaid(src: string): string {
  return src.split('\n').map(quoteLabelsInLine).join('\n');
}

export function useMermaid(rootRef: RefObject<HTMLElement | null>, html: string, slug: string, theme: 'light' | 'dark'): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !html) return;
    initMermaid(theme);

    let cancelled = false;
    const disposers: Array<() => void> = [];
    let rendering = false;

    const renderAll = async () => {
      if (cancelled || rendering) return;
      // Restore any previously-rendered mermaid wrappers to source form so a
      // theme change triggers a fresh render with the new palette.
      root.querySelectorAll<HTMLElement>('.mermaid-rendered').forEach((wrap) => {
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

      rendering = true;
      // Tear down any prior panzoom/observer attachments before re-rendering.
      while (disposers.length) {
        const d = disposers.pop();
        try { d?.(); } catch { /* noop */ }
      }

      for (let i = 0; i < blocks.length; i++) {
        if (cancelled) break;
        const code = blocks[i] as HTMLElement;
        const pre = code.parentElement;
        if (!pre) continue;
        const source = sanitizeMermaid(code.textContent ?? '');
        const id = `mmd-${slug.replace(/[^a-z0-9-]/gi, '')}-${i}-${Date.now().toString(36)}`;

        const wrap = document.createElement('div');
        wrap.className = 'mermaid-rendered';
        wrap.dataset.mermaidSource = source;

        const stage = document.createElement('div');
        stage.className = 'mermaid-stage';
        wrap.appendChild(stage);

        const controls = document.createElement('div');
        controls.className = 'mermaid-controls';
        controls.innerHTML = `
          <button type="button" data-act="out" title="Zoom out">−</button>
          <button type="button" data-act="reset" title="Fit">⤢</button>
          <button type="button" data-act="in" title="Zoom in">+</button>
        `;
        wrap.appendChild(controls);

        pre.replaceWith(wrap);

        try {
          const { svg, bindFunctions } = await mermaid.render(id, source);
          if (cancelled) break;
          stage.innerHTML = svg;
          // Mermaid sanitizes its own labels; this drawer's URL rule (no /api/, no javascript:) still applies.
          stripBlockedUrls(stage);
          bindFunctions?.(stage);
          wrap.dataset.mermaidRendered = '1';

          const svgEl = stage.querySelector('svg') as SVGSVGElement | null;
          if (!svgEl) continue;
          normalizeMermaidSvg(svgEl);
          // Lock SVG to its natural (viewBox) pixel size so panzoom transforms
          // scale predictably. Mermaid emits width="100%" which competes with
          // the panzoom transform and breaks the fit math.
          const vb = svgEl.viewBox.baseVal;
          const svgW = vb && vb.width > 0 ? vb.width : svgEl.getBoundingClientRect().width;
          const svgH = vb && vb.height > 0 ? vb.height : svgEl.getBoundingClientRect().height;
          svgEl.removeAttribute('width');
          svgEl.removeAttribute('height');
          svgEl.style.width = `${svgW}px`;
          svgEl.style.height = `${svgH}px`;
          svgEl.style.maxWidth = 'none';
          svgEl.style.transformOrigin = '0 0';

          const pz = panzoom(svgEl, {
            maxZoom: 12,
            minZoom: 0.15,
            bounds: false,
            zoomDoubleClickSpeed: 1.6,
            smoothScroll: false,
          });

          const fit = () => {
            try {
              const stageBox = stage.getBoundingClientRect();
              if (stageBox.width === 0 || stageBox.height === 0) return;
              const padding = 32;
              const scale = Math.min(
                (stageBox.width - padding) / svgW,
                (stageBox.height - padding) / svgH,
                1,
              );
              pz.zoomAbs(0, 0, 1);
              pz.moveTo(0, 0);
              pz.zoomAbs(0, 0, scale);
              const tx = (stageBox.width - svgW * scale) / 2;
              const ty = (stageBox.height - svgH * scale) / 2;
              pz.moveTo(tx, ty);
            } catch { /* noop */ }
          };
          requestAnimationFrame(() => requestAnimationFrame(fit));
          const ro = new ResizeObserver(() => fit());
          ro.observe(stage);

          // ── Click-to-zoom on individual nodes.
          // Animates the panzoom transform so the clicked node fills ~60% of the
          // stage. Clicking the stage background (or the SAME node twice) fits
          // back to the full diagram view.
          let zoomedNode: Element | null = null;
          const zoomToNode = (node: Element) => {
            try {
              const nodeRect = node.getBoundingClientRect();
              const stageBox = stage.getBoundingClientRect();
              if (nodeRect.width === 0) return;
              const cx = nodeRect.left + nodeRect.width / 2 - stageBox.left;
              const cy = nodeRect.top + nodeRect.height / 2 - stageBox.top;
              const desiredScale = Math.min(
                (stageBox.width * 0.6) / nodeRect.width,
                (stageBox.height * 0.6) / nodeRect.height,
                6,
              );
              const t = pz.getTransform();
              const mult = desiredScale / t.scale;
              if (Math.abs(mult - 1) < 0.01) return;
              pz.smoothZoom(cx, cy, mult);
            } catch { /* noop */ }
          };

          const onStageClick = (e: MouseEvent) => {
            const target = e.target as Element | null;
            const node = target?.closest('g.node, g.cluster') ?? null;
            if (!node) {
              // Click on empty stage — reset to fit.
              if (zoomedNode) { zoomedNode = null; fit(); }
              return;
            }
            if (zoomedNode === node) {
              // Second click on same node — unzoom.
              zoomedNode = null;
              fit();
            } else {
              zoomedNode = node;
              zoomToNode(node);
            }
          };
          stage.addEventListener('click', onStageClick);
          // Visual affordance: zoomable nodes get a pointer cursor.
          svgEl.querySelectorAll<HTMLElement>('g.node, g.cluster').forEach((n) => {
            n.style.cursor = 'zoom-in';
          });

          controls.addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = (e.target as HTMLElement).closest('button');
            if (!btn) return;
            const stageBox = stage.getBoundingClientRect();
            const cx = stageBox.width / 2;
            const cy = stageBox.height / 2;
            const act = btn.getAttribute('data-act');
            if (act === 'in') pz.smoothZoom(cx, cy, 1.4);
            else if (act === 'out') pz.smoothZoom(cx, cy, 1 / 1.4);
            else if (act === 'reset') { zoomedNode = null; fit(); }
          });

          disposers.push(() => {
            ro.disconnect();
            stage.removeEventListener('click', onStageClick);
            pz.dispose();
          });
        } catch (err) {
          if (cancelled) break;
          const msg = err instanceof Error ? err.message : String(err);
          stage.innerHTML = `<pre class="mermaid-error">Mermaid render failed: ${msg.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c)}</pre>`;
        }
      }
      rendering = false;
    };

    // Initial render.
    renderAll();

    // Self-healing: if React re-injects bodyHtml (or HMR), raw <pre><code> may
    // reappear without the effect re-firing. A MutationObserver triggers a
    // re-render whenever raw mermaid code exists but no rendered SVG.
    const observer = new MutationObserver(() => {
      if (cancelled || rendering) return;
      const hasRaw = root.querySelector('pre > code.language-mermaid');
      const hasRendered = root.querySelector('.mermaid-rendered .mermaid-stage svg');
      if (hasRaw && (!hasRendered || hasRaw)) {
        // Only re-render if there's actually raw code waiting.
        if (hasRaw) renderAll();
      }
    });
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      cancelled = true;
      observer.disconnect();
      while (disposers.length) {
        const d = disposers.pop();
        try { d?.(); } catch { /* noop */ }
      }
    };
  }, [html, slug, theme, rootRef]);
}
