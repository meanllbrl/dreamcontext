import { useState } from 'react';
import type { Series } from '../../hooks/useLab';

/** `raw` render: toggle between a flat table and the raw JSON, both from the cached series. */
export function RawDataView({ series }: { series: Series[] }) {
  const [mode, setMode] = useState<'table' | 'json'>('table');

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button
          onClick={() => setMode('table')}
          style={{
            padding: '4px 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
            border: '1px solid var(--color-border)',
            background: mode === 'table' ? 'var(--color-accent-soft)' : 'transparent',
            color: mode === 'table' ? 'var(--color-accent)' : 'var(--color-text-secondary)',
          }}
        >Table</button>
        <button
          onClick={() => setMode('json')}
          style={{
            padding: '4px 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
            border: '1px solid var(--color-border)',
            background: mode === 'json' ? 'var(--color-accent-soft)' : 'transparent',
            color: mode === 'json' ? 'var(--color-accent)' : 'var(--color-text-secondary)',
          }}
        >JSON</button>
      </div>

      {mode === 'table' ? (
        <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--color-border)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: 'var(--color-bg-tertiary)' }}>
                <th style={{ textAlign: 'left', padding: '6px 10px' }}>Series</th>
                <th style={{ textAlign: 'left', padding: '6px 10px' }}>Time</th>
                <th style={{ textAlign: 'right', padding: '6px 10px' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {series.flatMap((s) => s.points.map((p, i) => (
                <tr key={`${s.name}-${p.t}-${i}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '5px 10px', color: 'var(--color-text-secondary)' }}>{s.name}</td>
                  <td style={{ padding: '5px 10px' }}>{p.t}</td>
                  <td style={{ padding: '5px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{p.v}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      ) : (
        <pre style={{
          maxHeight: 220, overflow: 'auto', margin: 0, padding: 10, borderRadius: 8,
          border: '1px solid var(--color-border)', background: 'var(--color-bg-tertiary)',
          fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--color-text)',
        }}>{JSON.stringify(series, null, 2)}</pre>
      )}
    </div>
  );
}
