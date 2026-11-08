import { useRef } from 'react';
import { PriorityCard, useFlip } from './PriorityCard';
import { useStatusModel } from '../../hooks/useTasks';
import {
  BANDS, BAND_LABEL, bandRange, objectiveLanes, objectivePlace, objectiveWhen, priorityBand, waitsFor,
  type PriorityObjective,
} from './priorityModel';

/**
 * Lanes · Objectives: three bands (Now / Next / Later by the objective thresholds),
 * cards left to right by score with a gap that grows with the score drop, and a
 * NOT SCORED row below Later.
 */
export function ObjectiveLanes({ objectives, all, selected, onOpen }: {
  objectives: PriorityObjective[];
  all: PriorityObjective[];
  selected: string | null;
  onOpen: (slug: string) => void;
}) {
  const model = objectiveLanes(objectives);
  const ref = useRef<HTMLDivElement>(null);
  useFlip(ref, [objectives]);
  const statuses = useStatusModel();

  const card = (o: PriorityObjective, gapBefore = 0) => {
    const place = objectivePlace(o);
    const when = objectiveWhen(o);
    const pct = o.progress.pct ?? 0;
    const open = o.tasks.filter((t) => !statuses.isTerminal(t.status)).length;
    const todo = o.tasks.filter((t) => statuses.kindOf(t.status) === 'open').length;
    const wait = waitsFor(o, all);
    return (
      <PriorityCard
        key={o.slug}
        flipKey={`obj::${o.slug}`}
        title={o.title}
        place={place}
        band={priorityBand('objective', place.score)}
        variant="objective"
        selected={selected === o.slug}
        onOpen={() => onOpen(o.slug)}
        style={{ marginLeft: gapBefore }}
      >
        <div className="pc-meta">
          <span className="pc-bar" aria-hidden><span style={{ width: `${pct}%` }} /></span>
          <span>{o.progress.pct == null ? '—' : `${pct}%`}</span>
          <span className={when.late ? 'pc-late' : undefined}>{when.late ? when.text : `· ${when.text}`}</span>
        </div>
        <div className="pc-foot">
          {wait
            ? `Waits for ${wait.title}`
            : `${o.tasks.length} task${o.tasks.length === 1 ? '' : 's'} · ${open} open · ${todo} to do`}
        </div>
      </PriorityCard>
    );
  };

  return (
    <div className="pv-olanes" ref={ref}>
      {BANDS.map((b) => (
        <section key={b} className={`pv-band pv-band--${b}`} aria-label={`${BAND_LABEL[b]} band`}>
          <div className="pv-band-label">{BAND_LABEL[b]}</div>
          <div className="pv-band-range">{bandRange('objective', b)}</div>
          <div className="pv-orow">
            {model.bands[b].map((c) => card(c.item, c.gapBefore))}
          </div>
        </section>
      ))}
      {model.unscored.length > 0 && (
        <section className="pv-unscored-row" aria-label="Not scored">
          <div className="pv-row-title">Not scored · {model.unscored.length}</div>
          <div className="pv-orow">{model.unscored.map((o) => card(o))}</div>
        </section>
      )}
    </div>
  );
}
