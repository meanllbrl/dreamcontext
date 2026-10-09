import { useId } from 'react';
import { GEM_PATHS, GEM_RING_WIDTH, GEM_VIEWBOX } from '../../components/brand/gemPieces';

/**
 * The dream gem assembling itself: the same four pieces the opening splash and the Node setup
 * screen converge, filled from the brand tokens (no colour literals). Pieces fly in on one
 * `--ease-out` curve over `--motion-converge`; the ring and hairlines settle after. Under
 * `prefers-reduced-motion` the finished mark simply shows (Onboarding.css).
 */
export function GemConverge({ size = 'lg' }: { size?: 'md' | 'lg' }) {
  // Ids are per instance: two gems on one page must not share a clip path or gradient.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const clip = `ob-gem-clip-${uid}`;
  const body = `ob-gem-body-${uid}`;
  const dark = `ob-gem-dark-${uid}`;
  return (
    <svg className={`ob-gem ob-gem--${size}`} viewBox={GEM_VIEWBOX} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clip} clipPathUnits="userSpaceOnUse">
          <path d={GEM_PATHS.body} />
        </clipPath>
        <linearGradient id={body} x1="300" y1="230" x2="420" y2="780" gradientUnits="userSpaceOnUse">
          <stop offset="0" className="ob-gem-stop-light" />
          <stop offset="1" className="ob-gem-stop-mid" />
        </linearGradient>
        <linearGradient id={dark} x1="400" y1="330" x2="780" y2="680" gradientUnits="userSpaceOnUse">
          <stop offset="0" className="ob-gem-stop-mid" />
          <stop offset="1" className="ob-gem-stop-deep" />
        </linearGradient>
      </defs>
      <path className="ob-gem-ring" d={GEM_PATHS.ring} strokeWidth={GEM_RING_WIDTH} />
      <g className="ob-gem-piece ob-gem-left">
        <g clipPath={`url(#${clip})`}><path d={GEM_PATHS.left} fill={`url(#${body})`} /></g>
      </g>
      <g className="ob-gem-piece ob-gem-chevron">
        <g clipPath={`url(#${clip})`}><path className="ob-gem-chevron-fill" d={GEM_PATHS.chevron} /></g>
      </g>
      <g className="ob-gem-piece ob-gem-wedge">
        <g clipPath={`url(#${clip})`}><path d={GEM_PATHS.wedge} fill={`url(#${dark})`} /></g>
      </g>
      <g className="ob-gem-piece ob-gem-rhombus">
        <path className="ob-gem-rhombus-edge" d={GEM_PATHS.rhombus} fill={`url(#${dark})`} />
      </g>
      <path className="ob-gem-hairlines" d={GEM_PATHS.hairlines} />
    </svg>
  );
}
