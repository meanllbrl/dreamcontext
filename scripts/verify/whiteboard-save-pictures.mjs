/**
 * A drawn shape still saves on a board of pictures, and the pictures come through untouched.
 * On a COPY of a real board.
 *   node scripts/verify/whiteboard-save-pictures.mjs --board <dir>
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
const out = resolve('tmp', 'wb-perf');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await openApp({ suite: 'whiteboard-save-pictures', build: true });
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
  const parse = () => JSON.parse(/```json\n([\s\S]*?)```/.exec(readFileSync(file, 'utf8'))[1]).elements.filter((e) => !e.isDeleted);
  const was = parse();
  const box = await page.locator('.excalidraw canvas.static').first().boundingBox();
  await page.locator('[data-testid="toolbar-rectangle"]').click({ force: true });
  await page.mouse.move(box.x + box.width - 160, box.y + box.height - 160);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 60, box.y + box.height - 60, { steps: 5 });
  await page.mouse.up();
  await sleep(6000); // past the save debounce
  const now = parse();
  const pics = (l) => l.filter((e) => e.type === 'image').map((e) => `${e.id}:${e.fileId}:${e.version}`).sort().join();
  const result = { added: now.length - was.length, picturesIntact: pics(now) === pics(was), fileChanged: hash() !== before, errors: [...new Set(errors)] };
  console.log(JSON.stringify(result));
  await page.screenshot({ path: join(out, 'save-pictures.png') });
  code = result.added === 1 && result.picturesIntact && result.fileChanged && result.errors.length === 0 ? 0 : 1;
} finally {
  await browser.close().catch(() => {});
  await app.stop();
}
process.exit(code);
