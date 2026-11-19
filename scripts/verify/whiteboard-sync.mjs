#!/usr/bin/env node
/**
 * The board's Sync button (owner, 2026-11-18: the Agents panel goes, a Sync button comes):
 *
 *   dreamcontext builder heavy -- node scripts/verify/whiteboard-sync.mjs
 *
 * Scratch vault, real API from source, Vite dev server (lib/app.mjs). The page is reached by the
 * app's OWN navigation (the rail's Whiteboard button; on a phone, More > Whiteboard).
 *
 *   1440 px, light and dark: the idle row (Saved, Sync, no Agents), one REAL press (the scratch
 *     project syncs nowhere, so the server answers an off state), then every outcome with the
 *     sync answer stubbed in the browser, and the in-flight "Syncing..." button.
 *   Light: a rectangle drawn right before the press: the board's save (PUT) carrying it must
 *     have FINISHED before the sync request is sent.
 *   390 px, light and dark: the boards-travelled outcome, inside the viewport.
 *
 * Every note must say its state and sit inside the viewport; console errors and failed requests
 * are findings. The real two-clone exchange is tests/integration/board-sync-button.e2e.test.ts.
 */
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';

const START = '/?vault=proj&page=whiteboards';
const scrub = { blocks: [], warns: [] };
const STATES = [
  { name: 'up-to-date', expect: 'Up to date', body: { action: 'noop', pulledUpdates: 0, scrub } },
  { name: 'synced-in', expect: 'Synced, 3 updates came in', body: { action: 'pulled', pulledUpdates: 3, scrub } },
  { name: 'boards-sleep', expect: /Boards synced · 2 files wait for sleep/, body: { action: 'awaiting-agent', pulledUpdates: 0, scrub, boards: { sent: 1, received: 2, waiting: 0 }, awaitingSleep: 2 } },
  { name: 'boards-failed', expect: 'Boards did not travel', body: { action: 'awaiting-agent', pulledUpdates: 0, scrub, boards: { sent: 0, received: 0, waiting: 0, error: 'the remote moved twice' }, awaitingSleep: 1 } },
  { name: 'sign-in', expect: 'Sign in to GitHub', settings: true, body: { action: 'error', pulledUpdates: 0, scrub, failure: { kind: 'auth', recovery: 'reconnect-github', message: 'Authentication failed' } } },
  { name: 'locked', expect: 'Another sync is running', body: { action: 'locked', pulledUpdates: 0, scrub } },
];
const NOISE = /favicon|hot-update|\/@vite|sockjs|ws:\/\//;
const SYNC = '**/api/brain/sync';

const app = await openApp({ suite: 'whiteboard-sync', target: START });
const browser = await chromium.launch();
const finding = (s) => app.findings.push(s);

async function page(width, height, theme, label) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(`try { localStorage.setItem('dreamcontext-theme', '${theme}'); } catch {}`);
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) finding(`${label} console: ${m.text().slice(0, 200)}`); });
  p.on('pageerror', (e) => finding(`${label} crash: ${String(e.message).slice(0, 200)}`));
  p.on('requestfailed', (r) => { if (!NOISE.test(r.url())) finding(`${label} failed request: ${new URL(r.url()).pathname}`); });
  p.on('response', (r) => { if (r.status() >= 400 && !NOISE.test(r.url())) finding(`${label} ${r.status()}: ${new URL(r.url()).pathname}`); });
  await p.goto(`${app.base}${START}`, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  if (await p.locator('.announcements-modal-scrim').count()) await p.keyboard.press('Escape');
  return { p, ctx };
}

const syncButton = (p) => p.locator('.wbp-sync-btn').first();

/** The app's own navigation to the board; true when a real click would land on the button. */
async function toBoard(p, phone) {
  if (!phone) {
    await p.getByRole('button', { name: 'Whiteboard', exact: true }).first().click({ timeout: 10_000 }).catch(() => {});
  } else {
    await p.getByRole('button', { name: 'More', exact: true }).first().click({ timeout: 5_000 }).catch(() => {});
    await p.getByRole('menuitem', { name: /Whiteboard/ }).first().click({ timeout: 5_000 })
      .catch(() => p.getByText('Whiteboard', { exact: true }).first().click({ timeout: 5_000 }).catch(() => {}));
  }
  if (!(await syncButton(p).waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false))) return false;
  return syncButton(p).click({ trial: true, timeout: 3_000 }).then(() => true, () => false);
}

async function shot(p, name) {
  const file = `${app.shots}/${name}.png`;
  await p.screenshot({ path: file });
  app.taken.push(file);
}

/** Press, wait for the note, check its words and that it sits inside the viewport. */
async function pressAndRead(p, label, width, height, expect) {
  await syncButton(p).click();
  const note = p.locator('.wbp-sync-note');
  if (!(await note.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false))) { finding(`${label}: no note after the press`); return ''; }
  const text = (await note.innerText()).replace(/\s+/g, ' ');
  if (expect && !(expect instanceof RegExp ? expect.test(text) : text.includes(expect))) finding(`${label}: the note says "${text.slice(0, 160)}"`);
  const box = await note.boundingBox();
  if (!box || box.x < 0 || box.y < 0 || box.x + box.width > width + 0.5 || box.y + box.height > height + 0.5) finding(`${label}: note outside the viewport ${JSON.stringify(box)}`);
  process.stdout.write(`${label}: ${text.slice(0, 220)}\n`);
  return text;
}

try {
  const W = 1440, H = 900;
  for (const theme of ['light', 'dark']) {
    {
      const label = `desktop-${theme}-real-press`;
      const { p, ctx } = await page(W, H, theme, label);
      if (!(await toBoard(p, false))) {
        await shot(p, `${label}-nobutton`);
        finding(`${label}: the button is not reachable`);
      } else {
        if (await p.locator('.wbp-agent-toggle, .wb-agent-panel-head').count()) finding(`${label}: the retired Agents toggle or panel is still drawn`);
        await shot(p, `desktop-${theme}-idle`);
        const timeline = [];
        const isBoard = (u) => /\/api\/whiteboards\/[^/]+$/.test(new URL(u).pathname);
        const isSync = (u) => new URL(u).pathname === '/api/brain/sync';
        p.on('request', (r) => {
          if (isSync(r.url()) && r.method() === 'POST') timeline.push({ t: Date.now(), ev: 'sync', body: r.postData() ?? '' });
          if (isBoard(r.url()) && r.method() === 'PUT') timeline.push({ t: Date.now(), ev: 'put', body: r.postData() ?? '' });
        });
        p.on('requestfinished', (r) => { if (isBoard(r.url()) && r.method() === 'PUT') timeline.push({ t: Date.now(), ev: 'putEnd' }); });
        if (theme === 'light') {
          // A rectangle with the tool's key, dragged on the canvas, then the press at once.
          const box = await p.locator('.wbp-canvas').boundingBox();
          await p.mouse.click(box.x + box.width / 2 + 200, box.y + box.height / 2 + 200);
          await p.keyboard.press('r');
          await p.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2 - 50);
          await p.mouse.down();
          await p.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 50, { steps: 8 });
          await p.mouse.up();
        }
        await pressAndRead(p, label, W, H, /cloud|code repo|Sync|sync/);
        await shot(p, `desktop-${theme}-real-press`);
        if (theme === 'light') {
          const sync = timeline.find((e) => e.ev === 'sync');
          const puts = timeline.filter((e) => e.ev === 'put');
          const lastPut = puts.at(-1);
          const lastEnd = timeline.filter((e) => e.ev === 'putEnd').at(-1)?.t;
          const carries = !!lastPut && /"type"\s*:\s*"rectangle"/.test(lastPut.body);
          const ordered = sync !== undefined && lastEnd !== undefined && lastEnd <= sync.t;
          const auto = !!sync && /"mode"\s*:\s*"auto"/.test(sync.body) && /"foreground"\s*:\s*true/.test(sync.body);
          process.stdout.write(`flush: ${puts.length} save(s) before the press; the last carries the rectangle: ${carries}; it finished before the sync request: ${ordered}; sync body auto+foreground: ${auto}\n`);
          if (!carries) finding('flush: the save before the press did not carry the rectangle drawn just before it');
          if (!ordered) finding('flush: the sync request went out before the save finished');
          if (!auto) finding(`flush: the sync was not auto + foreground: ${sync?.body}`);
        }
      }
      await ctx.close();
    }
    for (const s of STATES) {
      const label = `desktop-${theme}-${s.name}`;
      const { p, ctx } = await page(W, H, theme, label);
      await p.route(SYNC, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(s.body) }));
      if (!(await toBoard(p, false))) { await shot(p, `${label}-nobutton`); finding(`${label}: the button is not reachable`); await ctx.close(); continue; }
      await pressAndRead(p, label, W, H, s.expect);
      if (s.settings && !(await p.locator('.wbp-sync-note-link').count())) finding(`${label}: no way to Settings`);
      await shot(p, label);
      await ctx.close();
    }
    {
      const label = `desktop-${theme}-syncing`;
      const { p, ctx } = await page(W, H, theme, label);
      let release;
      const held = new Promise((r) => { release = r; });
      await p.route(SYNC, async (r) => { await held; await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATES[0].body) }); });
      if (await toBoard(p, false)) {
        await syncButton(p).click();
        const busy = await p.getByRole('button', { name: /Syncing/ }).first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
        if (!busy) finding(`${label}: no Syncing... state while the sync runs`);
        if ((await syncButton(p).getAttribute('aria-disabled')) !== 'true') finding(`${label}: the button stays pressable while syncing`);
        await shot(p, label);
      } else finding(`${label}: the button is not reachable`);
      release();
      await ctx.close();
    }
  }
  for (const theme of ['light', 'dark']) {
    const label = `phone-${theme}-boards-sleep`;
    const { p, ctx } = await page(390, 844, theme, label);
    await p.route(SYNC, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATES[2].body) }));
    if (await toBoard(p, true)) {
      await pressAndRead(p, label, 390, 844, STATES[2].expect);
      await shot(p, label);
    } else {
      await shot(p, `${label}-nobutton`);
      finding(`${label}: the button is not reachable at 390 px`);
    }
    await ctx.close();
  }
} catch (err) {
  finding(`could not finish: ${err instanceof Error ? err.message : err}`);
}
await browser.close().catch(() => {});
process.exit(await app.finish());
