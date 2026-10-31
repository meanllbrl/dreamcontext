/**
 * A project web page with no CSS of its own reads with margins and a rhythm (owner 2026-10-31,
 * "padding vs."), a page with CSS is left alone, and the default moves neither the sandbox nor
 * the CSP.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageDefaultCss } from '../../dashboard/src/lib/pageDefaultCss.js';
import { SANDBOX_CSP, buildSandboxSrcdoc } from '../../dashboard/src/lib/sandboxHtml.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('pageDefaultCss', () => {
  it('a page on a card brings its margin; a reader column does not double it', () => {
    expect(pageDefaultCss(true)).toContain('padding: var(--space-6);');
    expect(pageDefaultCss(false)).toContain('padding: 0;');
  });

  it('every rule is gated on a body with no CSS of its own', () => {
    const selectors = pageDefaultCss(true).match(/^\S[^{\n]*\{/gm) ?? [];
    expect(selectors.length).toBeGreaterThan(10);
    for (const s of selectors) expect(s).toContain(':root:not([style]):not(:has(style:not([data-dc-host]), [style]:not(.dc-doc *))) body');
  });

  it('bare elements have zero specificity, so a dc- class beats them', () => {
    const bare = (pageDefaultCss(true).match(/^\S[^{\n]*\{/gm) ?? []).filter((s) => !s.startsWith(':root'));
    expect(bare.length).toBeGreaterThan(5);
    for (const s of bare) expect(s).toMatch(/^:where\(.+\) :where\(.+\) \{/);
  });

  it('marks every style of the host, so any other is the page\'s', () => {
    const doc = buildSandboxSrcdoc({ html: '', css: '.kit{}', tokens: {}, overrideCss: '.o{}' });
    const tags = doc.match(/<style[^>]*>/g) ?? [];
    expect(tags.length).toBe(4);
    for (const tag of tags) expect(tag).toBe('<style data-dc-host>');
  });

  it('holds no colour of its own', () => {
    expect(pageDefaultCss(true)).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i);
  });

  it('every token it names reaches the frame', () => {
    const kit = read('dashboard/src/components/sleepy/chat/chatHtmlKit.ts');
    const names = new Set(pageDefaultCss(true).match(/--[a-z0-9-]+/g));
    for (const n of names) expect(kit, n).toContain(`'${n}'`);
  });

  it('comes after the kit and the sandbox stays as it was', () => {
    const doc = buildSandboxSrcdoc({ html: '<p>x</p>', css: '.kit{}', tokens: {}, overrideCss: pageDefaultCss(true) });
    expect(doc.indexOf('.kit{}')).toBeLessThan(doc.indexOf('.dc-doc > * +'));
    expect(doc).toContain(`content="${SANDBOX_CSP}"`);
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(pageDefaultCss(true)).not.toMatch(/url\(|@import/);
  });

  it('both page surfaces use it', () => {
    expect(read('dashboard/src/components/appLink/DocumentReader.tsx')).toContain('overrideCss: pageDefaultCss(fill)');
    expect(read('dashboard/src/components/layout/FrameViewer.tsx')).toContain('overrideCss: pageDefaultCss(true)');
  });
});
