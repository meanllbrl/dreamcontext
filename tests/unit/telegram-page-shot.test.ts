/**
 * An option's drawing → PNG with headless Chromium (page-shot.ts, owner 2026-11-09 "çizim
 * gözükmüyor"): the page never leaves with a secret, the browser gets no network, no Chromium is
 * null (the caller says the drawing is on the Mac), and one Chromium runs at a time.
 */
import { describe, it, expect } from 'vitest';
import { makePreviewShooter, previewPage, shotArgs, shootPreviewPng } from '../../src/server/telegram/page-shot.js';
import { findChromium } from '../../src/server/telegram/page-pdf.js';
import { imageSize } from '../../src/server/telegram/pictures.js';
import { fitDrawing } from '../../src/lib/telegram/render.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

describe('previewPage', () => {
  it('builds the chat card page; the measuring copy reports its height to its own origin', () => {
    const page = previewPage('<div class="dc-card">Kart</div>', false)!;
    expect(page).toContain('dc-card');
    expect(page).not.toContain('?h=');
    expect(previewPage('<div class="dc-card">Kart</div>', true)).toContain('location.replace(location.pathname+"?h="');
  });

  it('an empty page or one carrying a secret never leaves', () => {
    expect(previewPage('   ', false)).toBeNull();
    expect(previewPage('<p>sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</p>', false)).toBeNull();
  });
});

describe('shotArgs', () => {
  it('no network but its own loopback port, a throwaway profile, the screenshot at the measured size', () => {
    const a = shotArgs('/tmp/x', 'http://127.0.0.1:4567/p.html', 720, 900, '/tmp/x/shot.png');
    expect(a).toContain('--proxy-server=http://127.0.0.1:9');
    expect(a).toContain('--proxy-bypass-list=<-loopback>;127.0.0.1:4567');
    expect(a).toContain('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
    expect(a).toContain('--user-data-dir=/tmp/x/profile');
    expect(a).toContain('--window-size=720,900');
    expect(a).toContain('--screenshot=/tmp/x/shot.png');
    expect(a.at(-1)).toBe('http://127.0.0.1:4567/p.html');
  });
});

describe('makePreviewShooter', () => {
  it('no Chromium on the machine: null', async () => {
    expect(await makePreviewShooter({ chromium: () => null })('<div>x</div>')).toBeNull();
  });

  it('one Chromium at a time', async () => {
    let running = 0; let most = 0;
    const shoot = makePreviewShooter({ chromium: () => '/bin/chromium', shoot: async () => { running++; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 20)); running--; return Buffer.from('png'); } });
    await Promise.all([shoot('a'), shoot('b'), shoot('c')]);
    expect(most).toBe(1);
  });
});

// Real Chromium, when the machine has one (the review's case, 2026-11-11).
describe.skipIf(!findChromium())('an option drawing is narrow only when nothing of it is lost', () => {
  it('a short card is drawn at a phone width (420 CSS px, 2x)', async () => {
    const png = await shootPreviewPng('<div class="dc-card"><div class="dc-card-title">Kargo</div><p class="dc-p">Kısa kart</p></div>');
    expect(imageSize(png!)?.w).toBe(840);
  }, 60_000);

  it('a line wider than the phone width is drawn at the chat width (720)', async () => {
    const png = await shootPreviewPng(fitDrawing('<div class="dc-card"><pre>npx wrangler deploy --env production --minify --compatibility-date 2026-11-01</pre></div>'));
    expect(imageSize(png!)?.w).toBe(1440);
  }, 60_000);

  const LINE = 'gh api repos/acme/web/actions/workflows/deploy.yml/dispatches -f ref=main -f inputs[env]=production -f inputs[purge]=true';
  // Fitted page, in Chromium: "fits" when no box still clips content wider than itself and the
  // text's own end (a Range) is inside the window. Unfitted, each of these reads "cut".
  const CHECK = '<script>window.addEventListener("load",function(){setTimeout(function(){'
    + 'var clip=0,a=document.querySelectorAll("body *");for(var i=0;i<a.length;i++){var e=a[i],c=getComputedStyle(e);'
    + 'if(e.clientWidth&&e.scrollWidth>e.clientWidth+1&&(c.overflowX!=="visible"||c.overflowY!=="visible"))clip=1;}'
    + 'var r=document.createRange();r.selectNodeContents(document.getElementById("l"));'
    + 'document.title=(!clip&&r.getBoundingClientRect().right<=window.innerWidth+1)?"fits":"cut";},900);});</script>';
  function fittedTitle(body: string, fit = true): string {
    const html = (fit ? fitDrawing(body) : body) + CHECK;
    const bin = findChromium()!;
    const dir = mkdtempSync(join(tmpdir(), 'dc-fit-'));
    try {
      writeFileSync(join(dir, 'p.html'), previewPage(html, false)!);
      const dom = execFileSync(bin, ['--headless', '--disable-gpu', `--user-data-dir=${join(dir, 'prof')}`, '--window-size=720,400', '--virtual-time-budget=4000', '--dump-dom', `file://${join(dir, 'p.html')}`], { encoding: 'utf8', timeout: 30_000 });
      return /<title>([^<]*)<\/title>/.exec(dom)?.[1] ?? '';
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const CASES: Array<[string, string]> = [
    ['a bare <pre>', `<div class="dc-card"><pre id="l">${LINE}</pre></div>`],
    ['an authored overflow:auto <pre>', `<div class="dc-card"><pre id="l" style="overflow:auto">${LINE}</pre></div>`],
    ['an overflow:hidden wrapper', `<div style="overflow:hidden;border-radius:8px"><pre id="l">${LINE}</pre></div>`],
    ['a no-wrap row in an overflow:hidden box', `<div style="overflow:hidden"><div id="l" style="white-space:nowrap">${LINE}</div></div>`],
  ];
  for (const [name, body] of CASES) {
    it(`a line wider than even 720, ${name}: nothing clips, its end is inside the picture`, () => {
      expect(fittedTitle(body, false)).toBe('cut');
      expect(fittedTitle(body)).toBe('fits');
    }, 60_000);
  }

  it('the fitted page still comes out at the chat width', async () => {
    const png = await shootPreviewPng(fitDrawing(`<div style="overflow:hidden"><pre id="l">${LINE}</pre></div>`));
    expect(imageSize(png!)?.w).toBe(1440);
  }, 60_000);
});
