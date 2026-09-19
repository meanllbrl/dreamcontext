import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

/**
 * The xterm PRIMITIVES every terminal surface in this app is built from: the theme read out
 * of the live design tokens, the zoom-aware type scale, the font-ready open dance, and the
 * OSC colour helpers that let Claude's TUI theme itself to our surface.
 *
 * Extracted from `agentSession.ts` when the Chat transcript's RUN card needed a real PTY of
 * its own. A second `new Terminal({...})` written by hand is how two terminals in one app
 * end up with different cell metrics, a different selection colour and one of them not
 * following the theme — every one of those was a bug fixed ONCE here (see the long notes
 * inside `readXtermTheme` and `openWhenFontsReady`). Reuse over reimplementation, and this
 * file is the reused half.
 *
 * `agentSession.ts` keeps everything a SESSION is — status, attention, the roster, the
 * conversation — and imports what a TERMINAL is from here.
 */

// Base xterm font size at 100% zoom. Multiplied by the app's `--zoom` so terminal
// text tracks the window zoom control (which otherwise only scales CSS font tokens).
export const BASE_FONT = 14.5;
export function currentZoom(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zoom'));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

// ── Theme ──────────────────────────────────────────────────────────────────────

export function readXtermTheme(): ITheme {
  const cs = getComputedStyle(document.body);
  const g = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const bg = g('--color-bg', '#14171f');
  const accent = g('--color-accent', '#9d8cff');
  // The 16 ANSI slots must keep conventional luminance ordering (0 = darkest →
  // 15 = lightest) REGARDLESS of theme. The old mapping wired black/white/brightBlack
  // straight to design tokens, which inverted them in light mode (black→#e9ebf0,
  // white→#646464) and made the dim grays too light in dark mode — so when Claude's
  // TUI fills a region with ANSI 7/8 as a background, the foreground collapsed to
  // same-luminance-on-same-luminance (the unreadable pale blocks). The grayscale ramp
  // is tuned per-theme so background fills BLEND with the surface; foreground
  // readability on any pairing is then guaranteed by `minimumContrastRatio` below.
  const isLight = currentTermTheme() === 'light';
  const ramp = isLight
    ? { black: '#292d34', brightBlack: '#646464', white: '#e9ebf0', brightWhite: '#ffffff' }
    : { black: '#20242e', brightBlack: '#3b4151', white: '#c8ccd9', brightWhite: '#f5f6fa' };
  // Deliberately SOFTER than --color-text: pure #f5f6fa on #14171f is ~17:1, which is
  // harsh/eye-tiring for long sessions. A calm off-white (dark) / lifted ink (light)
  // keeps text clearly present while dropping the glare. Dim text stays dim because
  // minimumContrastRatio is only 3 (not 4.5), so the hierarchy isn't flattened bright.
  const softFg = isLight ? '#33383f' : '#cdd3de';
  return {
    background: bg,
    foreground: softFg,
    cursor: accent,
    cursorAccent: bg,
    // Selection must be UNMISTAKABLE in both themes AND whether or not the terminal is the
    // focused element. A pale semi-transparent violet was invisible on the white light-mode
    // background; worse, while the selection is drawn UNFOCUSED xterm uses its faint default
    // `selectionInactiveBackground` (a light gray — visible on dark, invisible on white),
    // which is exactly what the light-mode bug was. So pin a SOLID deep brand-violet with
    // white text for BOTH the active and inactive selection: ~5.3:1 white-on-violet, clearly
    // visible on white AND on the dark canvas, regardless of focus.
    selectionBackground: '#6a57d6',
    selectionInactiveBackground: '#6a57d6',
    selectionForeground: '#ffffff',
    black: ramp.black,
    red: g('--color-error', '#ff5a5f'),
    green: g('--color-success', '#4ade80'),
    yellow: g('--color-warning', '#ffae3b'),
    blue: '#5b9dff',
    magenta: accent,
    cyan: '#3bd6c6',
    white: ramp.white,
    brightBlack: ramp.brightBlack,
    brightRed: '#ff7a7f',
    brightGreen: '#6ee7a0',
    brightYellow: '#ffc46b',
    brightBlue: '#8bbcff',
    brightMagenta: accent,
    brightCyan: '#6fe3d6',
    brightWhite: ramp.brightWhite,
  };
}

// ── Theme detection / colour reporting (so Claude themes to our surface) ────────

export function resolveRgb(cssColor: string): [number, number, number] | null {
  if (!cssColor) return null;
  const probe = document.createElement('span');
  probe.style.color = cssColor;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  const m = /rgba?\(([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)/.exec(c);
  return m ? [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])] : null;
}
export function toXtermRgb([r, g, b]: [number, number, number]): string {
  const h = (v: number) => ((v * 257) & 0xffff).toString(16).padStart(4, '0');
  return `rgb:${h(r)}/${h(g)}/${h(b)}`;
}
export function tokenRgb(varName: string, fallback: string): [number, number, number] | null {
  const v = getComputedStyle(document.body).getPropertyValue(varName).trim() || fallback;
  return resolveRgb(v);
}
export function currentTermTheme(): 'light' | 'dark' {
  const bg = tokenRgb('--color-bg', '#14171f');
  if (!bg) return 'dark';
  const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
  return lum > 140 ? 'light' : 'dark';
}


// ── The terminal itself ────────────────────────────────────────────────────────

export interface StyledTerm {
  term: Terminal;
  fit: FitAddon;
  /** The resolved `--font-mono` stack, for re-applying after the webfont lands. */
  fontFamily: string;
  /** The first family in that stack — the face {@link openWhenFontsReady} waits for. */
  primaryMono: string;
  /** Stop following the app's theme. The caller still disposes `term` itself. */
  stopThemeSync: () => void;
}

/**
 * One xterm wearing dreamcontext's design tokens, following the app's theme live.
 *
 * Every option here was argued for once, in `agentSession.ts`'s history, and none of them
 * is arbitrary: 14.5px/1.65 is the owner's comfort setting ("comfort over sharpness"), the
 * bar cursor and 400/700 weights match the installed JetBrains Mono, and
 * `minimumContrastRatio: 3` is the calmed-down floor that rescues Claude's ANSI block fills
 * without force-brightening genuinely dim text.
 */
export function createStyledTerm(opts: { scrollback?: number; cursorBlink?: boolean } = {}): StyledTerm {
  const fontFamily = getComputedStyle(document.body).getPropertyValue('--font-mono').trim()
    || "'JetBrains Mono', ui-monospace, Menlo, monospace";
  const primaryMono = (fontFamily.split(',')[0] || 'JetBrains Mono').replace(/['"]/g, '').trim();

  const term = new Terminal({
    fontFamily,
    fontSize: BASE_FONT * currentZoom(),
    lineHeight: 1.65,
    letterSpacing: 0,
    cursorBlink: opts.cursorBlink ?? true,
    cursorStyle: 'bar',
    fontWeightBold: '700',
    theme: readXtermTheme(),
    allowProposedApi: true,
    scrollback: opts.scrollback ?? 5000,
    minimumContrastRatio: 3,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  const themeObserver = new MutationObserver(() => { term.options.theme = readXtermTheme(); });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class'] });

  return {
    term,
    fit,
    fontFamily,
    primaryMono,
    stopThemeSync: () => { try { themeObserver.disconnect(); } catch { /* gone */ } },
  };
}

/**
 * Run `doOpen` once the mono webfont (both weights) has actually loaded.
 *
 * Not politeness: xterm measures its cell width at `open()`, and measuring against the
 * FALLBACK face bakes in a wider advance that every glyph then renders thin inside. The
 * failure looks like a rendering bug and is a timing one, which is why it gets its own
 * function instead of a comment. Degrades by opening immediately where `document.fonts` is
 * unavailable — a slightly-off grid beats a terminal that never appears.
 */
export function openWhenFontsReady(primaryMono: string, doOpen: () => void): void {
  const fonts = document.fonts;
  if (!fonts?.load) { doOpen(); return; }
  Promise.all([
    fonts.load(`${BASE_FONT}px "${primaryMono}"`),
    fonts.load(`700 ${BASE_FONT}px "${primaryMono}"`),
  ]).then(() => fonts.ready).then(doOpen).catch(doOpen);
}
