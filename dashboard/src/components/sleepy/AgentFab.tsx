import { SleepyMascot, type SleepyMood } from './SleepyMascot';
import './AgentFab.css';

/**
 * The global Agent floater — a bottom-right FAB present on every page (desktop
 * only). Clicking it expands the once-mounted {@link AgentSurface} to a fullscreen
 * overlay. Purely presentational: the live status/mood/label/attention are derived
 * in AgentSurface (the single owner of the sessions ref) and passed down, so the FAB
 * never touches the session engine and the persistence invariant is untouched.
 */

/** Worst-of-panes rollup that colours the status dot. */
export type FabStatus = 'idle' | 'connecting' | 'live' | 'streaming' | 'ended';

interface AgentFabProps {
  status: FabStatus;
  mood: SleepyMood;
  /** Focused session title (+ `· +N` when more sessions exist), or "Agent" when idle. */
  label: string;
  sessionCount: number;
  /** A backgrounded session finished / rang the bell while you weren't looking. */
  attention: boolean;
  onClick: () => void;
}

export function AgentFab({ status, mood, label, sessionCount, attention, onClick }: AgentFabProps) {
  return (
    <button
      type="button"
      className="agent-fab"
      data-status={status}
      data-count={sessionCount}
      onClick={onClick}
      aria-label={`Agent — ${label}`}
      title={label}
    >
      <span className="agent-fab-mascot" aria-hidden="true">
        <SleepyMascot mood={mood} size={32} compact />
        <span className="agent-fab-dot" data-status={status} />
        {attention && <span className="agent-fab-chip" />}
      </span>
      <span className="agent-fab-label">{label}</span>
    </button>
  );
}
