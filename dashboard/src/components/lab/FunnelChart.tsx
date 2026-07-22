import { useState } from 'react';
import type { Series } from '../../hooks/useLab';

/** Hand-rolled funnel chart — one horizontal bar per series, in series order
 *  (the adapter's array order IS the step order), sized by its latest value
 *  relative to the first step. Hovering a step reads out its share of the top
 *  and of the previous step. Clicking two steps pins an A → B conversion strip;
 *  clicking a pinned step unpins, a third click re-anchors. */

const BAR_COLOR = '#7b68ee';
const BAR_COLOR_DIM = '#7b68ee55';
const BAR_COLOR_PINNED = '#0091ff';

interface Step {
  name: string;
  value: number;
  /** Share of the first step (0–1). */
  ofTop: number;
  /** Share of the previous step (0–1), 1 for the first. */
  ofPrev: number;
}

function pct(frac: number): string {
  return `${(frac * 100).toFixed(frac >= 0.995 || frac === 0 ? 0 : 1)}%`;
}

export function FunnelChart({ series, unit = null }: { series: Series[]; unit?: string | null }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number[]>([]);

  const steps: Step[] = series
    .map((s) => ({ name: s.name, value: s.points.length > 0 ? s.points[s.points.length - 1].v : 0 }))
    .map((s, i, all) => ({
      ...s,
      ofTop: all[0].value > 0 ? s.value / all[0].value : 0,
      ofPrev: i === 0 ? 1 : all[i - 1].value > 0 ? s.value / all[i - 1].value : 0,
    }));

  if (steps.length === 0 || steps[0].value <= 0) {
    return <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: '24px 0' }}>No data yet.</div>;
  }

  const handleClick = (i: number) => {
    setPinned((prev) => {
      if (prev.includes(i)) return prev.filter((p) => p !== i); // unpin
      if (prev.length >= 2) return [i]; // third click re-anchors
      return [...prev, i].sort((a, b) => a - b);
    });
  };

  const [a, b] = pinned.length === 2 ? pinned : [null, null];
  const conversion = a !== null && b !== null && steps[a].value > 0 ? steps[b].value / steps[a].value : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
      {conversion !== null && a !== null && b !== null && (
        <div
          style={{
            display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 10px', marginBottom: 4,
            background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
            borderRadius: 8, fontSize: 12,
          }}
        >
          <span style={{ color: 'var(--color-text-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {steps[a].name} → {steps[b].name}
          </span>
          <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}>
            {pct(conversion)}
          </span>
          <span style={{ color: 'var(--color-text-tertiary)' }}>
            ({steps[a].value.toLocaleString()} → {steps[b].value.toLocaleString()})
          </span>
          <span
            style={{ marginLeft: 'auto', cursor: 'pointer', color: 'var(--color-text-tertiary)' }}
            onClick={() => setPinned([])}
            title="Clear selection"
          >✕</span>
        </div>
      )}
      {steps.map((s, i) => {
        const isPinned = pinned.includes(i);
        const dimmed = pinned.length === 2 && !isPinned;
        const active = hovered === i;
        return (
          <div
            key={`${s.name}-${i}`}
            style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minHeight: 22 }}
            onPointerEnter={() => setHovered(i)}
            onPointerLeave={() => setHovered(null)}
            onClick={() => handleClick(i)}
            title={pinned.length === 0 ? 'Click two steps to pin an A → B conversion' : undefined}
          >
            <span
              style={{
                width: 120, flexShrink: 0, fontSize: 11, textAlign: 'right',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                color: active || isPinned ? 'var(--color-text)' : 'var(--color-text-secondary)',
                fontWeight: isPinned ? 700 : 400,
              }}
            >{s.name}</span>
            <div style={{ flex: 1, position: 'relative', height: 16 }}>
              <div
                style={{
                  position: 'absolute', inset: '0 auto 0 0',
                  width: `${Math.max(s.ofTop * 100, 1)}%`,
                  background: isPinned ? BAR_COLOR_PINNED : dimmed ? BAR_COLOR_DIM : BAR_COLOR,
                  opacity: active ? 1 : 0.9,
                  borderRadius: 4,
                  transition: 'background 0.12s ease, opacity 0.12s ease',
                }}
              />
              <span
                style={{
                  position: 'absolute', left: `calc(${Math.max(s.ofTop * 100, 1)}% + 6px)`, top: '50%',
                  transform: 'translateY(-50%)', fontSize: 11, whiteSpace: 'nowrap',
                  fontFamily: 'var(--font-mono)',
                  color: active || isPinned ? 'var(--color-text)' : 'var(--color-text-tertiary)',
                }}
              >
                {s.value.toLocaleString()}{unit ? ` ${unit}` : ''}
                {active && (
                  <span style={{ color: 'var(--color-text-secondary)', marginLeft: 6 }}>
                    · {pct(s.ofTop)} of top{i > 0 ? ` · ${pct(s.ofPrev)} of prev` : ''}
                  </span>
                )}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
