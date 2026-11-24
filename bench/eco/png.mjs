#!/usr/bin/env node
// Renders every SVG in <dir> to a PNG beside it (2x) in headless Chromium, then deletes the SVG.
//   node bench/eco/png.mjs <dir>
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const dir = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
for (const f of readdirSync(dir).filter((n) => n.endsWith('.svg'))) {
  const svg = readFileSync(join(dir, f), 'utf-8');
  const [, w, h] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  await page.setViewportSize({ width: Number(w), height: Number(h) });
  await page.setContent(`<html><body style="margin:0">${svg.replace('style="width:100%;height:auto;', `style="width:${w}px;height:${h}px;`)}</body></html>`);
  await page.screenshot({ path: join(dir, f.replace(/\.svg$/, '.png')) });
  rmSync(join(dir, f));
}
await browser.close();
console.log('png done');
