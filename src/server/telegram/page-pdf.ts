/**
 * A project HTML report page → one PDF, the way the stage draws it (owner 2026-11-09: "Bence bu
 * PDF olarak gelmeliydi").
 *
 * The page is the SAME srcdoc the stage serves (`buildReportSrcdocServer`: the dc- kit CSS, the
 * light theme tokens, the kit's tab and graph scripts, the sandbox CSP first), plus a print
 * layer: A4, backgrounds kept, every `dc-tabs` panel shown under its tab's name, the `dc-graph`
 * laid out before printing (the CSS shows the panels before the kit lays out, and Chrome's
 * virtual-time budget lets the kit's layout timers finish).
 *
 * Rendered by headless Chromium (`--print-to-pdf`, no header/footer), one at a time, killed on a
 * timeout, with a fresh profile folder under the OS temp dir that is always removed. The page is
 * served from a one-off loopback http address (never `file://`, see `chromiumArgs`). No network:
 * the CSP (meta and header) allows only inline style/script and `data:` images/fonts, and the
 * browser gets a dead proxy plus a resolver that resolves nothing.
 *
 * Size (owner, same day): text and vectors stay vectors (the page is never rasterized). Only a
 * PDF over `SMALL_PDF_BYTES` with raster `<img>`s in it is printed again with those images
 * redrawn at <= `TARGET_DPI` for their printed size: a JPEG source as JPEG q0.85, anything else
 * (screenshots with text) as PNG. Chromium already writes every stream Flate-compressed. The
 * smaller of the two prints wins.
 *
 * Any failure (no Chromium, a refused page, a timeout, a bad file, over the upload cap) → null:
 * the caller sends the card's text line.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_CSP, buildReportSrcdocServer } from '../../lib/telegram/chat-kit.js';
import { reportTokens } from '../../lib/telegram/kit-tokens.js';
import { authoredSecretHit } from '../../lib/telegram/render.js';
import { REQUEST_MAX_BYTES } from './pictures.js';

export const PDF_TIMEOUT_MS = 30_000;
export const SMALL_PDF_BYTES = 1024 * 1024;
export const TARGET_DPI = 200;
const PDF_MAGIC = Buffer.from('%PDF-');

export type PagePdfRenderer = (html: string) => Promise<Buffer | null>;

/** The print layer: A4, backgrounds, every tab panel shown (before the kit lays graphs out). */
export const PRINT_CSS = [
  '@page{size:A4;margin:12mm}',
  'html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}',
  '.dc-panels>.dc-panel{display:block!important}',
  '.dc-panels>.dc-panel+.dc-panel{margin-top:18px}',
  '.dc-tabs>.dc-tablist{display:none!important}',
  '.dc-print-tab{display:block;margin:14px 0 6px}',
  // Small blocks stay whole; a table flows across pages, a row never splits, the head repeats.
  '.dc-graph,.dc-card,.dc-callout,.dc-stat,figure,img,svg,tr{break-inside:avoid}',
  'thead{display:table-header-group}',
  '.dc-table,.dc-table-wrap{overflow:visible!important}',
  'h1,h2,h3,.dc-h1,.dc-h2,.dc-h3{break-after:avoid}',
  '.dc-slide{break-after:page}',
  // A picture that could not load: its name in a dashed box, never a silent broken icon.
  '.dc-print-missing{display:block;border:1px dashed currentColor;border-radius:6px;padding:10px 12px;margin:4px 0;opacity:.7;font-size:13px;break-inside:avoid}',
].join('\n');

/**
 * The print script: names each panel after its tab (the tab strip is hidden), loads every
 * picture now (a `loading="lazy"` one below the fold would never load in a print), turns a
 * picture that fails (a path the host could not carry in, which the CSP blocks, or bad bytes)
 * into a named placeholder, and, with `downsample`, redraws oversized raster images at
 * TARGET_DPI for their printed size. Chromium prints after the load event, so every carried
 * picture is decoded first.
 * Runs at DOMContentLoaded, after the kit's own listeners (registered earlier in the head).
 */
export function printScript(downsample: boolean): string {
  return `(function(){
document.addEventListener('DOMContentLoaded',function(){
  [].forEach.call(document.querySelectorAll('.dc-tabs'),function(tabs){
    var names=[].map.call(tabs.querySelectorAll('.dc-tablist .dc-tab'),function(t){return (t.textContent||'').trim();});
    [].forEach.call(tabs.querySelectorAll('.dc-panels > .dc-panel'),function(p,i){
      if(!names[i])return;var h=document.createElement('div');h.className='dc-label dc-print-tab';h.textContent=names[i];p.parentNode.insertBefore(h,p);
    });
  });
  [].forEach.call([].slice.call(document.images),function(img){
    var src=img.getAttribute('src')||'';
    function miss(){
      if(!img.parentNode)return;
      var n=/^data:/i.test(src)?'':src.split(/[?#]/)[0].split('/').pop()||'';
      try{n=decodeURIComponent(n);}catch(e){}
      var d=document.createElement('div');d.className='dc-print-missing';
      d.textContent='Resim yüklenemedi: '+(n||img.getAttribute('alt')||'adsız resim');
      img.parentNode.replaceChild(d,img);
    }
    if(img.loading==='lazy')img.loading='eager';
    if(src&&img.complete&&!img.naturalWidth&&!/^data:/i.test(src))miss();else img.addEventListener('error',miss,{once:true});
  });
  ${downsample ? `var DPI=${TARGET_DPI};
  [].forEach.call(document.images,function(img){
    function go(){try{
      var w=img.getBoundingClientRect().width;if(!w||!img.naturalWidth)return;
      var max=Math.ceil(w*DPI/96);if(img.naturalWidth<=max)return;
      var h=Math.round(img.naturalHeight*max/img.naturalWidth);
      var c=document.createElement('canvas');c.width=max;c.height=h;
      var x=c.getContext('2d');x.imageSmoothingQuality='high';
      var jpeg=/^data:image\\/jpe?g/i.test(img.currentSrc||img.src);
      if(jpeg){x.fillStyle='#fff';x.fillRect(0,0,max,h);}
      x.drawImage(img,0,0,max,h);
      img.style.width=w+'px';img.removeAttribute('srcset');
      img.src=jpeg?c.toDataURL('image/jpeg',0.85):c.toDataURL('image/png');
    }catch(e){}}
    if(img.complete)go();else img.addEventListener('load',go,{once:true});
  });` : ''}
});
})();`;
}

/** The stage's srcdoc for this page + the print layer, or null when the page may not leave. */
export function printablePage(html: string, opts: { downsample?: boolean } = {}): string | null {
  if (!html.trim() || authoredSecretHit(html)) return null;
  const doc = buildReportSrcdocServer(html, reportTokens('light'), 'light');
  const i = doc.indexOf('</head>');
  if (i < 0) return null;
  return `${doc.slice(0, i)}<style data-dc-host>${PRINT_CSS}</style>\n<script>${printScript(!!opts.downsample)}</script>\n${doc.slice(i)}`;
}

/** The Chromium to print with: `DREAMCONTEXT_CHROMIUM`, the Playwright build the repo's verify
 *  scripts use, then an installed Chrome/Chromium/Edge. */
export function findChromium(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  const explicit = env.DREAMCONTEXT_CHROMIUM;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const out: string[] = [];
  const caches = [env.PLAYWRIGHT_BROWSERS_PATH, join(home, 'Library', 'Caches', 'ms-playwright'), join(home, '.cache', 'ms-playwright'), env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'ms-playwright') : undefined];
  for (const dir of caches) {
    if (!dir) continue;
    let names: string[] = [];
    try { names = readdirSync(dir).filter((n) => /^chromium(_headless_shell)?-\d+$/.test(n)).sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop())); } catch { continue; }
    for (const n of names) {
      const base = join(dir, n);
      out.push(
        join(base, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
        join(base, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
        join(base, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        join(base, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
        join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(base, 'chrome-linux', 'chrome'),
        join(base, 'chrome-win', 'chrome.exe'),
      );
    }
  }
  out.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  );
  return out.find((p) => { try { return statSync(p).isFile(); } catch { return false; } }) ?? null;
}

/**
 * Chromium flags: headless print, no network, a throwaway profile inside `dir`. The page is
 * served over loopback http (`pageUrl`), never `file://`: a page on a file origin may navigate
 * itself to any local file and Chromium would print THAT (review r1). An http page cannot open a
 * `file:` URL; every other request goes to a dead proxy and a resolver that resolves nothing,
 * loopback included (`<-loopback>`), except the one port the page is served from.
 */
export function chromiumArgs(dir: string, pageUrl: string, pdfPath: string): string[] {
  const port = new URL(pageUrl).port;
  return [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--mute-audio', '--hide-scrollbars', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', `--user-data-dir=${join(dir, 'profile')}`,
    '--proxy-server=http://127.0.0.1:9', `--proxy-bypass-list=<-loopback>;127.0.0.1:${port}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--run-all-compositor-stages-before-draw', '--virtual-time-budget=5000',
    '--no-pdf-header-footer', '--print-to-pdf-no-header', `--print-to-pdf=${pdfPath}`,
    pageUrl,
  ];
}

/** Serves `page` at one unguessable path on 127.0.0.1 (CSP header too); anything else is a 404. */
export function servePage(page: string): Promise<{ url: string; close: () => void }> {
  const path = `/${randomBytes(16).toString('hex')}.html`;
  const body = Buffer.from(page, 'utf8');
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== path) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': SANDBOX_CSP, 'Cache-Control': 'no-store', 'Content-Length': body.length });
    res.end(body);
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      if (!a || typeof a === 'string') { server.close(); fail(new Error('no port')); return; }
      done({ url: `http://127.0.0.1:${a.port}${path}`, close: () => { server.closeAllConnections?.(); server.close(); } });
    });
  });
}

export function runChromium(bin: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((done) => {
    let settled = false;
    const finish = (ok: boolean) => { if (!settled) { settled = true; clearTimeout(t); done(ok); } };
    const child = spawn(bin, args, { stdio: 'ignore', detached: process.platform !== 'win32' });
    const t = setTimeout(() => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* gone */ }
      finish(false);
    }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
  });
}

export async function printPage(bin: string, page: string, timeoutMs: number): Promise<Buffer | null> {
  const dir = mkdtempSync(join(tmpdir(), 'dc-page-pdf-'));
  let served: { url: string; close: () => void } | null = null;
  try {
    const pdfPath = join(dir, 'page.pdf');
    served = await servePage(page);
    if (!(await runChromium(bin, chromiumArgs(dir, served.url, pdfPath), timeoutMs))) return null;
    const pdf = readFileSync(pdfPath);
    return pdf.length > 64 && pdf.subarray(0, 5).equals(PDF_MAGIC) ? pdf : null;
  } catch {
    return null;
  } finally {
    served?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Raster images worth redrawing: an `<img>` with a data: source (the CSP loads nothing else). */
export function hasRasterImages(html: string): boolean {
  return /<img\b[^>]*\bsrc\s*=\s*["']?data:image\/(?:png|jpe?g|webp|gif|avif)/i.test(html);
}

let queue: Promise<unknown> = Promise.resolve();

/** One page → PDF bytes, or null. Serialised: one Chromium at a time. */
export function makePagePdfRenderer(opts: { chromium?: () => string | null; timeoutMs?: number; print?: (bin: string, page: string, timeoutMs: number) => Promise<Buffer | null> } = {}): PagePdfRenderer {
  const print = opts.print ?? printPage;
  return (html) => {
    const job = queue.then(async () => {
      const bin = (opts.chromium ?? findChromium)();
      const page = bin ? printablePage(html) : null;
      if (!bin || !page) return null;
      const timeoutMs = opts.timeoutMs ?? PDF_TIMEOUT_MS;
      let pdf = await print(bin, page, timeoutMs);
      if (pdf && pdf.length > SMALL_PDF_BYTES && hasRasterImages(html)) {
        const small = await print(bin, printablePage(html, { downsample: true })!, timeoutMs);
        if (small && small.length < pdf.length) pdf = small;
      }
      return pdf && pdf.length <= REQUEST_MAX_BYTES ? pdf : null;
    });
    queue = job.catch(() => null);
    return job.catch(() => null);
  };
}

export const renderPagePdf: PagePdfRenderer = makePagePdfRenderer();
