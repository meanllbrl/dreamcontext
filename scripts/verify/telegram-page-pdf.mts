// Manual proof: render a project HTML page to PDF the way Telegram gets it; report size; first page PNG.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makePagePdfRenderer, findChromium, printablePage } from '../../src/server/telegram/page-pdf.js';
const [src, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const html = readFileSync(src, 'utf8');
const t0 = Date.now();
const pdf = await makePagePdfRenderer()(html);
if (!pdf) { console.log('render failed; chromium =', findChromium()); process.exit(1); }
writeFileSync(join(outDir, 'sayfa.pdf'), pdf);
writeFileSync(join(outDir, 'printable.html'), printablePage(html)!);
console.log(JSON.stringify({ chromium: findChromium(), bytes: pdf.length, ms: Date.now() - t0 }));
