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

export const SETTINGS_ICONS = {
  platforms: PlatformsIcon,
  tasks: CloudTasksIcon,
  memory: MemoryIcon,
  connections: ConnectionsIcon,
  format: FormatIcon,
  brain: BrainRepoIcon,
  agents: AgentsIcon,
  sleepy: SleepyIcon,
} as const;

export type SettingsIconId = keyof typeof SETTINGS_ICONS;
