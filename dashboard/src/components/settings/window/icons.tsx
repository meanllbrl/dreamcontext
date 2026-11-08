import type { SwPageId } from './sections';

/** One stroke path set per page (16 px, currentColor), plus search and close. */
const PATHS: Record<SwPageId | 'search' | 'x', string> = {
  general: 'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1',
  chat: 'M2.5 7.6c0-2.6 2.5-4.6 5.5-4.6s5.5 2 5.5 4.6-2.5 4.6-5.5 4.6c-.8 0-1.5-.1-2.2-.4L3 12.8l.6-2.4c-.7-.8-1.1-1.8-1.1-2.8Z',
  voice: 'M8 2a2 2 0 0 0-2 2v4a2 2 0 1 0 4 0V4a2 2 0 0 0-2-2ZM4 7.5a4 4 0 0 0 8 0M8 11.5V14',
  models: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  mcp: 'M8 1.8 13.4 4.9v6.2L8 14.2 2.6 11.1V4.9L8 1.8ZM2.6 4.9 8 8l5.4-3.1M8 8v6.2',
  super: 'M8 1.8 13 8l-5 6.2L3 8l5-6.2Z',
  assistant: 'M8 2.2 9.3 6.7 13.8 8 9.3 9.3 8 13.8 6.7 9.3 2.2 8l4.5-1.3L8 2.2Z',
  memory: 'M4 3.5a1.5 1.5 0 1 0 0 .01M12 3.5a1.5 1.5 0 1 0 0 .01M8 12.5a1.5 1.5 0 1 0 0 .01M4 5v1.5a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 12 6.5V5M8 8v3',
  sleep: 'M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6Z',
  tasks: 'M3 2.5h10v11H3v-11ZM5.5 8l1.8 1.8L10.8 6.3',
  repos: 'M2.5 4.5h4l1.2 1.5h5.8v6.5h-11v-8Z',
  teamsync: 'M4.5 2.5v6.5M4.5 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM11.5 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM11.5 5.5c0 3-7 2-7 5',
  mirror: 'M3 2.5h10v11H3v-11ZM5.5 8l1.8 1.8L10.8 6.3',
  connected: 'M4.5 6a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM11.5 13.6a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6ZM5.8 5.4l4.4 5.2M11.5 6V3.5M4.5 10v2.5',
  handsfree: 'M5.5 8.5V3.8a1 1 0 0 1 2 0V8M7.5 7V2.8a1 1 0 0 1 2 0V7.5M9.5 7.5V4a1 1 0 0 1 2 0v5.5a4.5 4.5 0 0 1-8.2 2.6L2 10a1 1 0 0 1 1.6-1.2l1.9 1.7',
  telegram: 'M14 2.5 1.8 7.3c-.5.2-.5.9 0 1.1l3 1.1 1.2 3.7c.1.4.6.5.9.2l1.7-1.6 3.1 2.3c.4.3.9.1 1-.4L14.9 3.3c.1-.5-.4-.9-.9-.8ZM4.8 9.5l6.4-4.2-4.4 5',
  system: 'M3 5l3 3-3 3M8 11.5h5',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM10.6 10.6 14 14',
  x: 'M4 4l8 8M12 4l-8 8',
};

export function SwIcon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg className="sw-ic" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={PATHS[name]} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
