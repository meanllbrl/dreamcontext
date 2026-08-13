#!/usr/bin/env node
/**
 * Project-tabs runtime smoke — the FIRST STAGE of the goal's B checklist.
 *
 *   npm run build && node scripts/verify/project-tabs.mjs
 *
 * WHAT IT PROVES (real server, real bundle, real Chromium — no mocks):
 *   S1  the vault window boots and mounts exactly ONE ProjectInstance for `?vault=`
 *   S2  the chip strip renders exactly one chip, carrying that project's name
 *   S3  the instance wrapper is NOT hidden and NOT inert while it is the only chip
 *   S4  `.project-instance[hidden]` genuinely computes to `display: none` — the rule the
 *       whole hiding contract rests on (a `hidden` attribute alone loses to any author
 *       `display` rule, which would render every instance on top of the others)
 *   S5  no chip list is persisted: a reload comes back with exactly one chip (checklist B9)
 *   S6  every `/api/` call the boot actually makes SUCCEEDS. This one exists because of a
 *       real miss: the suite once reported all green on a page whose every request was
 *       failing 400, because "it rendered" and "it works" are not the same claim. A vault
 *       name the server does not know is answered with 400 on every route, and the shell
 *       still paints. Rendering is not evidence that the vault plumbing is connected.
 *   M1  two registered vaults open as two chips, with BOTH instances mounted at once
 *   M2  exactly one instance is visible; the other is hidden AND inert AND display:none
 *   M3  switching chips HIDES the old instance — its `data-instance` is unchanged, i.e. it
 *       was not remounted (the structural half of the red line: a remount is a killed PTY)
 *   M4  re-opening an already-open project focuses its chip instead of minting a second
 *       instance against the same vault (checklist B6, in-window half)
 *   M5  ⌃Tab moves to the next chip and ⌃⇧Tab back to the previous one, by real keystroke,
 *       without remounting either instance
 *
 * WHAT IT DELIBERATELY DOES NOT COVER — and why it is not silence:
 *   Anything that needs a REAL agent: a chat that keeps streaming across a switch (B2), a
 *   chip that bounces when a background chat asks (B3), a terminal's cols/rows after five
 *   switches (B4/M-x1), one PTY per session under StrictMode (M-x2), teardown at the
 *   six-instance ceiling (B7). Those need the Claude CLI and a live PTY, not a headless
 *   Chromium. They are reported as UNPROVEN by whoever invokes this — never folded into a
 *   pass, and never restated as if the structural check above had covered them.
 *
 * FAILURE POLICY — collect, don't fail fast: every check reports, then the process exits
 * non-zero if any failed, so one broken assumption doesn't hide the rest.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = process.env.PORT || '4791';
const URL = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

// Isolated scratch HOME so nothing touches the user's real vault registry. TWO vaults are
// registered, because one is the shape that hides every bug this feature could have: with a
// single project there is nothing to leak into, nothing to switch between, and nothing to
// duplicate.
const home = mkdtempSync(join(tmpdir(), 'dc-tabs-'));
const seedVault = (name) => {
  const dir = join(home, name);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(dir, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [] }, null, 2));
  return { name, path: dir };
};
const vaults = [seedVault('scratch-a'), seedVault('scratch-b')];
mkdirSync(join(home, '.dreamcontext'), { recursive: true });
writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ version: 1, vaults }, null, 2));

const server = spawn(process.execPath, ['dist/index.js', 'dashboard', '--no-open', '--port', PORT], {
  env: { ...process.env, HOME: home, DREAMCONTEXT_DESKTOP: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${URL}/api/health`); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

let browser;
try {
  if (!(await waitForServer())) {
    check('server boots', false, `no /api/health after 30s. log tail: ${serverLog.slice(-400)}`);
  } else {
    check('server boots', true, `${URL}/api/health`);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    // S6 — watch every `/api/` response for the whole run, both loads.
    // 404 is EXCLUDED from the failure set on purpose: several hooks are written to tolerate a
    // route an older backend does not serve, so a 404 is a designed answer here. 400 (the vault
    // the server cannot resolve), 401/403 and any 5xx are not — they mean the request reached
    // the server carrying something wrong, which is precisely the class this check exists for.
    const apiFailures = [];
    page.on('response', (res) => {
      const u = res.url();
      if (!u.includes('/api/')) return;
      const s = res.status();
      if (s >= 400 && s !== 404) apiFailures.push(`${s} ${u.replace(URL, '')}`);
    });

    await page.goto(`${URL}/?vault=scratch-a`, { waitUntil: 'domcontentloaded' });

    // S1 — exactly one instance mounts
    await page.waitForSelector('.project-instance', { timeout: 20000 }).catch(() => {});
    const instances = await page.locator('.project-instance').count();
    check('S1 exactly one ProjectInstance mounts', instances === 1, `found ${instances}`);

    // S2 — the chip strip renders one chip naming the project
    // EXACT class only — `[class*="project-tab"]` also matches project-tab-name/-dot/-badge,
    // i.e. one chip's own children, and would count a single chip eight times.
    const chipText = await page.locator('.project-tab').allTextContents().catch(() => []);
    check('S2 chip strip renders one chip for the project',
      chipText.length === 1 && chipText[0].includes('scratch-a'),
      `chips=${JSON.stringify(chipText)}`);

    // S3 — the only chip's instance is visible and interactive
    const state = await page.locator('.project-instance').first()
      .evaluate((el) => ({ hidden: el.hasAttribute('hidden'), inert: el.hasAttribute('inert') }));
    check('S3 the sole instance is not hidden and not inert',
      state.hidden === false && state.inert === false, JSON.stringify(state));

    // S4 — the hiding contract actually computes to display:none
    const displayWhenHidden = await page.evaluate(() => {
      const el = document.querySelector('.project-instance');
      if (!el) return 'no-instance';
      el.setAttribute('hidden', '');
      const d = getComputedStyle(el).display;
      el.removeAttribute('hidden');
      return d;
    });
    check('S4 .project-instance[hidden] computes to display:none',
      displayWhenHidden === 'none', `computed display = ${displayWhenHidden}`);

    // S7 — a never-seen vault raises the "what's new" modal over the chrome, and its scrim
    // swallows every click at the window level. Escape must dismiss it: that is the overlay
    // stack answering for the ACTIVE instance, driven end to end rather than unit-tested.
    // Checked HERE, before the reload, because the reload marks the announcement read and
    // there would be nothing left to dismiss — a check that passes by finding nothing to do
    // is the same green-for-no-reason this file added S6 to stop reporting.
    // The modal is raised by an API round trip, so it can land AFTER the checks above have
    // run. Sampling `count()` the instant we get here read that lateness as "no modal" — and
    // then the scrim would arrive on its own schedule and swallow the `+` click that opens the
    // second project, failing M1 with a message about chips. WAIT for it, bounded: an
    // announcement that never comes is still a failure (the point of the check), it is just no
    // longer a failure the harness manufactures by looking too early.
    const scrim = page.locator('.announcements-modal-scrim');
    await scrim.first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    const hadModal = await scrim.count();
    if (hadModal) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
    }
    check('S7 Escape dismisses the front-most overlay in the active project',
      hadModal > 0 && (await scrim.count()) === 0,
      hadModal ? `dismissed; scrims left: ${await scrim.count()}`
        : 'NO MODAL APPEARED — nothing was exercised, so this is not evidence');

    // S5 — no tab persistence (checklist B9)
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.project-instance', { timeout: 20000 }).catch(() => {});
    const afterReload = await page.locator('.project-instance').count();
    check('S5 a reload comes back with exactly one project (no tab persistence)',
      afterReload === 1, `found ${afterReload}`);

    // ─── TWO PROJECTS IN ONE WINDOW ───────────────────────────────────────────────
    // Everything above holds with a single chip, which is exactly the configuration that
    // cannot catch a cross-project bug. From here on there are two.

    const chipNames = () => page.locator('.project-tab-name').allTextContents();
    const activeChip = () => page.locator(".project-tab[data-active='true'] .project-tab-name").first().textContent();
    /** The mount identity of each instance — a REMOUNT changes it, a hide does not. */
    const instanceIds = () => page.locator('.project-instance').evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-instance')));

    /** Every fresh vault raises its own "what's new" modal, including the second one — and it
     *  arrives on the network's schedule, so give it a bounded chance to show up before
     *  concluding there is nothing to dismiss. A scrim missed here is not a quiet skip: it
     *  reappears later as a click that mysteriously times out against a chip. */
    const clearScrims = async () => {
      await scrim.first().waitFor({ state: 'attached', timeout: 6000 }).catch(() => {});
      for (let i = 0; i < 4 && await scrim.count(); i += 1) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      }
    };
    /** The switcher lists a "Launcher" home row FIRST, so `.psw-row` first is not the vault. */
    const pickProject = async (name) => {
      await page.locator('.project-tabs-add').click();
      await page.waitForSelector('.psw-input', { timeout: 10000 });
      await page.locator('.psw-input').fill(name);
      await page.locator('.psw-row')
        .filter({ has: page.locator('.psw-row-name', { hasText: new RegExp(`^${name}$`) }) })
        .first().click();
    };

    const openSecond = async () => {
      await pickProject('scratch-b');
      await page.waitForFunction(() => document.querySelectorAll('.project-tab').length === 2, null, { timeout: 15000 });
      await clearScrims();
    };
    await openSecond().catch((e) => check('M1 the + button opens a second project', false, String(e.message ?? e)));

    // M1 — both projects are chips, and BOTH are mounted. Two chips with one instance would
    // mean the strip is a router, not a holder of live projects.
    const names = await chipNames();
    const ids = await instanceIds();
    check('M1 two projects are open as two chips, both instances mounted',
      names.length === 2 && names.includes('scratch-a') && names.includes('scratch-b') && ids.length === 2,
      `chips=${JSON.stringify(names)} instances=${ids.length}`);

    // M2 — exactly one is visible; the other is hidden AND inert. Inert matters on its own:
    // a merely-invisible instance still takes focus and still answers the keyboard.
    const visibility = await page.locator('.project-instance').evaluateAll((els) => els.map((e) => ({
      hidden: e.hasAttribute('hidden'), inert: e.hasAttribute('inert'),
      display: getComputedStyle(e).display,
    })));
    const shown = visibility.filter((v) => !v.hidden);
    check('M2 exactly one instance is visible, the other hidden + inert + display:none',
      shown.length === 1 && visibility.filter((v) => v.hidden).every((v) => v.inert && v.display === 'none'),
      JSON.stringify(visibility));

    // M3 — THE RED LINE, structurally: switching chips must HIDE, never remount. A changed
    // `data-instance` is a torn-down instance, which is a killed PTY and a dropped socket
    // mid-conversation. This is the automatable half of B2/B4; the streaming half still needs
    // a real agent and is not claimed here.
    const before = await instanceIds();
    const other = (await activeChip())?.trim() === 'scratch-a' ? 'scratch-b' : 'scratch-a';
    await page.locator('.project-tab-main', { hasText: other }).first().click();
    await page.waitForTimeout(400);
    const afterSwitch = await instanceIds();
    const nowActive = (await activeChip())?.trim();
    check('M3 switching chips hides the old instance rather than remounting it',
      nowActive === other && JSON.stringify(before) === JSON.stringify(afterSwitch),
      `active=${nowActive} ids ${JSON.stringify(before)} -> ${JSON.stringify(afterSwitch)}`);

    // M4 — the same project can never be open twice (checklist B6, in-window half). Picking a
    // project that already has a chip must FOCUS it, not mint a second instance against the
    // same vault — two writers on one project's session roster is the failure being blocked.
    await pickProject('scratch-a');
    await page.waitForTimeout(700);
    await clearScrims();
    const dupNames = await chipNames();
    const dupIds = await instanceIds();
    check('M4 re-opening an already-open project focuses its chip instead of duplicating it',
      dupNames.length === 2 && dupIds.length === 2 && (await activeChip())?.trim() === 'scratch-a',
      `chips=${JSON.stringify(dupNames)} instances=${dupIds.length}`);

    // M5 — ⌃Tab walks the strip forward, ⌃⇧Tab back, and neither REMOUNTS anything. Driven
    // as a real keystroke rather than asserted on the handler, because the whole risk of this
    // shortcut is where it is listening: the chrome captures it above every mounted instance,
    // and a listener registered one level too low would be dead the moment focus sat inside a
    // project. The instance-id half is M3's red line again — a switch by key must hide, not
    // tear down, or ⌃Tab through six projects would kill six PTYs.
    const beforeCycle = await instanceIds();
    const cycleStart = (await activeChip())?.trim();
    await page.keyboard.press('Control+Tab');
    await page.waitForTimeout(400);
    const afterForward = (await activeChip())?.trim();
    await page.keyboard.press('Control+Shift+Tab');
    await page.waitForTimeout(400);
    const afterBack = (await activeChip())?.trim();
    check('M5 ⌃Tab / ⌃⇧Tab cycle the chip strip without remounting an instance',
      afterForward !== undefined && afterForward !== cycleStart && afterBack === cycleStart
        && JSON.stringify(beforeCycle) === JSON.stringify(await instanceIds()),
      `${cycleStart} -⌃Tab-> ${afterForward} -⌃⇧Tab-> ${afterBack}; ids ${JSON.stringify(beforeCycle)} -> ${JSON.stringify(await instanceIds())}`);

    // S6 — judged LAST, so it covers every request both projects made: the boot, the reload,
    // the second project's whole page load and both switches. A wrong vault reaching the
    // server shows up here as 400 and nowhere else — the UI paints either way.
    await page.waitForTimeout(1500);
    check('S6 no /api/ request failed across both projects (400/401/403/5xx)',
      apiFailures.length === 0,
      apiFailures.length ? `${apiFailures.length} failures: ${apiFailures.slice(0, 6).join(' | ')}`
        : 'every /api/ response 2xx/3xx (404 tolerated)');
  }
} catch (err) {
  check('harness ran to completion', false, String(err && err.message ? err.message : err));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill('SIGTERM');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(', ')); process.exit(1); }
