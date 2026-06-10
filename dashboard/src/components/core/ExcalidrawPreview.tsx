import { useEffect, useRef, useState } from 'react';
import panzoom from 'panzoom';
import { useTheme } from '../../context/ThemeContext';
import { extractExcalidrawScene } from '../../lib/excalidraw';
import './ExcalidrawPreview.css';

interface Props {
  content: string;
}

/**
 * Renders an Obsidian Excalidraw board as a static SVG with pan/zoom-to-fit.
 *
 * The heavy `@excalidraw/excalidraw` bundle is loaded lazily (only when an
 * Excalidraw knowledge file is opened) via dynamic import. We use `exportToSvg`
 * rather than the editor component — these are read-only figures, so a plain
 * SVG + panzoom (the same interaction the mermaid diagrams use) is lighter and
 * needs no editor chrome.
 */
export function ExcalidrawPreview({ content }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const { resolved } = useTheme();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    let cancelled = false;
    let disposePz: (() => void) | null = null;
    let ro: ResizeObserver | null = null;

    const scene = extractExcalidrawScene(content);
    if (!scene) {
      setError('Could not read the Excalidraw drawing in this file.');
      return;
    }
    setError(null);

    (async () => {
      try {
        const { exportToSvg } = await import('@excalidraw/excalidraw');
        if (cancelled) return;

        const svgEl = await exportToSvg({
          elements: scene.elements as never,
          files: (scene.files ?? null) as never,
          appState: {
            ...(scene.appState ?? {}),
            exportBackground: false,
            exportWithDarkMode: resolved === 'dark',
            exportEmbedScene: false,
          },
          exportPadding: 24,
        });
        if (cancelled) return;

        // Lock the SVG to its natural size so panzoom transforms scale
        // predictably (excalidraw emits width/height in px; fine to keep but
        // normalize maxWidth + transform origin — same approach as mermaid).
        const w = parseFloat(svgEl.getAttribute('width') || '0') || svgEl.viewBox.baseVal.width;
        const h = parseFloat(svgEl.getAttribute('height') || '0') || svgEl.viewBox.baseVal.height;
        svgEl.style.width = `${w}px`;
        svgEl.style.height = `${h}px`;
        svgEl.style.maxWidth = 'none';
        svgEl.style.transformOrigin = '0 0';

        stage.innerHTML = '';
        stage.appendChild(svgEl);

        const pz = panzoom(svgEl, {
          maxZoom: 12,
          minZoom: 0.1,
          bounds: false,
          zoomDoubleClickSpeed: 1.6,
          smoothScroll: false,
        });
        disposePz = () => pz.dispose();

        const fit = () => {
          try {
            const box = stage.getBoundingClientRect();
            if (box.width === 0 || box.height === 0 || w === 0 || h === 0) return;
            const padding = 24;
            const scale = Math.min(
              (box.width - padding) / w,
              (box.height - padding) / h,
              1,
            );
            pz.zoomAbs(0, 0, 1);
            pz.moveTo(0, 0);
            pz.zoomAbs(0, 0, scale);
            const tx = (box.width - w * scale) / 2;
            const ty = (box.height - h * scale) / 2;
            pz.moveTo(tx, ty);
          } catch { /* noop */ }
        };
        requestAnimationFrame(() => requestAnimationFrame(fit));
        ro = new ResizeObserver(() => fit());
        ro.observe(stage);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render Excalidraw drawing.');
        }
      }
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      disposePz?.();
      stage.innerHTML = '';
    };
  }, [content, resolved]);

  if (error) {
    return <div className="excalidraw-error">{error}</div>;
  }

  return (
    <div className="excalidraw-preview" data-theme={resolved}>
      <div ref={stageRef} className="excalidraw-stage" />
    </div>
  );
}
