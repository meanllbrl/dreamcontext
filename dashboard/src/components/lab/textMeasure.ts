/**
 * Text width in a rendered font, for components that fit their text to a
 * measured box (the tables' column ladder, the funnel's step marker). A canvas
 * measure; without a canvas (server render, tests) 7px a character.
 */

let measureCtx: CanvasRenderingContext2D | null | undefined;

export function textWidth(text: string, font: string): number {
  if (measureCtx === undefined) {
    measureCtx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** The canvas font of an element as rendered (`weight` overrides its own). */
export function elementFont(el: Element, weight?: string): string {
  const cs = getComputedStyle(el);
  return `${weight ?? cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
}
