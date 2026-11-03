/**
 * ImageViewer (dashboard/src/components/layout/ImageViewer.tsx), owner 2026-11-03: the bottom
 * controls covered the bottom of a tall picture (a paywall's main button). Now the picture fits
 * ABOVE a docked strip, the strip fades only while zoomed and idle, and the hint shows once.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { controlsShown, CONTROLS_IDLE_MS } from '../../dashboard/src/components/layout/ImageViewer.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('ImageViewer docked controls', () => {
  it('at fit the strip is always shown, even when idle', () => {
    expect(controlsShown({ zoomed: false, idle: true, hovering: false, focusInside: false })).toBe(true);
  });

  it('zoomed and idle the strip steps aside; hover or keyboard focus keeps it', () => {
    expect(controlsShown({ zoomed: true, idle: true, hovering: false, focusInside: false })).toBe(false);
    expect(controlsShown({ zoomed: true, idle: false, hovering: false, focusInside: false })).toBe(true);
    expect(controlsShown({ zoomed: true, idle: true, hovering: true, focusInside: false })).toBe(true);
    expect(controlsShown({ zoomed: true, idle: true, hovering: false, focusInside: true })).toBe(true);
  });

  it('fades after about a second and a half', () => {
    expect(CONTROLS_IDLE_MS).toBe(1500);
  });

  it('the stage ends where the strip starts, and the page viewer keeps its own foot', () => {
    const src = read('dashboard/src/components/layout/ImageViewer.tsx');
    expect(src).toMatch(/style=\{\{ bottom: footH \}\}/);
    expect(src).toMatch(/image-viewer-foot image-viewer-foot--dock/);
    const css = read('dashboard/src/components/layout/ImageViewer.css');
    expect(css).toMatch(/\.image-viewer-foot--dock:focus-within\s*\{[^}]*opacity: 1/);
    expect(css).toMatch(/backdrop-filter: blur/);
    expect(read('dashboard/src/components/layout/FrameViewer.tsx')).not.toMatch(/image-viewer-foot--dock/);
  });
});
