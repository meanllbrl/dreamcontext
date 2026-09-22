import type { Page } from './Sidebar';

/**
 * The sidebar's custom icon family. Every glyph is a hand-drawn stroke icon on a
 * 24×24 grid, inheriting `currentColor` so it picks up the rail's idle / hover /
 * active accent states. They're deliberately literal — a checklist for Tasks, a
 * book for Knowledge — so a first-time user can read the rail without learning
 * what an abstract glyph means. The whole set shares one
 * stroke weight and corner rounding so it feels like a single character, kept in
 * the same spirit as Sleepy's two-eyes mark (see {@link SleepyEyes}).
 *
 * ── TWO INVARIANTS, now enforced by `tests/unit/sidebar-nav.test.ts` ──────────
 * 1. ONE stroke weight and ONE linecap/linejoin pair for the whole set — a second
 *    `strokeWidth` literal anywhere in this file fails the drift test. The set
 *    reading as one hand is the only reason a rail of 15 custom glyphs does not
 *    look like 15 downloads.
 * 2. Every `Page` in `NAV_GROUPS` has an entry in {@link ICONS} and vice versa,
 *    so a nav item can never ship with a blank badge.
 *
 * ── "Literal" is a standard this set had to be held to, not a compliment ──────
 * Four glyphs were redrawn on 2026-09-22 because they depicted a category rather
 * than their page. The worst was Automations: an ALARM CLOCK, drawn when the page
 * was a list of scheduled jobs. That page is now a member list of AGENTS — people
 * with photos who post messages — so the clock described a feature that no longer
 * exists, on the item the product cares most about.
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

/** Council — two speech bubbles facing off: a debate. Both are now CLOSED shapes with
    the same corner rhythm; the second used to be a partial path, so at 14px the pair read
    as one bubble and a stray stroke rather than as two voices. */
function CouncilIcon() {
  return (
    <Svg>
      <path d="M2.8 6.4a1.8 1.8 0 0 1 1.8-1.8h7.2a1.8 1.8 0 0 1 1.8 1.8v3.4a1.8 1.8 0 0 1-1.8 1.8H6.6l-3.8 2.8v-2.8a1.8 1.8 0 0 1 0-5.2z" />
      <path d="M17 9.4h2.6a1.8 1.8 0 0 1 1.8 1.8v3.4a1.8 1.8 0 0 1-1.8 1.8h-.8v2.6l-3.4-2.6h-3a1.8 1.8 0 0 1-1.8-1.8v-1" />
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

/** Sleep cycle — a crescent moon with two drifting z's. The moon alone was a filled
    silhouette that read as Insights' old bulb at 14px; the z's say SLEEP, not "night". */
function SleepIcon() {
  return (
    <Svg>
      <path d="M18.6 13.9A7.4 7.4 0 0 1 8.6 3.9a7.4 7.4 0 1 0 10 10z" />
      <path d="M15.4 3.4h3.1l-3.1 3.4h3.1" />
      <path d="M19.9 8.9h2.2l-2.2 2.4h2.2" />
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

/** Insights — a rising sparkline over its baseline, with a dot at the latest point.
    Was a lightbulb, which is what every app draws for everything; Insights is TRACKED
    METRICS, and a trend line is the thing the page actually shows. */
function LabIcon() {
  return (
    <Svg>
      <path d="M3 20.2V4" />
      <path d="M3 20.2h18" />
      <path d="M6.2 16.4l4-4.6 3.2 2.6 4.6-6.2" />
      <circle cx="18" cy="8.2" r="1.5" fill="currentColor" stroke="none" />
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

/** Agents — two overlapping people, the front one with a speech tail.
 *
 * THE PAGE IS A MEMBER LIST: agents have photos, names and modes, and they POST. The
 * previous glyph was an alarm clock, drawn back when the page was a list of scheduled
 * jobs — it depicted a retired feature on the product's most important rail item. Two
 * heads say "these are a roster of someones"; the tail says "they talk to you"; and
 * overlapping them keeps both legible at 14px, where two separate figures would smear.
 * No clock, no gear, no lightning: none of those is what a user comes here to find. */
function AutomationsIcon() {
  return (
    <Svg>
      {/* The one behind — head and shoulder only, enough to read as a second member. */}
      <circle cx="16.4" cy="7.2" r="2.5" />
      <path d="M13.9 13.2a4.6 4.6 0 0 1 7.6 1.9" />
      {/* The one in front, carrying the speech tail. */}
      <circle cx="8.8" cy="8.6" r="3.2" />
      <path d="M3 18.4a6 6 0 0 1 11.6 0v1.9H6.2l-2.6 2.1v-2.1H3z" />
    </Svg>
  );
}

/**
 * Page → icon. Sleepy is handled separately (its animated eyes mark).
 *
 * EXPORTED for `tests/unit/sidebar-nav.test.ts`, which pins this map against
 * `NAV_GROUPS` in both directions — a nav item with no glyph, or a glyph for a page
 * that left the rail, both fail there instead of shipping as a blank badge.
 */
export const ICONS: Partial<Record<Page, () => React.ReactElement>> = {
  tasks: TasksIcon,
  roadmap: RoadmapIcon,
  hypotheses: HypothesesIcon,
  lab: LabIcon,
  automations: AutomationsIcon,
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
