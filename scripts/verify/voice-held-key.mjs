#!/usr/bin/env node
/**
 * Holding the push-to-talk chord types nothing, and ordinary typing still works.
 *
 *   dreamcontext builder heavy -- node scripts/verify/voice-held-key.mjs [tag]
 *
 * Drives the REAL `Composer` (harness/composer-voice) in Chromium with the chord Shift+KeyV.
 * Playwright's `keyboard.down` on a key already down is a trusted CDP key event with
 * `autoRepeat`, so `event.repeat` is true and the browser really tries to insert the text.
 *
 * HONEST LIMIT: Chromium, not the desktop app's WKWebView, whose macOS text input and
 * press-and-hold path this does not exercise.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASH = join(REPO, 'dashboard');
const HARNESS = join(REPO, 'scripts', 'verify', 'harness', 'composer-voice');
const OUT = join(REPO, 'tmp', 'verify-voice-held-key', process.argv[2] || 'run');
mkdirSync(OUT, { recursive: true });

const fromDash = (p) => import(pathToFileURL(join(DASH, 'node_modules', p)).href);
const { createServer } = await fromDash('vite/dist/node/index.js');
const react = (await fromDash('@vitejs/plugin-react/dist/index.js')).default;
const server = await createServer({
  configFile: false, root: HARNESS, logLevel: 'error', plugins: [react()],
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
  server: { port: 0, host: '127.0.0.1', fs: { allow: [REPO, DASH] } },
});
await server.listen();
const url = `${server.resolvedUrls.local[0]}?mode=assistant&theme=dark&lang=en&field=1&chord=Shift%2BKeyV`;
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

const REPEATS = 12;
const results = [];
const check = (name, got, want) => { const ok = got === want; results.push({ name, got, want, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForSelector('.chat-cmp-mic', { timeout: 20_000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__repeats = 0;
    window.addEventListener('keydown', (e) => { if (e.repeat) window.__repeats += 1; });
  });
  return { ctx, page, errors, box: page.locator('.chat-cmp-input'), field: page.getByTestId('other-field') };
}
const hold = async (page, code = 'KeyV') => { for (let i = 0; i <= REPEATS; i++) { await page.keyboard.down(code); await page.waitForTimeout(8); } };

try {
  { // The chord held in the composer: a take runs and nothing lands in the box.
    const { ctx, page, box, errors } = await fresh();
    await box.click();
    await page.keyboard.down('Shift');
    await hold(page);
    const recording = await page.locator('.chat-cmp-mic.is-recording').count().then((n) => n > 0, () => false);
    check('composer: real repeats were delivered', await page.evaluate(() => window.__repeats), REPEATS);
    check('composer: the take is running', recording, true);
    check('composer: nothing typed while held', await box.inputValue(), '');
    await page.screenshot({ path: join(OUT, 'held-in-composer.png') });
    await page.keyboard.up('KeyV');
    await page.keyboard.up('Shift');
    check('composer: nothing typed after release', await box.inputValue(), '');
    check('composer: no page errors', errors.length, 0);
    await ctx.close();
  }
  { // The chord held in another field on the same screen.
    const { ctx, page, field } = await fresh();
    await field.click();
    await page.keyboard.down('Shift');
    await hold(page);
    check('other field: nothing typed while held', await field.inputValue(), '');
    await page.keyboard.up('KeyV');
    await page.keyboard.up('Shift');
    await ctx.close();
  }
  { // Shift let go first: V keeps repeating as a lowercase v.
    const { ctx, page, box } = await fresh();
    await box.click();
    await page.keyboard.down('Shift');
    await hold(page);
    await page.keyboard.up('Shift');
    await hold(page);
    check('modifier released first: nothing typed', await box.inputValue(), '');
    await page.keyboard.up('KeyV');
    await ctx.close();
  }
  { // The owner clicks into another field mid-hold.
    const { ctx, page, box, field } = await fresh();
    await box.click();
    await page.keyboard.down('Shift');
    await hold(page);
    // `focus()`, not a click: Shift is down, and a Shift+click stays in the box as a selection.
    await field.evaluate((el) => el.focus());
    check('focus moved mid-hold: focus really moved', await field.evaluate((el) => document.activeElement === el), true);
    await hold(page);
    check('focus moved mid-hold: nothing typed there', await field.inputValue(), '');
    check('focus moved mid-hold: nothing typed in the box', await box.inputValue(), '');
    await page.keyboard.up('KeyV');
    await page.keyboard.up('Shift');
    await ctx.close();
  }
  { // Ordinary typing: lowercase, and its own repeats, in both fields, while the chord is bound.
    const { ctx, page, box, field } = await fresh();
    await box.click();
    await page.keyboard.type('vivid');
    check('typing: lowercase v in the box', await box.inputValue(), 'vivid');
    await page.keyboard.down('KeyV');
    await page.keyboard.down('KeyV');
    await page.keyboard.down('KeyV');
    await page.keyboard.up('KeyV');
    check('typing: a held lowercase v repeats', await box.inputValue(), 'vividvvv');
    await field.click();
    await page.keyboard.type('v');
    check('typing: lowercase v in another field', await field.inputValue(), 'v');
    await ctx.close();
  }
  { // After a take, the next plain press types again (the claim does not stick).
    const { ctx, page, box } = await fresh();
    await box.click();
    await page.keyboard.down('Shift');
    await hold(page);
    await page.keyboard.up('Shift');
    await page.keyboard.up('KeyV');
    await page.waitForTimeout(100);
    await page.keyboard.down('KeyV');
    await page.keyboard.down('KeyV');
    await page.keyboard.up('KeyV');
    const value = await box.inputValue();
    check('after a take: a held v types again', value.endsWith('vv'), true);
    await ctx.close();
  }
  { // No visible composer owns the chord: Shift+V is a capital V, repeats included.
    const { ctx, page, field } = await fresh();
    await page.evaluate(() => {
      for (let el = document.querySelector('.chat-cmp-input'); el && !el.matches('[data-testid="pane"]'); el = el.parentElement) el.style.display = 'none';
    });
    await field.evaluate((el) => el.focus());
    await page.keyboard.down('Shift');
    await page.keyboard.down('KeyV');
    await page.keyboard.down('KeyV');
    await page.keyboard.down('KeyV');
    await page.keyboard.up('KeyV');
    await page.keyboard.up('Shift');
    check('no owner: Shift+V types capitals, repeats included', await field.inputValue(), 'VVV');
    await ctx.close();
  }
  { // The design limit: a composer owns the chord, so one capital V cannot be typed.
    const { ctx, page, box } = await fresh();
    await box.click();
    await page.keyboard.press('Shift+KeyV');
    check('design: Shift+V beside a visible composer types nothing', await box.inputValue(), '');
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
