import { StatusBadge } from 'dreamcontext-dashboard';

// StatusBadge maps a council-run status string to a labelled, color-toned pill.
// Each export below is one card cell; together they sweep the four tones.

export const Running = () => <StatusBadge status="round_1_running" />;

export const Synthesizing = () => <StatusBadge status="synthesizing" />;

export const Complete = () => <StatusBadge status="complete" />;

export const Pending = () => <StatusBadge status="created" />;

export const Small = () => <StatusBadge status="round_2_complete" size="sm" />;

export const AllTones = () => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
    <StatusBadge status="round_1_running" />
    <StatusBadge status="synthesizing" />
    <StatusBadge status="complete" />
    <StatusBadge status="created" />
  </div>
);
