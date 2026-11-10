#!/usr/bin/env node
/**
 * app-veri-ortak, criterion 14 (what the owner sees): the Apps page with team-shared app data.
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/app-data-notice.mjs
 *
 * A scratch vault in full-repo mode with cloud sync on (a local bare remote) holds three apps:
 *   - "Rival Watch" (`rakip`): declares `notes/` shared + `visits.json` local (the template), so the
 *     first-share notice shows its paths with a tick each, Share and Keep local;
 *   - "Old Tool" (`eski`): no `data` field, so its own tile says the shared data is not decided yet
 *     (and nothing about it is stacked above the shelves);
 *   - `takim`: a teammate's app whose data is tracked in the brain but not installed here (team-data).
 * Then the two routes: data-share refuses a caller without the owner's key (403 owner_page_only),
 * sync-pause answers `not_running` for an app with no backend up.
 * Screenshots at 390 and 1440 px; console errors, failed requests and overflow are findings.
 * Fixtures are fictional.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApp } from './lib/app.mjs';

const app = await openApp({ suite: 'app-data-notice' });
const REPO = join(new URL('.', import.meta.url).pathname, '..', '..');
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_|CODEX_)/.test(k)));
const env = { ...hostEnv, HOME: app.home, npm_config_cache: join(process.env.HOME ?? app.home, '.npm'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'ornek', GIT_AUTHOR_EMAIL: 'ornek@example.com', GIT_COMMITTER_NAME: 'ornek', GIT_COMMITTER_EMAIL: 'ornek@example.com' };
const cli = (...args) => {
  const r = spawnSync('npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), ...args], { cwd: app.proj, env, encoding: 'utf-8' });
  if (r.status !== 0) app.findings.push(`dreamcontext ${args.join(' ')} failed: ${(r.stdout + r.stderr).slice(-300)}`);
  return r.stdout;
};
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf-8' });
  if (r.status !== 0) app.findings.push(`git ${args.join(' ')} failed: ${r.stderr.slice(-300)}`);
  return r.stdout;
};
/** One request; a transport failure is a finding with its cause, never the end of the run. */
async function req(path, init = {}) {
  try {
    const r = await fetch(`${app.base}${path}`, { ...init, headers: { 'x-dreamcontext-vault': 'proj', ...(init.headers ?? {}) } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch (e) {
    app.findings.push(`${init.method ?? 'GET'} ${path}: ${e.message} (${e.cause?.code ?? ''} ${e.cause?.message ?? ''})`);
    return { status: 0, body: {} };
  }
}
/** The Mac app's shell, as scripts/verify/app-tools.mjs plays it: the Apps page draws what only the app shows. */
const DESKTOP_SHELL = `window.__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } }; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };`;
const put = (abs, text) => { mkdirSync(join(abs, '..'), { recursive: true }); writeFileSync(abs, text); };

try {
  // Full-repo, cloud sync on, a local bare remote (no token is ever used).
  const bare = join(app.proj, '..', 'remote.git');
  git(join(app.proj, '..'), 'init', '-q', '--bare', '--initial-branch=main', bare);
  git(app.proj, 'remote', 'add', 'origin', bare);
  const dc = join(app.proj, '_dream_context');
  put(join(dc, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'full-repo', enabled: true, autoSync: false } }));

  cli('apps', 'new', 'rakip', '--name', 'Rival Watch');
  put(join(dc, 'apps', 'rakip', 'notes', 'fb-001.json'), JSON.stringify({ id: 'fb-001', note: 'try this hook' }));
  put(join(dc, 'apps', 'rakip', 'notes', 'tt-002.json'), JSON.stringify({ id: 'tt-002', note: 'strong paywall' }));
  put(join(dc, 'apps', 'rakip', 'visits.json'), '{"visits":12}');

  cli('apps', 'new', 'eski', '--name', 'Old Tool');
  const eskiManifest = join(`${app.proj}-apps`, 'eski', 'dreamcontext-app.json');
  const m = JSON.parse(readFileSync(eskiManifest, 'utf-8'));
  delete m.data;
  writeFileSync(eskiManifest, `${JSON.stringify(m, null, 2)}\n`);

  // A teammate's app: its data is tracked in the brain, the app is not installed here.
  put(join(dc, 'apps', 'takim', 'favorites', 'a.json'), '{"id":"a"}');
  put(join(dc, 'knowledge', 'notes.md'), '# Notes\n');
  git(app.proj, 'add', '-A', '--', '_dream_context/knowledge', '_dream_context/state/.config.json');
  git(app.proj, 'add', '-f', '--', '_dream_context/apps/takim/favorites/a.json');
  git(app.proj, 'commit', '-qm', 'team data');

  // The routes, as an agent or a script would call them (no owner key).
  const share = await req('/api/apps/rakip/data-share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: ['notes/'] }) });
  console.log(`POST data-share (no owner key) → ${share.status} ${JSON.stringify(share.body).slice(0, 160)}`);
  if (share.status !== 403) app.findings.push(`data-share without the owner key answered ${share.status}, not 403`);
  const pause = await req('/api/apps/rakip/sync-pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  console.log(`POST sync-pause → ${pause.status} ${JSON.stringify(pause.body)}`);
  if (pause.status !== 200 || pause.body.state !== 'not_running') app.findings.push(`sync-pause answered ${pause.status} ${JSON.stringify(pause.body)}`);
  const list = await req('/api/apps');
  console.log(`GET /api/apps others → ${JSON.stringify(list.body.others)}`);
  console.log(`GET /api/apps data → ${JSON.stringify((list.body.apps ?? []).map((a) => ({ slug: a.slug, mode: a.data?.mode, pending: a.data?.pendingPaths })))}`);

  await app.look('/?vault=proj&page=apps', async (page, w) => {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    // The new shell can open with the chat surface laid OVER the Apps page (the page is mounted and
    // "visible" underneath it). Always go to Apps by the rail, as the owner would: a rail click
    // collapses the chat surface. Desktop has Apps on the rail; the phone has it under More.
    const rail = page.getByTestId('ns-rail-apps');
    if (await rail.isVisible().catch(() => false)) await rail.click();
    else {
      await page.getByTestId('ns-rail-more').click().catch(() => {});
      await page.getByRole('menuitem', { name: /^(Apps|Uygulamalar)/ }).first().click().catch(() => {});
    }
    await page.waitForTimeout(800);
    if (await page.locator('.agent-surface.expanded').count()) app.findings.push(`apps@${w.name}: the chat surface still covers the Apps page`);
    if (!(await page.locator('.app-tile').first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false))) {
      app.findings.push(`apps@${w.name}: the Apps page did not open (no .app-tile)`);
    }
    // The share notice is the owner's click, so it is drawn only in the Mac app (desktop width
    // plays its shell below); the phone shows the tile line but never the notice.
    const notice = [/Rival Watch.*(shared with the team|ekiple ortak)/i, /notes\//];
    if (w.width <= 600) {
      for (const text of notice) {
        if (await page.getByText(text).first().isVisible().catch(() => false)) app.findings.push(`apps@${w.name}: ${text} is drawn on the phone`);
      }
    }
    for (const text of [/(Shared data not decided yet|Ortak veri henüz belirlenmedi)/i, ...(w.width > 600 ? notice : [])]) {
      const seen = await page.getByText(text).first().waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false);
      if (!seen) app.findings.push(`apps@${w.name}: ${text} is not on the page`);
    }
    // The undecided state lives on the tile, never as a row above the shelves.
    const above = await page.evaluate(() => {
      const shelf = document.querySelector('.app-tile');
      const line = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && /Shared data not decided yet|Ortak veri henüz belirlenmedi/.test(el.textContent ?? ''));
      return !!(shelf && line && !line.closest('.app-tile'));
    });
    if (above) app.findings.push(`apps@${w.name}: the undecided line is outside its tile`);
    await page.screenshot({ path: join(app.shots, `apps-full-${w.name}.png`), fullPage: true });
    app.taken.push(join(app.shots, `apps-full-${w.name}.png`));
  }, { name: 'apps', init: (w) => (w.width > 600 ? DESKTOP_SHELL : null) });
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
process.exit(await app.finish());
