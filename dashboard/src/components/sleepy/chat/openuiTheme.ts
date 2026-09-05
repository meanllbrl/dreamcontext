/**
 * The `dream-ui` block's theme, DERIVED from the app's own resolved tokens.
 *
 * WHY THIS FILE IS NOT OPTIONAL. `dream-html` needed three passes to stop looking foreign in
 * the transcript (F1-F8, G1-G6 on the depiction task), and every one of those defects was the
 * same shape: the block set its own type, its own scale, its own faces, and looked like an
 * embedded web page rather than part of the answer. OpenUI ships a complete design system of
 * its own — Inter at 16px/1.5, its own greys, its own blue accent, and a dark mode driven by
 * `prefers-color-scheme` — so out of the box it reproduces all of those defects at once, plus
 * a new one this project has never had:
 *
 *   THE DARK-MODE MISMATCH. This app's theme is a `data-theme` attribute the user chooses
 *   (ThemeContext), and it is NOT the OS preference — "system" is merely one of its options.
 *   OpenUI's stylesheet switches on `@media (prefers-color-scheme: dark)`. A user reading in
 *   Light on a dark-mode Mac would get a dark block inside a light transcript. Passing `mode`
 *   explicitly is what makes our switch the only switch.
 *
 * THE RULE, inherited from the kit: nothing here invents a value. Every colour, face, size
 * and space is READ from the live document (`resolveTokens`), so the brand override, the
 * user's zoom and the chosen theme all arrive without this file knowing they exist.
 */
import type { CSSProperties } from 'react';
import { resolveChatKitTokens } from './chatHtmlKit';

/** What `createTheme()` accepts. Typed loosely on purpose: the package's `Theme` has 200+
 *  optional keys and we set a deliberate subset, so a structural type here would be a second
 *  copy of their interface that could drift. The keys we use are asserted by tests. */
export type OpenUiThemeOverrides = Record<string, string | string[]>;

/** The app's reading size, in px, off the live pane — never the token's unevaluated text.
 *  `--chat-text` is `calc(15px * var(--zoom))`, and a custom property resolves lazily: read
 *  as a string it comes back as the calc expression, and every comparison against it is
 *  vacuous. This is the same trap `verify/chat-html.mjs` documents on the measuring side. */
function readingPx(tokens: Record<string, string>, fallback: number): number {
  const raw = tokens['--chat-text'] ?? '';
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build the OpenUI theme from the app's tokens.
 *
 * `scope` is any element inside the chat pane: the two READING tokens live on `.chat-pane`
 * rather than on `:root`, so resolving them off `documentElement` silently returns nothing
 * and the block falls back to OpenUI's own 16px. That exact mistake is recorded as G6 on the
 * `dream-html` side; it is repeated here rather than rediscovered.
 */
export function buildOpenUiTheme(scope: Element | null): OpenUiThemeOverrides {
  // REUSED, not re-derived: `resolveChatKitTokens` already reads the `:root` tokens plus the
  // two READING tokens off the scope element, which is exactly the split that made G6 a bug
  // on the `dream-html` side. A second resolver here could only get that wrong again.
  const t = resolveChatKitTokens(scope);
  const body = readingPx(t, 15);
  const lineHeight = t['--chat-line-height'] || '1.75';
  const fontBody = t['--font-family'] || 'system-ui, sans-serif';
  const fontDisplay = t['--font-family-display'] || fontBody;
  const fontMono = t['--font-mono'] || 'ui-monospace, monospace';

  /** The type ramp, in the app's reading size rather than OpenUI's 16px. Ratios kept from
   *  their scale so component proportions survive; only the base moves. */
  const px = (ratio: number) => `${Math.round(body * ratio * 100) / 100}px`;
  const size = {
    '2xs': px(0.67), xs: px(0.8), sm: px(0.93), md: px(1),
    lg: px(1.13), xl: px(1.25), '2xl': px(1.5), '3xl': px(1.75), '4xl': px(2), '5xl': px(2.25),
  };

  /** A `font` shorthand, which is how every `text*` token in their system is written.
   *  Overriding only the primitives is not enough: the composites bake weight, size, line
   *  height AND family into one string, so a component reading `textBodyDefault` would keep
   *  Inter at 16px however carefully the primitives were set. */
  const font = (weight: number, s: string, lh: string, family: string) => `${weight} ${s}/${lh} ${family}`;

  const heading = (weight: number, s: string) => font(weight, s, '1.25', fontDisplay);
  const text = (weight: number, s: string) => font(weight, s, lineHeight, fontBody);
  const label = (weight: number, s: string) => font(weight, s, '1.3', fontBody);
  const code = (weight: number, s: string) => font(weight, s, '1.5', fontMono);

  return {
    // ── Surfaces and text ────────────────────────────────────────────────────────────────
    // `background` is the page behind the card and `foreground` the card itself, so they map
    // to our two surface tokens in that order — not to text colour, despite the name.
    background: t['--color-bg'] || 'transparent',
    foreground: t['--color-bg-elevated'] || t['--color-bg-secondary'] || 'transparent',
    popoverBackground: t['--color-bg-elevated'] || 'transparent',
    textNeutralPrimary: t['--color-text'] || 'inherit',
    textNeutralSecondary: t['--color-text-secondary'] || 'inherit',
    textNeutralTertiary: t['--color-text-tertiary'] || 'inherit',
    textNeutralLink: t['--color-accent'] || 'inherit',
    textBrand: t['--color-accent'] || 'inherit',
    borderDefault: t['--color-border'] || 'transparent',
    borderInteractive: t['--color-border-hover'] || t['--color-border'] || 'transparent',
    borderInteractiveEmphasis: t['--color-accent'] || 'transparent',
    interactiveAccentDefault: t['--color-accent'] || 'transparent',
    interactiveAccentHover: t['--color-accent-soft'] || t['--color-accent'] || 'transparent',
    interactiveAccentPressed: t['--color-accent'] || 'transparent',

    // ── Tone. Meaning, not decoration — the same four the kit uses. ──────────────────────
    textSuccessPrimary: t['--color-success'] || 'inherit',
    successBackground: t['--color-success-subtle'] || 'transparent',
    borderSuccessEmphasis: t['--color-success'] || 'transparent',
    textDangerPrimary: t['--color-error'] || 'inherit',
    dangerBackground: t['--color-error-subtle'] || 'transparent',
    borderDangerEmphasis: t['--color-error'] || 'transparent',
    textAlertPrimary: t['--color-warning'] || 'inherit',
    borderAlertEmphasis: t['--color-warning'] || 'transparent',
    textInfoPrimary: t['--color-accent'] || 'inherit',
    borderInfoEmphasis: t['--color-accent'] || 'transparent',

    // ── Charts. The ONE part that is not CSS: the palette is read through their React
    // context (`useChartPalette` → `theme.defaultChartPalette`), so a stylesheet override
    // cannot reach it. These are the same eight fills the kit's `dc-f1..8` use, in order,
    // which is what makes a chart in this mode and a chart in the other one the same chart.
    ...chartPalettes([1, 2, 3, 4, 5, 6, 7, 8].map((i) => t[`--chart-${i}`]).filter(Boolean)),

    // ── Type ─────────────────────────────────────────────────────────────────────────────
    fontBody, fontLabel: fontBody, fontNumbers: fontBody, fontHeading: fontDisplay, fontCode: fontMono,
    fontSize2xs: size['2xs'], fontSizeXs: size.xs, fontSizeSm: size.sm, fontSizeMd: size.md,
    fontSizeLg: size.lg, fontSizeXl: size.xl, fontSize2xl: size['2xl'], fontSize3xl: size['3xl'],
    fontSize4xl: size['4xl'], fontSize5xl: size['5xl'],
    lineHeightBody: lineHeight,
    letterSpacingNormal: t['--letter-spacing-body'] || '0',

    textBodyXs: text(400, size.xs), textBodyXsHeavy: text(600, size.xs),
    textBodySm: text(400, size.sm), textBodySmHeavy: text(600, size.sm),
    textBodyDefault: text(400, size.md), textBodyDefaultHeavy: text(600, size.md),
    textBodyLg: text(400, size.lg), textBodyLgHeavy: text(600, size.lg),
    textHeadingXs: heading(600, size.md), textHeadingSm: heading(600, size.lg),
    textHeadingMd: heading(600, size.xl), textHeadingLg: heading(600, size['2xl']),
    textHeadingXl: heading(700, size['3xl']),
    textLabelXs: label(400, size.xs), textLabelXsHeavy: label(600, size.xs),
    textLabelSm: label(400, size.sm), textLabelSmHeavy: label(600, size.sm),
    textLabelDefault: label(400, size.md), textLabelDefaultHeavy: label(600, size.md),
    textLabelLg: label(400, size.lg), textLabelLgHeavy: label(600, size.lg),
    textNumbersXs: text(400, size.xs), textNumbersSm: text(400, size.sm),
    textNumbersDefault: text(400, size.md), textNumbersLg: text(400, size.lg),
    textNumbersHeadingSm: heading(600, size.lg), textNumbersHeadingMd: heading(600, size.xl),
    textCodeSm: code(400, size.xs), textCodeDefault: code(400, size.sm),

    // ── Space. The project's 4px grid, read rather than restated. ────────────────────────
    space2xs: t['--space-1'] || '4px', spaceS: t['--space-2'] || '8px',
    spaceM: t['--space-3'] || '12px', spaceML: t['--space-4'] || '16px',
    spaceXl: t['--space-6'] || '24px', space2xl: t['--space-8'] || '32px',
  };
}

/** Every chart family gets the SAME eight fills. Their system allows a palette per chart
 *  type; using one keeps a bar and a pie in the same answer speaking the same colour
 *  language, which is the kit's rule too. */
function chartPalettes(colors: string[]): OpenUiThemeOverrides {
  if (colors.length === 0) return {};
  return Object.fromEntries([
    'defaultChartPalette', 'barChartPalette', 'lineChartPalette', 'areaChartPalette',
    'pieChartPalette', 'radarChartPalette', 'radialChartPalette', 'horizontalBarChartPalette',
  ].map((k) => [k, colors]));
}

/** Reserved for values that must be computed rather than written once — the box itself now
 *  lives in `OpenUiView.css`, where it can reach the card inside it. */
export const OPENUI_BLOCK_STYLE: CSSProperties = {};
