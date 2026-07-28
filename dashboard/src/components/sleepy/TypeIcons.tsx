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

/** Objective — the Roadmap page's stacked objective bars + "today" marker. */
export function ObjectiveIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <line x1="3" y1="4.5" x2="21" y2="4.5" />
      <rect x="3" y="7.4" width="11" height="3.2" rx="1.2" />
      <rect x="8" y="13.2" width="13" height="3.2" rx="1.2" />
      <rect x="3" y="19" width="8" height="3.2" rx="1.2" />
      <line x1="10" y1="3" x2="10" y2="21" strokeDasharray="1.6 2" opacity="0.55" />
    </Svg>
  );
}

/** Insight — the Insights page's lightbulb. */
export function InsightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 2.8a6 6 0 0 1 3.7 10.7c-.75.6-1.2 1.3-1.2 2.1v.9H9.5v-.9c0-.8-.45-1.5-1.2-2.1A6 6 0 0 1 12 2.8z" />
      <line x1="9.8" y1="19.4" x2="14.2" y2="19.4" />
      <line x1="10.6" y1="21.4" x2="13.4" y2="21.4" />
    </Svg>
  );
}

/** Thesis — the Hypotheses page's flask. */
export function ThesisIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.5 3h5" />
      <path d="M10.5 3v5.4L5.8 17a2 2 0 0 0 1.8 2.9h8.8a2 2 0 0 0 1.8-2.9L13.5 8.4V3" />
      <path d="M7.8 14.5h8.4" />
    </Svg>
  );
}

/** Automation — the Automations page's alarm clock. */
export function AutomationIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="13.6" r="7.1" />
      <path d="M12 9.9v3.7l2.5 1.5" />
      <path d="M5.1 6.6a3.1 3.1 0 0 1 3.6-2.2" />
      <path d="M18.9 6.6a3.1 3.1 0 0 0-3.6-2.2" />
    </Svg>
  );
}

// One entry per RecallHit['type'] — the Record (not Partial) is deliberate: a new
// corpus channel must fail the build here rather than silently fall back to the
// knowledge book, which is how objectives/insights/theses shipped wearing the
// wrong glyph. Each mirrors its own page's sidebar icon so a hit reads as the
// surface it opens.
const BY_TYPE: Record<RecallHit['type'], (p: IconProps) => React.ReactElement> = {
  knowledge: KnowledgeIcon,
  feature: FeaturesIcon,
  task: TasksIcon,
  changelog: CoreIcon,
  memory: MemoryIcon,
  objective: ObjectiveIcon,
  insight: InsightIcon,
  thesis: ThesisIcon,
  automation: AutomationIcon,
};

/** Render the stroke icon for a recall type. */
export function TypeIcon({ type, size, color }: { type: RecallHit['type'] } & IconProps) {
  const Icon = BY_TYPE[type] ?? KnowledgeIcon;
  return <Icon size={size} color={color} />;
}
