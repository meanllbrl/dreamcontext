import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cardOut, type CardContext } from '../../src/server/telegram/cards.js';
import { sendPresentation } from '../../src/server/telegram/present.js';
import { chromiumArgs, findChromium, makePagePdfRenderer, PRINT_CSS, printablePage, SMALL_PDF_BYTES } from '../../src/server/telegram/page-pdf.js';
import { SANDBOX_CSP } from '../../src/lib/telegram/chat-kit.js';
import { REQUEST_MAX_BYTES } from '../../src/server/telegram/pictures.js';
import type { SuperContainer } from '../../src/lib/super/types.js';

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 32)]);
const card = (kind: SuperContainer['kind'], ref: string, title: string): SuperContainer => ({ id: `${kind}-1`, kind, ref, shape: 'square', place: 'main', title } as SuperContainer);

function project(): { dir: string; ctx: CardContext } {
  const dir = mkdtempSync(join(tmpdir(), 'tg-page-pdf-'));
  const root = join(dir, '_dream_context');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(dir, 'rapor.html'), '<div class="dc-doc"><h1 class="dc-h1">Rapor</h1></div>');
  const ctx: CardContext = { contextRoot: root, sessionId: 's', pictures: true, isGitIgnored: () => false, snapshot: async () => { throw new Error('no snapshot for a page'); } };
  return { dir, ctx };
}

function fakeHub(uploadOk = true) {
  const upload = vi.fn(async () => (uploadOk ? { message_id: 7 } : null));
  const ab = { key: 'k', projectName: 'p', binding: { chatId: 1 }, transport: { upload } } as never;
  const hub = { send: vi.fn(async () => ({})), reply: vi.fn(async () => {}), sendButtons: vi.fn(async () => ({})) } as never as Parameters<typeof sendPresentation>[0];
  return { hub, ab, upload };
}

describe('a project HTML page card goes as a PDF document', () => {
  it('page card → one .pdf document, sent with sendDocument and its title as caption', async () => {
    const { dir, ctx } = project();
    try {
      const renderPdf = vi.fn(async () => PDF);
      const out = await cardOut({ ...ctx, renderPdf }, card('web', 'rapor.html', 'Sürüm 0.41.10'));
      expect(renderPdf).toHaveBeenCalledWith(expect.stringContaining('dc-h1'));
      expect(out).toMatchObject({ kind: 'media', items: [{ kind: 'document', title: 'Sürüm 0.41.10', file: { name: 'Sürüm 0.41.10.pdf', contentType: 'application/pdf' } }] });
      const { hub, ab, upload } = fakeHub();
      const r = await sendPresentation(hub, ab, [out], 'spotlight', 0, 's', { phoneLink: () => 'off' });
      expect(r).toMatchObject({ photos: 0, texts: 0 });
      expect(upload).toHaveBeenCalledTimes(1);
      const [method, params, files] = upload.mock.calls[0] as unknown as [string, Record<string, unknown>, Record<string, { name: string; data: Buffer }>];
      expect(method).toBe('sendDocument');
      expect(params.caption).toBe('Sürüm 0.41.10');
      expect(files.document.name).toMatch(/\.pdf$/);
      expect(files.document.data.equals(PDF)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a live URL card is unchanged: a link line, no render', async () => {
    const { dir, ctx } = project();
    try {
      const renderPdf = vi.fn(async () => PDF);
      const out = await cardOut({ ...ctx, renderPdf }, card('web', 'https://staging.example.com/x', 'Staging'));
      expect(out).toMatchObject({ kind: 'text', button: { url: 'https://staging.example.com/x' } });
      expect(renderPdf).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('render failure → the text line; a refused upload → "<title> (Mac\'te)"; the rest still goes', async () => {
    const { dir, ctx } = project();
    try {
      const failed = await cardOut({ ...ctx, renderPdf: async () => null }, card('web', 'rapor.html', 'Rapor'));
      expect(failed).toEqual({ kind: 'text', line: "Mac'te açık: Rapor", title: 'Rapor' });
      const thrown = await cardOut({ ...ctx, renderPdf: async () => { throw new Error('boom'); } }, card('web', 'rapor.html', 'Rapor'));
      expect(thrown).toMatchObject({ kind: 'text' });
      // A page outside the project never reaches the renderer.
      const renderPdf = vi.fn(async () => PDF);
      expect(await cardOut({ ...ctx, renderPdf }, card('web', '/etc/hosts.html', 'Dış'))).toMatchObject({ kind: 'text' });
      expect(renderPdf).not.toHaveBeenCalled();

      const ok = await cardOut({ ...ctx, renderPdf: async () => PDF }, card('web', 'rapor.html', 'Rapor'));
      const { hub, ab } = fakeHub(false);
      await sendPresentation(hub, ab, [ok, { kind: 'text', line: 'Görev: X', title: 'X' }], 'open', 0, 's', { phoneLink: () => 'off' });
      const text = String((hub.send as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1]);
      // Owner 2026-11-11: the line says why it did not go.
      expect(text).toContain("Rapor (gönderilmedi: Telegram kabul etmedi, Mac'te açık)");
      expect(text).toContain('Görev: X');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('page-pdf renderer', () => {
  const html = '<div class="dc-tabs"><div class="dc-tablist"><button class="dc-tab">A</button></div><div class="dc-panels"><div class="dc-panel">1</div></div></div>';

  it('the printable page is the stage srcdoc (CSP first) plus the print layer; a secret page is refused', () => {
    const page = printablePage(html)!;
    expect(page.indexOf(SANDBOX_CSP)).toBeGreaterThan(0);
    expect(page.indexOf(SANDBOX_CSP)).toBeLessThan(page.indexOf(PRINT_CSS));
    expect(page).toContain('size:A4');
    expect(page).toContain('.dc-panels>.dc-panel{display:block!important}');
    expect(page).not.toContain('toDataURL');
    expect(printablePage(html, { downsample: true })).toContain("toDataURL('image/jpeg',0.85)");
    expect(printablePage('<p>token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</p>')).toBeNull();
    expect(printablePage('  ')).toBeNull();
  });

  it('chromium gets no network and no header/footer', () => {
    const a = chromiumArgs('/tmp/x', 'http://127.0.0.1:4321/p.html', '/tmp/x/page.pdf');
    expect(a).toEqual(expect.arrayContaining(['--headless', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>;127.0.0.1:4321', '--no-pdf-header-footer', '--print-to-pdf=/tmp/x/page.pdf', 'http://127.0.0.1:4321/p.html']));
    expect(a.some((x) => x.startsWith('file:'))).toBe(false);
  });

  it('no chromium → null; a small PDF is printed once; a large one with images is printed again downsampled', async () => {
    expect(await makePagePdfRenderer({ chromium: () => null, print: async () => PDF })(html)).toBeNull();

    const once = vi.fn(async () => PDF);
    expect(await makePagePdfRenderer({ chromium: () => '/bin/chrome', print: once })(`${html}<img src="data:image/png;base64,AAAA">`)).toBe(PDF);
    expect(once).toHaveBeenCalledTimes(1);

    const big = Buffer.concat([PDF, Buffer.alloc(SMALL_PDF_BYTES)]);
    const twice = vi.fn(async (_b: string, page: string) => (page.includes('toDataURL') ? PDF : big));
    expect(await makePagePdfRenderer({ chromium: () => '/bin/chrome', print: twice })(`${html}<img src="data:image/jpeg;base64,AAAA">`)).toBe(PDF);
    expect(twice).toHaveBeenCalledTimes(2);

    // Large but no raster image: nothing to recompress, one print.
    const noImg = vi.fn(async () => big);
    expect(await makePagePdfRenderer({ chromium: () => '/bin/chrome', print: noImg })(html)).toBe(big);
    expect(noImg).toHaveBeenCalledTimes(1);

    // Over the upload cap → null (text line).
    const huge = Buffer.concat([PDF, Buffer.alloc(REQUEST_MAX_BYTES)]);
    expect(await makePagePdfRenderer({ chromium: () => '/bin/chrome', print: async () => huge })(html)).toBeNull();
  });

  it('renders one at a time', async () => {
    let live = 0; let peak = 0;
    const print = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 10)); live--; return PDF; };
    const r = makePagePdfRenderer({ chromium: () => '/bin/chrome', print });
    await Promise.all([r(html), r(html), r(html)]);
    expect(peak).toBe(1);
  });

  it('DREAMCONTEXT_CHROMIUM wins; a missing override is no chromium', () => {
    expect(findChromium({ DREAMCONTEXT_CHROMIUM: process.execPath }, '/nonexistent')).toBe(process.execPath);
    expect(findChromium({ DREAMCONTEXT_CHROMIUM: '/nope/chrome' }, '/nonexistent')).toBeNull();
  });
});

/** Does a PDF's metadata carry this title? (Chromium writes document.title to /Title, ASCII or UTF-16BE hex.) */
function pdfHasTitle(pdf: Buffer, title: string): boolean {
  const raw = pdf.toString('latin1');
  const hex = Buffer.from(`﻿${title}`, 'utf16le').swap16().toString('hex').toUpperCase();
  return raw.includes(`(${title})`) || raw.toUpperCase().includes(hex);
}

describe.skipIf(!findChromium())('page-pdf in a real Chromium: the page cannot print another local file', () => {
  it('location= and meta refresh to a file:// canary print the authored page, never the canary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-pdf-canary-'));
    try {
      const canary = join(dir, 'canary.html');
      writeFileSync(canary, '<title>CANARYTITLE</title><p>secret</p>');
      const render = makePagePdfRenderer({ timeoutMs: 20_000 });
      // Control: the page's own title reaches the PDF, so the probe below can see a swap.
      const own = await render('<script>document.title="OWNTITLE"</script><p>x</p>');
      expect(own && pdfHasTitle(own, 'OWNTITLE')).toBe(true);
      for (const attack of [
        `<script>document.title="OWNTITLE";location.href=${JSON.stringify(`file://${canary}`)}</script><p>x</p>`,
        `<meta http-equiv="refresh" content="0;url=file://${canary}"><p>x</p>`,
      ]) {
        const pdf = await render(attack);
        if (pdf) expect(pdfHasTitle(pdf, 'CANARYTITLE')).toBe(false);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('another loopback server (the dashboard) gets no request: navigation, form post, image', async () => {
    let hits = 0;
    const server = createServer((_q, r) => { hits++; r.end('<title>DASHTITLE</title>'); });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as { port: number }).port;
    try {
      const render = makePagePdfRenderer({ timeoutMs: 20_000 });
      for (const attack of [
        `<script>location.href="http://127.0.0.1:${port}/x"</script>`,
        `<form id="f" method="post" action="http://localhost:${port}/api"></form><script>document.getElementById('f').submit()</script>`,
        `<img src="http://127.0.0.1:${port}/i.png"><p>x</p>`,
      ]) {
        const pdf = await render(attack);
        if (pdf) expect(pdfHasTitle(pdf, 'DASHTITLE')).toBe(false);
      }
      expect(hits).toBe(0);
    } finally { server.close(); }
  }, 60_000);
});
