// Manual proof for the size rule: a page with big raster images, printed as-is (before) and as
// Telegram gets it (after: downsampled when over 1 MB). Usage: vite-node <this> <photo.jpg> <shot.png> <outDir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findChromium, makePagePdfRenderer, printablePage, printPage } from '../../src/server/telegram/page-pdf.js';

const [photo, shot, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const jpg = readFileSync(photo).toString('base64');
const png = readFileSync(shot).toString('base64');
const html = `<div class="dc-doc"><h1 class="dc-h1">Görselli sayfa</h1><p class="dc-p">Bir fotoğraf ve bir ekran görüntüsü.</p>
<img class="dc-img" src="data:image/jpeg;base64,${jpg}"><img class="dc-img" src="data:image/png;base64,${png}"></div>`;
const before = await printPage(findChromium()!, printablePage(html)!, 30_000);
const after = await makePagePdfRenderer()(html);
writeFileSync(join(outDir, 'gorselli-once.pdf'), before!);
writeFileSync(join(outDir, 'gorselli-sonra.pdf'), after!);
console.log(JSON.stringify({ before: before?.length, after: after?.length }));
