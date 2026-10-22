#!/usr/bin/env node
/**
 * AI Team as a tree — seed a scratch vault through the REAL CLI, then screenshot the page.
 *
 *   npx tsup && node scripts/verify/ai-team-tree.mjs seed <scratchDir>
 *       Fake HOME + a project with 12 fictional teammates, placed with
 *       `agents edit --reports-to/--team`, a few routines (one paused), one teammate edited by
 *       hand so it waits for approval. Prints `agents list --tree`.
 *   node scripts/verify/ai-team-tree.mjs shots <base-url> <vault> [outDir]
 *       For light and dark at 1440x900: (A) the roster in Tree view with a teammate open and
 *       its Profile's "Place in team", a lead folded; (B) the Org chart with the Team tab.
 *       At 390x844: the Tree list, and the Org chart. Console errors fail the run.
 *
 * Every name here is fictional (pattern: synthetic fixtures for published artifacts).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const [mode, ...rest] = process.argv.slice(2);

const TEAM = [
  ['operasyon-sefi', 'Operasyon Şefi', 'Ekibin işini dağıtır, haftalık durumu toplar.', null, 'Operasyon'],
  ['buyume-analisti', 'Büyüme Analisti', 'Kayıt, aktivasyon ve gelir metriklerini izler.', 'operasyon-sefi', 'Büyüme'],
  ['reklam-izleyici', 'Reklam İzleyici', "Meta ve TikTok reklam setlerinin harcamasını ve CPA'sını günlük izler.", 'buyume-analisti', null],
  ['magaza-yorumcusu', 'Mağaza Yorumcusu', 'App Store ve Play yorumlarını okur, hataları ayırır.', 'buyume-analisti', null],
  ['icerik-editoru', 'İçerik Editörü', 'Blog ve bülten taslaklarını yönetir.', 'operasyon-sefi', 'İçerik'],
  ['bulten-yazari', 'Bülten Yazarı', 'Haftalık bülteni yazar.', 'icerik-editoru', null],
  ['sosyal-taslakci', 'Sosyal Taslakçı', 'LinkedIn ve X taslakları hazırlar.', 'icerik-editoru', null],
  ['destek-ozeti', 'Destek Özeti', 'Destek kutusunu özetler.', 'operasyon-sefi', 'Destek'],
  ['hata-avcisi', 'Hata Avcısı', 'Crash ve hata loglarını tarar.', 'destek-ozeti', null],
  ['sabah-brifingi', 'Sabah Brifingi', 'Her sabah kısa bir brifing yazar.', 'operasyon-sefi', null],
  ['arastirmaci', 'Araştırmacı', 'Kaynaklı derin araştırma yapar.', null, null],
  ['kod-gozcusu', 'Kod Gözcüsü', "Açık PR'ları risk için tarar.", null, null],
];
const ROUTINES = [
  ['gunluk-metrik', 'Günlük metrik turu', 'buyume-analisti', 'daily', '08:30'],
  ['reklam-turu', 'Reklam turu', 'reklam-izleyici', 'daily', '10:00'],
  ['ogle-kontrolu', 'Öğle kontrolü', 'reklam-izleyici', 'mon-fri', '13:00'],
  ['yorum-turu', 'Yorum turu', 'magaza-yorumcusu', 'mon,thu', '11:00'],
  ['bulten-taslagi', 'Bülten taslağı', 'bulten-yazari', 'fri', '09:00'],
  ['destek-turu', 'Destek turu', 'destek-ozeti', 'daily', '17:00'],
  ['sabah-turu', 'Sabah turu', 'sabah-brifingi', 'mon-fri', '08:00'],
];

if (mode === 'seed') {
  const dir = resolve(rest[0] ?? join(tmpdir(), 'dc-verify-ai-team-tree'));
  const home = join(dir, 'home');
  const proj = join(dir, 'proj');
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  mkdirSync(join(proj, '_dream_context', 'state'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: proj });
  // A Claude session's env would make the CLI refuse owner steps; the seed acts as the owner.
  const env = { ...process.env, HOME: home };
  for (const k of ['CLAUDECODE', 'DREAMCONTEXT_AGENT_SELF', 'DREAMCONTEXT_AUTOMATION_RUN']) delete env[k];
  // The built CLI (`npx tsup` first): the same binary a user runs.
  const cli = (...args) => execFileSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args], { cwd: proj, env, encoding: 'utf8' });
  cli('vaults', 'add', 'proj', proj);
  for (const [slug, title, prompt] of TEAM) cli('agents', 'create', slug, '--title', title, '--prompt', prompt);
  for (const [slug, , , reportsTo, team] of TEAM) {
    const args = [];
    if (reportsTo) args.push('--reports-to', reportsTo);
    if (team) args.push('--team', team);
    if (args.length) cli('agents', 'edit', slug, ...args);
  }
  for (const [slug, title, agent, days, at] of ROUTINES) {
    cli('automations', 'create', slug, '--title', title, '--agent', agent, '--job', `${title}: işini yap.`, '--days', days, '--at', at);
  }
  cli('automations', 'disable', 'bulten-taslagi');
  // Edited by hand, outside every write surface: its hash moves, so it waits for approval.
  const file = join(proj, '_dream_context', 'agents', 'hata-avcisi.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('Crash ve hata loglarını tarar.', 'Crash ve hata loglarını tarar, tekrarlayanları gruplar.'));
  // The refusals the CLI must make, said here so the seed log is evidence too.
  for (const bad of [['operasyon-sefi', 'reklam-izleyici'], ['arastirmaci', 'arastirmaci'], ['arastirmaci', 'yok-boyle-biri']]) {
    try {
      cli('agents', 'edit', bad[0], '--reports-to', bad[1]);
      console.log(`UNEXPECTED: ${bad[0]} -> ${bad[1]} accepted`);
      process.exitCode = 1;
    } catch (err) {
      console.log(`refused ${bad[0]} -> ${bad[1]}: ${String(err.stderr ?? err.stdout ?? err.message).trim().split('\n').pop()}`);
    }
  }
  console.log(cli('agents', 'list', '--tree'));
  console.log(`HOME=${home}\nPROJ=${proj}`);
} else if (mode === 'shots') {
  await shots(...rest);
} else {
  console.error('usage: ai-team-tree.mjs seed <scratchDir> | shots <base-url> <vault> [outDir]');
  process.exit(2);
}

async function shots(base, vault, outArg) {
  const { chromium } = await import('playwright');
  const { dispatcherState, mockDispatcher, setTheme } = await import('./lib/measure.mjs');
  if (!base || !vault) {
    console.error('usage: ai-team-tree.mjs shots <base-url> <vault> [outDir]');
    process.exit(2);
  }
  const OUT = outArg ?? join(REPO, 'tmp', 'verify-shots', 'ai-team-tree');
  mkdirSync(OUT, { recursive: true });
  const errors = [];
  const taken = [];

  const open = async (browser, theme, width, height) => {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 2 });
    await setTheme(context, theme);
    await context.addInitScript(() => { try { localStorage.setItem('dreamcontext.announcements.seen', '9999'); } catch { /* private */ } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${theme}/${width} pageerror: ${e}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${theme}/${width} console: ${m.text()}`); });
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`${theme}/${width} ${r.status()} ${r.request().method()} ${r.url()}`); });
    await mockDispatcher(page, dispatcherState());
    await page.goto(`${base}/?vault=${encodeURIComponent(vault)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    for (let i = 0; i < 4 && (await page.locator('.announcements-modal-scrim').count()); i++) {
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    }
    if (width < 760) {
      const menu = page.locator('.phone-bar button').first();
      if (await menu.count()) { await menu.click(); await page.waitForTimeout(400); }
    }
    await page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^AI Team$/ }) }).first().click();
    await page.locator('.aiteam').waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500);
    return { context, page };
  };
  const shot = async (page, name) => {
    await page.waitForTimeout(600);
    const path = join(OUT, `${name}.png`);
    await page.screenshot({ path });
    taken.push(path);
  };
  const hasOrg = async (page) => (await page.locator('[data-page-view="org"]').count()) > 0;

  const browser = await chromium.launch();
  try {
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(browser, theme, 1440, 900);
      // A: the tree, a teammate three levels down open, its Profile.
      await page.locator('[data-roster-view="tree"]').click();
      await page.locator('[data-tree-row="reklam-izleyici"] [data-team-row]').click();
      await page.locator('.aiteam-iconbtn[aria-label]').last().click();
      await page.locator('[data-section="place"]').waitFor({ timeout: 10000 });
      await page.locator('[data-tree-row="icerik-editoru"] .aiteam-caret').click();
      await page.locator('[data-tree-row="destek-ozeti"] .aiteam-caret').click();
      await shot(page, `A-1440-${theme}-tree-profile`);
      // B: the org chart, a lead selected, the Team tab.
      if (await hasOrg(page)) {
        await page.locator('[data-page-view="org"]').click();
        await page.locator('[data-org-card="buyume-analisti"]').click();
        await page.locator('[data-panel-tab="team"]').waitFor({ timeout: 10000 });
        await shot(page, `B-1440-${theme}-org-team`);
        await page.locator('[data-page-view="conversations"]').click();
      }
      await context.close();

      const phone = await open(browser, theme, 390, 844);
      await phone.page.locator('[data-roster-view="tree"]').click();
      await shot(phone.page, `A-390-${theme}-tree`);
      if (await hasOrg(phone.page)) {
        await phone.page.locator('[data-page-view="org"]').click();
        await shot(phone.page, `B-390-${theme}-org`);
        await phone.page.locator('[data-org-card="operasyon-sefi"]').click();
        await phone.page.locator('[data-panel-tab="team"]').waitFor({ timeout: 10000 });
        await shot(phone.page, `B-390-${theme}-team-panel`);
      }
      await phone.context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(taken.join('\n'));
  if (errors.length) {
    console.error(`\n${errors.length} error(s):\n${errors.join('\n')}`);
    process.exit(1);
  }
  console.log('\nconsole clean');
}
