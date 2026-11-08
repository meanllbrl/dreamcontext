/**
 * Pictures stay sharp close up, and looking at a board writes nothing. On a COPY of a real board:
 * zoom onto one picture, wait for the rest state, screenshot it, and compare the board file's hash.
 *   node scripts/verify/whiteboard-sharp.mjs --board <dir> --x 810 --y 392 [--label after] [--engine webkit] [--dark]
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const boardDir = resolve(arg('board', ''));
const slug = basename(boardDir);
const engine = arg('engine', 'chromium');
const dark = process.argv.includes('--dark');
const name = `sharp-${arg('label', 'run')}-${engine}${dark ? '-dark' : ''}`;
const out = resolve('tmp', 'wb-perf');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await openApp({ suite: 'whiteboard-sharp', build: true });
const dest = join(app.proj, '_dream_context', 'whiteboards', slug);
cpSync(boardDir, dest, { recursive: true });
const file = join(dest, `${slug}.excalidraw.md`);
const hash = () => createHash('sha1').update(readFileSync(file)).digest('hex');
const before = hash();
const browser = await (engine === 'webkit' ? webkit : chromium).launch();
const errors = [];
let code = 1;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await markAnnouncementsSeen(context, app.base);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto(`${app.base}/?vault=proj#wb=${slug}`, { waitUntil: 'load' });
  await page.locator('[aria-label*="hiteboard"], [title*="hiteboard"], .sidebar-item:has-text("Whiteboard")').first().click();
  await page.locator('.excalidraw canvas.static').first().waitFor({ state: 'visible' });
  await sleep(6000);
  await page.mouse.move(Number(arg('x', 810)), Number(arg('y', 392)));
  await page.keyboard.down('Control');
  for (let i = 0; i < 200; i += 1) {
    const z = parseInt(await page.locator('.reset-zoom-button, .zoom-reset').first().innerText(), 10);
    if (z >= 290) break;
    await page.mouse.wheel(0, -10);
    await sleep(30);
  }
  await page.keyboard.up('Control');
  await page.screenshot({ path: join(out, `${name}-early.png`) });
  await sleep(4000);
  await page.screenshot({ path: join(out, `${name}-rest.png`) });
  await sleep(3000); // past the save debounce
  const saved = await page.locator('text=Saved').count();
  const same = hash() === before;
  console.log(JSON.stringify({ name, fileUnchanged: same, savedLabel: saved, errors: [...new Set(errors)] }));
  code = same && errors.length === 0 ? 0 : 1;
} finally {
  await browser.close().catch(() => {});
  await app.stop();
}
process.exit(code);
