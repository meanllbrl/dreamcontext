#!/usr/bin/env node
/**
 * dreamcontext screens embedded in an app's window, through the REAL gateway and the REAL frame
 * gate, in Chromium at 390 and 1440 px (dreamcontext-apps plan r19, W4). The app's own page frames
 * each of the five views; what is checked is that each draws, that nothing decides for the owner,
 * and that a frame with no live token gets nothing. Needs a build: `dreamcontext builder heavy --
 * npm run build` first.
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/apps-embed.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './lib/app.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = await openApp({ suite: 'apps-embed', build: true, desktop: true });
// Without the session's variables: an agent made from inside a session is not approved here.
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
const cli = (...args) => {
  const r = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args], { cwd: app.proj, env: { ...hostEnv, HOME: app.home }, encoding: 'utf-8' });
  if (r.status !== 0) app.findings.push(`dreamcontext ${args.join(' ')} failed: ${(r.stdout + r.stderr).slice(-300)}`);
  return r.stdout;
};

async function windowUrl() {
  const file = JSON.parse(readFileSync(join(app.home, '.dreamcontext', 'desktop-server.json'), 'utf-8'));
  const r = await fetch(`${app.base}/api/apps/launch-window`, {
    method: 'POST',
    headers: { authorization: `Bearer ${file.launchToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectRoot: realpathSync(app.proj), slug: 'demo' }),
  });
  if (!r.ok) throw new Error(`launch-window ${r.status}: ${await r.text()}`);
  return (await r.json()).url;
}

async function frameOf(page, path, height = '100vh') {
  await page.evaluate(([src, h]) => {
    document.body.innerHTML = '';
    document.body.style.margin = '0';
    const f = document.createElement('iframe');
    f.src = src;
    f.style.cssText = `border:0;width:100vw;height:${h};display:block`;
    document.body.append(f);
  }, [path, height]);
  await page.waitForTimeout(2500);
  return page.frames().find((f) => f !== page.mainFrame());
}

const see = async (frame, where, text) => {
  const ok = await frame?.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
  if (!ok) app.findings.push(`${where}: "${text}" is not drawn`);
};
const absent = async (frame, where, selector) => {
  const n = await frame.locator(selector).count();
  if (n) app.findings.push(`${where}: ${selector} is drawn ${n}x, it decides for the owner`);
};

try {
  cli('apps', 'new', 'demo', '--name', 'Demo Ads');
  cli('agents', 'create', 'ua', '--title', 'UA Manager', '--prompt', 'Run the ads.');
  cli('tasks', 'create', 'Pause the weak campaign', '-w', 'A fixture task.');
  cli('lab', 'create', 'spend', '--title', 'Ad spend');

  const view = (name, path, act) => app.look('/?vault=proj', async (page, w) => {
    const where = `${name}@${w.name}`;
    await page.goto(await windowUrl(), { waitUntil: 'domcontentloaded' });
    const frame = path ? await frameOf(page, path) : page.mainFrame();
    if (!frame) { app.findings.push(`${where}: no frame`); return; }
    await act(frame, where, page);
  }, { name });

  await view('embed-tasks', '/__dc/embed/tasks', async (f, w) => {
    await see(f, w, 'Pause the weak campaign');
    await f.getByText('Pause the weak campaign').first().click({ timeout: 5_000 }).catch(() => {});
    await f.waitForTimeout?.(800);
    // The owner's own: assign, approve/object, rename, create.
    for (const sel of ['.gta', '[data-testid="new-task"]', '.detail-filing button', '.detail-title[contenteditable="true"]']) await absent(f, w, sel);
  });
  await view('embed-roadmap', '/__dc/embed/roadmap', async (f, w) => {
    await see(f, w, 'Roadmap');
    const n = await f.getByText('New Objective').count();
    if (n) app.findings.push(`${w}: "New Objective" is drawn ${n}x, it decides for the owner`);
  });
  await view('embed-insight', '/__dc/embed/insight?insight=spend', async (f, w) => { await see(f, w, 'Ad spend'); });
  await view('embed-team', '/__dc/embed/team', async (f, w) => {
    await see(f, w, 'UA Manager');
    for (const s of ['.aiteam-newbtn', '[data-team-routines]', '[data-team-approval]', '[data-sync-strip]']) await absent(f, w, s);
    // A phone draws the list first; the conversation, and its link out, are one tap away.
    if (w.startsWith('embed-team@phone')) await f.getByText('UA Manager').first().click({ timeout: 5_000 }).catch(() => {});
    await see(f, w, 'Open in the main app');
  });
  await view('embed-chat', '/__dc/embed/chat?member=ua', async (f, w, page) => {
    await see(f, w, 'UA Manager');
    for (const s of ['[data-team-routines]', '[data-team-approval]', '.aiteam-roster']) await absent(f, w, s);
    const box = f.locator('textarea, [contenteditable="true"]').first();
    await box.fill('how are the ads doing');
    const said = page.waitForResponse((r) => /\/api\/apps\/demo\/say$/.test(r.url()), { timeout: 10_000 }).catch(() => null);
    await box.press('Enter');
    const r = await said;
    if (!r || r.status() !== 200) app.findings.push(`${w}: the embedded chat's send answered ${r?.status() ?? 'nothing'}`);
    await see(f, w, 'how are the ads doing');
    const fw = await f.evaluate(() => ({ convo: document.querySelector('.aiteam-convo')?.getBoundingClientRect().width ?? 0, frame: window.innerWidth }));
    if (fw.convo < fw.frame * 0.9) app.findings.push(`${w}: the conversation is ${Math.round(fw.convo)}px wide in a ${fw.frame}px frame`);
  });

  // A short frame: the owner could not type in a 360px chat. The box stays on screen and sends at
  // every height, and the messages scroll, not the box.
  for (const height of ['300px', '360px', '560px', '100vh']) {
    await view(`embed-chat-${height.replace('px', '')}`, null, async (_f, w, page) => {
      const f = await frameOf(page, '/__dc/embed/chat?member=ua', height);
      await see(f, w, 'UA Manager');
      const box = f.locator('textarea, [contenteditable="true"]').first();
      for (let i = 1; i <= 4; i += 1) {
        await box.fill(`message ${i} at ${height}`);
        const said = page.waitForResponse((r) => /\/api\/apps\/demo\/say$/.test(r.url()), { timeout: 10_000 }).catch(() => null);
        await f.locator('.chat-cmp-send, button[type="submit"]').first().click({ timeout: 5_000 }).catch((e) => app.findings.push(`${w}: the send button cannot be clicked: ${String(e.message).slice(0, 120)}`));
        const r = await said;
        if (!r || r.status() !== 200) app.findings.push(`${w}: send ${i} answered ${r?.status() ?? 'nothing'}`);
        await f.waitForTimeout?.(300);
      }
      await see(f, w, `message 4 at ${height}`);
      const m = await f.evaluate(() => {
        const rect = (s) => document.querySelector(s)?.getBoundingClientRect();
        const list = document.querySelector('.aiteam-scroll');
        const input = rect('textarea, [contenteditable="true"]');
        return { frame: window.innerHeight, composerBottom: rect('.aiteam-composer')?.bottom ?? 0, inputTop: input?.top ?? 0, inputH: input?.height ?? 0, list: list?.clientHeight ?? 0, listAll: list?.scrollHeight ?? 0, head: rect('.aiteam-convo-head')?.height ?? 0 };
      });
      process.stdout.write(`${w}: ${JSON.stringify(m)}\n`);
      if (m.composerBottom > m.frame + 1 || m.inputTop < 0 || m.inputH < 20) app.findings.push(`${w}: the box is off screen ${JSON.stringify(m)}`);
      if (m.list < 60) app.findings.push(`${w}: only ${m.list}px left for the messages`);
      if (m.listAll <= m.list) app.findings.push(`${w}: the messages do not scroll ${JSON.stringify(m)}`);
      // A long draft takes the box to its tallest: it still has to be reachable and sendable.
      await box.fill(Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n'));
      await f.waitForTimeout?.(400);
      const d = await f.evaluate(() => ({ frame: window.innerHeight, bottom: document.querySelector('.aiteam-composer')?.getBoundingClientRect().bottom ?? 0, list: document.querySelector('.aiteam-scroll')?.clientHeight ?? 0 }));
      process.stdout.write(`${w} long draft: ${JSON.stringify(d)}\n`);
      if (d.bottom > d.frame + 1) app.findings.push(`${w}: a long draft pushes the box off screen ${JSON.stringify(d)}`);
      await f.locator('.chat-cmp-send, button[type="submit"]').first().click({ timeout: 5_000, trial: true }).catch(() => app.findings.push(`${w}: a long draft hides the send button`));
    });
  }
  // What `apps new` leaves: a bare page that works, with no color of ours on it.
  await view('template-page', null, async (_f, w, page) => {
    await page.getByText('backend: from the backend').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => app.findings.push(`${w}: the template page did not reach its backend`));
    await page.waitForTimeout(800);
    const look = await page.evaluate(() => ({ text: document.body.innerText, bg: getComputedStyle(document.body).backgroundColor, sheets: document.styleSheets.length }));
    process.stdout.write(`${w}: ${JSON.stringify(look)}\n`);
    if (look.sheets !== 0 || !/tasks: 1/.test(look.text)) app.findings.push(`${w}: template page ${JSON.stringify(look)}`);
  });
  // A task opened full page in a short frame: its way out stays on screen.
  await view('embed-task-full', null, async (_f, w, page) => {
    const f = await frameOf(page, '/__dc/embed/tasks', '360px');
    await f.getByText('Pause the weak campaign').first().click({ timeout: 5_000 });
    await f.locator('button:left-of(.modal-close)').first().click({ timeout: 5_000 });
    await f.waitForTimeout?.(600);
    const top = await f.evaluate(() => document.querySelector('.detail-overlay--fullscreen')?.getBoundingClientRect().top ?? null);
    process.stdout.write(`${w}: full page top ${top}\n`);
    if (top !== 0) app.findings.push(`${w}: the full-page task starts at ${top}`);
  });
  // The SDK's helper: an auto-height host gets the minimum, a tall host is filled.
  await view('embed-mount', null, async (_f, w, page) => {
    const sizes = await page.evaluate(async () => {
      const { dc } = await import('/__dc/sdk.js');
      document.body.innerHTML = '';
      const auto = document.createElement('div');
      const tall = document.createElement('div');
      tall.style.height = '700px';
      const clipped = document.createElement('div');
      clipped.style.cssText = 'height:300px;overflow:hidden';
      document.body.append(auto, tall, clipped);
      dc.mountEmbed(auto, 'chat', { member: 'ua' });
      dc.mountEmbed(tall, 'tasks');
      dc.mountEmbed(clipped, 'chat', { member: 'ua' });
      return [auto, tall, clipped].flatMap((h) => [h.firstChild.getBoundingClientRect().height, h.clientHeight]);
    });
    if (sizes.join() !== '560,560,700,700,560,560') app.findings.push(`${w}: mountEmbed drew ${sizes.join()}`);
    await page.waitForTimeout(1500);
  });
  // The other screens in a short frame: they scroll, nothing is cut off.
  for (const [name, path] of [['tasks', '/__dc/embed/tasks'], ['roadmap', '/__dc/embed/roadmap'], ['team', '/__dc/embed/team'], ['insight', '/__dc/embed/insight?insight=spend']]) {
    await view(`embed-short-${name}`, null, async (_f, w, page) => {
      const f = await frameOf(page, path, '360px');
      await f.waitForTimeout?.(1500);
      const m = await f.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('.embed-root, .embed-root *')) {
          const st = getComputedStyle(el);
          if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 2) out.push({ c: String(el.className).slice(0, 40), h: el.clientHeight, all: el.scrollHeight, y: st.overflowY });
        }
        return out;
      });
      process.stdout.write(`${w}: ${JSON.stringify(m)}\n`);
      for (const c of m) if (c.y === 'hidden' || c.y === 'clip') app.findings.push(`${w}: ${c.c} cuts ${c.all - c.h}px`);
    });
  }

  await app.look('/?vault=proj', async (page, w) => {
    await page.goto(await windowUrl(), { waitUntil: 'domcontentloaded' });
    const seen = [];
    page.on('response', (r) => { if (r.url().includes('embed=')) seen.push(r.status()); });
    const dash = new URL(app.base).port;
    await frameOf(page, `http://127.0.0.1:${dash}/?embed=tasks&vault=proj&tk=${'x'.repeat(43)}`);
    if (!seen.includes(403)) app.findings.push(`no-token@${w.name}: a frame with a dead token got ${seen.join(',') || 'nothing'}, not 403`);
    app.findings.splice(0, app.findings.length, ...app.findings.filter((f) => !/^no-token@[^:]+ console: .*status of 403\b/.test(f) && !/^no-token@[^:]+ 403: \/\?embed=tasks&vault=proj&tk=x{43}$/.test(f)));
  }, { name: 'no-token' });
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
process.exit(await app.finish());
