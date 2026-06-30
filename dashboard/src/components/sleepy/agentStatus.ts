import type { SleepyMood } from './SleepyMascot';
import type { TermStatus } from './agentSession';

/**
 * The single source of truth for "what state is this agent session in?" — the user's
 * #1 need ("I can't tell if it's working or not"). Pure + framework-free so it drives
 * BOTH the expanded session-list rail and the collapsed status bubbles identically, and
 * is unit-testable in isolation.
 *
 * Five mutually exclusive kinds, each with a distinct one-word label, mascot mood, and a
 * `data-kind` hook the CSS colours from design tokens (no hardcoded hues here):
 *   - saved    — a restored roster entry with NO live session (Resume to spawn). Indigo.
 *   - starting — the PTY/WebSocket is connecting. Amber.
 *   - working  — open AND output is streaming (Claude is busy). Green, pulsing.
 *   - ready    — open AND idle (waiting for you). Accent.
 *   - ended    — the session closed (PTY exited). Red.
 */
export type SessionStatusKind = 'saved' | 'starting' | 'working' | 'ready' | 'ended';

export interface SessionStatusInfo {
  kind: SessionStatusKind;
  /** One human word, shown on the tab and in the collapsed dock chip. */
  label: string;
  /** Which Sleepy face encodes this state. */
  mood: SleepyMood;
}

/**
 * One session as a status-bearing row view-model — the shape the collapsed dock chips
 * (and, derived further, the top-bar tabs) are built from. Pure data, framework-free, so
 * it lives here with the status taxonomy rather than in any one component.
 */
export interface SessionRow {
  id: string;
  title: string;
  info: SessionStatusInfo;
  /** A backgrounded session finished / rang the bell since you last looked at it. */
  attention: boolean;
}

export interface SessionStatusInput {
  /** A restored tab with no live Session yet — always reads as "saved". */
  dormant?: boolean;
  /** The live Session's status, or undefined when there is no live session. */
  status?: TermStatus;
  /** Whether the live session is actively streaming output. */
  busy?: boolean;
}

/**
 * Derive the presentation state for one session. `dormant` wins over everything (a
 * restored tab is "saved" even if a stale status leaked in); otherwise the live PTY
 * status decides, splitting `open` into working/ready by the busy flag.
 */
export function deriveSessionStatus({ dormant, status, busy }: SessionStatusInput): SessionStatusInfo {
  if (dormant) return { kind: 'saved', label: 'saved', mood: 'sleeps' };
  switch (status) {
    case 'open':
      return busy
        ? { kind: 'working', label: 'working', mood: 'working' }
        : { kind: 'ready', label: 'ready', mood: 'waving' };
    case 'closed':
      return { kind: 'ended', label: 'ended', mood: 'sleeps' };
    case 'connecting':
    default:
      // No live session yet (undefined) reads the same as connecting — a session is
      // about to attach. Never leaves a row blank.
      return { kind: 'starting', label: 'starting', mood: 'thinking' };
  }
}
