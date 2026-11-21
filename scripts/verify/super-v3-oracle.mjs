#!/usr/bin/env node
/**
 * The Super v3 Dock oracle (task super-sunum-ekranlari, plan super-v3 K2-oracle): reads the approved
 * mockups' own drawn Dock and presentation window and writes the geometry the layout test compares
 * `dockTiles` and `presentWidth` with. Run once per mockup change:
 *
 *   node scripts/verify/super-v3-oracle.mjs <v3-mockup-folder> <review-mockup-folder> [out.json]
 *
 * Each folder holds an `app.html` that draws a frame with `?s=<frame>`. Only rects, kinds and the
 * foot text are stored (the titles are the mockups' fictional ones and are not kept).
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(ROOT, 'package.json'));
const { chromium } = require('playwright');

const [v3Dir, reviewDir, outArg] = process.argv.slice(2);
if (!v3Dir || !reviewDir) {
  console.error('usage: super-v3-oracle.mjs <v3-mockup-folder> <review-mockup-folder> [out.json]');
  process.exit(2);
}
const out = resolve(outArg ?? join(ROOT, 'tests/unit/fixtures/super-v3/frames.json'));
const FRAMES = [
  [v3Dir, '05-sekiz-oturum'], [v3Dir, '05-sekiz-oturum-3'], [v3Dir, '07a-sunum-dar'], [v3Dir, '07b-sunum-orta'],
  [v3Dir, '07c-sunum-genis'], [v3Dir, '09b-kucult-3'], [reviewDir, 'B-onbes'], [reviewDir, 'T6-sonra'],
];

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
const result = {};
for (const [dir, frame] of FRAMES) {
  await page.goto(`${pathToFileURL(join(resolve(dir), 'app.html')).href}?s=${frame}&theme=dark`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);
  // Freeze motion where the shots froze it, and drop transforms so rects are the layout's own.
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}.dtile{transform:none!important}' });
  result[frame] = await page.evaluate(() => {
    const canvas = document.querySelector('.canvas');
    const cb = canvas.getBoundingClientRect();
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left - cb.left), y: Math.round(b.top - cb.top), width: Math.round(b.width), height: Math.round(b.height) }; };
    const dock = document.querySelector('.dock');
    const kindOf = (el) => {
      if (el.classList.contains('dsep')) return 'sep';
      if (el.classList.contains('dfoot')) return 'foot';
      if (el.classList.contains('widgett')) return 'today';
      if (el.classList.contains('mt')) return 'member';
      if (el.classList.contains('mini')) return 'mini';
      if (el.classList.contains('wait')) return 'needs';
      if (el.classList.contains('pool')) return 'pool';
      return 'job';
    };
    const tiles = dock ? [...dock.children].map((el) => ({ kind: kindOf(el), ...r(el), ...(el.classList.contains('dfoot') ? { text: el.textContent.trim() } : {}) })) : [];
    const pwin = document.querySelector('.pwin');
    const db = dock ? r(dock) : null;
    return {
      stage: { width: Math.round(cb.width), height: Math.round(cb.height) },
      dock: db ? { ...db, inset: Math.round(cb.height - (db.y + db.height)) } : null,
      tiles,
      ...(pwin ? { present: r(pwin) } : {}),
    };
  });
  console.log('read', frame, result[frame].tiles.length, 'dock items');
}
await browser.close();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log('wrote', out);
