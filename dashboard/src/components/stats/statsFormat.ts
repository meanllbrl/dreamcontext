export const fmtCost = (v: number): string => {
  if (v === 0) return '$0';
  if (v >= 100) return `$${Math.round(v).toLocaleString('en-US')}`;
  return `$${v.toFixed(2)}`;
};

export const fmtTokens = (v: number): string => {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(Math.round(v));
};

export const fmtPct = (v: number): string => {
  if (v <= 0) return '0%';
  return v >= 10 ? `${Math.round(v)}%` : `${v.toFixed(1).replace(/\.0$/, '')}%`;
};

export const fmtIn = (ms: number): string => {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
};

export const fmtDay = (ms: number): string => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export const fmtClock = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const fmtWhen = (ms: number): string => `${fmtDay(ms)} ${fmtClock(ms)}`;
