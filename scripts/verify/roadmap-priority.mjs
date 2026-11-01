#!/usr/bin/env node
/**
 * The Roadmap's priority board in the real app, against a scratch vault (no build):
 *
 *   dreamcontext builder heavy -- node scripts/verify/roadmap-priority.mjs
 *
 * 1. First open on a machine with OLD prefs (layout: timeline, no v): it opens on
 *    Objectives + Lanes; the one open objective is unscored, so the bands are empty, the
 *    NOT SCORED row holds it and the button reads "✦ Score N".
 * 2. A scored board with suggestions: Objectives / Tasks × Lanes / Map, panel open, light
 *    and dark, at 390 and 1440 px (screenshots).
 * 3. Desktop: a sideways drag links a task to another objective; Undo restores it; a
 *    suggestion is accepted from the panel; no window.confirm/alert/prompt is ever called.
 * Console errors, failed requests and sideways overflow are reported by lib/app.mjs.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './lib/app.mjs';

const app = await openApp({ suite: 'roadmap-priority' });
const ctx = join(app.proj, '_dream_context');
const objDir = join(ctx, 'core', 'objectives');
mkdirSync(objDir, { recursive: true });

const yaml = (v) => JSON.stringify(v);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The real CLI against the scratch vault (what a scoring agent runs). */
const cli = (...args) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
  const r = spawnSync('npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), ...args], { cwd: app.proj, env: { ...env, HOME: app.home }, encoding: 'utf-8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const api = (path, body) => fetch(`${app.base}/api${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function writeObjective(slug, fm) {
  const lines = Object.entries({ title: slug, depends_on: [], created_at: '2026-10-01', updated_at: '2026-10-01', ...fm })
    .filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${yaml(v)}`);
  writeFileSync(join(objDir, `${slug}.md`), `---\n${lines.join('\n')}\n---\n## Why\nScratch objective.\n`);
}
function writeTask(slug, fm) {
  const lines = Object.entries({ name: slug, status: 'todo', priority: 'medium', urgency: 'medium', created_at: '2026-10-01', updated_at: '2026-10-01', ...fm })
    .filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${yaml(v)}`);
  writeFileSync(join(ctx, 'state', `${slug}.md`), `---\n${lines.join('\n')}\n---\n## Why\nScratch task.\n`);
}
const fmOf = (slug) => readFileSync(join(ctx, 'state', `${slug}.md`), 'utf-8');

const ROADMAP = '/?vault=proj&page=roadmap';
const shot = async (page, name, w) => {
  const file = join(app.shots, `${name}-${w.name}.png`);
  await page.screenshot({ path: file });
  app.taken.push(file);
};
const setTheme = async (page, t) => {
  await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t);
  await page.waitForTimeout(150);
};
const dismissModals = async (page) => {
  if (await page.locator('.announcements-modal-scrim').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
};
/** The app opens on Chat in the new shell: go to the Roadmap through the rail (phone: More). */
const goRoadmap = async (page) => {
  await dismissModals(page);
  const rail = page.getByTestId('ns-rail-roadmap');
  // Right after a load the rail may not be drawn yet: wait for it before choosing the phone path.
  const onRail = await rail.waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false);
  // The What's New popup can open late, after a reload: close it before any click.
  for (let i = 0; i < 3 && await page.locator('.announcements-modal-scrim').isVisible().catch(() => false); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  if (onRail) {
    await rail.click();
  } else {
    await page.getByTestId('ns-rail-more').click();
    await page.getByTestId('ns-more-roadmap').click();
  }
  await page.waitForTimeout(600);
  // The Roadmap may already be mounted under the chat overlay: wait for the overlay to go too.
  await page.locator('.project-instance:not([hidden]) .agent-surface.expanded').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  await page.locator('.rm-seg').first().waitFor({ timeout: 15000 });
};
/** Drop ONLY the failures a scene injected on purpose (route.fulfill 500), never anything else. */
const dropInjected = (scene, paths) => {
  for (let i = app.findings.length - 1; i >= 0; i--) {
    const f = app.findings[i];
    if (!f.startsWith(`${scene}@`)) continue;
    const injected = / (500|409): /.test(f) && paths.some((p) => f.includes(p));
    const consoleOfInjected = /console: Failed to load resource: the server responded with a status of (500|409)/.test(f);
    if (injected || consoleOfInjected) app.findings.splice(i, 1);
  }
};
const trapDialogs = async (page) => {
  await page.evaluate(() => {
    window.__dialogs = [];
    for (const k of ['confirm', 'alert', 'prompt']) window[k] = (...a) => { window.__dialogs.push(k); return k === 'confirm' ? true : null; };
  });
};
const seg = (page, label) => page.locator('.rm-seg-opt', { hasText: label }).first();
const expectText = async (page, where, text) => {
  const ok = await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false);
  if (!ok) app.findings.push(`${where}: "${text}" is not on the page`);
  return ok;
};

try {
  // ── 1. First open (Tilki shape) with old prefs ───────────────────────────
  writeFileSync(join(ctx, 'state', '.roadmap-prefs.json'), JSON.stringify({ layout: 'timeline', search: '' }));
  writeObjective('mrr', { title: '3000 USD MRR', impact: 5, effort: 4 });
  for (let i = 0; i < 6; i++) writeTask(`backlog-${i}`, { rice: i < 2 ? { reach: 9, impact: 5, confidence: 100, effort: 0.4 } : undefined, objectives: i === 1 ? ['mrr'] : undefined });

  await app.look(ROADMAP, async (page, w) => {
    await goRoadmap(page);
    const lanesOn = await seg(page, 'Lanes').getAttribute('aria-checked');
    if (lanesOn !== 'true') app.findings.push(`first-open@${w.name}: Lanes is not the open layout (old prefs said timeline)`);
    const objOn = await seg(page, 'Objectives').getAttribute('aria-checked');
    if (objOn !== 'true') app.findings.push(`first-open@${w.name}: Objectives is not the open level`);
    await expectText(page, `first-open@${w.name}`, 'Not scored · 1');
    await expectText(page, `first-open@${w.name}`, '✦ Score');
    if (w.name === 'phone') {
      const levelTop = await page.locator('.rm-level-seg').boundingBox();
      const searchTop = await page.locator('.rm-toolbar input').boundingBox();
      if (levelTop && searchTop && Math.abs(levelTop.y - searchTop.y) < 8) app.findings.push('first-open@phone: the level segment is not on its own row');
    }
    for (const t of ['light', 'dark']) { await setTheme(page, t); await shot(page, `first-open-${t}`, w); }
    await setTheme(page, 'light');
  }, { name: 'first-open' });

  // ── 2. A scored board with suggestions ───────────────────────────────────
  writeObjective('mrr', { title: '3000 USD MRR', impact: 5, effort: 4, reach: 8, confidence: 100, target_date: '2026-11-08' });
  writeObjective('retention', { title: 'D30 retention 40%', impact: 4, effort: 2, reach: 6, confidence: 75 });
  writeObjective('social', { title: 'Marketing ready social media', impact: 3, effort: 3, target_date: '2026-10-31', priority_suggestion: { reach: 6, confidence: 75, why: 'Every launch needs it.', at: '2026-11-01T10:00:00.000Z-aaaa', dismissed_at: null, accepted_at: null } });
  writeObjective('pilot', { title: 'Institution pilot: 5 schools', depends_on: ['mrr'] });
  const tasks = [
    ['pay-template', { reach: 8, impact: 5, confidence: 100, effort: 0.5 }, ['mrr']],
    ['cancel-shows-done', null, ['mrr'], { reach: 6, impact: 3, confidence: 75, effort: 0.5 }],
    ['attribution-cleanup', { reach: 6, impact: 5, confidence: 100, effort: 1 }, ['social']],
    ['trial-followup', null, ['social'], { reach: 7, impact: 2, confidence: 100, effort: 1 }],
    ['teacher-rate', { reach: 5, impact: 3, confidence: 100, effort: 0.8 }, ['mrr']],
    ['minor-phone', { reach: 4, impact: 4, confidence: 100, effort: 1 }, ['mrr', 'retention']],
    ['meeting-call', { reach: 9, impact: 5, confidence: 100, effort: 0.4 }, []],
    ['csp-header', { reach: 3, impact: 3, confidence: 50, effort: 1 }, []],
    ['old-link', { reach: 2, impact: 2, confidence: 50, effort: 1 }, ['gone-objective']],
    ['unscored-a', null, ['retention']],
    ['unscored-b', null, []],
  ];
  for (const [slug, rice, links, sugg] of tasks) {
    writeTask(slug, {
      ...(rice ? { rice } : {}),
      ...(links.length ? { objectives: links } : {}),
      ...(sugg ? { priority_suggestion: { ...sugg, why: 'Nine cancellations in 30 days.', at: `2026-11-01T10:00:00.000Z-${slug.slice(0, 4)}`, dismissed_at: null, accepted_at: null } } : {}),
      ...(slug === 'teacher-rate' ? { status: 'in_progress' } : {}),
    });
  }
  writeTask('meeting-sub', { parent_task: 'meeting-call', rice: { reach: 9, impact: 5, confidence: 100, effort: 0.5 } });
  writeTask('meeting-call-link-sugg', { rice: { reach: 9, impact: 4, confidence: 100, effort: 1 }, priority_suggestion: { objective: 'retention', why: 'Retention driver.', at: '2026-11-01T10:00:00.000Z-mcls', dismissed_at: null, accepted_at: null } });

  await app.look(ROADMAP, async (page, w) => {
    await goRoadmap(page);
    await trapDialogs(page);
    const where = `board@${w.name}`;
    // Objectives × Lanes
    await seg(page, 'Lanes').click();
    await seg(page, 'Objectives').click();
    await expectText(page, where, '3000 USD MRR');
    await expectText(page, where, 'suggestions');
    for (const t of ['light', 'dark']) { await setTheme(page, t); await shot(page, `obj-lanes-${t}`, w); }
    await setTheme(page, 'light');
    // Objectives × Map (hidden under 768 px)
    const mapBtn = seg(page, 'Map');
    if (w.name === 'desktop') {
      await mapBtn.click();
      await page.waitForTimeout(300);
      for (const t of ['light', 'dark']) { await setTheme(page, t); await shot(page, `obj-map-${t}`, w); }
      await setTheme(page, 'light');
    } else if (await mapBtn.count()) {
      app.findings.push(`${where}: Map is offered under 768 px`);
    }
    // Tasks × Lanes
    await seg(page, 'Lanes').click();
    await seg(page, 'Tasks').click();
    await expectText(page, where, 'Unlinked');
    await expectText(page, where, 'meeting-call');
    if (await page.getByText('meeting-sub', { exact: true }).count()) app.findings.push(`${where}: a sub-task is a card`);
    for (const t of ['light', 'dark']) { await setTheme(page, t); await shot(page, `task-lanes-${t}`, w); }
    await setTheme(page, 'light');
    // Panel open on a suggestion (the walk button)
    await page.locator('.rm-agent-btn.is-pending').click();
    await page.locator('.pp').waitFor({ timeout: 5000 });
    await expectText(page, where, 'Suggestion 1 of');
    for (const t of ['light', 'dark']) { await setTheme(page, t); await shot(page, `panel-${t}`, w); }
    await setTheme(page, 'light');
    await page.locator('.pp-x').click();
    // Tasks × Map
    if (w.name === 'desktop') {
      await seg(page, 'Map').click();
      await page.waitForTimeout(300);
      for (const t of ['light', 'dark']) { await setTheme(page, t); await shot(page, `task-map-${t}`, w); }
      await setTheme(page, 'light');
      await seg(page, 'Lanes').click();

      // ── 3. Drag sideways, Undo, accept ───────────────────────────────
      const card = page.locator('.pv-tl-cell .pc', { hasText: 'csp-header' }).first();
      const target = page.locator('.pv-col-head', { hasText: 'D30 retention' }).first();
      await card.dragTo(target);
      await expectText(page, where, 'Linked to D30 retention');
      await page.waitForTimeout(600);
      if (!/objectives:\s*\n?\s*-?\s*"?retention/.test(fmOf('csp-header')) && !fmOf('csp-header').includes('retention')) app.findings.push(`${where}: the drag did not link csp-header`);
      await page.locator('.pv-toast button', { hasText: 'Undo' }).click();
      await page.waitForTimeout(800);
      if (fmOf('csp-header').includes('retention')) app.findings.push(`${where}: Undo did not remove the link`);
      // Accept the first suggestion from the panel.
      await page.locator('.rm-agent-btn.is-pending').click();
      await page.locator('.pp').waitFor({ timeout: 5000 });
      await page.locator('.pp-foot .pv-btn--primary').click();
      await expectText(page, where, 'Accepted');
      const dialogs = await page.evaluate(() => window.__dialogs);
      if (dialogs.length) app.findings.push(`${where}: window.${dialogs.join(', ')} was called`);
      await shot(page, 'after-accept-light', w);
    }
  }, { name: 'board' });

  // ── 4. Behaviours (desktop): live refresh, concurrent link, rollback, states, glide ──
  await app.look(ROADMAP, async (page, w) => {
    if (w.name !== 'desktop') return;
    const where = 'behaviour@desktop';
    await goRoadmap(page);
    await trapDialogs(page);
    await seg(page, 'Lanes').click();
    await seg(page, 'Objectives').click();
    // Suggestions appear within 15 s with no reload (the project client polls every 15 s while active).
    const before = (await page.locator('.rm-agent-btn').first().textContent()) ?? '';
    writeTask('unscored-b', { priority_suggestion: { reach: 2, impact: 2, confidence: 50, effort: 1, no_objective: true, why: 'Nothing fits.', at: '2026-11-01T11:00:00.000Z-live', dismissed_at: null, accepted_at: null } });
    const t0 = Date.now();
    const changed = await page.waitForFunction((b) => (document.querySelector('.rm-agent-btn')?.textContent ?? '') !== b, before, { timeout: 16_000 }).then(() => true, () => false);
    if (!changed) app.findings.push(`${where}: a new suggestion did not appear within 16 s without a reload (button stayed "${before}")`);
    else console.log(`live suggestion appeared after ${Date.now() - t0} ms: "${before}" → "${await page.locator('.rm-agent-btn').first().textContent()}"`);

    // Glide: a score change moves the card with an animation (220 ms).
    await page.locator('.pc', { hasText: 'D30 retention' }).first().click();
    await page.locator('.pp').waitFor();
    await page.locator('.pp-seg[aria-label="Reach"] button', { hasText: '10' }).click();
    const glided = await page.waitForFunction(() => {
      const el = document.querySelector('[data-flip-key="obj::retention"]');
      return !!el && el.getAnimations().some((a) => a.effect && a.effect.getTiming().duration === 220);
    }, null, { timeout: 5000 }).then(() => true, () => false);
    if (!glided) app.findings.push(`${where}: the card did not glide (220 ms) when its score changed`);
    await page.locator('.pp-x').click();

    // A link added elsewhere while the board is open survives a drag and an Undo.
    await seg(page, 'Tasks').click();
    writeTask('csp-header', { rice: { reach: 3, impact: 3, confidence: 50, effort: 1 }, objectives: ['pilot'] });
    await page.waitForTimeout(16_000); // let the poll bring it in: the card is now in the pilot column
    const card = page.locator('.pv-tl-cell .pc', { hasText: 'csp-header' }).first();
    await card.dragTo(page.locator('.pv-col-head', { hasText: 'D30 retention' }).first());
    await expectText(page, where, 'Linked to D30 retention');
    // ...and meanwhile another link lands from elsewhere (another window, the CLI):
    const added = await fetch(`${app.base}/api/tasks/csp-header/objectives/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ add: 'mrr' }) });
    if (!added.ok) app.findings.push(`${where}: could not add the concurrent link (${added.status})`);
    await page.locator('.pv-toast button', { hasText: 'Undo' }).click();
    await page.waitForTimeout(800);
    const links = fmOf('csp-header');
    if (!links.includes('pilot') || !links.includes('mrr') || links.includes('retention')) app.findings.push(`${where}: after drag + Undo the links are wrong: ${links.split('\n').find((l) => l.includes('objectives'))}`);

    // A failed move rolls back, with an error toast.
    await page.route('**/api/tasks/*/objectives/move', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"move_link_failed","message":"Disk full."}' }));
    const victim = page.locator('.pv-tl-cell .pc', { hasText: 'pay-template' }).first();
    await victim.dragTo(page.locator('.pv-col-head', { hasText: 'Marketing ready' }).first());
    await expectText(page, where, 'Move failed');
    await page.waitForTimeout(800);
    const backHome = await page.locator('.pv-tl-cell .pc', { hasText: 'pay-template' }).count();
    if (backHome !== 1) app.findings.push(`${where}: a failed move did not roll back (pay-template cards: ${backHome})`);
    await page.unroute('**/api/tasks/*/objectives/move');
    await shot(page, 'rollback', w);

    // Dropping where it is already linked removes the SOURCE link only, and the toast names it.
    const both = page.locator('.pv-tl-cell .pc', { hasText: 'minor-phone' }).nth(1); // its 3000 USD MRR card (second column)
    await both.dragTo(page.locator('.pv-col-head', { hasText: 'D30 retention' }).first());
    await expectText(page, where, 'Already linked there: removed the link to 3000 USD MRR only');
    await page.waitForTimeout(600);
    if (fmOf('minor-phone').includes('mrr') || !fmOf('minor-phone').includes('retention')) app.findings.push(`${where}: already-linked drop changed the wrong link`);

    const dialogs = await page.evaluate(() => window.__dialogs);
    if (dialogs.length) app.findings.push(`${where}: window.${dialogs.join(', ')} was called`);
  }, { name: 'behaviour' }).finally(() => dropInjected('behaviour', ['/objectives/move']));

  // Reduced motion: no glide.
  await app.look(ROADMAP, async (page, w) => {
    if (w.name !== 'desktop') return;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await goRoadmap(page);
    await seg(page, 'Lanes').click();
    await seg(page, 'Objectives').click();
    await page.locator('.pc', { hasText: 'D30 retention' }).first().click();
    await page.locator('.pp').waitFor();
    await page.locator('.pp-seg[aria-label="Reach"] button', { hasText: '2' }).first().click();
    await page.waitForTimeout(1500);
    const anims = await page.evaluate(() => [...document.querySelectorAll('[data-flip-key]')].reduce((n, el) => n + el.getAnimations().length, 0));
    if (anims !== 0) app.findings.push(`reduced-motion@desktop: ${anims} card animation(s) ran under prefers-reduced-motion`);
  }, { name: 'reduced-motion' });

  // States: load error with retry, loading skeleton, agent unavailable, no objectives.
  await app.look(ROADMAP, async (page, w) => {
    const where = `states@${w.name}`;
    await page.route('**/api/roadmap/priority', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"priority_failed","message":"x"}' }));
    // look() already loaded the page (and the payload): reload so the routes apply from the start.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await goRoadmap(page).catch(() => {});
    await expectText(page, where, 'did not load');
    await shot(page, 'state-error', w);
    await page.unroute('**/api/roadmap/priority');
    await page.route('**/api/roadmap/priority', async (r) => { await new Promise((d) => setTimeout(d, 2500)); await r.continue(); });
    await page.getByRole('button', { name: 'Retry' }).click();
    const skel = await page.locator('.pv-skel').waitFor({ timeout: 2000 }).then(() => true, () => false);
    // A retry keeps the previous error until data lands; the skeleton shows on a cold load.
    if (skel) await shot(page, 'state-loading', w);
    await expectText(page, where, '3000 USD MRR');
  }, { name: 'states' }).finally(() => dropInjected('states', ['/api/roadmap/priority']));

  // ── 5. The agent button and prefs, observed (desktop) ───────────────────
  await app.look(ROADMAP, async (page, w) => {
    if (w.name !== 'desktop') return;
    const where = 'agent-button@desktop';
    await goRoadmap(page);
    await seg(page, 'Lanes').click();
    await seg(page, 'Objectives').click();
    // "Open objective" from the priority panel opens the full objective detail.
    await page.locator('.pc', { hasText: '3000 USD MRR' }).first().click();
    await page.getByRole('button', { name: 'Open objective' }).click();
    const detail = await page.locator('.odp-panel').waitFor({ timeout: 5000 }).then(() => true, () => false);
    if (!detail) app.findings.push(`${where}: "Open objective" did not open the objective detail panel`);
    await shot(page, 'open-objective', w);
    await page.keyboard.press('Escape');
    await page.locator('.odp-overlay').click({ force: true }).catch(() => {});

    const btn = () => page.locator('.rm-agent-btn').last();
    const label = async () => ((await btn().count()) ? (await btn().textContent())?.trim() : '(hidden)');
    // The agent is running (marker set as scoring/start does).
    const started = await (await api('/roadmap/scoring/start', {})).json();
    if (!started.started) app.findings.push(`${where}: could not set the scoring marker`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await goRoadmap(page);
    const pendingLabel = (await label()) ?? '';
    if (!/suggestion/.test(pendingLabel)) app.findings.push(`${where}: with pending suggestions while running, the button reads "${pendingLabel}" (want "N suggestions")`);
    // The button count equals the items the panel walks.
    const n = Number((pendingLabel.match(/(\d+)/) ?? [])[1]);
    await btn().click();
    await page.locator('.pp').waitFor();
    const walkText = (await page.locator('.pp-walk').textContent()) ?? '';
    if (!walkText.endsWith(`of ${n}`)) app.findings.push(`${where}: the button says ${n} suggestions but the panel walks "${walkText}"`);
    // Walk: dismiss all but the last, then ACCEPT the last → the accept takes pending to 0 mid-run.
    for (let i = 0; i < 30; i++) {
      const t = (await page.locator('.pp-walk').textContent().catch(() => '')) ?? '';
      const m = t.match(/Suggestion (\d+) of (\d+)/);
      if (!m || Number(m[2]) <= 1) break;
      await page.locator('.pp-foot .pv-btn', { hasText: 'Dismiss' }).click();
      await page.waitForTimeout(700);
    }
    await page.locator('.pp-foot .pv-btn--primary').click();
    await expectText(page, where, 'Accepted');
    await page.waitForTimeout(1500);
    const midRun = await label();
    const midDisabled = (await btn().count()) ? await btn().isDisabled() : null;
    if (midRun !== 'Scoring…' || midDisabled !== true) app.findings.push(`${where}: after pending reached 0 mid-run the button reads "${midRun}" (disabled ${midDisabled}); want disabled "Scoring…"`);
    await shot(page, 'midrun-scoring', w);
    // A reload keeps Scoring…
    await page.reload({ waitUntil: 'domcontentloaded' });
    await goRoadmap(page);
    if ((await label()) !== 'Scoring…') app.findings.push(`${where}: a reload lost "Scoring…" (reads "${await label()}")`);
    // A second window while the agent runs: its button is the same disabled "Scoring…", so it cannot start one.
    const ctx2 = await page.context().browser().newContext({ viewport: { width: 1440, height: 900 } });
    const page2 = await ctx2.newPage();
    await page2.goto(`${app.base}${ROADMAP}`, { waitUntil: 'domcontentloaded' });
    await goRoadmap(page2);
    const b2 = page2.locator('.rm-agent-btn').last();
    const second2 = (await b2.count()) ? [(await b2.textContent())?.trim(), await b2.isDisabled()] : ['(hidden)', null];
    if (second2[0] !== 'Scoring…' || second2[1] !== true) app.findings.push(`${where}: a second window shows "${second2[0]}" (disabled ${second2[1]}) while the agent runs`);
    await page2.screenshot({ path: join(app.shots, 'second-window-desktop.png') });
    app.taken.push(join(app.shots, 'second-window-desktop.png'));
    await ctx2.close();
    // ...and the server refuses a second start outright.
    const second = await (await api('/roadmap/scoring/start', {})).json();
    if (second.started !== false || second.error !== 'already_running') app.findings.push(`${where}: a second start was not refused: ${JSON.stringify(second)}`);
    // The pass ends; a double click starts exactly one agent request.
    cli('roadmap', 'unscored', '--done');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await goRoadmap(page);
    const before = await label();
    if (!/^✦ Score \d+$/.test(before ?? '')) app.findings.push(`${where}: after the pass ended the button reads "${before}" (want "✦ Score N")`);
    // Count the starts a double click sends, and answer them "already running" so NO real agent is dispatched.
    let starts = 0;
    await page.route('**/api/roadmap/scoring/start', (r) => {
      starts++;
      return r.fulfill({ status: 409, contentType: 'application/json', body: '{"started":false,"error":"already_running","message":"verify: not dispatched"}' });
    });
    await btn().dblclick();
    await page.waitForTimeout(1500);
    await page.unroute('**/api/roadmap/scoring/start');
    if (starts !== 1) app.findings.push(`${where}: a double click sent ${starts} scoring/start request(s) (want 1)`);
    // Two windows racing a start on the real server (marker free): exactly one wins.
    const raced = await Promise.all([api('/roadmap/scoring/start', {}), api('/roadmap/scoring/start', {})].map(async (r) => (await r).status));
    if (raced.filter((s) => s === 200).length !== 1) app.findings.push(`${where}: two concurrent starts on a free marker: ${raced} (want exactly one 200)`);
    cli('roadmap', 'unscored', '--done');
    // A scoring agent's whole pass (the real CLI), then the owner dismisses every suggestion → the button is hidden.
    const listed = cli('roadmap', 'unscored', '--json');
    if (listed.code !== 0) app.findings.push(`${where}: roadmap unscored --json failed: ${(listed.err || listed.out).slice(0, 160)}`);
    const work = JSON.parse(listed.out || '{"items":[]}');
    if (work.items.length === 0) app.findings.push(`${where}: the scoring pass had no items to suggest (the hidden check would prove nothing)`);
    for (const it of work.items) {
      const vals = { reach: '3', impact: '2', confidence: '50', effort: '1' };
      const flags = it.missing.flatMap((k) => [`--${k}`, vals[k]]);
      const args = it.kind === 'objective'
        ? ['roadmap', 'objective', 'suggest', it.slug, ...flags, '--why', 'scratch']
        : ['tasks', 'suggest', it.slug, ...flags, ...(it.needs_link ? ['--no-objective'] : []), '--why', 'scratch'];
      const r = cli(...args);
      if (r.code !== 0) app.findings.push(`${where}: suggest ${it.slug} failed: ${(r.err || r.out).slice(0, 160)}`);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await goRoadmap(page);
    await btn().click();
    await page.locator('.pp').waitFor();
    for (let i = 0; i < 30 && await page.locator('.pp-foot').count(); i++) {
      await page.locator('.pp-foot .pv-btn', { hasText: 'Dismiss' }).click();
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1500);
    if ((await label()) !== '(hidden)') app.findings.push(`${where}: after everything was dismissed the button still reads "${await label()}"`);
    await shot(page, 'all-dismissed-hidden', w);

    // The layout choice persists across a reload.
    await seg(page, 'Timeline').click();
    await page.waitForTimeout(1200); // the prefs write-through is debounced 600 ms
    await page.reload({ waitUntil: 'domcontentloaded' });
    await goRoadmap(page);
    if ((await seg(page, 'Timeline').getAttribute('aria-checked')) !== 'true') app.findings.push(`${where}: the Timeline choice did not persist across a reload`);
    await seg(page, 'Lanes').click();
    await page.waitForTimeout(1200);
  }, { name: 'agent-button' }).finally(() => dropInjected('agent-button', ['/api/roadmap/scoring/start']));

  // Agent unavailable names why next to the button. Runs AFTER the agent-button scene, which leaves
  // nothing pending: one item that still needs scoring makes the button "✦ Score N".
  writeTask('needs-score', {});
  await app.look(ROADMAP, async (page, w) => {
    const where = `agent-unavailable@${w.name}`;
    await page.route('**/api/agent/capabilities', async (r) => {
      const res = await r.fetch();
      const body = await res.json();
      await r.fulfill({ response: res, json: { ...body, claudeCli: false } });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await goRoadmap(page);
    const b = page.locator('.rm-agent-btn').last();
    const txt = (await b.count()) ? (await b.textContent())?.trim() : '(hidden)';
    if (!/^✦ Score \d+$/.test(txt ?? '')) app.findings.push(`${where}: the button reads "${txt}" (want "✦ Score N")`);
    await expectText(page, where, 'Install the Claude CLI to score');
    if ((await b.count()) && !(await b.isDisabled())) app.findings.push(`${where}: the Score button is enabled although the agent cannot run`);
    await shot(page, 'state-agent-unavailable', w);
  }, { name: 'agent-unavailable' });

  // Timeline and Board still behave (objectives only).
  await app.look(ROADMAP, async (page, w) => {
    await goRoadmap(page);
    for (const [label, name] of [['Timeline', 'timeline'], ['Board', 'board-view']]) {
      await seg(page, label).click();
      await page.waitForTimeout(700);
      if ((await seg(page, label).getAttribute('aria-checked')) !== 'true') app.findings.push(`${name}@${w.name}: ${label} is not the checked layout after the click`);
      await expectText(page, `${name}@${w.name}`, '3000 USD MRR');
      await shot(page, name, w);
    }
  }, { name: 'timeline-board' });

  // No objectives but tasks exist.
  for (const f of ['mrr', 'retention', 'social', 'pilot']) writeObjective(f, { title: f, status: 'done' });
  await app.look(ROADMAP, async (page, w) => {
    await goRoadmap(page);
    await seg(page, 'Objectives').click();
    await expectText(page, `no-objectives@${w.name}`, 'No objectives yet');
    await shot(page, 'state-no-objectives', w);
    await seg(page, 'Tasks').click();
    await expectText(page, `no-objectives@${w.name}`, 'Unlinked');
  }, { name: 'no-objectives' });
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
process.exit(await app.finish());
