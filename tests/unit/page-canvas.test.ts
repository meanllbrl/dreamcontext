import { describe, expect, it } from 'vitest';
import { OWN_CANVAS_CSS, pageOwnsPalette, pageTokens } from '../../dashboard/src/lib/pageCanvas.js';
import { CHAT_KIT_TOKENS } from '../../src/lib/telegram/kit-tokens.js';

// A fictional report, shaped like the one that was half unreadable in the dark theme
// (owner, 2026-11-09): its own stylesheet colours headings dark and table heads white.
const LIGHT_REPORT = `<style>
  h1, h2 { color: #1a1a2e; }
  th { background: #fff; color: #333; }
  .callout { background: white; border-left: 4px solid #222; }
</style>
<h1>Acme card declines</h1><div class="callout">Result</div><table><tr><th>Country</th></tr></table>`;

describe('pageOwnsPalette: a page is fully themed or fully its own', () => {
  it('a page whose stylesheet names literal colours gets its own canvas', () => {
    expect(pageOwnsPalette(LIGHT_REPORT)).toBe(true);
    expect(pageOwnsPalette('<style>body{background-color:rgb(250,250,250)}</style><p>x</p>')).toBe(true);
    expect(pageOwnsPalette('<style>.t { color: hsl(0 0% 10%) }</style>')).toBe(true);
  });

  it('a kit page, an unstyled page and geometry-only CSS follow the theme', () => {
    expect(pageOwnsPalette('<div class="dc-doc"><h1 class="dc-h1">Hi</h1></div>')).toBe(false);
    expect(pageOwnsPalette('<h1>Plain</h1><table><tr><td>1</td></tr></table>')).toBe(false);
    expect(pageOwnsPalette('<style>.grid { display: grid; gap: 8px; color: var(--color-text); background: transparent }</style>')).toBe(false);
    // A var() fallback is never used: the kit defines every token.
    expect(pageOwnsPalette('<style>.x { background: var(--color-bg, #fff) }</style>')).toBe(false);
  });

  it('inline colours inside the page are geometry or a self-contained mockup, not the page palette', () => {
    expect(pageOwnsPalette('<div class="dc-doc"><div style="width:40%;background:#7b68ee"></div></div>')).toBe(false);
  });

  it('colour on <html>/<body> or legacy colour attributes count', () => {
    expect(pageOwnsPalette('<body style="color:#111"><p>x</p></body>')).toBe(true);
    expect(pageOwnsPalette('<table bgcolor="#ffffff"><tr><td>x</td></tr></table>')).toBe(true);
  });

  it('a page that handles dark itself follows the theme', () => {
    expect(pageOwnsPalette(`${LIGHT_REPORT}<style>@media (prefers-color-scheme: dark) { h1 { color: #eee } }</style>`)).toBe(false);
    expect(pageOwnsPalette(`<meta name="color-scheme" content="light dark">${LIGHT_REPORT}`)).toBe(false);
    expect(pageOwnsPalette('<style>:root { color-scheme: light dark } h1 { color: #111 }</style>')).toBe(false);
    // Declaring light only is still its own light page.
    expect(pageOwnsPalette('<style>:root { color-scheme: light } h1 { color: #111 }</style>')).toBe(true);
  });
});

describe('pageTokens', () => {
  const live = { '--color-bg': '#111', '--color-text': '#eee', '--chart-1': '#9d8cff', '--space-2': '8px', '--chat-text': '15px' };

  it('the same theme keeps the live tokens', () => {
    expect(pageTokens(live, 'dark', 'dark')).toBe(live);
  });

  it('a light canvas under the dark app swaps only colours, keeping spacing and reading size', () => {
    const out = pageTokens(live, 'light', 'dark');
    expect(out['--color-bg']).toBe(CHAT_KIT_TOKENS.light['--color-bg']);
    expect(out['--color-text']).toBe(CHAT_KIT_TOKENS.light['--color-text']);
    expect(out['--chart-1']).toBe(CHAT_KIT_TOKENS.light['--chart-1']);
    expect(out['--space-2']).toBe('8px');
    expect(out['--chat-text']).toBe('15px');
  });

  it('the own canvas is opaque, painted from the token', () => {
    expect(OWN_CANVAS_CSS).toContain('background: var(--color-bg)');
  });
});
