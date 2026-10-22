/**
 * A project web page's own pictures and stylesheets, carried into its sandboxed srcdoc
 * (dashboard/src/lib/htmlLocalAssets.ts). The CSP is not relaxed: what is pinned here is that
 * ONLY a document-relative file inside the project is ever picked up, that whatever is not
 * loaded stays exactly as written (so the CSP keeps blocking it), and that both html frames
 * that draw a project page use the inlining and the link guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  findLocalAssets, inlineLocalAssets, LINK_GUARD, MAX_ASSETS,
} from '../../dashboard/src/lib/htmlLocalAssets.js';
import { SANDBOX_CSP } from '../../dashboard/src/lib/sandboxHtml.js';

const DOC = '_dream_context/tmp/taslak/v6/akis.html';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('findLocalAssets', () => {
  it('resolves pictures and stylesheets against the page folder, deduped, in order', () => {
    const html = `
      <link rel="stylesheet" href="stil.css">
      <a href="sonra/1-pano.png"><img src="sonra/1-pano.png" alt="1"></a>
      <img alt="2" src='once/0-pano.png'>
      <img src=sonra/1-pano.png>
      <img src="./ortak/../logo.svg">`;
    expect(findLocalAssets(html, DOC)).toEqual({
      images: [
        '_dream_context/tmp/taslak/v6/sonra/1-pano.png',
        '_dream_context/tmp/taslak/v6/once/0-pano.png',
        '_dream_context/tmp/taslak/v6/logo.svg',
      ],
      styles: ['_dream_context/tmp/taslak/v6/stil.css'],
    });
  });

  it('never picks up a remote, rooted, escaping or non-picture reference', () => {
    const html = `
      <img src="https://evil.test/x.png"><img src="//evil.test/x.png">
      <img src="data:image/png;base64,AAAA"><img src="/etc/passwd.png">
      <img src="~/x.png"><img src="../../../../../../x.png">
      <img src="notes.md"><img data-src="lazy.png">
      <link rel="icon" href="fav.png"><link rel="stylesheet" href="https://cdn.test/a.css">
      <link rel="stylesheet" href="theme.scss">`;
    expect(findLocalAssets(html, DOC)).toEqual({ images: [], styles: [] });
  });

  it('only the page\'s own folder and below: a ref that climbs out or crosses a hidden folder is refused', () => {
    const html = `
      <img src="../ortak/logo.png"><img src="sonra/../../v5/x.png">
      <img src="../../../state/shot.png"><img src="../../../../src/app.png">
      <img src=".git/x.png"><img src="sonra/.cache/x.png"><link rel="stylesheet" href="../theme.css">`;
    expect(findLocalAssets(html, DOC)).toEqual({ images: [], styles: [] });
    // A page at the project root owns the project's (non-hidden) folders.
    expect(findLocalAssets('<img src="img/a.png"><img src=".env/a.png">', 'index.html').images).toEqual(['img/a.png']);
  });

  it('never reads a reference written inside a script, style, template, textarea or comment', () => {
    const html = `<script>var s = "<img src='js.png'>";</script><style>/* <img src="css.png"> */</style>
      <template><img src="tpl.png"></template><textarea><img src="ta.png"></textarea><!-- <img src="c.png"> -->
      <img src="real.png">`;
    expect(findLocalAssets(html, DOC).images).toEqual(['_dream_context/tmp/taslak/v6/real.png']);
  });

  it('a page read by absolute path names no neighbours (only that one file was allowed)', () => {
    expect(findLocalAssets('<img src="a.png">', '/Users/someone/elsewhere/page.html')).toEqual({ images: [], styles: [] });
  });

  it('caps how many files one page may pull in', () => {
    const html = Array.from({ length: MAX_ASSETS + 20 }, (_, i) => `<img src="p${i}.png">`).join('');
    expect(findLocalAssets(html, DOC).images).toHaveLength(MAX_ASSETS);
  });

  it('decodes percent escapes and drops a query', () => {
    expect(findLocalAssets('<img src="my%20shot.png?v=2">', DOC).images).toEqual(['_dream_context/tmp/taslak/v6/my shot.png']);
  });
});

describe('inlineLocalAssets', () => {
  it('writes a loaded picture in as its data URL and leaves the rest of the tag alone', () => {
    const loaded = { images: new Map([['_dream_context/tmp/taslak/v6/sonra/1-pano.png', PNG]]), styles: new Map() };
    const out = inlineLocalAssets('<a href="sonra/1-pano.png"><img class="s" src="sonra/1-pano.png" alt="Pano"></a>', DOC, loaded);
    expect(out).toBe(`<a href="sonra/1-pano.png"><img class="s" src="${PNG}" alt="Pano"></a>`);
  });

  it('leaves a script that builds <img> from a JS string parseable, and keeps the quote it was written with', () => {
    const loaded = { images: new Map([['_dream_context/tmp/taslak/v6/a.png', PNG]]), styles: new Map() };
    const html = `<script>var s = "<img src='a.png'>";</script><img src='a.png' alt="x"><img src=a.png>`;
    const out = inlineLocalAssets(html, DOC, loaded);
    expect(out).toBe(`<script>var s = "<img src='a.png'>";</script><img src='${PNG}' alt="x"><img src="${PNG}">`);
    expect(() => new Function(/<script>([\s\S]*?)<\/script>/.exec(out)![1])).not.toThrow();
  });

  it('a value carrying a quote (an SVG data URL) is escaped, so it cannot leave its attribute', () => {
    const svg = `data:image/svg+xml;charset=utf-8,<svg a='1' b="2">`;
    const loaded = { images: new Map([['_dream_context/tmp/taslak/v6/a.svg', svg]]), styles: new Map() };
    const out = inlineLocalAssets(`<img src='a.svg' alt="ok">`, DOC, loaded);
    expect(out).toBe(`<img src='data:image/svg+xml;charset=utf-8,<svg a=%271%27 b=%222%22>' alt="ok">`);
  });

  it('drops a srcset only where the src was inlined (it would win over the data URL)', () => {
    const loaded = { images: new Map([['_dream_context/tmp/taslak/v6/a.png', PNG]]), styles: new Map() };
    expect(inlineLocalAssets('<img src="a.png" srcset="a@2x.png 2x">', DOC, loaded)).toBe(`<img src="${PNG}">`);
    expect(inlineLocalAssets('<img src="b.png" srcset="b@2x.png 2x">', DOC, loaded)).toBe('<img src="b.png" srcset="b@2x.png 2x">');
  });

  it('leaves an unloaded or remote reference exactly as written', () => {
    const empty = { images: new Map(), styles: new Map() };
    const html = '<img src="missing.png"><img src="https://evil.test/x.png"><link rel="stylesheet" href="x.css">';
    expect(inlineLocalAssets(html, DOC, empty)).toBe(html);
  });

  it('turns a stylesheet link into an inline style in place, and that style cannot close early', () => {
    const loaded = { images: new Map(), styles: new Map([['_dream_context/tmp/taslak/v6/stil.css', 'h1{color:red}</style><script>x()</script>']]) };
    const out = inlineLocalAssets('<head><link href="stil.css" rel="stylesheet"></head>', DOC, loaded);
    expect(out).toBe('<head><style data-dc-src="_dream_context/tmp/taslak/v6/stil.css">h1{color:red}<\\/style><script>x()</script></style></head>');
    expect(out.match(/<\/style>/g)).toHaveLength(1);
  });
});

describe('the sandbox is unchanged and both project-page frames use the inlining', () => {
  it('the CSP still allows pictures only from the document itself', () => {
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(SANDBOX_CSP).toContain('img-src data:');
    expect(SANDBOX_CSP).not.toMatch(/https:|blob:|'self'|http:/);
  });

  it('the link guard cancels every non-anchor link click, in capture', () => {
    expect(LINK_GUARD).toContain("closest('a[href]')");
    expect(LINK_GUARD).toContain("href.charAt(0) === '#'");
    expect(LINK_GUARD).toContain('event.preventDefault()');
    expect(LINK_GUARD).toMatch(/\}, true\);/);
  });

  for (const file of ['dashboard/src/components/appLink/DocumentReader.tsx', 'dashboard/src/components/layout/FrameViewer.tsx']) {
    it(`${file} reads the page through useProjectHtml and loads the link guard`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).toMatch(/useProjectHtml\(path/);
      expect(src).toContain('LINK_GUARD');
    });
  }
});
