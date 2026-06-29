import { SleepyMascot, type SleepyMood } from './SleepyMascot';
import type { TermStatus } from './agentSession';

/**
 * A minimized session, docked bottom-right. Sleepy's face encodes the live phase
 * (sleeping / thinking / working / waiting) by eye colour + animation; the bubble
 * glows the matching hue, a caption spells the state out, and a notification chip
 * appears when it finished while docked. Click (or Enter/Space) restores it.
 */

// One short, human-readable word per collapsed state, shown as a colour-coded
// caption under the bubble so the status isn't only conveyed by eye colour.
const STATE_LABEL: Record<SleepyMood, string> = {
  idle: 'idle', sleepy: 'drowsy', sleeps: 'sleeping',
  thinking: 'thinking', working: 'working', waving: 'waiting',
};

export function DockBubble({ title, mood, status, attention, onClick, onClose }: {
  title: string;
  mood: SleepyMood;
  status: TermStatus;
  attention: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  const state = STATE_LABEL[mood];
  return (
    <div className="agent-dock-item">
      <div
        className="agent-bubble"
        data-status={status}
        data-mood={mood}
        role="button"
        tabIndex={0}
        title={`${title} — ${state} · click to restore`}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      >
        <SleepyMascot mood={mood} size={36} compact />
        {attention && <span className="agent-bubble-badge" aria-label="Waiting for you" />}
        <span
          className="agent-bubble-close"
          role="button"
          tabIndex={0}
          aria-label={`Close ${title}`}
          title="Close session"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClose(); } }}
        >✕</span>
      </div>
      <span className="agent-bubble-state" data-mood={mood}>{state}</span>
      <span className="agent-bubble-title" title={title}>{title}</span>
    </div>
  );
}
