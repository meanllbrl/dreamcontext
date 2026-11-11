/**
 * The Boards list's glyphs (16px, the rail's stroke hand). Kept apart so the list, its trash and
 * the page share them without importing each other.
 */

const glyph = {
  width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
};

export function BoardGlyph() {
  return (
    <svg {...glyph} className="wbs-glyph">
      <rect x="2" y="2.5" width="12" height="11" rx="2.5" />
      <path d="M2 6h12M6.5 6v7.5" />
    </svg>
  );
}

export function PlusGlyph() {
  return <svg {...glyph} className="wbs-glyph"><path d="M8 3.5v9M3.5 8h9" /></svg>;
}

export function SearchGlyph() {
  return <svg {...glyph} className="wbs-glyph"><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3 3" /></svg>;
}

export function TrashGlyph() {
  return (
    <svg {...glyph} className="wbs-glyph">
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1" />
    </svg>
  );
}

export function SidebarGlyph() {
  return <svg {...glyph} className="wbs-glyph"><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M6 2.5v11" /></svg>;
}
export function FolderGlyph() {
  return <svg {...glyph} className="wbs-glyph"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3L8 4.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /></svg>;
}
export function ChevronRightGlyph() {
  return <svg {...glyph} className="wbs-glyph"><path d="M6 4l4 4-4 4" /></svg>;
}
export function PinGlyph() {
  return <svg {...glyph} className="wbs-glyph"><path d="M6 2.5h4l-.5 4 2 2v1h-7v-1l2-2zM8 9.5V14" /></svg>;
}
export function ClockGlyph() {
  return <svg {...glyph} className="wbs-glyph"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></svg>;
}
export function DotsGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="wbs-glyph">
      <circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" />
    </svg>
  );
}
