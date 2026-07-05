import { useState } from 'react';
import type { PublicTweak } from '../../hooks/useLab';

/** Generic form built from `TweakDecl[]`: enum → select, date → date input, string → text.
 *  NO range branch — a relative range is just an enum tweak keyed "range" (LOCKED). */
export function TweakEditor({
  tweaks,
  onSave,
  saving,
}: {
  tweaks: PublicTweak[];
  onSave: (values: Record<string, string>) => void;
  saving?: boolean;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const t of tweaks) seed[t.key] = t.value ?? t.default ?? '';
    return seed;
  });

  if (tweaks.length === 0) return null;

  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      {tweaks.map((t) => (
        <label key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
          <span style={{ minWidth: 90, color: 'var(--color-text-secondary)' }}>{t.label ?? t.key}</span>
          {t.type === 'enum' ? (
            <select
              value={draft[t.key] ?? ''}
              onChange={(e) => set(t.key, e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 12.5 }}
            >
              {(t.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : t.type === 'date' ? (
            <input
              type="date"
              value={draft[t.key] ?? ''}
              onChange={(e) => set(t.key, e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 12.5 }}
            />
          ) : (
            <input
              type="text"
              value={draft[t.key] ?? ''}
              onChange={(e) => set(t.key, e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 12.5, flex: 1 }}
            />
          )}
        </label>
      ))}
      <button
        onClick={() => onSave(draft)}
        disabled={saving}
        style={{
          alignSelf: 'flex-start', padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
          cursor: saving ? 'default' : 'pointer', border: 'none',
          background: 'var(--color-accent)', color: 'var(--color-accent-text)', opacity: saving ? 0.6 : 1,
        }}
      >{saving ? 'Saving…' : 'Save'}</button>
    </div>
  );
}
