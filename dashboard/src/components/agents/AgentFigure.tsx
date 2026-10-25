import { useId, type CSSProperties } from 'react';
import { FIGURE_TONES, faceOf, type AgentFace } from '../../../../src/lib/agents/figure.js';
import './AgentFigure.css';

/**
 * The agent figure ("B · Rüya", owner-approved 2026-10-24): one of 8 shapes in one of 8 identity
 * tones. Which pair an agent wears is decided ONCE, by the store, and stamped on its file (`face`);
 * an unstamped one draws the bare hash of its slug (`src/lib/agents/figure.ts`, the rule both sides
 * import).
 *
 * The drawings are the approved SVGs, verbatim (`./figure/shape-<n>.svg`, and `-24` for a target
 * under 32 px: no dream-stone, a closer frame, thicker eyes). They paint with `--fc-body`,
 * `--fc-facet` and `--fc-eye`, set here from the `--agent-face-<tone>` tokens, so light and dark
 * each get their own tone. Identity only: a state (working, asking) is drawn OUTSIDE the figure,
 * never on it.
 */

const RAW = import.meta.glob('./figure/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

interface Drawing { viewBox: string; inner: string }

function parse(svg: string): Drawing {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '0 0 100 100';
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return { viewBox, inner };
}

const DRAWINGS: Record<string, Drawing> = Object.fromEntries(
  Object.entries(RAW).map(([path, svg]) => [path.replace(/^.*\/shape-/, '').replace(/\.svg$/, ''), parse(svg)]),
);

/** The size under which the small drawing is used (NOT.md: "below 32 px"). */
export const FIGURE_SMALL_BELOW = 32;

export function AgentFigure({
  slug,
  face,
  size = 40,
  className,
}: {
  slug: string;
  /** The stamped face; absent or null draws the bare hash of the slug. */
  face?: AgentFace | null;
  size?: number;
  className?: string;
}) {
  // A mask id must be unique on the page: two crescents would otherwise share one.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const f = faceOf(slug, face ?? null);
  const drawing = DRAWINGS[size < FIGURE_SMALL_BELOW ? `${f.shape}-24` : `${f.shape}`] ?? DRAWINGS[`${f.shape}`];
  const tone = FIGURE_TONES[f.color] ?? FIGURE_TONES[0];
  const style = { width: size, height: size, '--fc-body': `var(--agent-face-${tone})` } as CSSProperties;
  if (!drawing) return <span className={`agent-figure${className ? ` ${className}` : ''}`} style={style} aria-hidden="true" />;
  const inner = drawing.inner.replace(/id="([^"]+)"/g, `id="$1-${uid}"`).replace(/url\(#([^)]+)\)/g, `url(#$1-${uid})`);
  return (
    <svg
      className={`agent-figure${className ? ` ${className}` : ''}`}
      viewBox={drawing.viewBox}
      style={style}
      aria-hidden="true"
      data-shape={f.shape}
      data-tone={tone}
      // Static, bundled, owner-approved drawings: nothing from a manifest or a user reaches here.
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}
