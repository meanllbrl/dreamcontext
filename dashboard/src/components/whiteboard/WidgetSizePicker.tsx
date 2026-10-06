import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CARD_COLORS, type CardColor, type WidgetSize } from '../../lib/whiteboardWidgets';
import { WIDGET_SIZE_ORDER } from './widgetSize';
import { useWbText } from './whiteboardHost';

const LABEL: Record<WidgetSize, string> = { s: 'S', m: 'M', l: 'L', xl: 'XL' };
const NAME: Record<WidgetSize, string> = { s: 'Small', m: 'Medium', l: 'Large', xl: 'Extra large' };

/**
 * The S / M / L / XL segmented control for the selected widget (A17), and its colour.
 *
 * It floats in the canvas wrapper under the widget rather than inside the widget's own DOM:
 * Excalidraw hands pointer events to an embeddable only while it is active, and a size change
 * must work on a merely selected widget too. Positioned in the wrapper's pixel space by the
 * canvas, which hides it during a drag or resize.
 *
 * A widget dragged to a free-form size (`custom`) has no current preset; any segment snaps it
 * back to that preset's box.
 *
 * The last button is the card's colour (owner, 2026-10-05): it opens a row of the tints a card
 * can wear (the tab groups' names) and "none". It opens upward when the control sits in the
 * lower half of the window, so it never runs under the canvas's bottom bar. The canvas keys this
 * control on the widget, so another widget selected starts with the row closed (a pan or zoom
 * only moves it). Keyboard: the row takes focus on its current swatch, ←/→ move, Escape closes
 * it back onto the colour button.
 */
export function WidgetSizePicker({ left, top, size, custom, color, onPick, onColor }: {
  left: number;
  top: number;
  size: WidgetSize;
  custom: boolean;
  color: CardColor | null;
  onPick: (size: WidgetSize) => void;
  onColor: (color: CardColor | null) => void;
}) {
  const tx = useWbText();
  const [colors, setColors] = useState(false);
  const [up, setUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!colors) return;
    const row = rowRef.current;
    (row?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? row?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, [colors]);
  const closeColors = () => { setColors(false); toggleRef.current?.focus(); };
  const onRowKey = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeColors(); return; }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const swatches = [...(rowRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = swatches.indexOf(document.activeElement as HTMLButtonElement);
    const next = swatches[(at + (e.key === 'ArrowRight' ? 1 : -1) + swatches.length) % swatches.length];
    next?.focus();
  };
  const colorName = (c: CardColor) => tx(`whiteboard.tabs.color.${c}`, c[0].toUpperCase() + c.slice(1));
  const toggleColors = () => {
    const box = rootRef.current?.getBoundingClientRect();
    setUp(!!box && box.top > window.innerHeight / 2);
    setColors((v) => !v);
  };
  return (
    <div
      className="wb-size-picker"
      ref={rootRef}
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="wb-size-segments" role="radiogroup" aria-label={tx('whiteboard.size.label', 'Widget size')}>
        {WIDGET_SIZE_ORDER.map((s) => {
          const current = !custom && s === size;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={current}
              className={`wb-size-option${current ? ' is-current' : ''}`}
              title={tx(`whiteboard.size.${s}`, NAME[s])}
              onClick={() => { if (!current) onPick(s); }}
            >
              {LABEL[s]}
            </button>
          );
        })}
      </div>
      <span className="wb-size-sep" aria-hidden="true" />
      <button
        ref={toggleRef}
        type="button"
        className="wb-color-toggle"
        aria-haspopup="true"
        aria-expanded={colors}
        title={tx('whiteboard.color.label', 'Card colour')}
        aria-label={tx('whiteboard.color.label', 'Card colour')}
        onClick={toggleColors}
      >
        <span className="wb-color-dot" data-card-color={color ?? undefined} aria-hidden="true" />
      </button>
      {colors && (
        <div
          ref={rowRef}
          className={`wb-color-row${up ? ' is-up' : ''}`}
          onKeyDown={onRowKey}
          role="radiogroup"
          aria-label={tx('whiteboard.color.label', 'Card colour')}
        >
          <button
            type="button"
            role="radio"
            aria-checked={color === null}
            className="wb-color-swatch wb-color-swatch--none"
            title={tx('whiteboard.color.none', 'No colour')}
            aria-label={tx('whiteboard.color.none', 'No colour')}
            onClick={() => { closeColors(); if (color !== null) onColor(null); }}
          />
          {CARD_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              className="wb-color-swatch"
              data-card-color={c}
              title={colorName(c)}
              aria-label={colorName(c)}
              onClick={() => { closeColors(); if (color !== c) onColor(c); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
