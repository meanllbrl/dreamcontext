import type { SVGProps } from 'react';

/**
 * Settings section icons — one consistent line-icon set (Heroicons v2 outline)
 * so the nav rail reads as one system instead of the old look-alike Unicode
 * glyphs (⬡ ⇅ ❖ ⊕ …) that were easy to confuse. Single stroke style, 20px,
 * `currentColor` so active/hover states tint via CSS.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Platforms — a 2×2 grid of agent surfaces. */
export function PlatformsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.75" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.75" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.75" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.75" />
    </Icon>
  );
}

/** Cloud Tasks — a cloud. */
export function CloudTasksIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 18.5a4 4 0 0 1-.7-7.94 5.25 5.25 0 0 1 10.16-1.9A3.75 3.75 0 0 1 17.5 18.5H6.5Z" />
    </Icon>
  );
}

/** Memory — a database / knowledge store. */
export function MemoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
      <path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
    </Icon>
  );
}

/** Connections — share nodes across projects. */
export function ConnectionsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.2 10.8 15.8 7.2M8.2 13.2l7.6 3.6" />
    </Icon>
  );
}

/** Task Format — a list of fields. */
export function FormatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <circle cx="4" cy="6" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1.25" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Agents — an in-app terminal. */
export function AgentsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.25" />
      <path d="M7.5 9.5 10 12l-2.5 2.5M12.5 14.5h4" />
    </Icon>
  );
}

/** Sleepy — a moon. */
export function SleepyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20.5 14.3A8.25 8.25 0 0 1 9.7 3.5a8.25 8.25 0 1 0 10.8 10.8Z" />
    </Icon>
  );
}

/** Brain Repo & Collaboration — a cloud with a sync arrow. */
export function BrainRepoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 17.5a4 4 0 0 1-.7-7.94 5.25 5.25 0 0 1 10.16-1.9A3.75 3.75 0 0 1 17.5 17.5H6.5Z" />
      <path d="M9.5 13.5 12 11l2.5 2.5M12 11v6.5" />
    </Icon>
  );
}

/** System dependencies — a wrench (setup/tooling). */
export function SystemIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M11.42 15.17 6.9 19.7a2.1 2.1 0 0 1-2.97-2.97l4.52-4.52a6 6 0 0 1 7.5-7.6l-3.4 3.4 3.44 3.44 3.4-3.4a6 6 0 0 1-7.6 7.5Z" />
    </Icon>
  );
}

/** Learning — a spark: the layer that forms and tests hypotheses. */
export function LearningIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5" />
      <circle cx="12" cy="12" r="3.25" />
    </Icon>
  );
}

/** Recall — a magnifier over a document: how memory is fetched back. */
export function RecallIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.75" cy="10.75" r="6.25" />
      <path d="m15.5 15.5 4 4" />
      <path d="M8.25 9.75h5M8.25 12.5h3.5" />
    </Icon>
  );
}

/** ClickUp — three stacked task lines with a check. */
export function ClickUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6.5h9M4 12h9M4 17.5h6" />
      <path d="m15.5 16 2 2 4-4.5" />
    </Icon>
  );
}

/** Team sync — two people sharing one repo. */
export function TeamSyncIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M3.5 19.5a4.5 4.5 0 0 1 9 0" />
      <path d="M15.5 5.5a2.75 2.75 0 0 1 0 5.5" />
      <path d="M17 15.5a4.5 4.5 0 0 1 3.5 4" />
    </Icon>
  );
}

/** Linked repos — a folder tied to a remote. */
export function LinkedReposIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h3.4l1.6 2h4.5A1.5 1.5 0 0 1 16 9.5V11" />
      <path d="M3.5 7.5v9A1.5 1.5 0 0 0 5 18h6" />
      <path d="M14.5 15.5a2 2 0 0 1 2-2h1a2 2 0 1 1 0 4h-1" />
      <path d="M20.5 15.5a2 2 0 0 0-2-2" />
      <path d="M15.5 15.5h4" />
    </Icon>
  );
}

export const SETTINGS_ICONS = {
  platforms: PlatformsIcon,
  format: FormatIcon,
  agents: AgentsIcon,
  sleepy: SleepyIcon,
  memory: MemoryIcon,
  learning: LearningIcon,
  recall: RecallIcon,
  github: BrainRepoIcon,
  teamsync: TeamSyncIcon,
  linkedrepos: LinkedReposIcon,
  clickup: ClickUpIcon,
  connections: ConnectionsIcon,
  system: SystemIcon,
  /** Legacy id kept so the old `tasks` icon import site (if any) still resolves. */
  tasks: CloudTasksIcon,
} as const;

export type SettingsIconId = keyof typeof SETTINGS_ICONS;
