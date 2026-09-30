import type { WidgetSize } from '../../lib/whiteboardWidgets';
import { WIDGET_SIZE_ORDER } from './widgetSize';
import { useWbText } from './whiteboardHost';

const LABEL: Record<WidgetSize, string> = { s: 'S', m: 'M', l: 'L', xl: 'XL' };
const NAME: Record<WidgetSize, string> = { s: 'Small', m: 'Medium', l: 'Large', xl: 'Extra large' };

/**
 * The S / M / L / XL segmented control for the selected widget (A17).
 *
 * It floats in the canvas wrapper under the widget rather than inside the widget's own DOM:
 * Excalidraw hands pointer events to an embeddable only while it is active, and a size change
 * must work on a merely selected widget too. Positioned in the wrapper's pixel space by the
 * canvas, which hides it during a drag or resize.
 */
export function WidgetSizePicker({ left, top, size, onPick }: {
  left: number;
  top: number;
  size: WidgetSize;
  onPick: (size: WidgetSize) => void;
}) {
  const tx = useWbText();
  return (
    <div
      className="wb-size-picker"
      style={{ left, top }}
      role="radiogroup"
      aria-label={tx('whiteboard.size.label', 'Widget size')}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {WIDGET_SIZE_ORDER.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={s === size}
          className={`wb-size-option${s === size ? ' is-current' : ''}`}
          title={tx(`whiteboard.size.${s}`, NAME[s])}
          onClick={() => { if (s !== size) onPick(s); }}
        >
          {LABEL[s]}
        </button>
      ))}
    </div>
  );
}
