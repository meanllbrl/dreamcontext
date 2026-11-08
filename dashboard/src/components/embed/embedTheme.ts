/**
 * An embedded screen in the app's colours (plan r9, D13). Applying only `--color-*` tokens recolours
 * the real Chat almost entirely, so this derives the set from what the page said and never touches
 * a component. Pure: colours in, tokens out. A pair under 4.5:1 is dropped, never drawn.
 */

export interface EmbedColors {
  bg?: string | null;
  surface?: string | null;
  text?: string | null;
  accent?: string | null;
}

const HEX = /^#[0-9a-f]{6}$/;

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function hexOf(c: readonly number[]): string {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

export function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return hexOf(x.map((v, i) => v + (y[i] - v) * t));
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const MIN = 4.5;
/** The strongest of a colour fading towards the background that still reads; else the colour. */
function readable(text: string, bg: string, fade: number): string {
  const c = mix(text, bg, fade);
  return contrast(c, bg) >= MIN ? c : text;
}

/** The `--color-*` overrides for these colours; empty when the page named no usable background. */
export function embedTokens(c: EmbedColors): Record<string, string> {
  const bg = c.bg && HEX.test(c.bg) ? c.bg : null;
  if (!bg) return {};
  // The better of the two, measured: a mid grey fails with the one its lightness suggests.
  const soft = contrast('#f2f3f5', bg) >= contrast('#14161a', bg) ? '#f2f3f5' : '#14161a';
  const fallback = contrast(soft, bg) >= MIN ? soft : contrast('#ffffff', bg) >= contrast('#000000', bg) ? '#ffffff' : '#000000';
  const text = c.text && HEX.test(c.text) && contrast(c.text, bg) >= MIN ? c.text : fallback;
  const surface = c.surface && HEX.test(c.surface) && contrast(text, c.surface) >= MIN ? c.surface : mix(bg, text, 0.05);
  const tokens: Record<string, string> = {
    '--color-bg': bg,
    '--color-bg-secondary': surface,
    '--color-bg-tertiary': mix(bg, text, 0.09),
    '--color-bg-elevated': surface,
    '--color-border': mix(bg, text, 0.16),
    '--color-border-hover': mix(bg, text, 0.26),
    '--color-text': text,
    '--color-text-secondary': readable(text, bg, 0.25),
    '--color-text-tertiary': readable(text, bg, 0.38),
    '--color-text-placeholder': readable(text, bg, 0.42),
  };
  if (c.accent && HEX.test(c.accent) && contrast(c.accent, bg) >= MIN) {
    tokens['--color-accent'] = c.accent;
    tokens['--color-accent-strong'] = c.accent;
    tokens['--color-accent-text'] = c.accent;
    tokens['--color-accent-soft'] = mix(bg, c.accent, 0.14);
    tokens['--color-accent-ink'] = contrast('#ffffff', c.accent) >= contrast('#101114', c.accent) ? '#ffffff' : '#101114';
  }
  return tokens;
}
