#!/usr/bin/env node
/**
 * Proof for the three requests (task uc-istek-…, 2026-11-03), in a real browser against a scratch
 * vault with a fake HOME (lib/app.mjs):
 *   1. right-click a project → Remove from app → Cancel keeps it → Remove drops it; folder stays.
 *   2. Settings → System → Optional tools, Codex installed + Antigravity missing.
 *   3. the setup status chip in each state (a)-(f), plus the scratch machine's real report, and
 *      how often it reads (idle, then a focus).
 * States (a)-(f) answer /api/onboarding/readiness and /api/agent/tools (and, for (f),
 * /api/launcher/status) with fixed reports in the server's own shape; the chip, its rule and its
 * popover are the real ones.
 *
 *   dreamcontext builder heavy -- node scripts/verify/uc-istek.mjs <out-dir>
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './lib/app.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] ?? join(REPO, 'tmp', 'uc-istek-kanit');
mkdirSync(OUT, { recursive: true });
const app = await openApp({ suite: 'uc-istek' });
const { base, home, findings } = app;
const log = [];
const note = (s) => { log.push(s); process.stdout.write(`${s}\n`); };

// Two more projects, so one can be removed while `proj` stays open.
const cliEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME: home };
const extra = {};
for (const name of ['alpha', 'beta']) {
  const p = join(dirname(app.proj), name);
  mkdirSync(join(p, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: p });
  spawnSync('npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), 'vaults', 'add', name, p], { cwd: p, env: cliEnv, stdio: 'ignore' });
  extra[name] = p;
}

// ── Fixture reports in the server's shape ───────────────────────────────────────────
const IDS = ['network', 'node', 'npm', 'cli', 'claude', 'claude-auth', 'codex', 'codex-auth', 'git', 'github', 'gh', 'terminal'];
const FIX = { node: 'node-shell-path', npm: null, cli: 'cli-install', claude: 'claude-install', 'claude-auth': 'claude-signin', codex: 'codex-install', 'codex-auth': 'codex-signin', git: 'git-install', github: 'github-signin', gh: 'gh-install', terminal: 'pty-install' };
const TIER = { codex: 'optional', 'codex-auth': 'optional', git: 'recommended', github: 'recommended', gh: 'recommended', terminal: 'optional' };
function readiness(over = {}) {
  const checks = IDS.map((id) => {
    const o = over[id] ?? { status: 'ok' };
    const fix = o.status === 'ok' || !FIX[id] ? null : { id: FIX[id], kind: 'auto', runnable: true, editsShellProfile: false };
    return { id, tier: TIER[id] ?? 'required', scopes: ['machine'], status: o.status, dependsOn: [], fix, ...o };
  });
  return { version: 1, platform: 'darwin', arch: 'arm64', surface: 'desktop', generatedAt: Date.now(), ready: true, online: over.network?.status !== 'missing', plan: [], next: null, activeFixes: [], checks };
}
const tool = (t, installed, signedIn) => ({ tool: t, label: t, ready: installed && signedIn, installed, signedIn, defaultModel: null, models: [] });
const CLAUDE_ONLY = [tool('claude', true, true), tool('codex', false, false), tool('antigravity', false, false)];
const acct = (state) => ({ id: `a-${state}`, email: 'pat@example.test', organizationName: '', tier: 'max', preferred: true, isPrimary: true, state, limits: [], fetchedAtMs: null });
const ACC_OK = [acct('ok')];

const STATES = [
  { key: 'a-hepsi-iyi', expect: 'none', accounts: ACC_OK, ready: readiness(), tools: [tool('claude', true, true), tool('codex', true, true), tool('antigravity', true, true)] },
  { key: 'b-codex-antigravity-github-terminal-yok', expect: 'none', accounts: ACC_OK, tools: CLAUDE_ONLY, ready: readiness({
    codex: { status: 'missing', reason: 'not-installed' }, 'codex-auth': { status: 'blocked', blockedBy: ['codex'] },
    git: { status: 'missing' }, github: { status: 'needs-action', reason: 'signed-out' }, gh: { status: 'missing' }, terminal: { status: 'missing' } }) },
  { key: 'c-claude-yok-codex-girisli', expect: 'quiet', accounts: [], tools: [tool('claude', false, false), tool('codex', true, true), tool('antigravity', false, false)],
    ready: readiness({ claude: { status: 'missing', reason: 'not-installed' }, 'claude-auth': { status: 'blocked', blockedBy: ['claude'] } }) },
  { key: 'd-node-yok', expect: 'bad', accounts: ACC_OK, tools: CLAUDE_ONLY, ready: readiness({
    node: { status: 'missing', reason: 'too-old' }, npm: { status: 'blocked', blockedBy: ['node'] }, cli: { status: 'blocked', blockedBy: ['npm'] } }) },
  { key: 'e-hicbir-ajanda-giris-yok', expect: 'bad', accounts: [acct('needs-relogin')], tools: [tool('claude', true, false), tool('codex', true, false), tool('antigravity', true, false)],
    ready: readiness({ 'claude-auth': { status: 'needs-action', reason: 'signed-out' } }) },
  { key: 'f-proje-klasoru-yok', expect: 'bad', accounts: ACC_OK, tools: CLAUDE_ONLY, ready: readiness(), projectMissing: true },
  // One offline read (a slow ping): the report says offline, but only once.
  { key: 'h-tek-cevrimdisi-okuma', expect: 'none', accounts: ACC_OK, tools: CLAUDE_ONLY,
    ready: readiness({ network: { status: 'missing', reason: 'offline' } }) },
  // The owner's Mac as its app answered on 2026-11-03: the report says Claude signed out, the
  // app's own five Claude accounts are fine, and Codex and Antigravity are signed in.
  { key: 'g-sahibin-makinesi', expect: 'none', accounts: [acct('ok'), acct('ok')],
    tools: [tool('claude', true, true), tool('codex', true, true), tool('antigravity', true, true)],
    ready: readiness({ 'claude-auth': { status: 'needs-action', reason: 'signed-out' } }) },
];

const W = (page, ms) => page.waitForTimeout(ms);
const copy = (from, name) => copyFileSync(from, join(OUT, name));
async function chipState(page) {
  const chip = page.getByTestId('setup-status-chip');
  if (!(await chip.isVisible().catch(() => false))) return { drawn: false };
  return { drawn: true, tone: await chip.getAttribute('data-tone'), text: (await chip.innerText()).trim() };
}

try {
  // ── 3. the chip, every state, both widths ───────────────────────────────────────
  await app.look('/?vault=proj', async (page, w) => {
    await W(page, 2500);
    const real = await chipState(page);
    note(`[3] real scratch-machine report @${w.name}: ${JSON.stringify(real)}`);
    await page.screenshot({ path: join(OUT, `durum-gercek-makine-${w.name}.png`) });
    for (const s of STATES) {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.route('**/api/onboarding/readiness*', (r) => r.fulfill({ json: s.ready }));
      await page.route('**/api/agent/tools', (r) => r.fulfill({ json: { tools: s.tools } }));
      await page.route('**/api/agent/accounts', (r) => r.fulfill({ json: { accounts: s.accounts, autoSwitch: false, switchStrategy: 'score', switchWeights: {} } }));
      if (s.projectMissing) {
        await page.route('**/api/launcher/status', async (r) => {
          const res = await r.fetch();
          const body = await res.json();
          for (const v of body.vaults ?? []) if (v.name === 'proj') v.exists = false;
          await r.fulfill({ response: res, json: body });
        });
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await W(page, 1500);
      const st = await chipState(page);
      const got = st.drawn ? st.tone : 'none';
      note(`[3] ${s.key} @${w.name}: expected ${s.expect}, got ${got}${st.text ? ` "${st.text}"` : ''}`);
      if (got !== s.expect) findings.push(`${s.key}@${w.name}: expected ${s.expect}, got ${got}`);
      await page.screenshot({ path: join(OUT, `durum-${s.key}-${w.name}.png`) });
      if (st.drawn && w.name === 'desktop') {
        await page.getByTestId('setup-status-chip').click();
        await W(page, 300);
        const rows = await page.locator('[data-testid^="setup-status-row-"]').allInnerTexts();
        note(`[3]   popover: ${rows.map((r) => r.replace(/\s+/g, ' ')).join(' | ')}`);
        await page.screenshot({ path: join(OUT, `durum-${s.key}-acik-${w.name}.png`) });
        await page.keyboard.press('Escape');
      }
    }
    await page.unrouteAll({ behavior: 'ignoreErrors' });

    // How often it reads: idle 35 s, then the window comes back into focus.
    if (w.name === 'desktop') {
      const counts = { readiness: 0, tools: 0 };
      page.on('request', (r) => {
        if (/\/api\/onboarding\/readiness/.test(r.url())) counts.readiness += 1;
        if (/\/api\/agent\/tools$/.test(r.url())) counts.tools += 1;
        if (/\/api\/agent\/accounts$/.test(r.url())) counts.accounts = (counts.accounts ?? 0) + 1;
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await W(page, 3000);
      const onOpen = { ...counts };
      await W(page, 35_000);
      const idle = { ...counts };
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
      });
      await W(page, 2000);
      note(`[3] reads: on open ${JSON.stringify(onOpen)}, after 35 s idle ${JSON.stringify(idle)}, after a focus at 35 s ${JSON.stringify(counts)} (the chip re-reads on focus only after 5 min)`);
    }
  }, { name: 'durum' });

  // ── 1. Remove from app ──────────────────────────────────────────────────────────
  await app.look('/?vault=proj', async (page, w) => {
    if (w.name !== 'desktop') return;
    await W(page, 1500);
    const row = () => page.locator('.ns-dr-proj', { hasText: 'beta' });
    await row().first().click({ button: 'right' });
    await W(page, 300);
    await page.screenshot({ path: join(OUT, 'kaldir-1-menu.png') });
    await page.getByTestId('drawer-project-remove').click();
    await W(page, 500);
    await page.screenshot({ path: join(OUT, 'kaldir-2-onay.png') });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await W(page, 800);
    const afterCancel = await row().count();
    note(`[1] after Cancel, beta rows in the drawer: ${afterCancel} (want 1)`);
    if (afterCancel !== 1) findings.push('Cancel removed the project');
    await row().first().click({ button: 'right' });
    await page.getByTestId('drawer-project-remove').click();
    await W(page, 500);
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await W(page, 2000);
    const afterRemove = await row().count();
    const onDisk = existsSync(join(extra.beta, '_dream_context'));
    note(`[1] after Remove, beta rows: ${afterRemove} (want 0); folder still on disk: ${onDisk}`);
    if (afterRemove !== 0) findings.push('Remove left the project in the drawer');
    if (!onDisk) findings.push('Remove touched the folder');
    await page.screenshot({ path: join(OUT, 'kaldir-3-sonra.png') });
  }, { name: 'kaldir' });

  // ── 2. Settings → System → Optional tools ───────────────────────────────────────
  await app.look('/?vault=proj', async (page, w) => {
    await page.route('**/api/agent/tools', (r) => r.fulfill({ json: { tools: [tool('claude', true, true), tool('codex', true, true), tool('antigravity', false, false)] } }));
    await page.route('**/api/agent/accounts/codex', (r) => r.fulfill({ json: { tool: 'codex', accounts: [{ id: 'p', tool: 'codex', email: 'pat@example.test', planType: 'plus', isPrimary: true, preferred: true, state: 'ok', limits: [], fetchedAtMs: Date.now(), windows: [{ id: 's', kind: 'session', label: '5h', usedPercent: 41 }, { id: 'w', kind: 'weekly', label: 'weekly', usedPercent: 12 }] }] } }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    const rail = page.getByTestId('ns-rail-settings');
    if (await rail.isVisible().catch(() => false)) await rail.click();
    else await page.goto(`${base}/?vault=proj&page=settings`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('settings-window').waitFor({ state: 'visible', timeout: 10_000 });
    await page.click('[data-sw-nav="system"]');
    await W(page, 1200);
    const card = await page.getByTestId('optional-tools').innerText().catch(() => '');
    note(`[2] optional card @${w.name}: ${card.replace(/\s+/g, ' ')}`);
    const reds = await page.locator('[data-testid="optional-tools"] .sysdep-dot:not(.sysdep-dot--ok):not(.sysdep-dot--muted), [data-testid="optional-tools"] .sysdep-error').count();
    if (reds) findings.push(`optional card draws ${reds} red/error element(s)`);
    await page.screenshot({ path: join(OUT, `ayarlar-sistem-${w.name}.png`), fullPage: true });
  }, { name: 'ayarlar' });
} catch (err) {
  findings.push(`could not finish: ${err instanceof Error ? err.stack ?? err.message : err}`);
}
for (const f of app.taken) copy(f, `ham-${f.split('/').slice(-1)[0]}`);
const code = await app.finish();
note(`OUT ${OUT}`);
process.exit(code);
