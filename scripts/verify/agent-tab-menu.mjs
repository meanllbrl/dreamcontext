#!/usr/bin/env node
/**
 * Agent tab RIGHT-CLICK MENU runtime proof.
 *
 *   npm run build && node scripts/verify/agent-tab-menu.mjs
 *
 * WHAT IT PROVES (real server, real bundle, real Chromium — no mocks):
 *   T1  right-clicking a tab opens `.agent-tab-menu`, and it is a direct child of <body> —
 *       the portal is not cosmetic: `.agent-pane-tabbar` is an overflow scroller and
 *       `.agent-surface` sets `contain: layout paint`, so a menu left in place would be
 *       clipped by the strip and positioned against the surface instead of the viewport
 *   T2  the menu names the tab it was raised on, and is fully inside the viewport even when
 *       the click lands at the tab's right edge
 *   T3  "Rename" opens the inline editor ON THAT TAB, seeded with its current title; typing
 *       + Enter renames the tab in the strip AND lands in the persisted roster on disk
 *   T4  the "Auto-rename tabs" switch reflects the PERSISTED preference (off out of the box)
 *       and flipping it writes `autoTitle: true` into ~/.dreamcontext/agent-ui.json — the
 *       very file Settings → Agents reads and writes, which is the whole claim of the
 *       feature. The menu stays open and the switch shows its on state.
 *   T5  a Settings page mounted UNDER the overlay picks the change up live — its checkbox is
 *       checked without a reload (the AGENT_SETTINGS_EVENT listener; without it the page
 *       would also spread its stale snapshot back over the change on its next write)
 *   T6  Escape closes the MENU and leaves the surface expanded; a second Escape then
 *       collapses the surface (the arbitration `.agent-tab-menu` guard added to
 *       AgentSurface's Esc handler — a window-level listener that fires first)
 *   T7  a click outside the menu dismisses it
 *
 * WHAT IT DELIBERATELY DOES NOT COVER — and why that is not silence:
 *   The tabs here are DORMANT restores (roster entries with no pinned conversation), so no
 *   `claude` process and no PTY is ever spawned. That is what makes the run hermetic, and it
 *   means this file says nothing about auto-titling actually NAMING a tab — that needs a live
 *   Haiku call against a real transcript. What is proven is that the switch reads and writes
 *   the same persisted preference the Settings checkbox does.
 *
 * FAILURE POLICY — collect, don't fail fast: every check reports, then the process exits
 * non-zero if any failed, so one broken assumption doesn't hide the rest.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = process.env.PORT || '4793';
const URL = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

// Isolated scratch HOME: the agent-settings blob this test WRITES is app-global
// (~/.dreamcontext/agent-ui.json), so running against the real HOME would flip the user's
// own "auto-name tabs" preference.
const home = mkdtempSync(join(tmpdir(), 'dc-tabmenu-'));
const vaultDir = join(home, 'scratch-a');
mkdirSync(join(vaultDir, '_dream_context', 'state'), { recursive: true });
writeFileSync(join(vaultDir, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [] }, null, 2));
mkdirSync(join(home, '.dreamcontext'), { recursive: true });
writeFileSync(join(home, '.dreamcontext', 'vaults.json'),
  JSON.stringify({ version: 1, vaults: [{ name: 'scratch-a', path: vaultDir }] }, null, 2));

// Two saved tabs, deliberately WITHOUT `sessionId`: a roster entry with a pinned
// conversation auto-resumes a real `claude` on hydrate, which this test neither needs nor
// wants. Without one they restore as dormant, named tabs — exactly the surface the menu acts
// on, and no child process anywhere.
const rosterPath = join(vaultDir, '_dream_context', 'state', '.agent-sessions.json');
const TAB_A = 'Chat 1';
const TAB_B = 'Parser refactor';
writeFileSync(rosterPath, JSON.stringify({
  sessions: [
    { title: TAB_A, bypass: false, minimized: false, size: 1, kind: 'chat' },
    { title: TAB_B, bypass: false, minimized: false, size: 1, kind: 'chat' },
  ],
}, null, 2));

const agentUiPath = join(home, '.dreamcontext', 'agent-ui.json');
const readAgentUi = () => {
  try { return existsSync(agentUiPath) ? JSON.parse(readFileSync(agentUiPath, 'utf8')) : null; }
  catch { return null; }
};

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

    // The whole surface is gated on the machine's real capabilities. If neither node-pty nor
    // the claude CLI is present the tab strip never renders at all — report that as an
    // UNPROVEN precondition rather than letting every check below fail with "no tab found".
    const caps = await fetch(`${URL}/api/agent/capabilities`).then((r) => r.json()).catch(() => null);
    const surfaceAvailable = !!caps?.desktop && (!!caps?.embeddedTerminal || !!caps?.claudeCli);
    check('precondition: the agent surface can render on this machine', surfaceAvailable,
      `caps=${JSON.stringify(caps)}`);

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${URL}/?vault=scratch-a`, { waitUntil: 'domcontentloaded' });

    // A never-seen vault raises the "what's new" modal, whose scrim swallows every click.
    const scrim = page.locator('.announcements-modal-scrim');
    await scrim.first().waitFor({ state: 'attached', timeout: 12000 }).catch(() => {});
    for (let i = 0; i < 4 && await scrim.count(); i += 1) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    // Land on Settings → Agents FIRST and leave it mounted under the overlay. T5 is only a
    // real check if the page was already on screen when the menu wrote the preference — a
    // page mounted afterwards would read the new value from the server and pass for the
    // wrong reason.
    await page.locator('.sidebar-item', { hasText: /^Settings$/ }).first().click();
    await page.waitForSelector('.settings-nav', { timeout: 15000 });
    await page.locator('.settings-nav-item', { hasText: /^Agents/ }).first().click();
    await page.waitForSelector('.settings-checkbox-label', { timeout: 15000 });
    const autoTitleBox = page.locator('.settings-checkbox-label', { hasText: /Auto-name tabs/ })
      .locator('input.settings-checkbox');
    const boxBefore = await autoTitleBox.isChecked().catch(() => null);

    /* Open the overlay the way the corner actually offers it. With saved sessions the
       collapsed entry point is the DOCK (one chip per session), not the single "Agent" FAB —
       the FAB only renders at zero sessions, which a restored roster never is. */
    const openOverlay = async () => {
      await page.locator('.agent-dock-chip').first().click({ timeout: 20000 });
      await page.waitForSelector('.agent-surface.expanded', { timeout: 15000 }).catch(() => {});
    };
    await openOverlay();
    await page.waitForSelector('.agent-tab', { timeout: 15000 }).catch(() => {});
    const tabTitles = await page.locator('.agent-tab-title').allTextContents();
    check('setup: both saved tabs restored into the strip',
      tabTitles.length === 2 && tabTitles[1] === TAB_B, `titles=${JSON.stringify(tabTitles)}`);

    const menu = page.locator('.agent-tab-menu');
    const secondTab = page.locator('.agent-tab').nth(1);

    // ── T1/T2 — the menu opens, portals to <body>, names its tab, and fits on screen ──
    // Driven through the locator rather than `mouse.click()` at a measured point: the overlay
    // expands with a 320ms scale animation, and a raw coordinate read while it is still
    // running lands somewhere that is no longer the tab. The locator waits for stability.
    await secondTab.click({ button: 'right' });
    await menu.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const opened = await menu.count();
    const parentIsBody = opened
      ? await menu.evaluate((el) => el.parentElement === document.body) : false;
    check('T1 right-click opens the tab menu, portaled to <body>',
      opened === 1 && parentIsBody, `count=${opened} parentIsBody=${parentIsBody}`);

    const headText = opened ? (await menu.locator('.agent-tab-menu-head').textContent()) : '';
    const fits = opened ? await menu.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
    }) : false;
    check('T2 the menu names the right-clicked tab and stays inside the viewport',
      headText?.trim() === TAB_B && fits, `head=${JSON.stringify(headText)} fits=${fits}`);

    // `SHOT=<path> node scripts/verify/agent-tab-menu.mjs` also writes what the menu looks
    // like — a check can only ever say the markup is right, never that it reads well.
    if (process.env.SHOT && opened) {
      await page.screenshot({ path: process.env.SHOT });
      console.log(`      shot: ${process.env.SHOT}`);
    }

    // ── T4 — the switch mirrors the persisted preference, and flipping it persists ──────
    // Done BEFORE the rename because renaming closes the menu.
    const switchOffAtRest = opened
      ? await menu.locator('.agent-tab-menu-switch').evaluate((el) => el.getAttribute('data-on')) : 'unread';
    await menu.locator('[role="menuitemcheckbox"]').click();
    await page.waitForTimeout(900); // the write is fire-and-forget to the server
    const uiAfter = readAgentUi();
    const stillOpen = await menu.count();
    const switchOn = stillOpen
      ? await menu.locator('.agent-tab-menu-switch').evaluate((el) => el.getAttribute('data-on')) : null;
    const ariaOn = stillOpen
      ? await menu.locator('[role="menuitemcheckbox"]').getAttribute('aria-checked') : null;
    if (process.env.SHOT && stillOpen) {
      await page.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-on.png') });
    }
    check('T4 the auto-rename switch reads OFF at rest and persists ON to agent-ui.json',
      switchOffAtRest === null && uiAfter?.autoTitle === true
        && stillOpen === 1 && switchOn === 'true' && ariaOn === 'true',
      `atRest=${switchOffAtRest} file=${JSON.stringify(uiAfter)} menuOpen=${stillOpen} switch=${switchOn} aria=${ariaOn}`);

    // ── T6 — Escape closes the MENU, not the surface ───────────────────────────────────
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const menuGoneOnEsc = (await menu.count()) === 0;
    const surfaceStillUp = (await page.locator('.agent-surface.expanded').count()) === 1;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const surfaceCollapsed = (await page.locator('.agent-surface.expanded').count()) === 0;
    check('T6 Escape closes the menu and spares the surface; a second Escape collapses it',
      menuGoneOnEsc && surfaceStillUp && surfaceCollapsed,
      `menuGone=${menuGoneOnEsc} surfaceUpAfter1st=${surfaceStillUp} collapsedAfter2nd=${surfaceCollapsed}`);

    // ── T5 — the Settings checkbox under the overlay picked the change up LIVE ─────────
    const boxAfter = await autoTitleBox.isChecked().catch(() => null);
    check('T5 the mounted Settings page reflects the menu\'s change without a reload',
      boxBefore === false && boxAfter === true, `before=${boxBefore} after=${boxAfter}`);

    // ── T3 — Rename, end to end, down to the roster on disk ────────────────────────────
    await openOverlay();
    await page.locator('.agent-tab').nth(1).click({ button: 'right' });
    await menu.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await menu.locator('[role="menuitem"]', { hasText: 'Rename' }).click();
    const editor = page.locator('.agent-tab-rename');
    await editor.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const seeded = await editor.inputValue().catch(() => '');
    // The editor must belong to the tab the menu named — with two tabs on screen, an
    // off-by-one here is exactly the bug worth catching.
    const editorOnRightTab = await editor.evaluate(
      (el, first) => el.closest('.agent-tab')?.previousElementSibling?.textContent?.includes(first) === true,
      TAB_A,
    ).catch(() => false);
    const RENAMED = 'Renamed from the menu';
    await editor.fill(RENAMED);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500); // the roster PUT is debounced
    const titlesAfter = await page.locator('.agent-tab-title').allTextContents();
    let roster = null;
    try { roster = JSON.parse(readFileSync(rosterPath, 'utf8')); } catch { /* reported below */ }
    const persisted = roster?.sessions?.some?.((s) => s.title === RENAMED);
    check('T3 Rename edits the right tab, seeded with its title, and persists to the roster',
      seeded === TAB_B && editorOnRightTab && titlesAfter.includes(RENAMED) && persisted === true,
      `seeded=${JSON.stringify(seeded)} rightTab=${editorOnRightTab} strip=${JSON.stringify(titlesAfter)} persisted=${persisted}`);

    // ── T7 — an outside click dismisses it ─────────────────────────────────────────────
    await page.locator('.agent-tab').nth(0).click({ button: 'right' });
    await menu.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const openedAgain = await menu.count();
    await page.mouse.click(640, 600);
    await page.waitForTimeout(300);
    check('T7 an outside click dismisses the menu',
      openedAgain === 1 && (await menu.count()) === 0, `opened=${openedAgain}`);

    // ── T8 — the clamp, actually exercised ─────────────────────────────────────────────
    // T2's "fits" is true for free in a 1280×800 window: the menu is 232px wide and the tab
    // is nowhere near an edge, so nothing is being clamped. Shrink the window until the tab
    // sits close to BOTH edges and the placement has to do real work — pushed left by the
    // width clamp and flipped above the pointer by the height one.
    await page.setViewportSize({ width: 520, height: 300 });
    await page.waitForTimeout(400);
    await page.locator('.agent-tab').nth(0).click({ button: 'right' });
    await menu.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const tight = await menu.count()
      ? await menu.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { fits: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight, r: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
      })
      : { fits: false, r: null };
    check('T8 the menu clamps into a window barely bigger than itself',
      tight.fits === true, `rect=${JSON.stringify(tight.r)} viewport=520x300`);
    await page.setViewportSize({ width: 1280, height: 800 });
  }
} catch (err) {
  check('harness completed without throwing', false, err instanceof Error ? err.stack : String(err));
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log(`scratch HOME kept for inspection: ${home}`);
  process.exit(1);
}
