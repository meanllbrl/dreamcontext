import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  computeStepRows,
  dropSeverity,
  worstDropIndex,
  FUNNEL_COLORS,
} from './funnelModel';
import './FunnelLane.css';

/**
 * The horizontal node lane (A6/A7) — the Excalidraw-board reading of a funnel:
 * full-content-width row of rounded step NODES connected left→right, the drop
 * between adjacent steps a first-class badge (−n · −x%), and the two-click arc
 * gesture: click node A (anchor), click node B → a curved labeled arrow above
 * the lane with the A→B conversion. Arcs stack at distinct heights/colors; ✕
 * or re-clicking the pair removes one; Esc (owned by the page) clears all.
 *
 * With `bands` (breakdown mode A10a) every node stacks per-segment bars.
 * Nodes and arc chips are real buttons — the whole lane is keyboard-operable;
 * the FunnelStepTable twin carries the same numbers for non-visual reading.
 */

export interface LaneArc {
  from: string;
  to: string;
}

const ARC_SPACE_BASE = 56;
const ARC_STEP = 34;
const MANY_STEPS = 12;

export function FunnelLane({
  steps,
  arcs = [],
  anchor = null,
  onNodeClick,
  onArcRemove,
  bands = null,
  bandLegend = null,
  compact = false,
  volumeMax,
  collapsedInfo,
  arcDetail,
}: {
  steps: { key: string; label: string; users: number }[];
  /** Pinned arcs (validated by the caller — both endpoints exist). */
  arcs?: LaneArc[];
  /** The armed first-click node key. */
  anchor?: string | null;
  onNodeClick?: (key: string) => void;
  onArcRemove?: (index: number) => void;
  /** Breakdown (stacked) mode: per step key, ordered segment bands. */
  bands?: Map<string, { value: string; users: number }[]> | null;
  bandLegend?: { value: string; color: string }[] | null;
  /** Small-multiple variant: tighter nodes, no arcs. */
  compact?: boolean;
  /** Shared volume scale (small multiples): volume bars = users / volumeMax
   *  instead of % of this lane's own top, so lanes are visually comparable. */
  volumeMax?: number;
  /** Significant-change collapse: per step key, the group this node stands for
   *  (start → end users + member count). Key = the group's LAST member. */
  collapsedInfo?: Map<string, { count: number; startUsers: number }>;
  /** Per-segment A→B rows shown inside an arc chip (breakdown mode). */
  arcDetail?: (arc: LaneArc) => { value: string; from: number; to: number }[] | null;
}) {
  const rows = useMemo(() => computeStepRows(steps), [steps]);
  const worst = useMemo(() => worstDropIndex(rows), [rows]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const [centers, setCenters] = useState<Map<string, number>>(new Map());
  const [rowWidth, setRowWidth] = useState(0);
  const [fit, setFit] = useState(false);

  const manySteps = rows.length > MANY_STEPS;
  const arcSpace = arcs.length > 0 ? ARC_SPACE_BASE + arcs.length * ARC_STEP : anchor ? ARC_SPACE_BASE : 0;

  // Measure node centers (for the SVG arc layer) whenever layout can change.
  useLayoutEffect(() => {
    const measure = () => {
      const next = new Map<string, number>();
      for (const [key, el] of nodeRefs.current) {
        next.set(key, el.offsetLeft + el.offsetWidth / 2);
      }
      setCenters(next);
      setRowWidth(rowRef.current?.scrollWidth ?? 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (rowRef.current) ro.observe(rowRef.current);
    return () => ro.disconnect();
  }, [steps, fit, bands]);

  // Keep the anchored node visible when arcs toggle layout height.
  useEffect(() => {
    if (!anchor) return;
    nodeRefs.current.get(anchor)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [anchor]);

  const usersByKey = useMemo(() => new Map(rows.map((r) => [r.key, r.users])), [rows]);

  // Arc stacking level by SPAN (narrowest closest to the lane, widest on top) —
  // pin ORDER keeps the color, span keeps the geometry nested instead of crossing.
  const levelOf = useMemo(() => {
    const spans = arcs.map((arc, i) => ({
      i,
      span: Math.abs((centers.get(arc.to) ?? 0) - (centers.get(arc.from) ?? 0)),
    }));
    return new Map(spans.sort((a, b) => a.span - b.span).map((e, rank) => [e.i, rank]));
  }, [arcs, centers]);

  return (
    <div className={`funnel-lane${compact ? ' funnel-lane--compact' : ''}${fit ? ' funnel-lane--fit' : ''}`}>
      {manySteps && !compact && (
        <div className="funnel-lane-tools">
          <button className="funnel-lane-fit" onClick={() => setFit((v) => !v)} aria-pressed={fit}>
            {fit ? 'Actual size' : 'Zoom to fit'}
          </button>
        </div>
      )}
      <div className={`funnel-lane-scroll${manySteps && !fit ? ' funnel-lane-scroll--fade' : ''}`} ref={scrollRef}>
        <div className="funnel-lane-row" ref={rowRef} style={{ paddingTop: arcSpace }}>
          {/* ── Arc layer: SVG paths + HTML label chips, above the nodes. ── */}
          {arcs.length > 0 && rowWidth > 0 && (
            <svg
              className="funnel-lane-arcsvg"
              width={rowWidth}
              height={arcSpace}
              aria-hidden
            >
              <defs>
                {arcs.map((_, i) => (
                  <marker
                    key={i}
                    id={`funnel-arrow-${i}`}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0L8 4L0 8Z" fill={FUNNEL_COLORS[i % FUNNEL_COLORS.length]} />
                  </marker>
                ))}
              </defs>
              {arcs.map((arc, i) => {
                const x1 = centers.get(arc.from);
                const x2 = centers.get(arc.to);
                if (x1 === undefined || x2 === undefined) return null;
                const y = arcSpace - 6;
                const level = levelOf.get(i) ?? i;
                const hy = arcSpace - ARC_SPACE_BASE - level * ARC_STEP + 18;
                return (
                  <path
                    key={i}
                    d={`M ${x1} ${y} C ${x1} ${hy}, ${x2} ${hy}, ${x2} ${y}`}
                    fill="none"
                    stroke={FUNNEL_COLORS[i % FUNNEL_COLORS.length]}
                    strokeWidth={2}
                    markerEnd={`url(#funnel-arrow-${i})`}
                  />
                );
              })}
            </svg>
          )}
          {arcs.map((arc, i) => {
            const x1 = centers.get(arc.from);
            const x2 = centers.get(arc.to);
            if (x1 === undefined || x2 === undefined) return null;
            const fromUsers = usersByKey.get(arc.from) ?? 0;
            const toUsers = usersByKey.get(arc.to) ?? 0;
            const conv = fromUsers > 0 ? (toUsers / fromUsers) * 100 : null;
            const mid = (x1 + x2) / 2;
            const level = levelOf.get(i) ?? i;
            const top = arcSpace - ARC_SPACE_BASE - level * ARC_STEP + 2;
            const detail = arcDetail?.(arc) ?? null;
            const counts = `${fromUsers.toLocaleString('en-US')} → ${toUsers.toLocaleString('en-US')} (−${Math.max(0, fromUsers - toUsers).toLocaleString('en-US')})`;
            // Dense chips (many arcs) keep only the % inline; counts + the
            // per-segment table live in the hover/focus popover — pinned arcs
            // must never occlude each other or the connector labels.
            const dense = arcs.length >= 3;
            return (
              <div
                key={`chip-${i}`}
                className={`funnel-arc-chip${dense ? ' funnel-arc-chip--dense' : ''}`}
                style={{ left: mid, top, borderColor: FUNNEL_COLORS[i % FUNNEL_COLORS.length] }}
                tabIndex={0}
                aria-label={`Arc ${arc.from} to ${arc.to}: ${conv === null ? 'no rate' : `${conv.toFixed(1)}% conversion`}, ${counts}`}
              >
                <span className="funnel-arc-text">
                  {conv === null ? '—' : `${conv.toFixed(conv >= 10 ? 0 : 1)}%`}
                  {!dense && <span className="funnel-arc-counts"> · {counts}</span>}
                </span>
                <button
                  className="funnel-arc-x"
                  onClick={() => onArcRemove?.(i)}
                  aria-label={`Remove arc ${arc.from} to ${arc.to}`}
                >✕</button>
                <div className="funnel-arc-pop" role="tooltip">
                  <div className="funnel-arc-detail-row funnel-arc-pop-total">
                    <span className="funnel-arc-detail-name">total</span>
                    <span>{conv === null ? '—' : `${conv.toFixed(1)}%`}</span>
                    <span className="funnel-arc-counts">{counts}</span>
                  </div>
                  {(detail ?? []).map((d) => (
                    <div key={d.value} className="funnel-arc-detail-row">
                      <span className="funnel-arc-detail-name">{d.value}</span>
                      <span>{d.from > 0 ? `${((d.to / d.from) * 100).toFixed(1)}%` : '—'}</span>
                      <span className="funnel-arc-counts">{d.from.toLocaleString('en-US')} → {d.to.toLocaleString('en-US')}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* ── Nodes + connectors. ── */}
          {rows.map((row, i) => {
            const severity = dropSeverity(row.ofPrev);
            const isAnchor = anchor === row.key;
            const inArc = arcs.some((a) => a.from === row.key || a.to === row.key);
            return (
              <div className="funnel-lane-cell" key={row.key}>
                {i > 0 && (
                  <div className="funnel-conn" aria-hidden>
                    <span className="funnel-conn-rate">{row.ofPrev === null ? '—' : `${row.ofPrev.toFixed(row.ofPrev >= 10 ? 0 : 1)}%`}</span>
                    <span className="funnel-conn-line" />
                    {row.drop !== null && row.drop !== 0 && (
                      row.drop > 0 ? (
                        <span className={`funnel-drop funnel-drop--${severity}`}>
                          −{row.drop.toLocaleString('en-US')} · −{row.ofPrev === null ? '—' : (100 - row.ofPrev).toFixed(100 - row.ofPrev >= 10 ? 0 : 1)}%
                        </span>
                      ) : (
                        <span className="funnel-drop funnel-drop--up" title="Users increased between steps — re-entry or a tracking artifact; shown honestly, not clamped.">
                          ↑{(-row.drop).toLocaleString('en-US')}
                        </span>
                      )
                    )}
                  </div>
                )}
                <button
                  ref={(el) => {
                    if (el) nodeRefs.current.set(row.key, el);
                    else nodeRefs.current.delete(row.key);
                  }}
                  className={[
                    'funnel-node',
                    isAnchor ? 'funnel-node--anchor' : '',
                    inArc ? 'funnel-node--linked' : '',
                    i === worst ? 'funnel-node--worst' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => onNodeClick?.(row.key)}
                  aria-pressed={isAnchor}
                  aria-label={(() => {
                    const group = collapsedInfo?.get(row.key);
                    const base = group
                      ? `${row.label}: ${group.count} collapsed steps, ${group.startUsers.toLocaleString('en-US')} users in, ${row.users.toLocaleString('en-US')} out`
                      : `${row.label}: ${row.users.toLocaleString('en-US')} users`;
                    return `${base}${row.ofTop !== null ? `, ${row.ofTop.toFixed(1)}% of top` : ''}${isAnchor ? ' (arc anchor — pick a second step)' : ''}`;
                  })()}
                  title={isAnchor ? 'Anchor set — click another step to draw the arrow' : 'Click, then click another step to draw a conversion arrow'}
                >
                  <span className="funnel-node-label">{row.label}</span>
                  {bands ? (
                    <NodeBands bands={bands.get(row.key) ?? []} total={row.users} legend={bandLegend ?? []} />
                  ) : null}
                  {(() => {
                    const group = collapsedInfo?.get(row.key);
                    if (!group) {
                      return <span className="funnel-node-users">{row.users.toLocaleString('en-US')}</span>;
                    }
                    // A collapsed run shows BOTH ends — many small drops adding
                    // up to a big one must stay visible, never hidden.
                    return (
                      <>
                        <span className="funnel-node-users">
                          {group.startUsers.toLocaleString('en-US')} <span className="funnel-node-arrow" aria-hidden>→</span> {row.users.toLocaleString('en-US')}
                        </span>
                        <span className="funnel-node-groupchip" title={`${group.count} steps collapsed — each adjacent change below the threshold`}>
                          {group.count} steps
                        </span>
                      </>
                    );
                  })()}
                  <span className="funnel-node-oftop">{row.ofTop === null ? '—' : `${row.ofTop.toFixed(row.ofTop >= 10 ? 0 : 1)}% of top`}</span>
                  <span className="funnel-node-volume" aria-hidden>
                    <span
                      className="funnel-node-volume-fill"
                      style={{ width: `${Math.min(100, Math.max(2, volumeMax && volumeMax > 0 ? (row.users / volumeMax) * 100 : (row.ofTop ?? 0)))}%` }}
                    />
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function NodeBands({ bands, total, legend }: {
  bands: { value: string; users: number }[];
  total: number;
  legend: { value: string; color: string }[];
}) {
  if (bands.length === 0 || total <= 0) return null;
  const colorFor = (value: string) => legend.find((l) => l.value === value)?.color ?? 'var(--color-bg-tertiary)';
  return (
    <span className="funnel-node-bands" aria-hidden>
      {bands.map((b) => (
        <span
          key={b.value}
          className="funnel-node-band"
          style={{ width: `${(b.users / total) * 100}%`, background: colorFor(b.value) }}
          title={`${b.value}: ${b.users.toLocaleString('en-US')}`}
        />
      ))}
    </span>
  );
}
