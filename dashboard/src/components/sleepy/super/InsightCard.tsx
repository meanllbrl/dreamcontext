import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SuperContainer as Container } from '../../../lib/superTypes';
import type { WidgetSize } from '../../../lib/whiteboardWidgets';
import { InsightWidget } from '../../whiteboard/widgets/InsightWidget';
import { WhiteboardHostContext, type WhiteboardHost } from '../../whiteboard/whiteboardHost';
import './superInsight.css';

/**
 * The large insight card: the whiteboard's insight widget IS the Lab card at this size (a funnel
 * set opens as its explorer, a chart fills the card, a table or an app scrolls), so the stage
 * mounts it rather than drawing a copy. What the widget needs from a whiteboard canvas is its
 * host: the date-window chip reports a failed re-sync through `toast`, which outside a canvas is
 * a no-op, so here it is a short line over the card's foot instead of silence.
 */
export function InsightCard({ container: c, size, elementId }: { container: Container; size: WidgetSize; elementId: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const toast = useCallback((text: string) => {
    window.clearTimeout(timer.current);
    setMessage(text);
    timer.current = window.setTimeout(() => setMessage(null), 6000);
  }, []);
  const host = useMemo<WhiteboardHost>(() => ({ commitWidget: () => { /* read-only: the range lives in the insight's tweaks */ }, toast }), [toast]);
  return (
    <div className="super-card-view super-card-view--insight">
      <WhiteboardHostContext.Provider value={host}>
        <InsightWidget elementId={elementId} payload={{ v: 1, kind: 'insight', ref: c.ref, title: '' }} active size={size} />
      </WhiteboardHostContext.Provider>
      {message && <div className="super-insight-notice" role="status">{message}</div>}
    </div>
  );
}
