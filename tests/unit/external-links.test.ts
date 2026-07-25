/**
 * Unit tests for externalLinks.ts — the rule that keeps a link from destroying the
 * desktop app. The shell has no back button, so a URL followed in-place replaces the
 * app with a web page the user can't return from; these tests pin exactly which hrefs
 * leave for the browser (absolute http/https/mailto/tel, including same-origin and
 * ⌘-clicked ones) and which stay in the page (every relative href, and the absolute
 * schemes that must never reach the OS).
 *
 * Structural stubs stand in for DOM events — the suite runs in node, and the module is
 * written duck-typed precisely so this logic is testable without a browser.
 */
import { describe, it, expect } from 'vitest';
import { externalHref, externalUrlForClick } from '../../dashboard/src/lib/externalLinks.js';

/** A click on an anchor carrying `href`, or on no anchor at all when href is null. */
function clickOn(href: string | null, over: Partial<{ type: string; button: number; defaultPrevented: boolean }> = {}) {
  return {
    type: 'click',
    button: 0,
    defaultPrevented: false,
    target: {
      closest: (selector: string) =>
        (selector === 'a[href]' && href !== null ? { getAttribute: () => href } : null),
    },
    ...over,
  };
}

// ─── externalHref ───────────────────────────────────────────────────────────────

describe('externalHref', () => {
  it('sends absolute http(s) URLs to the browser', () => {
    expect(externalHref('https://github.com/meanllbrl/dreamcontext')).toBe('https://github.com/meanllbrl/dreamcontext');
    expect(externalHref('http://example.com/a?b=1#c')).toBe('http://example.com/a?b=1#c');
  });

  it('sends a SAME-ORIGIN absolute URL out too — an answer that writes the address means the address', () => {
    // The reported break: the dashboard's own server URL, printed by the agent.
    expect(externalHref('http://127.0.0.1:53628')).toBe('http://127.0.0.1:53628/');
  });

  it('accepts mailto and tel', () => {
    expect(externalHref('mailto:mehmet@nuraydin.com')).toBe('mailto:mehmet@nuraydin.com');
    expect(externalHref('tel:+15551234567')).toBe('tel:+15551234567');
  });

  it('treats a protocol-relative href as absolute — the browser would leave the app for it', () => {
    expect(externalHref('//example.com/x')).toBe('https://example.com/x');
  });

  it('trims surrounding whitespace', () => {
    expect(externalHref('  https://example.com  ')).toBe('https://example.com/');
  });

  it('leaves every relative href alone — those are in-app routes and file paths', () => {
    expect(externalHref('/tasks')).toBeNull();
    expect(externalHref('/api/agent/file?path=x&raw=1')).toBeNull();
    expect(externalHref('src/server/routes/agent-chat.ts')).toBeNull();
    expect(externalHref('./clip.mp4')).toBeNull();
    expect(externalHref('#top')).toBeNull();
  });

  it('refuses absolute schemes that must never reach the OS', () => {
    expect(externalHref('javascript:alert(1)')).toBeNull();
    expect(externalHref('data:text/html,<script>x</script>')).toBeNull();
    expect(externalHref('blob:http://127.0.0.1:53628/abc')).toBeNull();
    expect(externalHref('file:///etc/passwd')).toBeNull();
  });

  it('handles an absent or empty href', () => {
    expect(externalHref(null)).toBeNull();
    expect(externalHref(undefined)).toBeNull();
    expect(externalHref('')).toBeNull();
    expect(externalHref('   ')).toBeNull();
  });
});

// ─── externalUrlForClick ────────────────────────────────────────────────────────

describe('externalUrlForClick', () => {
  it('claims a plain left click on an external link', () => {
    expect(externalUrlForClick(clickOn('https://example.com/x'))).toBe('https://example.com/x');
  });

  it('claims a ⌘-click — the modifier is what broke the app, not a reason to let it through', () => {
    const metaClick = { ...clickOn('https://example.com/x'), metaKey: true };
    expect(externalUrlForClick(metaClick)).toBe('https://example.com/x');
  });

  it('claims a middle click, which is a new-tab request', () => {
    expect(externalUrlForClick(clickOn('https://example.com/x', { type: 'auxclick', button: 1 })))
      .toBe('https://example.com/x');
  });

  it('leaves a right click to the context menu', () => {
    expect(externalUrlForClick(clickOn('https://example.com/x', { type: 'auxclick', button: 2 }))).toBeNull();
  });

  it('ignores a non-primary button on an ordinary click', () => {
    expect(externalUrlForClick(clickOn('https://example.com/x', { button: 1 }))).toBeNull();
  });

  it('defers to a handler that already claimed the click', () => {
    expect(externalUrlForClick(clickOn('https://example.com/x', { defaultPrevented: true }))).toBeNull();
  });

  it('ignores a click that landed on no link', () => {
    expect(externalUrlForClick(clickOn(null))).toBeNull();
  });

  it('ignores a click whose target cannot be walked', () => {
    expect(externalUrlForClick({ type: 'click', button: 0, defaultPrevented: false, target: null })).toBeNull();
    expect(externalUrlForClick({ type: 'click', button: 0, defaultPrevented: false, target: undefined })).toBeNull();
  });

  it('leaves an in-app link to the router', () => {
    expect(externalUrlForClick(clickOn('/tasks'))).toBeNull();
    expect(externalUrlForClick(clickOn('src/server/index.ts'))).toBeNull();
  });
});
