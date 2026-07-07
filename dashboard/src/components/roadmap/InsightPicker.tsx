import { useEffect, useMemo, useRef, useState } from 'react';
import type { InsightSummary } from '../../hooks/useLab';
import { fmtMetricValue } from './chrome';
import './InsightPicker.css';

/**
 * Searchable single-select for connecting a Lab insight to an objective's Key
 * Result. The selected insight shows as a chip (title + latest value + ×); the
 * field opens a search popover listing every insight (title, latest, slug),
 * filtered as you type. Insights already feeding ANOTHER objective carry a
 * "feeds <slug>" badge — picking one moves it here (the server enforces the
 * single-feeder invariant). Mirrors DependencyPicker's in-flow popover.
 */

interface InsightPickerProps {
  insights: InsightSummary[];
  /** Slug of the insight currently feeding this objective, or null. */
  selected: string | null;
  /** This objective's slug (so its own binding isn't badged as "feeds elsewhere"). Null at create time. */
  objectiveSlug: string | null;
  onSelect: (slug: string | null) => void;
  disabled?: boolean;
}

// Diacritic/Turkish-insensitive fold — mirrors DependencyPicker.
function fold(s: string): string {
  const tr: Record<number, string> = { 0x131: 'i', 0x130: 'i', 0x15f: 's', 0x15e: 's', 0x11f: 'g', 0x11e: 'g' };
  let mapped = '';
  for (const ch of s) mapped += tr[ch.codePointAt(0) ?? 0] ?? ch;
  let out = '';
  for (const ch of mapped.normalize('NFD')) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x0300 || cp > 0x036f) out += ch;
  }
  return out.toLowerCase();
}

function FlaskIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 2v6.5L4.7 18a2 2 0 0 0 1.8 3h11a2 2 0 0 0 1.8-3L14 8.5V2" />
      <path d="M8.5 2h7" />
      <path d="M7 15h10" />
    </svg>
  );
}

export function InsightPicker({ insights, selected, objectiveSlug, onSelect, disabled }: InsightPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = useMemo(() => insights.find((i) => i.slug === selected) ?? null, [insights, selected]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const filtered = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return insights;
    return insights.filter((i) =>
      fold(i.title).includes(q) || i.slug.includes(q) || (i.group ? fold(i.group).includes(q) : false));
  }, [insights, query]);

  const pick = (slug: string) => {
    setOpen(false);
    setQuery('');
    if (slug !== selected) onSelect(slug);
  };

  if (insights.length === 0) return null;

  return (
    <div className="inp" ref={ref}>
      {current ? (
        <div className="inp-chip" title={current.slug}>
          <span className="inp-chip-icon"><FlaskIcon /></span>
          <span className="inp-chip-label">{current.title}</span>
          {current.latest !== null && (
            <span className="inp-chip-value">{fmtMetricValue(current.latest, current.unit)}</span>
          )}
          {current.stale && <span className="inp-chip-stale" title="Cached value is past its TTL — refresh from the Insights page">stale</span>}
          <button type="button" className="inp-chip-change" onClick={() => setOpen((o) => !o)} disabled={disabled} title="Connect a different insight">change</button>
          <button type="button" className="inp-chip-x" onClick={() => onSelect(null)} disabled={disabled} title="Disconnect — the metric stops updating from this insight" aria-label="Disconnect insight">×</button>
        </div>
      ) : (
        <button type="button" className={`inp-trigger${open ? ' inp-trigger--open' : ''}`} onClick={() => setOpen((o) => !o)} disabled={disabled}>
          <FlaskIcon />
          <span className="inp-trigger-label">Connect an insight — the metric updates itself on every sync…</span>
        </button>
      )}

      {open && (
        <div className="inp-pop">
          <input
            ref={inputRef}
            className="inp-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search insights…"
            spellCheck={false}
          />
          <div className="inp-list bd-scroll">
            {filtered.length === 0 ? (
              <div className="inp-empty">No matches.</div>
            ) : (
              filtered.map((i) => {
                const on = i.slug === selected;
                const feedsOther = i.binding && i.binding.objective !== objectiveSlug ? i.binding.objective : null;
                return (
                  <div className={`inp-row${on ? ' inp-row--on' : ''}`} key={i.slug} onClick={() => pick(i.slug)}>
                    <span className={`inp-check${on ? ' inp-check--on' : ''}`}>{on ? '✓' : ''}</span>
                    <span className="inp-row-main">
                      <span className="inp-row-title">{i.title}</span>
                      {feedsOther && <span className="inp-row-feeds" title={`Currently feeds "${feedsOther}" — picking it moves it here`}>feeds {feedsOther}</span>}
                    </span>
                    <span className="inp-row-value">{i.latest !== null ? fmtMetricValue(i.latest, i.unit) : '—'}</span>
                    <span className="inp-row-slug">{i.slug}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
