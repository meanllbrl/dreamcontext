/**
 * A `type:'chart'` view — the card the Chat view renders for `render: 'line' | 'pie' |
 * 'number' | 'table' | 'funnel'`. `spec` arrives already validated and capped by
 * `chatViewSpec.parseViewBlock` (`lib/chatViewSpec.ts`); this component does not
 * re-validate it. It just switches onto the matching Lab chart component
 * (`components/lab/*` — pure props-in/SVG-out, no CSS-file coupling of their own) and adds
 * the one thing none of them have on their own: a head with a title/unit and a way to see
 * the same chart bigger.
 *
 * `onAction` is accepted (never used) only so `ChatViews` can pass the same prop uniformly
 * to every view kind in its `switch` — a `chart` payload carries no `actions` field, unlike
 * a page's cards.
 *
 * Fullscreen state lives HERE, not lifted to `ChatPane`: a chart has exactly one entry
 * point (its own ⛶), unlike a board's four, so lifting the state up would be ceremony with
 * no second caller. `ChartFullscreen` is a SEPARATE mount portaled to `document.body` —
 * `.agent-surface` sets `contain: layout paint`, which makes it the containing block for
 * `position: fixed`, so an un-portaled overlay would be clipped to the chat pane instead of
 * covering the window (the same reason `BoardFullscreen` portals). Being a separate mount
 * means closing it leaves the inline card's own state exactly as it was.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChartViewSpec } from '../../../lib/chatViewSpec';
import type { ChatAction } from './chatActions';
import { FullscreenOverlay } from '../../layout/FullscreenOverlay';
import { LineChart } from '../../lab/LineChart';
import { PieChart } from '../../lab/PieChart';
import { NumberCard } from '../../lab/NumberCard';
import { RawDataView } from '../../lab/RawDataView';
import { FunnelChart } from '../../lab/FunnelChart';
import './ChartView.css';

/** `NumberCard`'s `latest` is DERIVED from the last point of the first series, not asked
 *  for in the schema — a redundant field the agent could contradict is a bug surface. */
function latestValue(series: ChartViewSpec['series']): number | null {
  const points = series[0]?.points ?? [];
  return points.length > 0 ? points[points.length - 1].v : null;
}

/** One switch, shared by the inline card and the fullscreen mount. `big` only changes the
 *  two kinds that take an explicit size prop (`line`, `pie`) — the rest render identically
 *  either way and just get more room around them. */
function ChartBody({ spec, big }: { spec: ChartViewSpec; big: boolean }) {
  switch (spec.render) {
    case 'line':
      return <LineChart series={spec.series} unit={spec.unit} height={big ? 480 : 200} />;
    case 'pie':
      return <PieChart series={spec.series} unit={spec.unit} size={big ? 360 : 140} />;
    case 'number':
      return <NumberCard latest={latestValue(spec.series)} unit={spec.unit ?? null} series={spec.series} />;
    case 'table':
      return <RawDataView series={spec.series} />;
    case 'funnel':
      return <FunnelChart series={spec.series} unit={spec.unit} />;
  }
}

function ChartFullscreen({ spec, onClose }: { spec: ChartViewSpec; onClose: () => void }) {
  return createPortal(
    <FullscreenOverlay label={spec.title ?? 'Chart'} onClose={onClose}>
      <div className="chat-chartcard-full">
        <ChartBody spec={spec} big />
      </div>
    </FullscreenOverlay>,
    document.body,
  );
}

export function ChartView(props: { spec: ChartViewSpec; onAction?: (a: ChatAction) => void }) {
  const { spec } = props;
  const [full, setFull] = useState(false);

  return (
    <div className="chat-chartcard">
      <div className="chat-chartcard-head">
        <div className="chat-chartcard-titlewrap">
          {spec.title && <span className="chat-chartcard-title">{spec.title}</span>}
          {spec.unit && <span className="chat-chartcard-unit">{spec.unit}</span>}
        </div>
        <button
          type="button"
          className="chat-chartcard-full-btn"
          onClick={() => setFull(true)}
          aria-label={spec.title ? `Open ${spec.title} full screen` : 'Open chart full screen'}
        >
          <span aria-hidden>⛶</span>
        </button>
      </div>
      <div className="chat-chartcard-body">
        <ChartBody spec={spec} big={false} />
      </div>
      {full && <ChartFullscreen spec={spec} onClose={() => setFull(false)} />}
    </div>
  );
}
