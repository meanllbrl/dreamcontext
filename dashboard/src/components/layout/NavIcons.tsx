import type { Page } from './Sidebar';

/**
 * The sidebar's custom icon family. Every glyph is a hand-drawn stroke icon on a
 * 24×24 grid, inheriting `currentColor` so it picks up the rail's idle / hover /
 * active accent states. They're deliberately literal — a checklist for Tasks, a
 * book for Knowledge — so a first-time user can read the rail without learning
 * what an abstract glyph means. The whole set shares one
 * stroke weight and corner rounding so it feels like a single character, kept in
 * the same spirit as Sleepy's two-eyes mark (see {@link SleepyEyes}).
 */
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" {...STROKE} aria-hidden="true">
      {children}
    </svg>
  );
}

/** Tasks — a checklist: rows ticked off top-to-bottom. */
function TasksIcon() {
  return (
    <Svg>
      <path d="M3.5 6.5 5 8l2.4-2.6" />
      <line x1="10" y1="6.5" x2="20.5" y2="6.5" />
      <path d="M3.5 12 5 13.5 7.4 10.9" />
      <line x1="10" y1="12" x2="20.5" y2="12" />
      <line x1="3.5" y1="17.5" x2="6.5" y2="17.5" />
      <line x1="10" y1="17.5" x2="20.5" y2="17.5" />
    </Svg>
  );
}

/** Hypotheses — a flask: the falsifiable-claim validation loop. */
function HypothesesIcon() {
  return (
    <Svg>
      <path d="M9.5 3h5" />
      <path d="M10.5 3v5.4L5.8 17a2 2 0 0 0 1.8 2.9h8.8a2 2 0 0 0 1.8-2.9L13.5 8.4V3" />
      <path d="M7.8 14.5h8.4" />
    </Svg>
  );
}

/** Roadmap — a horizontal timeline of objective bars stacked left→right, with a
   dashed "today" marker: the PO board reduced to its silhouette. */
function RoadmapIcon() {
  return (
    <Svg>
      <line x1="3" y1="4.5" x2="21" y2="4.5" />
      <rect x="3" y="7.4" width="11" height="3.2" rx="1.2" />
      <rect x="8" y="13.2" width="13" height="3.2" rx="1.2" />
      <rect x="3" y="19" width="8" height="3.2" rx="1.2" />
      <line x1="10" y1="3" x2="10" y2="21" strokeDasharray="1.6 2" opacity="0.55" />
    </Svg>
  );
}

/** Council — two speech bubbles facing off: a debate. */
function CouncilIcon() {
  return (
    <Svg>
      <path d="M3 5.5h9a1.8 1.8 0 0 1 1.8 1.8v3.4A1.8 1.8 0 0 1 12 12.5H7l-3 2.6V12.5a1.8 1.8 0 0 1-1-1.6V7.3A1.8 1.8 0 0 1 3 5.5z" />
      <path d="M21 11.5v3.4a1.8 1.8 0 0 1-1.8 1.8H16l-2.4 2.1v-2.1" />
    </Svg>
  );
}

/** Core — the brand gem: identity, soul, the project's faceted center. */
function CoreIcon() {
  return (
    <Svg>
      <path d="M6 3.5h12l3.5 5.5L12 21 2.5 9z" />
      <path d="M2.5 9h19" />
      <path d="M9 3.5 7 9l5 12 5-12-2-5.5" />
    </Svg>
  );
}

/** Knowledge — an open book. */
function KnowledgeIcon() {
  return (
    <Svg>
      <path d="M12 6.2C10.1 4.9 7.8 4.2 5 4.2c-.9 0-1.7.1-2.5.3v13c.8-.2 1.6-.3 2.5-.3 2.8 0 5.1.7 7 2" />
      <path d="M12 6.2c1.9-1.3 4.2-2 7-2 .9 0 1.7.1 2.5.3v13c-.8-.2-1.6-.3-2.5-.3-2.8 0-5.1.7-7 2" />
      <line x1="12" y1="6.2" x2="12" y2="19.2" />
    </Svg>
  );
}

/** Taxonomy — a label/tag with its eyelet. */
function TaxonomyIcon() {
  return (
    <Svg>
      <path d="M3 11.4V5a2 2 0 0 1 2-2h6.4a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8l-6.4 6.4a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 3 11.4z" />
      <circle cx="7.6" cy="7.6" r="1.3" />
    </Svg>
  );
}

/** Map (brain) — a connected node graph. */
function BrainIcon() {
  return (
    <Svg>
      <circle cx="6" cy="6" r="2.1" />
      <circle cx="18" cy="7.5" r="2.1" />
      <circle cx="8.5" cy="18" r="2.1" />
      <circle cx="17.5" cy="17" r="2.1" />
      <line x1="7.7" y1="7.4" x2="8.2" y2="15.9" />
      <line x1="8" y1="6.4" x2="15.9" y2="7.1" />
      <line x1="10.6" y1="17.7" x2="15.4" y2="17.2" />
      <line x1="17.6" y1="9.5" x2="9.5" y2="16.2" />
    </Svg>
  );
}

/** Sleep cycle — a crescent moon. */
function SleepIcon() {
  return (
    <Svg>
      <path d="M20.5 14.6A8.2 8.2 0 0 1 9.4 3.5a8.2 8.2 0 1 0 11.1 11.1z" />
    </Svg>
  );
}

/** Packs — stacked layers. */
function PacksIcon() {
  return (
    <Svg>
      <path d="M12 3 21.5 8 12 13 2.5 8z" />
      <path d="M2.5 12 12 17l9.5-5" />
      <path d="M2.5 16 12 21l9.5-5" />
    </Svg>
  );
}

/** Settings — sliders. */
function SettingsIcon() {
  return (
    <Svg>
      <line x1="3.5" y1="8" x2="20.5" y2="8" />
      <circle cx="9" cy="8" r="2.2" />
      <line x1="3.5" y1="16" x2="20.5" y2="16" />
      <circle cx="15" cy="16" r="2.2" />
    </Svg>
  );
}

/** Insights (lab) — a lightbulb: the moment an insight lands. */
function LabIcon() {
  return (
    <Svg>
      <path d="M12 2.8a6 6 0 0 1 3.7 10.7c-.75.6-1.2 1.3-1.2 2.1v.9H9.5v-.9c0-.8-.45-1.5-1.2-2.1A6 6 0 0 1 12 2.8z" />
      <line x1="9.8" y1="19.4" x2="14.2" y2="19.4" />
      <line x1="10.6" y1="21.4" x2="13.4" y2="21.4" />
    </Svg>
  );
}

/** About — "What is this?": a question mark in a circle. */
function AboutIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.5-2.7 2.5" />
      <circle cx="11.9" cy="16.6" r="0.7" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Announcements — a megaphone: what's new, said out loud. */
function AnnouncementsIcon() {
  return (
    <Svg>
      <path d="M3 11 21 6v12L3 14z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </Svg>
  );
}

/** Page → icon. Sleepy is handled separately (its animated eyes mark). */
const ICONS: Partial<Record<Page, () => React.ReactElement>> = {
  tasks: TasksIcon,
  roadmap: RoadmapIcon,
  hypotheses: HypothesesIcon,
  lab: LabIcon,
  council: CouncilIcon,
  core: CoreIcon,
  knowledge: KnowledgeIcon,
  taxonomy: TaxonomyIcon,
  brain: BrainIcon,
  sleep: SleepIcon,
  announcements: AnnouncementsIcon,
  packs: PacksIcon,
  settings: SettingsIcon,
  about: AboutIcon,
};

/** Render the custom nav icon for a page, or null if none is mapped. */
export function NavIcon({ page }: { page: Page }) {
  const Icon = ICONS[page];
  return Icon ? <Icon /> : null;
}
