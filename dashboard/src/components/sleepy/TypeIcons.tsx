import type { RecallHit } from '../../hooks/useRecall';

/**
 * Type glyphs for the Sleepy view, drawn in the SAME hand-stroke family as the
 * sidebar's {@link NavIcons} (24×24 grid, `currentColor`, one stroke weight) so
 * a Knowledge hit here reads as the Knowledge page's book, a Feature as its flag,
 * etc. Sleepy previously used loose unicode glyphs (✦ ⚑ ▦ ◈ ❉); these replace
 * them so the whole product shares one icon character. Sized via the `size` prop
 * (the rail's icons are fixed 14px; here badges/chips/nodes need 13–18px).
 */

interface IconProps { size?: number; color?: string }

function Svg({ size = 16, color = 'currentColor', children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size}
      fill="none" stroke={color} strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Knowledge — an open book (matches NavIcons). */
export function KnowledgeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 6.2C10.1 4.9 7.8 4.2 5 4.2c-.9 0-1.7.1-2.5.3v13c.8-.2 1.6-.3 2.5-.3 2.8 0 5.1.7 7 2" />
      <path d="M12 6.2c1.9-1.3 4.2-2 7-2 .9 0 1.7.1 2.5.3v13c-.8-.2-1.6-.3-2.5-.3-2.8 0-5.1.7-7 2" />
      <line x1="12" y1="6.2" x2="12" y2="19.2" />
    </Svg>
  );
}

/** Features — a planted flag (matches NavIcons). */
export function FeaturesIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <line x1="5.5" y1="21" x2="5.5" y2="3.5" />
      <path d="M5.5 4h12l-2.4 3.4L17.5 11h-12" />
    </Svg>
  );
}

/** Tasks — a checklist (matches NavIcons). */
export function TasksIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 6.5 5 8l2.4-2.6" />
      <line x1="10" y1="6.5" x2="20.5" y2="6.5" />
      <path d="M3.5 12 5 13.5 7.4 10.9" />
      <line x1="10" y1="12" x2="20.5" y2="12" />
      <line x1="3.5" y1="17.5" x2="6.5" y2="17.5" />
      <line x1="10" y1="17.5" x2="20.5" y2="17.5" />
    </Svg>
  );
}

/** Core — the brand gem (matches NavIcons). */
export function CoreIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 3.5h12l3.5 5.5L12 21 2.5 9z" />
      <path d="M2.5 9h19" />
      <path d="M9 3.5 7 9l5 12 5-12-2-5.5" />
    </Svg>
  );
}

/** Memory — a recall spark: a four-point sparkle with a small companion. */
export function MemoryIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M11 3.5c.4 3.6 1.9 5.1 5.5 5.5-3.6.4-5.1 1.9-5.5 5.5-.4-3.6-1.9-5.1-5.5-5.5 3.6-.4 5.1-1.9 5.5-5.5z" />
      <path d="M17.5 14.5c.2 1.8.9 2.5 2.7 2.7-1.8.2-2.5.9-2.7 2.7-.2-1.8-.9-2.5-2.7-2.7 1.8-.2 2.5-.9 2.7-2.7z" />
    </Svg>
  );
}

/** Search — a magnifier (replaces the ⌕ glyph). */
export function SearchIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="20" y1="20" x2="15.1" y2="15.1" />
    </Svg>
  );
}

/** Ask — a sparkle (replaces the ✦ glyph), the "intelligent" mark. */
export function SparkIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3c.5 4.6 2.4 6.5 7 7-4.6.5-6.5 2.4-7 7-.5-4.6-2.4-6.5-7-7 4.6-.5 6.5-2.4 7-7z" />
    </Svg>
  );
}

const BY_TYPE: Record<RecallHit['type'], (p: IconProps) => React.ReactElement> = {
  knowledge: KnowledgeIcon,
  feature: FeaturesIcon,
  task: TasksIcon,
  changelog: CoreIcon,
  memory: MemoryIcon,
};

/** Render the stroke icon for a recall type. */
export function TypeIcon({ type, size, color }: { type: RecallHit['type'] } & IconProps) {
  const Icon = BY_TYPE[type] ?? KnowledgeIcon;
  return <Icon size={size} color={color} />;
}
