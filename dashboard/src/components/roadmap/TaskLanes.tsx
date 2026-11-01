import { useEffect, useRef, useState, type DragEvent } from 'react';
import { PriorityCard, useFlip } from './PriorityCard';
import {
  BANDS, BAND_LABEL, UNLINKED, bandRange, fmtScore, objectivePlace, objectiveWhen, priorityBand, taskLanes,
  type PriorityObjective, type PriorityTask, type TaskCardModel, type TaskColumn,
} from './priorityModel';

/**
 * Lanes · Tasks: columns are objectives in rank order (unscored after), Unlinked
 * always last. A card's height inside its band follows its log score, pushed apart
 * without leaving the band. Below Later, each column has a collapsed "Not scored · N".
 * Drag is horizontal, mouse only (HTML5 drag does not start on touch): dropping on
 * another column moves THE SOURCE link only. Touch links through the panel's picker.
 */
const DRAG_MIME = 'application/x-dc-priority-card';

export function TaskLanes({ objectives, tasks, search, selected, onOpen, onDrop, expandRequest }: {
  objectives: PriorityObjective[];
  tasks: PriorityTask[];
  search: string;
  selected: string | null;
  onOpen: (key: string) => void;
  onDrop: (card: TaskCardModel, targetColumn: string) => void;
  /** A Map "Not scored" chip asks every column's row open. */
  expandRequest?: number;
}) {
  const model = taskLanes(objectives, tasks, search);
  const ref = useRef<HTMLDivElement>(null);
  useFlip(ref, [tasks, objectives, search]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<TaskCardModel | null>(null);
  const [over, setOver] = useState<string | null>(null);

  useEffect(() => {
    if (expandRequest) setOpen(new Set(model.columns.map((c) => c.slug)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandRequest]);

  const byKey = new Map<string, TaskCardModel>();
  for (const c of model.columns) {
    for (const b of BANDS) for (const card of c.bands[b]) byKey.set(card.key, card);
    for (const card of c.notScored) byKey.set(card.key, card);
  }

  const dropProps = (column: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging || !e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (over !== column) setOver(column);
    },
    onDragLeave: () => setOver((o) => (o === column ? null : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const key = e.dataTransfer.getData(DRAG_MIME);
      const card = byKey.get(key);
      setOver(null);
      setDragging(null);
      if (card) onDrop(card, column);
    },
  });

  const cardEl = (card: TaskCardModel, positioned: boolean) => (
    <PriorityCard
      key={card.key}
      flipKey={card.key}
      title={card.task.name}
      place={card.place}
      band={priorityBand('task', card.place.score)}
      variant="task"
      ghost={card.linkGhost}
      activeDot={card.task.status_kind !== 'other'}
      selected={selected === card.key}
      onOpen={() => onOpen(card.key)}
      draggable={!card.linkGhost}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, card.key);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(card);
      }}
      onDragEnd={() => { setDragging(null); setOver(null); }}
      style={positioned ? { top: card.y } : undefined}
    >
      {(card.task.mark || card.task.no_objective || card.task.subtask_count > 0) && (
        <div className="pc-meta">
          {card.task.mark && <span className="pc-mark">{card.task.mark}</span>}
          {!card.task.mark && card.task.no_objective && card.column === UNLINKED && <span className="pc-quiet">no objective fits</span>}
          {card.task.subtask_count > 0 && <span className="pc-quiet">{card.task.subtask_count} sub-task{card.task.subtask_count === 1 ? '' : 's'}</span>}
        </div>
      )}
    </PriorityCard>
  );

  const head = (c: TaskColumn) => {
    const o = c.objective;
    const place = o ? objectivePlace(o) : null;
    const when = o ? objectiveWhen(o) : null;
    return (
      <div key={c.slug} className={`pv-col-head${over === c.slug ? ' is-drop' : ''}`} {...dropProps(c.slug)}>
        <div className="pv-col-title">
          <span title={c.title}>{c.title}</span>
          <span className="pc-score" style={place?.suggested ? { color: 'var(--color-accent)' } : undefined}>
            {o ? (place?.score != null ? fmtScore(place.score) : '—') : c.count}
          </span>
        </div>
        <div className="pv-col-sub">
          {o ? (
            <>
              <span className="pc-bar" aria-hidden><span style={{ width: `${o.progress.pct ?? 0}%` }} /></span>
              <span>{o.progress.done}/{o.progress.total}</span>
              {when && <span className={when.late ? 'pc-late' : undefined}>{when.late ? when.text : when.text === 'no date' ? '' : `· ${when.text}`}</span>}
            </>
          ) : <span>no objective yet</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="pv-tl" ref={ref} aria-label="Tasks by objective">
      <div className="pv-tl-head">
        <div className="pv-tl-corner" />
        {model.columns.map(head)}
      </div>
      {BANDS.map((b) => (
        <div key={b} className={`pv-tl-row pv-band--${b}`} style={{ height: model.bandHeight[b] }}>
          <div className="pv-tl-label">
            <div className="pv-band-label">{BAND_LABEL[b]}</div>
            <div className="pv-band-range">{bandRange('task', b)}</div>
          </div>
          {model.columns.map((c) => (
            <div key={c.slug} className={`pv-tl-cell${over === c.slug ? ' is-drop' : ''}`} {...dropProps(c.slug)}>
              {c.bands[b].map((card) => cardEl(card, true))}
            </div>
          ))}
        </div>
      ))}
      <div className="pv-tl-row pv-tl-ns">
        <div className="pv-tl-label"><div className="pv-row-title">Not scored</div></div>
        {model.columns.map((c) => {
          const isOpen = open.has(c.slug) || c.notScoredHit;
          return (
            <div key={c.slug} className={`pv-tl-cell${over === c.slug ? ' is-drop' : ''}`} {...dropProps(c.slug)}>
              {c.notScored.length > 0 && (
                <button
                  type="button" className="pv-ns-toggle" aria-expanded={isOpen}
                  onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(c.slug)) n.delete(c.slug); else n.add(c.slug); return n; })}
                >{isOpen ? '▾' : '▸'} Not scored · {c.notScored.length}</button>
              )}
              {isOpen && <div className="pv-ns-list">{c.notScored.map((card) => cardEl(card, false))}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
