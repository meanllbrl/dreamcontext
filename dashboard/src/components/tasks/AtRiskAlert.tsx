interface AtRiskAlertProps {
  overdue: number;
  today: number;
  soon: number;
  onFocus: () => void;
  onDismiss: () => void;
}

export function AtRiskAlert({ overdue, today, soon, onFocus, onDismiss }: AtRiskAlertProps) {
  const parts: string[] = [];
  if (overdue) parts.push(`${overdue} overdue`);
  if (today) parts.push(`${today} due today`);
  if (soon) parts.push(`${soon} due this week`);
  return (
    <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 14, padding: '9px 18px', background: 'var(--color-error-subtle)', borderBottom: '1px solid var(--color-border)', animation: 'bd_fade .2s ease' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-error)', animation: 'bd_pulse 1.4s ease-in-out infinite', flex: '0 0 auto' }} />
      <span style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 600 }}>{overdue ? 'Attention needed' : 'Heads up'}</span>
      <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{parts.join(' · ')}</span>
      <div style={{ flex: 1 }} />
      <span className="bd-chip" onClick={onFocus} style={{ padding: '5px 12px', borderRadius: 8, cursor: 'pointer', background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-text)', fontSize: 12, fontWeight: 600 }}>Show at-risk only</span>
      <span className="bd-hover bd-hover-text" onClick={onDismiss} title="Dismiss" style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, cursor: 'pointer', color: 'var(--color-text-tertiary)', fontSize: 13 }}>✕</span>
    </div>
  );
}
