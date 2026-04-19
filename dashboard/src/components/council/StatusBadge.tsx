interface Props {
  status: string;
  size?: 'sm' | 'md';
}

function statusInfo(status: string): { label: string; tone: 'running' | 'complete' | 'synth' | 'pending' } {
  if (status === 'complete') return { label: 'Complete', tone: 'complete' };
  if (status === 'synthesizing') return { label: 'Synthesizing', tone: 'synth' };
  if (/_running$/.test(status)) {
    const round = status.match(/^round_(\d+)_running$/)?.[1];
    return { label: round ? `Round ${round} running` : 'Running', tone: 'running' };
  }
  if (/_complete$/.test(status)) {
    const round = status.match(/^round_(\d+)_complete$/)?.[1];
    return { label: round ? `Round ${round} done` : 'Round done', tone: 'pending' };
  }
  if (status === 'created') return { label: 'Created', tone: 'pending' };
  return { label: status, tone: 'pending' };
}

export function StatusBadge({ status, size = 'md' }: Props) {
  const { label, tone } = statusInfo(status);
  return (
    <span className={`council-status council-status--${tone} council-status--${size}`}>
      <span className="council-status-dot" />
      {label}
    </span>
  );
}
