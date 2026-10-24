#!/usr/bin/env node
/**
 * The composer's voice row, photographed in every state it has, without building the app.
 *
 *   node scripts/verify/composer-voice-dark.mjs [tag]      (tag: a folder name, e.g. before / after)
 *
 * WHAT IT DRIVES — the REAL `Composer` (its CSS, the real theme tokens, the real
 * `useVoiceCapture`) served by the dashboard's own Vite in dev mode from
 * `scripts/verify/harness/composer-voice/`, in Chromium with a FAKE microphone. The page is told it
 * is the desktop shell (so the voice row is drawn) and every shell command is refused, so the take
 * runs on the page microphone. `/stt` never answers, which holds the take in "transcribing".
 *
 * For each mode (assistant = the notch's composer, super, chat), theme (dark, light) and width
 * (390, 1440): idle, recording, transcribing and a tap (too short). Per shot it records whether the
 * voice line overflows its box (`scrollWidth > clientWidth`) or wraps (more than one line), and the
 * console errors.
 *
 * Output: tmp/verify-composer-voice/<tag>/<mode>-<theme>-<width>-<state>.png and report.json.
 * HONEST LIMIT — Chromium, not the desktop app's WKWebView, and the fake device's tone, not a voice.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASH = join(REPO, 'dashboard');
const HARNESS = join(REPO, 'scripts', 'verify', 'harness', 'composer-voice');
const TAG = process.argv[2] || 'run';
const OUT = join(REPO, 'tmp', 'verify-composer-voice', TAG);
const MODES = (process.env.MODES || 'assistant,super,chat').split(',');
const THEMES = (process.env.THEMES || 'dark,light').split(',');
const WIDTHS = [390, 1440];
const LANG = process.env.LANG_UI || 'en';

const fromDash = (p) => import(pathToFileURL(join(DASH, 'node_modules', p)).href);
const { createServer } = await fromDash('vite/dist/node/index.js');
const react = (await fromDash('@vitejs/plugin-react/dist/index.js')).default;

mkdirSync(OUT, { recursive: true });
const server = await createServer({
  configFile: false,
  root: HARNESS,
  logLevel: 'error',
  plugins: [react()],
  define: { __DC_VERSION__: JSON.stringify('0.0.0-harness') },
  resolve: {
    alias: [
      { find: /^react$/, replacement: join(DASH, 'node_modules', 'react') },
      { find: /^react\/(.*)$/, replacement: join(DASH, 'node_modules', 'react', '$1') },
      { find: /^react-dom$/, replacement: join(DASH, 'node_modules', 'react-dom') },
      { find: /^react-dom\/(.*)$/, replacement: join(DASH, 'node_modules', 'react-dom', '$1') },
      { find: /^@tanstack\/react-query$/, replacement: join(DASH, 'node_modules', '@tanstack', 'react-query') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: { port: 0, host: '127.0.0.1', fs: { allow: [REPO] } },
  optimizeDeps: { entries: [join(HARNESS, 'index.html')] },
});
await server.listen();
const base = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const report = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The voice line(s) in the toolbar: their text, whether each is cut or wraps. */
async function measure(page) {
  return page.evaluate(() => [...document.querySelectorAll('.chat-cmp-voice-note')].map((el) => {
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
    const r = el.getBoundingClientRect();
    return {
      text: el.textContent,
      shown: cs.display !== 'none' && r.width > 0,
      cut: el.scrollWidth > el.clientWidth + 1,
      wraps: r.height > lh * 1.5,
      width: Math.round(r.width),
    };
  }));
}

async function shot(page, name) {
  const box = await page.locator('.chat-cmp').boundingBox();
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, clip: box ? { x: 0, y: Math.max(0, box.y - 8), width: page.viewportSize().width, height: box.height + 8 } : undefined });
  return file;
}

try {
  for (const mode of MODES) for (const theme of THEMES) for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 2, permissions: ['microphone'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (process.env.DEBUG) console.log('[page]', m.type(), m.text()); if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    const url = `${base}?mode=${mode}&theme=${theme}&lang=${LANG}`;
    const id = `${mode}-${theme}-${width}`;
    const row = { id, shots: {}, notes: {}, readAloudButton: false, errors };

    await page.goto(url);
    await page.waitForSelector('.chat-cmp-mic', { timeout: 20_000 });
    await sleep(400);
    row.readAloudButton = await page.locator('.chat-cmp-readaloud').count() > 0;
    row.shots.idle = await shot(page, `${id}-idle`);
    row.notes.idle = await measure(page);

    // The press is DISPATCHED on the button rather than made with the mouse: a real pointer
    // over a button that moves gets a pointerleave, which ends the take. Whether the button
    // moves is measured instead (`micMoved`), because that is the defect worth seeing.
    const press = (type) => page.locator('.chat-cmp-mic').dispatchEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 });
    const micAt = async () => { const b = await page.locator('.chat-cmp-mic').boundingBox(); return b ? Math.round(b.x) : null; };
    const restX = await micAt();
    await press('pointerdown');
    await page.waitForSelector('.chat-cmp-mic.is-recording', { timeout: 10_000 });
    await sleep(1200);
    row.micMoved = { rest: restX, recording: await micAt() };
    row.shots.recording = await shot(page, `${id}-recording`);
    row.notes.recording = await measure(page);
    await press('pointerup');
    await sleep(300);
    row.micMoved.transcribing = await micAt();
    row.shots.transcribing = await shot(page, `${id}-transcribing`);
    row.notes.transcribing = await measure(page);

    await page.goto(url);
    await page.waitForSelector('.chat-cmp-mic', { timeout: 20_000 });
    await sleep(400);
    await press('pointerdown');
    await sleep(60);
    await press('pointerup');
    row.tapNudged = await page.waitForSelector('.chat-cmp-mic.is-nudged', { timeout: 1500 }).then(() => true, () => false);
    await sleep(700);
    row.micMoved.tap = await micAt();
    row.shots.tap = await shot(page, `${id}-tap`);
    row.notes.tap = await measure(page);
    row.tts = await page.evaluate(() => window.__tts ?? 0);

    report.push(row);
    console.log(`  ${id}: ${Object.entries(row.notes).map(([k, v]) => `${k}=${JSON.stringify(v.filter((n) => n.shown).map((n) => `${n.text}${n.cut ? ' [CUT]' : ''}${n.wraps ? ' [WRAPS]' : ''}`))}`).join('  ')}  mic=${JSON.stringify(row.micMoved)}  nudge=${row.tapNudged}${errors.length ? `  errors=${errors.length}` : ''}`);
    await ctx.close();
  }
  // The notch's listening card: always on the night surface (the notch is dark in both themes).
  for (const lang of (process.env.OVERLAY_LANGS || 'en,tr').split(',')) for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 500 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}?overlay=1&theme=dark&lang=${lang}`);
    await page.waitForSelector('[data-testid="notch"]', { timeout: 20_000 });
    await sleep(300);
    const id = `notch-${lang}-${width}`;
    const row = { id, shots: {}, lines: {}, errors };
    for (const [state, phase, attempt] of [['recording', 'recording', 0], ['transcribing', 'transcribing', 0], ['retry', 'transcribing', 1], ['error', 'error', 0], ['tap', 'too-short', 0], ['silent', 'silent', 0]]) {
      await page.evaluate(([p, a]) => window.__voice('idle', 0) || window.__voice(p, a), [phase, attempt]);
      await sleep(250);
      const box = await page.locator('[data-testid="notch"]').boundingBox();
      const file = join(OUT, `${id}-${state}.png`);
      await page.screenshot({ path: file, clip: box });
      row.shots[state] = file;
      row.lines[state] = await page.evaluate(() => [...document.querySelectorAll('.dc-listen__title, .dc-listen__sub')].map((el) => ({
        text: el.textContent, cut: el.scrollWidth > el.clientWidth + 1, nudged: getComputedStyle(el.closest('.dc-listen').querySelector('.dc-listen__orb')).animationName,
      })));
    }
    report.push(row);
    console.log(`  ${id}: ${Object.entries(row.lines).map(([k, v]) => `${k}=${JSON.stringify(v.map((l) => l.text + (l.cut ? ' [CUT]' : '')))}`).join('  ')}  tapAnim=${row.lines.tap?.[0]?.nudged}${errors.length ? `  errors=${errors.length}` : ''}`);
    await ctx.close();
  }
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
}
console.log(`shots: ${OUT}`);
