#!/usr/bin/env node
/**
 * /verify for the one GitHub connection (task task-sync-to-github-fails-with-401-…, plan
 * github-baglanti r4, criteria 4, 8, 9): Settings → GitHub, the Team sync and Task mirroring
 * status lines, a dead project token healed onto the sign-in, the one-click reconnect, and the
 * browser-served "managed in the app" state.
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/github-baglanti.mjs
 *
 * Scratch HOME and vault (lib/app.mjs) with a FAKE sign-in: nothing reaches GitHub. The device
 * flow's two routes and github.com are stubbed in the browser, so Reconnect shows its code and
 * the approval flips the chip without a real account. The dead-token heal is the state the
 * session writes after a sign-in retry worked (unit-tested in github-credential.test.ts): a
 * project token plus its `all` demotion marker. 1440 dark and light, the GitHub page also at 390.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const app = await openApp({ suite: 'github-baglanti' });
const { base, home, proj, shots, findings } = app;
const checks = [];
const ok = (name, v) => { checks.push({ name, ok: !!v }); if (!v) findings.push(`check failed: ${name}`); };

const globalSecrets = join(home, '.dreamcontext', '.secrets.json');
const projectSecrets = join(proj, '_dream_context', 'state', '.secrets.json');
const brainLocal = join(proj, '_dream_context', 'state', '.brain-local.json');
const signIn = (extra = {}) => writeFileSync(globalSecrets, JSON.stringify({ github: { token: 'gho_fake_verify_signin', login: 'verify-user', ...extra } }), { mode: 0o600 });
signIn();

// Task mirroring on GitHub Issues only for its own screenshot: with it on, the server tries the
// fake sign-in against GitHub, gets 401 and (correctly) raises the reconnect flag.
const cfgPath = join(proj, '_dream_context', 'state', '.config.json');
const backend = (b) => {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch { /* none yet */ }
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, taskBackend: b, github: { owner: 'acme', repo: 'tasks' } }, null, 2));
};
backend('local');

const browser = await chromium.launch();
const W = (page, ms = 300) => page.waitForTimeout(ms);
// Expected in this harness: nothing real behind the fake token, so GitHub-reaching task routes may fail.
const EXPECTED = /\/api\/tasks\/(containers|sync-status|token-status|test)|\/api\/brain\/team|github\.com/;

async function openPage(width, height, theme, tag, { desktopOnly = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await context.addInitScript((th) => { try { localStorage.setItem('dreamcontext-theme', th); } catch { /* ignore */ } }, theme);
  await markAnnouncementsSeen(context, base);
  // Never reach GitHub: the device page the reconnect opens is answered here.
  await context.route('https://github.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>stub device page</p>' }));
  let polls = 0;
  await context.route('**/api/brain/auth/device/start', (r) => r.fulfill({ json: { sessionId: 'verify', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 1 } }));
  await context.route('**/api/brain/auth/device/poll', (r) => {
    polls += 1;
    if (polls < 2) return r.fulfill({ json: { status: 'pending' } });
    signIn(); // what the real authorized poll writes: a fresh token, no reconnect flag
    return r.fulfill({ json: { status: 'authorized', login: 'verify-user' } });
  });
  if (desktopOnly) {
    await context.route('**/api/brain/auth/status', (r) => r.fulfill({ status: 403, json: { error: 'desktop_only', kind: 'desktop_only', reconnect: false, message: 'GitHub sign-in is only available in the desktop app.' } }));
  }
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/\/@vite\/|favicon|403|desktop_only|Failed to load resource/.test(m.text())) findings.push(`${tag} console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => findings.push(`${tag} crash: ${String(e.message).slice(0, 200)}`));
  page.on('response', (r) => {
    if (r.status() < 400 || /\/@vite\/|favicon|\/ws\b/.test(r.url()) || EXPECTED.test(r.url())) return;
    if (desktopOnly && /\/api\/brain\/auth\/status/.test(r.url())) return;
    findings.push(`${tag} ${r.status()}: ${new URL(r.url()).pathname}`);
  });
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  const got = page.getByRole('button', { name: 'Got it' });
  if (await got.isVisible().catch(() => false)) { await got.click(); await W(page); }
  return { context, page };
}

async function openWindow(page) {
  const rail = page.getByTestId('ns-rail-settings');
  if (await rail.isVisible().catch(() => false)) await rail.click();
  else await page.goto(`${base}/?vault=proj&page=settings`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('settings-window').waitFor({ state: 'visible', timeout: 10_000 });
  await W(page, 400);
}
const go = async (page, id) => { await page.click(`[data-sw-nav="${id}"]`); await W(page, 500); };
const shot = async (page, name) => { await W(page, 250); await page.screenshot({ path: join(shots, `${name}.png`) }); };
const body = (page) => page.locator('.sw-body').first().innerText().catch(() => '');
const openAdvanced = async (page) => {
  const s = page.locator('summary', { hasText: 'Advanced: another account or a token' }).first();
  await s.click(); await W(page, 350);
  await page.locator('[data-row="gh-adv-project"]').first().scrollIntoViewIfNeeded().catch(() => {});
};
const overflow = (page) => page.evaluate(() => [document.documentElement, document.querySelector('.sw-body')].some((e) => e && e.scrollWidth - e.clientWidth > 1));

for (const theme of ['dark', 'light']) {
  // ── connected ──
  signIn();
  writeFileSync(projectSecrets, '{}');
  writeFileSync(brainLocal, '{}');
  {
    const { context, page } = await openPage(1440, 900, theme, `connected-${theme}`);
    await openWindow(page);
    const nav = await page.locator('[data-sw-nav]').evaluateAll((els) => els.map((e) => e.getAttribute('data-sw-nav')));
    ok(`${theme}: GitHub is first in Connections`, nav.indexOf('github') >= 0 && nav[nav.indexOf('github') + 1] === 'teamsync');
    await go(page, 'github');
    const b = await body(page);
    ok(`${theme}: account row names the login and Connected`, /verify-user/.test(b) && /Connected/.test(b));
    ok(`${theme}: the fixed list of what uses it`, ['Team sync', 'Task mirroring', 'Cloning in the launcher', 'App sharing'].every((x) => b.includes(x)));
    ok(`${theme}: Advanced is closed by default`, !(await page.locator('[data-row="gh-adv-project"]').first().isVisible().catch(() => false)));
    ok(`${theme}: no token asked for by default`, !/paste|fine-grained/i.test(b));
    ok(`${theme}: GitHub page fits 1440`, !(await overflow(page)));
    await shot(page, `github-page-connected-1440-${theme}`);
    await openAdvanced(page);
    ok(`${theme}: Advanced shows the project token state None`, /This project's own token[\s\S]*None/.test(await body(page)));
    await shot(page, `github-page-advanced-1440-${theme}`);
    await go(page, 'teamsync');
    ok(`${theme}: Team sync shows one status line`, /Connected as verify-user/.test(await body(page)) && (await page.locator('.sw-body .gh-login').count()) === 0);
    await shot(page, `teamsync-line-1440-${theme}`);
    backend('github');
    await go(page, 'general');
    await go(page, 'mirror');
    ok(`${theme}: Task mirroring row uses the sign-in, asks no token`, /Connected as verify-user/.test(await body(page)) && !(await page.locator('.sw-body input[type="password"]').count()));
    await shot(page, `mirror-line-1440-${theme}`);
    await context.close();
    backend('local');
  }
  // ── dead project token, healed onto the sign-in ──
  {
    signIn();
    const dead = 'github_pat_fake_verify_dead_project_token';
    writeFileSync(projectSecrets, JSON.stringify({ github: { token: dead } }), { mode: 0o600 });
    writeFileSync(brainLocal, JSON.stringify({ githubDemoted: { all: createHash('sha256').update(dead).digest('hex') } }));
    const { context, page } = await openPage(1440, 900, theme, `heal-${theme}`);
    await openWindow(page);
    await go(page, 'github');
    const b = await body(page);
    ok(`${theme}: heal says the project token stopped working and the sign-in took over`, /own token stopped working; it uses your sign-in now/.test(b));
    ok(`${theme}: heal is not an error to fix (still Connected, no Reconnect)`, /Connected/.test(b) && !/Reconnect GitHub/.test(b));
    await openAdvanced(page);
    ok(`${theme}: Advanced names the demoted state`, /Not working, switched to your sign-in/.test(await body(page)));
    await shot(page, `github-page-heal-1440-${theme}`);
    await context.close();
    writeFileSync(projectSecrets, '{}');
    writeFileSync(brainLocal, '{}');
  }
  // ── the sign-in rejected → one-click reconnect ──
  {
    signIn({ needsReconnect: true });
    const { context, page } = await openPage(1440, 900, theme, `reconnect-${theme}`);
    await openWindow(page);
    await go(page, 'teamsync');
    ok(`${theme}: Team sync line is red with Reconnect`, (await page.locator('.sw-body .gh-status--bad').count()) === 1 && /Reconnect GitHub/.test(await body(page)));
    await shot(page, `teamsync-expired-1440-${theme}`);
    await go(page, 'github');
    let b = await body(page);
    ok(`${theme}: GitHub page says Disconnected and every user Needs Reconnect`, /Disconnected/.test(b) && (b.match(/Needs Reconnect/g)?.length ?? 0) === 4);
    await shot(page, `github-page-expired-1440-${theme}`);
    const popup = context.waitForEvent('page', { timeout: 5_000 }).catch(() => null);
    await page.locator('[data-row="gh-account"] button', { hasText: 'Reconnect GitHub' }).first().click();
    await W(page, 400);
    b = await body(page);
    ok(`${theme}: one click shows the code, already copied`, /WDJB-MJHT/.test(b) && /Code copied/.test(b));
    ok(`${theme}: one click opened github.com/login/device`, !!(await popup));
    await shot(page, `github-page-reconnect-code-1440-${theme}`);
    await page.getByText('Connected', { exact: true }).first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    await W(page, 600);
    b = await body(page);
    ok(`${theme}: after approval the chip is Connected and nothing needs reconnect`, /Connected/.test(b) && !/Needs Reconnect|Disconnected/.test(b));
    await shot(page, `github-page-reconnected-1440-${theme}`);
    await context.close();
    signIn();
  }
  // ── browser-served dashboard: managed in the app, never "not connected" ──
  {
    const { context, page } = await openPage(1440, 900, theme, `inapp-${theme}`, { desktopOnly: true });
    await openWindow(page);
    await go(page, 'github');
    const b = await body(page);
    ok(`${theme}: browser says managed in the app, not "Not connected"`, /Managed in the app/.test(b) && /Open in the app/.test(b) && !/Not connected/.test(b));
    await shot(page, `github-page-inapp-1440-${theme}`);
    backend('github');
    await go(page, 'general');
    await go(page, 'mirror');
    ok(`${theme}: Task mirroring says managed in the app too`, /GitHub is managed in the app/.test(await body(page)));
    await shot(page, `mirror-inapp-1440-${theme}`);
    await context.close();
    backend('local');
    signIn();
  }
  // ── phone width ──
  {
    const { context, page } = await openPage(390, 844, theme, `phone-${theme}`);
    await openWindow(page);
    await go(page, 'github');
    ok(`${theme}: GitHub page fits 390`, !(await overflow(page)));
    await shot(page, `github-page-390-${theme}`);
    await openAdvanced(page);
    ok(`${theme}: Advanced fits 390`, !(await overflow(page)));
    await shot(page, `github-page-advanced-390-${theme}`);
    await context.close();
  }
}

await browser.close();
for (const c of checks) process.stdout.write(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}\n`);
process.stdout.write(`shots: ${shots}\n`);
process.exit(await app.finish());
