/**
 * Verification pass for a PDF a KNOWLEDGE note links to: opens the note in the Knowledge page,
 * clicks the link, and proves (a) the full-window viewer opens, (b) it embeds the VAULT route
 * (not the desktop-only chat one), (c) the click did not navigate the SPA away — the failure
 * this whole class of link used to cause — and (d) Esc closes the viewer and only it.
 *
 * Boots its own dashboard server on an isolated scratch vault, so it touches no user state:
 *
 *   npm run build && node e2e/knowledge-pdf-verify.mjs
 */
import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-knowledge-pdf');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');

const results = [];
const check = (label, cond, detail) => {
  results.push({ label, ok: !!cond });
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : `  — ${detail}`}`);
};

function pdfBytes(padTo = 0) {
  const head = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n';
  const tail = '\ntrailer<</Root 1 0 R>>\n%%EOF\n';
  const pad = padTo > head.length + tail.length ? 'x'.repeat(padTo - head.length - tail.length) : '';
  return Buffer.from(head + pad + tail, 'utf-8');
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(PROJ, { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  const init = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'init', '--yes'],
    { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr || init.stdout}`);

  const KDIR = join(PROJ, '_dream_context', 'knowledge', 'legal');
  mkdirSync(join(KDIR, 'assets'), { recursive: true });
  writeFileSync(join(KDIR, 'assets', 'msa.pdf'), pdfBytes(120 * 1024));
  writeFileSync(join(KDIR, 'contracts.md'),
    '---\ntype: knowledge\nname: contracts\ndescription: Contract terms\n---\n\n'
    + '# Contracts\n\nThe signed agreement is [the MSA](assets/msa.pdf).\n', 'utf-8');

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'kpdf', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath,
    [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)],
    { cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

let server = null;
let browser = null;
try {
  console.log('· preparing an isolated scratch vault…');
  setup();
  const port = await freePort();
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);
  const BASE = `http://127.0.0.1:${port}`;

  // Real Chrome, when it is installed: Playwright's BUNDLED headless Chromium ships without
  // the PDF extension (`navigator.pdfViewerEnabled === false`), which is a genuine engine
  // state the viewer degrades for — but verifying only that would never exercise the embed.
  // Whichever engine we get, the run asserts the behaviour that engine is supposed to have.
  browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  console.log('· driving the Knowledge page:');

  await page.goto(`${BASE}/?vault=kpdf`, { waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar-item').first().waitFor({ timeout: 30000 });
  // A fresh vault has unread releases, and the "What's new" popup owns the screen (its scrim
  // swallows every click) until it is dismissed.
  await page.waitForTimeout(1500);
  for (let i = 0; i < 4; i += 1) {
    if (!(await page.locator('.announcements-modal-scrim').count())) break;
    const close = page.locator('.announcements-modal-close').first();
    if (await close.count()) await close.click({ force: true }).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }

  await page.locator('.sidebar-item', { hasText: 'Knowledge' }).first().click();
  await page.locator('.knowledge-page').waitFor({ timeout: 30000 });

  // The note sits in a `legal/` folder, which renders COLLAPSED — and this vault has no
  // root-level notes at all, so there is no card to wait for until a folder is opened. Open
  // them until the card is reachable (each click can reveal further folders).
  for (let i = 0; i < 6; i += 1) {
    if (await page.locator('.knowledge-card', { hasText: 'contracts' }).count()) break;
    const collapsed = page.locator('.knowledge-folder-header[aria-expanded="false"]').first();
    if (!(await collapsed.count())) break;
    await collapsed.click();
    await page.waitForTimeout(300);
  }
  const card = page.locator('.knowledge-card', { hasText: 'contracts' }).first();
  await card.waitFor({ timeout: 15000 });
  await card.click();
  await page.waitForTimeout(1000);

  const link = page.locator('.markdown-body a[href$="assets/msa.pdf"]').first();
  await link.waitFor({ timeout: 15000 });
  check('the note renders its PDF link', await link.count() === 1);

  const urlBefore = page.url();
  await link.click();
  await page.waitForTimeout(1200);

  const viewer = page.locator('.pdf-viewer');
  check('clicking the link opens the full-window PDF viewer', (await viewer.count()) === 1);

  // The failure this class of link used to cause: following a filesystem href navigated the
  // one webview off the app, and there is no back button in the desktop shell.
  check('the click did NOT navigate the app away', page.url() === urlBefore, `${urlBefore} → ${page.url()}`);

  if (await viewer.count()) {
    const box = await viewer.boundingBox();
    const vp = page.viewportSize();
    check('the viewer covers the whole window',
      box && box.x === 0 && box.y === 0 && box.width === vp.width && box.height === vp.height,
      JSON.stringify(box));

    const enginePdf = await page.evaluate(() => navigator.pdfViewerEnabled);
    console.log(`      (engine PDF viewer: ${enginePdf})`);

    let src = null;
    if (enginePdf) {
      src = await page.locator('.pdf-viewer-frame').getAttribute('src').catch(() => null);
      check('it embeds the VAULT route, not the desktop-only chat one',
        !!src && src.includes('/graph/content') && src.includes('raw=1'), String(src));
      check('and the URL names the resolved vault path',
        !!src && decodeURIComponent(src).includes('knowledge/legal/assets/msa.pdf'), String(src));
    } else {
      // The honest degrade, and the reason it exists: an engine with no viewer must SAY so and
      // point at the button that works, never paint a blank rectangle.
      const status = await page.locator('.pdf-viewer-status').innerText().catch(() => '');
      check('an engine without a PDF viewer says so instead of showing a blank frame',
        /can’t display PDFs|can't display PDFs/.test(status), status);
      check('no frame is rendered in that state', (await page.locator('.pdf-viewer-frame').count()) === 0);
    }

    // The bytes really arrive — the URL the iframe was given, or the one it would have been.
    const bytesUrl = src
      ? new URL(src, BASE).toString()
      : `${BASE}/api/graph/content?path=${encodeURIComponent('knowledge/legal/assets/msa.pdf')}&raw=1&vault=kpdf`;
    const probe = await page.evaluate(async (u) => {
      const r = await fetch(u, { headers: { Range: 'bytes=0-7' } });
      return { status: r.status, type: r.headers.get('content-type') };
    }, bytesUrl);
    check('that URL serves PDF bytes to the page',
      (probe.status === 206 || probe.status === 200) && probe.type === 'application/pdf',
      `${probe.status} ${probe.type}`);

    check('the OS buttons are present in the viewer',
      (await page.locator('.pdf-viewer .chat-fileactions button').count()) >= 2);

    await page.screenshot({ path: '/tmp/knowledge-pdf-viewer.png' });

    // Esc, once focus is OURS. On an engine that embeds the document, its PDF plugin owns the
    // keyboard while it has focus and no listener here can see the key — a click on the
    // viewer's own chrome hands focus back and re-arms Esc, which is the behaviour under test.
    await page.locator('.pdf-viewer-head').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    check('Esc closes the viewer once focus is back in its own chrome',
      (await page.locator('.pdf-viewer').count()) === 0);
    check('and leaves the note open underneath',
      (await page.locator('.markdown-body').count()) > 0);

    // The guaranteed way out, which must work wherever focus ended up — including straight
    // after opening, when the embedded plugin has taken it.
    await link.click();
    await page.waitForTimeout(1200);
    await page.locator('.pdf-viewer-close').click();
    await page.waitForTimeout(400);
    check('the ✕ closes it from any focus state', (await page.locator('.pdf-viewer').count()) === 0);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? '✗' : '✓'} ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
