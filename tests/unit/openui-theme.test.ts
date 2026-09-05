/**
 * The theme DERIVATION, checked without a browser.
 *
 * `verify:openui-look` proves the rendered pixels match the transcript, but it needs Chromium
 * and a dashboard server, so it is not what runs on every change. This file holds the part
 * that can be checked cheaply and that a regression would break first: that every value comes
 * FROM the app's tokens, and that none of OpenUI's own defaults survive.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildOpenUiTheme } from '../../dashboard/src/components/sleepy/chat/openuiTheme.js';

/** A stand-in for the live document: the tokens the kit resolves, with values nothing else
 *  in the system uses, so a hardcoded fallback cannot be mistaken for a derived value. */
const TOKENS: Record<string, string> = {
  '--chat-text': '19px',
  '--chat-line-height': '1.9',
  '--font-family': 'TestBody, sans-serif',
  '--font-family-display': 'TestDisplay, serif',
  '--font-mono': 'TestMono, monospace',
  '--color-bg': '#010203',
  '--color-bg-elevated': '#040506',
  '--color-text': '#070809',
  '--color-text-secondary': '#0a0b0c',
  '--color-accent': '#0d0e0f',
  '--color-border': '#101112',
  '--color-success': '#131415',
  '--color-error': '#161718',
  '--color-warning': '#191a1b',
  '--chart-1': '#c00001', '--chart-2': '#c00002', '--chart-3': '#c00003', '--chart-4': '#c00004',
  '--chart-5': '#c00005', '--chart-6': '#c00006', '--chart-7': '#c00007', '--chart-8': '#c00008',
  '--space-1': '4px', '--space-2': '8px', '--space-3': '12px',
};

vi.mock('../../dashboard/src/components/sleepy/chat/chatHtmlKit.js', () => ({
  resolveChatKitTokens: () => TOKENS,
}));

afterEach(() => vi.clearAllMocks());

describe('openui theme — every value is derived, none invented', () => {
  const theme = buildOpenUiTheme(null) as Record<string, string | string[]>;

  it('takes its faces from the app, not from Inter', () => {
    expect(theme.fontBody).toBe('TestBody, sans-serif');
    expect(theme.fontHeading).toBe('TestDisplay, serif');
    expect(theme.fontCode).toBe('TestMono, monospace');
    // The package's default is Inter everywhere. If any of these came back Inter, the theme
    // is not being applied and the block would silently look foreign.
    // Checked per VALUE, never over the stringified whole: `borderInteractive` and
    // `interactiveAccentDefault` contain the substring "Inter" in their KEY names, and a
    // `JSON.stringify(theme).includes('Inter')` fails on those alone. The first version of
    // this assertion did exactly that and reported a defect that did not exist.
    const interKeys = Object.entries(theme).filter(([, v]) => JSON.stringify(v).includes('Inter')).map(([k]) => k);
    expect(interKeys, `these kept Inter: ${interKeys.join(', ')}`).toEqual([]);
  });

  it('rebuilds the COMPOSITE font shorthands, not just the primitives', () => {
    // The trap: `textBodyDefault` is a `font` shorthand that bakes weight, size, line height
    // AND family into one string. Setting `fontSizeMd` alone leaves every component reading
    // the composite at 16px/1.5 Inter, and the block looks untouched while the tokens look set.
    expect(theme.textBodyDefault).toBe('400 19px/1.9 TestBody, sans-serif');
    expect(theme.textBodyDefaultHeavy).toBe('600 19px/1.9 TestBody, sans-serif');
    expect(theme.textHeadingMd).toContain('TestDisplay, serif');
    expect(theme.textCodeDefault).toContain('TestMono, monospace');
    for (const key of Object.keys(theme)) {
      if (!key.startsWith('text') || Array.isArray(theme[key])) continue;
      expect(String(theme[key]), `${key} kept a hardcoded 16px`).not.toMatch(/\b16px\b/);
    }
  });

  it('scales the whole ramp from the app reading size', () => {
    expect(theme.fontSizeMd).toBe('19px');
    expect(parseFloat(String(theme.fontSizeSm))).toBeLessThan(19);
    expect(parseFloat(String(theme.fontSizeXl))).toBeGreaterThan(19);
  });

  it('hands the CHART palette through — the one thing CSS cannot reach', () => {
    // `useChartPalette` reads `theme.defaultChartPalette` from React context, so a stylesheet
    // override cannot colour a chart. Missing this would leave every chart in the package's
    // own blue while the rest of the block was on-brand.
    expect(theme.defaultChartPalette).toEqual([
      '#c00001', '#c00002', '#c00003', '#c00004', '#c00005', '#c00006', '#c00007', '#c00008',
    ]);
    // Every chart family gets the SAME palette, so a bar and a pie in one answer agree.
    expect(theme.pieChartPalette).toEqual(theme.defaultChartPalette);
    expect(theme.lineChartPalette).toEqual(theme.defaultChartPalette);
  });

  it('maps tone to MEANING, using the app tone tokens', () => {
    expect(theme.textSuccessPrimary).toBe('#131415');
    expect(theme.textDangerPrimary).toBe('#161718');
    expect(theme.textAlertPrimary).toBe('#191a1b');
    expect(theme.interactiveAccentDefault).toBe('#0d0e0f');
  });

  it('survives a document with none of the tokens set', () => {
    // A host with no chat pane (the Meeting Room embed does this) must not produce `NaNpx`.
    expect(() => buildOpenUiTheme(null)).not.toThrow();
    expect(String(theme.fontSizeMd)).not.toContain('NaN');
  });
});
