import { useLayoutEffect, useRef, useState } from 'react';
import { PriorityCard } from './PriorityCard';
import {
  mapGeometry, objectivePlace, priorityBand, taskPlace,
  type MapPoint, type PriorityLevel, type PriorityObjective, type PriorityTask, type RiceValues, type Placed,
} from './priorityModel';

/**
 * Map: value (reach × impact × confidence/100) up, effort right, both on log axes.
 * The band lines are the TRUE iso-RICE lines of the level's thresholds
 * (value = threshold × effort). No drag. Unscored items are a count chip that
 * opens the Lanes row. At the Tasks level every scored task is a dot and the top
 * 20 by score carry a card with a leader line; the rest name on hover.
 */
type Item = { kind: 'objective'; o: PriorityObjective } | { kind: 'task'; t: PriorityTask };

const CARD_W = { task: 232, objective: 260 };
const CARD_H = 40;

export function PriorityMap({ level, objectives, tasks, selected, onOpen, onOpenUnscored }: {
  level: PriorityLevel;
  objectives: PriorityObjective[];
  tasks: PriorityTask[];
  selected: string | null;
  onOpen: (key: string) => void;
  onOpenUnscored: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 560 });
  const [hover, setHover] = useState<MapPoint<Item> | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: Math.max(320, el.clientWidth), h: Math.max(360, el.clientHeight) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const items: Array<{ item: Item; key: string; rice: RiceValues; place: Placed }> = level === 'objective'
    ? objectives.map((o) => ({
      item: { kind: 'objective', o } as Item,
      key: o.slug,
      rice: fill({ reach: o.reach, impact: o.impact, confidence: o.confidence, effort: o.effort }, o.effective_suggestion?.rice),
      place: objectivePlace(o),
    }))
    : tasks.map((t) => ({
      item: { kind: 'task', t } as Item,
      key: `${t.slug}::map`,
      rice: fill(t.rice, t.effective_suggestion?.rice),
      place: taskPlace(t),
    }));

  const geo = mapGeometry(level, items, size.w, size.h);
  const w = CARD_W[level];

  // Labels sit beside their dot (right, else left); a greedy pass pushes an overlapping one
  // down, and takes whichever side moves it least while staying inside the box.
  const labelled = geo.points.filter((p) => p.labelled).sort((a, b) => a.y - b.y);
  const placed: Array<{ p: MapPoint<Item>; x: number; y: number }> = [];
  const GAP = 4;
  const fit = (x: number, startY: number): number => {
    let y = startY;
    for (let moved = true; moved;) {
      moved = false;
      for (const q of placed) {
        if (Math.abs(q.x - x) < w && y < q.y + CARD_H + GAP && y + CARD_H + GAP > q.y) { y = q.y + CARD_H + GAP; moved = true; }
      }
    }
    return y;
  };
  for (const p of labelled) {
    const startY = Math.max(0, p.y - CARD_H / 2);
    const sides = [Math.min(p.x + 16, size.w - w), Math.max(0, p.x - 16 - w)].map((x) => Math.max(0, x));
    const options = sides.map((x) => ({ x, y: fit(x, startY) }));
    const inside = options.filter((o) => o.y + CARD_H <= size.h);
    const best = (inside.length ? inside : options).reduce((a, b) => (Math.abs(b.y - startY) < Math.abs(a.y - startY) ? b : a));
    placed.push({ p, x: best.x, y: Math.min(best.y, Math.max(0, size.h - CARD_H)) });
  }

  // The Now region: above the Now line (value ≥ now × effort).
  const nowLine = geo.lines.find((l) => l.band === 'now');

  return (
    <div className="pv-map" ref={box} aria-label={`${level === 'task' ? 'Tasks' : 'Objectives'} map: value against effort`}>
      <svg width={size.w} height={size.h} aria-hidden>
        {nowLine && (
          <polygon className="pv-map-band" points={`0,0 ${size.w},0 ${nowLine.x2},${nowLine.y2} ${nowLine.x1},${nowLine.y1} 0,${nowLine.y1}`} />
        )}
        {geo.lines.map((l) => <line key={l.band} className="pv-map-line" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />)}
        {placed.map(({ p, x, y }) => (
          <line key={p.key} className="pv-map-leader" x1={p.x} y1={p.y} x2={x} y2={y + CARD_H / 2} />
        ))}
      </svg>
      <span className="pv-map-band-label" style={{ left: 12, top: 36 }}>Now</span>
      <span className="pv-map-band-label" style={{ right: 12, bottom: 40 }}>Later</span>
      <span className="pv-map-axis" style={{ left: 0, bottom: -28 }}>Less effort</span>
      <span className="pv-map-axis" style={{ right: 0, bottom: -28 }}>More effort</span>

      {geo.unscored > 0 && (
        <div className="pv-map-legend">
          <button type="button" className="pv-chip" onClick={onOpenUnscored}>Not scored · {geo.unscored}</button>
        </div>
      )}

      {geo.points.map((p) => (
        <button
          key={`dot-${p.key}`} type="button"
          className={`pv-map-dot${p.suggested ? ' is-suggested' : ''}`}
          style={{ left: p.x, top: p.y }}
          aria-label={titleOf(p.item)}
          onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)}
          onFocus={() => setHover(p)} onBlur={() => setHover(null)}
          onClick={() => onOpen(p.key)}
        />
      ))}
      {placed.map(({ p, x, y }) => (
        <PriorityCard
          key={p.key}
          flipKey={`map::${p.key}`}
          title={titleOf(p.item)}
          place={{ score: p.score, suggested: p.suggested }}
          band={priorityBand(level, p.score)}
          variant={level === 'task' ? 'task' : 'objective'}
          selected={selected === p.key}
          onOpen={() => onOpen(p.key)}
          style={{ left: x, top: y }}
        />
      ))}
      {hover && !hover.labelled && (
        <div className="pv-map-tip" style={{ left: hover.x, top: hover.y }}>{titleOf(hover.item)}</div>
      )}
    </div>
  );
}

function titleOf(i: Item): string {
  return i.kind === 'objective' ? i.o.title : i.t.name;
}

function fill(r: RiceValues, s: Partial<RiceValues> | null | undefined): RiceValues {
  if (!s) return r;
  return {
    reach: r.reach ?? s.reach ?? null,
    impact: r.impact ?? s.impact ?? null,
    confidence: r.confidence ?? s.confidence ?? null,
    effort: r.effort ?? s.effort ?? null,
  };
}
