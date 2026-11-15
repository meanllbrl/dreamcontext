#!/usr/bin/env node
/**
 * /verify: the drawer's Hidden group (owner 2026-11-14, option A). Four projects, two hidden:
 * the hover eye beside "+", the folded group carrying a hidden project's question (its summary
 * answer is patched to ask, the one thing a scratch vault cannot produce), the group open, and
 * one click on the eye hides a project. Dark and light, drawer crops copied by the caller.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openApp } from './lib/app.mjs';

const REPO = new URL('../..', import.meta.url).pathname;
const app = await openApp({ suite: 'drawer-hidden' });
const results = [];
const ok = (n, v, why = '') => { results.push(`${v ? 'ok  ' : 'FAIL'} ${n}${why ? ` (${why})` : ''}`); if (!v) app.findings.push(`check failed: ${n}`); };

const env = { ...process.env, HOME: app.home };
for (const name of ['Atlas', 'Kestrel', 'Meridian', 'Orbit']) {
  const dir = join(app.home, '..', name);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = spawnSync('npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), 'vaults', 'add', name, dir], { cwd: dir, env, encoding: 'utf-8' });
  if (r.status !== 0) app.findings.push(`could not add ${name}: ${r.stderr}`);
}
const post = (body) => fetch(`${app.base}/api/launcher/ui-settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

for (const theme of ['dark', 'light']) {
  await post({ theme, shell: 'new', projectOrder: ['proj', 'Atlas', 'Kestrel', 'Meridian', 'Orbit'], hiddenProjects: ['Meridian', 'Orbit'], drawerExpanded: ['proj'], drawerOpen: true });
  await app.look('/?vault=proj', async (page, w) => {
    if (w.name !== 'desktop') return;
    // Meridian's Super Agent asks the owner, Orbit's runs a job.
    await page.route('**/api/agent/sessions?summary=1', async (route) => {
      const vault = route.request().headers()['x-dreamcontext-vault'];
      const res = await route.fetch();
      const body = await res.json().catch(() => ({}));
      if (vault === 'Meridian') body.superAsking = true;
      if (vault === 'Orbit') body.superWorking = 1;
      await route.fulfill({ response: res, json: body });
    });
    await page.reload();
    const drawer = page.locator('[data-testid="chat-drawer"]');
    await drawer.waitFor({ timeout: 20_000 });
    const group = page.locator('[data-testid="drawer-hidden-row"]');
    await group.waitFor({ timeout: 10_000 });
    ok(`${theme}: hidden projects are out of the list`, (await page.locator('[data-drawer-project="Meridian"]').count()) === 0);
    ok(`${theme}: the group says how many`, (await group.innerText()).includes('2'));
    await page.waitForFunction(() => document.querySelector('[data-testid="drawer-hidden-row"]')?.getAttribute('data-ask-row') === 'true', null, { timeout: 20_000 }).catch(() => {});
    ok(`${theme}: the folded group carries the hidden question`, (await group.getAttribute('data-ask-row')) === 'true');
    const box = await drawer.boundingBox();
    const clip = { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 620) };
    await page.screenshot({ path: `${app.shots}/${theme}-2-folded.png`, clip });

    // Hover a listed project: the eye beside "+".
    const atlas = page.locator('[data-drawer-project="Atlas"] .ns-dr-proj');
    await atlas.hover();
    await page.waitForTimeout(250);
    const eye = page.locator('[data-drawer-project="Atlas"] [data-testid="drawer-project-hide"]');
    ok(`${theme}: hovering shows the eye beside +`, await eye.isVisible());
    await page.screenshot({ path: `${app.shots}/${theme}-1-hover.png`, clip });

    // Open the group in place.
    await group.click();
    await page.mouse.move(box.x + box.width + 200, 300);
    await page.waitForTimeout(300);
    ok(`${theme}: the group opens in place`, (await page.locator('[data-hidden-project="Meridian"]').count()) === 1);
    await page.locator('[data-hidden-project="Orbit"] .ns-dr-proj').hover();
    await page.waitForTimeout(250);
    ok(`${theme}: a hidden project's eye says Show again`, await page.locator('[data-hidden-project="Orbit"] [data-testid="drawer-project-show"]').isVisible());
    await page.screenshot({ path: `${app.shots}/${theme}-3-open.png`, clip });

    // One click on the eye hides Atlas; Show again brings it back.
    await atlas.hover();
    await eye.click();
    await page.waitForTimeout(300);
    ok(`${theme}: one click hides`, (await page.locator('[data-hidden-project="Atlas"]').count()) === 1);
    await page.locator('[data-hidden-project="Atlas"] .ns-dr-proj').hover();
    await page.locator('[data-hidden-project="Atlas"] [data-testid="drawer-project-show"]').click();
    await page.waitForTimeout(300);
    ok(`${theme}: Show again brings it back`, (await page.locator('[data-drawer-project="Atlas"]:not([data-hidden-project])').count()) === 1);
    await page.waitForTimeout(900); // the layout write is debounced (LAYOUT_WRITE_DEBOUNCE_MS)
    const stored = await fetch(`${app.base}/api/launcher/ui-settings`).then((r) => r.json());
    ok(`${theme}: stored hidden list`, JSON.stringify(stored.hiddenProjects) === JSON.stringify(['Meridian', 'Orbit']), JSON.stringify(stored.hiddenProjects));
  }, { name: theme });
}
console.log(results.join('\n'));
console.log(`shots: ${app.shots}`);
process.exit(await app.finish());
