/** The AI Team's few glyphs, in the app's stroke set (24 viewBox, 1.75 stroke). */
const PATHS = {
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  panel: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><line x1="14.5" y1="4.5" x2="14.5" y2="19.5" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  play: <path d="M8 5.5v13l10-6.5z" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  pause: <><line x1="9" y1="6" x2="9" y2="18" /><line x1="15" y1="6" x2="15" y2="18" /></>,
  back: <path d="m14.5 6-6 6 6 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
} as const;

export type TeamIconName = keyof typeof PATHS;

export function TeamIcon({ name, size = 14 }: { name: TeamIconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
