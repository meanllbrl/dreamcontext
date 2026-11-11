/**
 * A question option's drawing (its AskUserQuestion `preview`, dream-html) → one PNG, without the
 * Mac window (owner 2026-11-09: "çizim gözükmüyor"). The window's sealed renderer
 * (`pictures.ts` `snapshotPage`) needs the Super window open; this one needs only Chromium, the
 * way the page PDF prints (`page-pdf.ts`: same binary search, loopback http origin, dead proxy,
 * throwaway profile, killed on a timeout, one at a time).
 *
 * The page is the chat card's own srcdoc (`buildChatSrcdocServer`, light theme, dc- kit). Two
 * runs: the first lays the page out and reports its height by navigating to `?h=<px>` on the same
 * one-off server (the sandbox CSP lets a page load nothing else); the second screenshots exactly
 * that height (capped) at 2x. Any failure → null: the caller says the drawing is on the Mac.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { SANDBOX_CSP, buildChatSrcdocServer } from '../../lib/telegram/chat-kit.js';
import { chatHtmlTokens } from '../../lib/telegram/kit-tokens.js';
import { authoredSecretHit } from '../../lib/telegram/render.js';
import { DRAWING_RENDER_WIDTH_PX, SERVER_RENDER_WIDTH_PX } from '../../lib/telegram/contract.js';
import { findChromium, runChromium } from './page-pdf.js';

export const SHOT_TIMEOUT_MS = 20_000;
/** A drawing taller than this is cut at the bottom; this tall it already goes as a document
 *  (pictures.ts sendWhole), so the cap is only a fence against a runaway page. */
export const SHOT_MAX_HEIGHT_PX = 6000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PreviewShooter = (html: string) => Promise<Buffer | null>;

/** The card page for one preview, or null when it may not leave (a secret in it, empty). */
export function previewPage(html: string, measure: boolean): string | null {
  if (!html.trim() || authoredSecretHit(html)) return null;
  const doc = buildChatSrcdocServer({ html, tokens: chatHtmlTokens('light'), scheme: 'light', mode: 'card' });
  if (!measure) return doc;
  const i = doc.lastIndexOf('</body>');
  // After the kit's layout timers: report the laid-out height by a same-origin navigation.
  const script = '<script>window.__dcNoFit=1;window.addEventListener("load",function(){setTimeout(function(){'
    // Content wider than its box anywhere (a long <pre> line, a no-wrap row, a wide table): the
    // page is too narrow for it (the caller may draw it wider).
    + 'var o=document.documentElement.scrollWidth>window.innerWidth+1?1:0;'
    + 'if(!o){var a=document.querySelectorAll("*");for(var i=0;i<a.length;i++){var e=a[i];if(e.clientWidth&&e.scrollWidth>e.clientWidth+1){o=1;break;}}}'
    // Then fitted as the shot will be (render.ts fitDrawing), so the height is the fitted one.
    + 'if(window.__dcFit)window.__dcFit();'
    + 'var h=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0)*(parseFloat(document.documentElement.style.zoom)||1));'
    + 'location.replace(location.pathname+"?h="+h+"&o="+o);},600);});</script>';
  return i < 0 ? `${doc}${script}` : `${doc.slice(0, i)}${script}${doc.slice(i)}`;
}

/** Serves `page` at one unguessable path; `?h=<n>&o=<0|1>` on it records the height and whether
 *  content overflowed, and serves a blank page. */
function serve(page: string): Promise<{ url: string; height: () => number | null; overflow: () => boolean; close: () => void }> {
  const path = `/${randomBytes(16).toString('hex')}.html`;
  const body = Buffer.from(page, 'utf8');
  let height: number | null = null;
  let overflow = false;
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || u.pathname !== path) { res.writeHead(404).end(); return; }
    const h = u.searchParams.get('h');
    if (h !== null) {
      const n = Number(h);
      if (Number.isFinite(n) && n > 0) height = Math.ceil(n);
      overflow = u.searchParams.get('o') === '1';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': SANDBOX_CSP }).end('<!doctype html><title>.</title>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': SANDBOX_CSP, 'Cache-Control': 'no-store', 'Content-Length': body.length });
    res.end(body);
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      if (!a || typeof a === 'string') { server.close(); fail(new Error('no port')); return; }
      done({ url: `http://127.0.0.1:${a.port}${path}`, height: () => height, overflow: () => overflow, close: () => { server.closeAllConnections?.(); server.close(); } });
    });
  });
}

/** The page-PDF flags minus printing: no network, throwaway profile, the one loopback port. */
export function shotArgs(dir: string, pageUrl: string, width: number, height: number, out: string | null): string[] {
  const port = new URL(pageUrl).port;
  return [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--mute-audio', '--hide-scrollbars', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', `--user-data-dir=${join(dir, 'profile')}`,
    '--proxy-server=http://127.0.0.1:9', `--proxy-bypass-list=<-loopback>;127.0.0.1:${port}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--run-all-compositor-stages-before-draw', '--virtual-time-budget=3000', '--force-device-scale-factor=2',
    `--window-size=${width},${height}`,
    ...(out ? [`--screenshot=${out}`] : ['--dump-dom']),
    pageUrl,
  ];
}

/**
 * One preview → PNG. With `wide` (wider than `width`): the page is measured at `width` first, and
 * when any of its content overflows there (it would be cut off) it is drawn at `wide` instead, so
 * a drawing is narrow (its text big on a phone) only when nothing of it is lost.
 */
export async function shootPreview(bin: string, html: string, timeoutMs = SHOT_TIMEOUT_MS, width = SERVER_RENDER_WIDTH_PX, wide?: number): Promise<Buffer | null> {
  const measurePage = previewPage(html, true);
  const page = previewPage(html, false);
  if (!measurePage || !page) return null;
  const dir = mkdtempSync(join(tmpdir(), 'dc-preview-shot-'));
  const opened: { close: () => void }[] = [];
  try {
    let m = await serve(measurePage);
    opened.push(m);
    await runChromium(bin, shotArgs(dir, m.url, width, 100, null), timeoutMs);
    if (wide && wide > width && m.overflow()) {
      width = wide;
      m = await serve(measurePage);
      opened.push(m);
      await runChromium(bin, shotArgs(dir, m.url, width, 100, null), timeoutMs);
    }
    // A short window: scrollHeight is never below the viewport, so the page reports its own height.
    const height = Math.min(Math.max(m.height() ?? 800, 120), SHOT_MAX_HEIGHT_PX);
    const s = await serve(page);
    opened.push(s);
    const out = join(dir, 'shot.png');
    if (!(await runChromium(bin, shotArgs(dir, s.url, width, height, out), timeoutMs))) return null;
    const png = readFileSync(out);
    return png.length > 64 && png.subarray(0, 8).equals(PNG_MAGIC) ? png : null;
  } catch {
    return null;
  } finally {
    for (const o of opened) o.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** One preview → PNG bytes, or null. Serialised with itself: one Chromium at a time. */
export function makePreviewShooter(opts: { chromium?: () => string | null; shoot?: (bin: string, html: string) => Promise<Buffer | null> } = {}): PreviewShooter {
  // At a phone's width (the drawing goes as a photo the phone shows full width), unless that
  // would cut its content: then at the chat's width, whole.
  const shoot = opts.shoot ?? ((bin: string, html: string) => shootPreview(bin, html, SHOT_TIMEOUT_MS, DRAWING_RENDER_WIDTH_PX, SERVER_RENDER_WIDTH_PX));
  return (html) => {
    const job = queue.then(async () => {
      const bin = (opts.chromium ?? findChromium)();
      return bin ? shoot(bin, html) : null;
    });
    queue = job.catch(() => null);
    return job.catch(() => null);
  };
}

export const shootPreviewPng: PreviewShooter = makePreviewShooter();
