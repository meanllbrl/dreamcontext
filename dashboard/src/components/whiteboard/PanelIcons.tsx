/**
 * The page panel's icon set: line glyphs drawn the way the sidebar's are (layout/NavIcons.tsx)
 * — a 24×24 grid, `currentColor` stroke, ONE stroke weight and one linecap/linejoin pair — so
 * a header of six icon buttons reads as one hand rather than a row of mixed text glyphs.
 *
 * Standalone on purpose: the wiki card's in-card reader uses the same back / forward / more
 * icons without any of the panel's chrome.
 */
import type { ReactNode } from 'react';

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...STROKE} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export interface PanelIconProps { size?: number }

/** Back — a chevron pointing left. */
export function BackIcon({ size }: PanelIconProps) {
  return <Svg size={size}><path d="M15 5 8 12l7 7" /></Svg>;
}

/** Forward — a chevron pointing right. */
export function ForwardIcon({ size }: PanelIconProps) {
  return <Svg size={size}><path d="m9 5 7 7-7 7" /></Svg>;
}

/** Expand — two corners pulled outward. */
export function ExpandIcon({ size }: PanelIconProps) {
  return (
    <Svg size={size}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-6.5 6.5" />
      <path d="M10 20H4v-6" />
      <path d="M4 20l6.5-6.5" />
    </Svg>
  );
}

/** Collapse — two corners pushed back in. */
export function CollapseIcon({ size }: PanelIconProps) {
  return (
    <Svg size={size}>
      <path d="M19 11h-6V5" />
      <path d="M13 11l7-7" />
      <path d="M5 13h6v6" />
      <path d="M11 13l-7 7" />
    </Svg>
  );
}

/** More — three dots in a row (the ⋯ menu). */
export function MoreIcon({ size }: PanelIconProps) {
  return (
    <Svg size={size}>
      <circle cx="5.5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="18.5" cy="12" r="1" />
    </Svg>
  );
}

/** Close — an ×. */
export function CloseIcon({ size }: PanelIconProps) {
  return (
    <Svg size={size}>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </Svg>
  );
}

/** Open in the app — a page with an arrow leaving its corner. */
export function OpenInAppIcon({ size }: PanelIconProps) {
  return (
    <Svg size={size}>
      <path d="M13 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <path d="M16 4h4v4" />
      <path d="M20 4l-8 8" />
    </Svg>
  );
}

/** Open on computer — a laptop. */
export function ComputerIcon({ size }: PanelIconProps) {
  return (
    <Svg size={size}>
      <rect x="4.5" y="5" width="15" height="10.5" rx="1.5" />
      <path d="M2.5 19h19" />
    </Svg>
  );
}

/** Reveal in Finder — a folder. */
export function FolderIcon({ size }: PanelIconProps) {
  return (
    <Svg size={size}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </Svg>
  );
}

/** Copy path — two stacked sheets. */
export function CopyIcon({ size }: PanelIconProps) {
  return (
    <Svg size={size}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </Svg>
  );
}
