import { useState } from 'react';
import {
  fmtScore, riceScore, segmentValues,
  type EffectiveSuggestion, type PriorityObjective, type RiceKey, type RiceValues,
} from './priorityModel';

/**
 * The priority panel: one card's RICE as segments (five values of each scale,
 * always including the stored value), the agent's reason, and — for tasks — an
 * objective picker, which is the touch path for linking. With a pending
 * suggestion it shows Dismiss / Accept; Accept sends ONLY the fields the owner
 * changed here, so a stale panel can never overwrite a value set elsewhere.
 * Without one, a segment click saves that owner value directly.
 */
export interface PanelTarget {
  kind: 'task' | 'objective';
  slug: string;
  title: string;
  rice: RiceValues;
  suggestion: EffectiveSuggestion | null;
  /** Live links (tasks). */
  links: string[];
  context: string;
}

const KEYS: Array<{ k: RiceKey; label: string; fmt: (v: number) => string }> = [
  { k: 'reach', label: 'Reach', fmt: (v) => String(v) },
  { k: 'impact', label: 'Impact', fmt: (v) => String(v) },
  { k: 'confidence', label: 'Confidence', fmt: (v) => `${v}%` },
  { k: 'effort', label: 'Effort', fmt: (v) => `${v}w` },
];

export function PriorityPanel({
  target, objectives, walk, busy, onClose, onAccept, onDismiss, onSaveRice, onToggleLink, onOpenTask, onOpenObjective,
}: {
  target: PanelTarget;
  /** Live objectives (the picker). */
  objectives: PriorityObjective[];
  /** "2 of 5" while walking the suggestions. */
  walk: string | null;
  busy: boolean;
  onClose: () => void;
  onAccept: (edits: Partial<Record<RiceKey, number>>) => void;
  onDismiss: () => void;
  onSaveRice: (key: RiceKey, value: number) => void;
  onToggleLink: (objective: string, on: boolean) => void;
  onOpenTask?: () => void;
  onOpenObjective?: () => void;
}) {
  const [edits, setEdits] = useState<Partial<Record<RiceKey, number>>>({});
  const s = target.suggestion;
  const value = (k: RiceKey): number | null => edits[k] ?? target.rice[k] ?? s?.rice?.[k] ?? null;
  const shown: RiceValues = { reach: value('reach'), impact: value('impact'), confidence: value('confidence'), effort: value('effort') };
  const score = riceScore(shown);
  const fromAgent = !!s?.rice && KEYS.some(({ k }) => target.rice[k] == null && s.rice?.[k] != null && edits[k] == null);

  const pick = (k: RiceKey, v: number) => {
    if (s) setEdits((e) => ({ ...e, [k]: v }));
    else onSaveRice(k, v);
  };

  return (
    <aside className="pp" aria-label={`${target.title} priority`}>
      <div className="pp-body">
        <div className="pp-top">
          <h2 className="pp-title">{target.title}</h2>
          <button type="button" className="pp-x" onClick={onClose} aria-label="Close panel">✕</button>
        </div>
        {walk && <div className="pp-walk">Suggestion {walk}</div>}
        <div className={`pp-score${fromAgent ? ' is-suggested' : ''}`}>
          <b>{fromAgent ? '✦ ' : ''}{score != null ? fmtScore(score) : '—'}</b>
          <span>{target.context}</span>
        </div>

        {KEYS.map(({ k, label, fmt }) => {
          const cur = value(k);
          const agentValue = target.rice[k] == null ? s?.rice?.[k] : undefined;
          return (
            <div key={k}>
              <div className="pp-field-head"><span>{label}</span><b>{cur != null ? fmt(cur) : '—'}</b></div>
              <div className="pp-seg" role="radiogroup" aria-label={label}>
                {segmentValues(k, cur).map((v) => (
                  <button
                    key={v} type="button" role="radio" aria-checked={cur === v}
                    disabled={busy}
                    className={[cur === v ? 'is-on' : '', agentValue === v && edits[k] == null ? 'is-suggested' : ''].filter(Boolean).join(' ')}
                    onClick={() => pick(k, v)}
                  >{fmt(v)}</button>
                ))}
              </div>
            </div>
          );
        })}

        {s?.why && <p className="pp-why">✦ {s.why}</p>}

        {target.kind === 'task' && (
          <div>
            <div className="pp-field-head"><span>Objective</span></div>
            <div className="pp-picker">
              {objectives.length === 0 && <span className="pc-quiet">No open objectives yet.</span>}
              {objectives.map((o) => {
                const on = target.links.includes(o.slug);
                const suggested = !on && s?.objective === o.slug;
                return (
                  <button
                    key={o.slug} type="button" disabled={busy}
                    className={`pp-pick${on ? ' is-on' : ''}${suggested ? ' is-suggested' : ''}`}
                    aria-pressed={on}
                    onClick={() => onToggleLink(o.slug, !on)}
                  >
                    <span aria-hidden>{on ? '✓' : suggested ? '✦' : '○'}</span>
                    <span>{o.title}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {onOpenTask && <button type="button" className="pv-btn" onClick={onOpenTask}>Open task</button>}
        {onOpenObjective && <button type="button" className="pv-btn" onClick={onOpenObjective}>Open objective</button>}
      </div>
      {s && (
        <div className="pp-foot">
          <button type="button" className="pv-btn" disabled={busy} onClick={onDismiss}>Dismiss</button>
          <button type="button" className="pv-btn pv-btn--primary" disabled={busy} onClick={() => onAccept(edits)}>Accept</button>
        </div>
      )}
    </aside>
  );
}
