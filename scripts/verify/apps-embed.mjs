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
const cli = (...args) => {
  const r = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args], { cwd: app.proj, env: { ...process.env, HOME: app.home }, encoding: 'utf-8' });
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

async function frameOf(page, path) {
  await page.evaluate((src) => {
    document.body.innerHTML = '';
    document.body.style.margin = '0';
    const f = document.createElement('iframe');
    f.src = src;
    f.style.cssText = 'border:0;width:100vw;height:100vh;display:block';
    document.body.append(f);
  }, path);
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
    const frame = await frameOf(page, path);
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
