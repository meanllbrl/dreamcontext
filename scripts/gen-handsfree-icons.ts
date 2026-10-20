#!/usr/bin/env -S npx vite-node
/**
 * Regenerates everything the hands-free mark is drawn into outside React, from ONE description
 * (`dashboard/src/components/brand/handsfreeMarkGeometry.ts`) and the gem's colour tokens
 * (`--gem-*` in `dashboard/src/styles/tokens.css`):
 *
 *   dashboard/src/assets/handsfree/handsfree-mark.svg   the mark, tight box, colours written in
 *   dashboard/src/assets/handsfree/handsfree-icon.svg   the icon square (composition inside the
 *                                                        maskable safe circle), transparent
 *   dashboard/public/icons/icon-192.png, icon-512.png   the installed phone app's icons (manifest),
 *                                                        transparent, rendered from the icon SVG
 *   dashboard/public/icons/apple-touch-icon-180.png     the iPhone Home Screen icon: opaque, on the
 *                                                        light canvas (`--color-bg`), since iOS
 *                                                        paints a transparent icon black
 *   src/server/handsfree-mark.ts                        the mark, the corner outlines and their
 *                                                        paint rules for the phone's server-rendered
 *                                                        sign-in and offline pages (the server
 *                                                        cannot import the dashboard)
 *
 * Every PNG carries a `tEXt` chunk `dc-source` = the sha256 of the SVG it was rendered from, so
 * `tests/unit/handsfree-mark.test.ts` fails when the mark changes and the icons were not
 * re-rendered (and when anything here drifts from what this script would write).
 *
 * Usage: npx vite-node scripts/gen-handsfree-icons.ts      (npm run gen:handsfree-icons)
 *        Renders with the repo's Playwright Chromium.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSETS, buildServerMirror, buildSvgs, ICONS, PNG_ICONS, SERVER_MIRROR, sha256, SOURCE_KEY, TOKENS_CSS, withTextChunk,
} from './lib/handsfree-icons';

const svgs = buildSvgs(readFileSync(TOKENS_CSS, 'utf8'));
mkdirSync(ASSETS, { recursive: true });
writeFileSync(join(ASSETS, 'handsfree-mark.svg'), svgs.mark);
writeFileSync(join(ASSETS, 'handsfree-icon.svg'), svgs.icon);
writeFileSync(SERVER_MIRROR, buildServerMirror());

const { chromium } = await import('playwright');
const browser = await chromium.launch();
try {
  for (const s of PNG_ICONS) {
    const svg = s.opaque ? svgs.iconOpaque : svgs.icon;
    const page = await browser.newPage({ viewport: { width: s.size, height: s.size }, deviceScaleFactor: 1 });
    const sized = svg.replace('<svg ', `<svg width="${s.size}" height="${s.size}" `);
    await page.setContent(`<!doctype html><html><body style="margin:0">${sized}</body></html>`);
    const png = await page.screenshot({ omitBackground: !s.opaque, clip: { x: 0, y: 0, width: s.size, height: s.size } });
    writeFileSync(join(ICONS, s.file), withTextChunk(png, SOURCE_KEY, sha256(svg)));
    await page.close();
    console.log(`  dashboard/public/icons/${s.file} ${s.size}x${s.size}${s.opaque ? ` on ${svgs.background}` : ', transparent'}`);
  }
} finally {
  await browser.close();
}
console.log('  dashboard/src/assets/handsfree/handsfree-mark.svg, handsfree-icon.svg');
console.log('  src/server/handsfree-mark.ts');
