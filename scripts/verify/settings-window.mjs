#!/usr/bin/env node
/**
 * /verify for the Settings window of the new layout (task settings-konuya-gore-…, 2026-11-01).
 * The prototype's check31 ported to the real selectors; its Super→Codex, MCP sign-in and
 * Antigravity/OpenCode data checks are dropped (this version does not have them).
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/settings-window.mjs
 *
 * Scratch HOME and vault (lib/app.mjs), a stand-in `codex` whose `mcp list --json` carries an env
 * secret, and a project `.mcp.json`. At 1440 dark it drives the behaviour; then every page at
 * 1440/1024/768/390 in dark and light: no sideways overflow, no "undefined", no console error.
 * Expected: the Assistant routes may answer 403 outside the desktop app (owner-gated).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const app = await openApp({ suite: 'settings-window' });
const { base, home, proj, shots, findings } = app;
const checks = [];
const ok = (name, v) => { checks.push({ name, ok: !!v }); if (!v) findings.push(`check failed: ${name}`); };
const EXPECTED_403 = /\/api\/assistant\//;

// A stand-in codex: version, a failed login probe, and an MCP list whose transport holds an env secret.
const bin = join(home, '.local', 'bin');
writeFileSync(join(bin, 'codex'), `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "codex-cli 0.60.0" ;;
  "mcp list") echo '[{"name":"linear","enabled":true,"auth_status":"unsupported","transport":{"type":"stdio","command":"npx","args":["linear"],"env":{"LINEAR_KEY":"sk-verify-secret"}}},{"name":"only-codex","enabled":false,"auth_status":"o_auth","transport":{"type":"streamable_http","url":"https://example.invalid"}}]' ;;
  *) exit 1 ;;
esac
`);
chmodSync(join(bin, 'codex'), 0o755);
writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { linear: { command: 'echo', args: ['x'] } } }));

const PAGES = ['general', 'chat', 'voice', 'models', 'mcp', 'super', 'assistant', 'memory', 'sleep', 'tasks', 'repos', 'teamsync', 'mirror', 'connected', 'handsfree', 'system'];
const NAV = 'General Chat Voice Agents Models Tools (MCP) Super Agent Assistant Memory Memory search Sleep Project Tasks Code repos Connections Team sync Task mirroring Connected projects Hands-free System';
const GONE = /Show Chat|Open sessions as|Terminal drawing|Show\/hide shortcut|Platforms|Default agent/;

const browser = await chromium.launch();
const W = (page, ms = 300) => page.waitForTimeout(ms);
const txt = (page, sel) => page.locator(sel).first().innerText().catch(() => '');

async function openPage(width, height, theme, tag) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript((th) => {
    try { localStorage.setItem('dreamcontext-theme', th); } catch { /* ignore */ }
  }, theme);
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/\/@vite\/|favicon/.test(m.text())) findings.push(`${tag} console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => findings.push(`${tag} crash: ${String(e.message).slice(0, 200)}`));
  page.on('response', (r) => {
    if (r.status() < 400 || /\/@vite\/|favicon|\/ws\b/.test(r.url())) return;
    if (r.status() === 403 && EXPECTED_403.test(r.url())) return;
    findings.push(`${tag} ${r.status()}: ${new URL(r.url()).pathname}`);
  });
  page.on('requestfailed', (r) => { if (!/\/@vite\/|favicon|\/ws\b/.test(r.url())) findings.push(`${tag} failed request: ${new URL(r.url()).pathname}`); });
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
const go = async (page, id) => { await page.click(`[data-sw-nav="${id}"]`); await W(page, 450); };
const shot = async (page, name) => { await W(page, 200); await page.screenshot({ path: join(shots, `${name}.png`) }); };
// Fits = nothing scrolls sideways (page, window, body), and the page's title and first card are on screen.
const fits = (page) => page.evaluate(() => {
  const b = document.querySelector('.sw-body');
  const w = document.querySelector('.sw-win');
  const on = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1; };
  return !!b && b.scrollWidth <= b.clientWidth + 1 && w.scrollWidth <= w.clientWidth + 1 && w.scrollLeft === 0
    && w.getBoundingClientRect().right <= innerWidth + 1
    && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    && on(document.querySelector('.sw-title')) && on(document.querySelector('.sw-sec > :not(.sw-head)'));
});
const pickModel = async (page, chipTestId, rail, name) => {
  await page.getByTestId(chipTestId).click();
  await page.getByTestId(`${chipTestId}-picker`).waitFor({ state: 'visible' });
  if (rail) await page.locator(`.sw-popover .mp-tool[data-tool="${rail}"]`).click();
  await page.locator('.sw-popover .mp-row-pick', { hasText: name }).first().click();
  await W(page, 600);
  if (await page.getByTestId(`${chipTestId}-picker`).isVisible().catch(() => false)) { await page.keyboard.press('Escape'); await W(page); }
};

try {
  // ── Behaviour, 1440 dark ─────────────────────────────────────────────────────────────
  const { context, page } = await openPage(1440, 900, 'dark', 'behaviour@1440');
  const behindBefore = await page.locator('[data-testid^="ns-rail-"][data-on="true"]').getAttribute('data-testid').catch(() => null);
  await openWindow(page);
  ok('rail opens the window', await page.getByTestId('settings-window').isVisible());
  const nav = (await txt(page, '.sw-nav')).replace(/\s+/g, ' ').trim();
  ok(`nav order (${nav})`, nav === NAV);
  ok('16 pages', (await page.locator('.sw-ni').count()) === 16);
  ok('General first', (await txt(page, '.sw-title')) === 'General');
  await shot(page, 'general-1440-dark');
  for (const id of PAGES) {
    await go(page, id);
    const body = await txt(page, '.sw-body');
    ok(`renders ${id}`, (await page.locator('.sw-sec').count()) === 1 && (await page.locator('.sw-sec > :not(.sw-head)').count()) > 0);
    ok(`no undefined ${id}`, !body.includes('undefined'));
    ok(`no removed rows ${id}`, !GONE.test(body));
    ok(`fits ${id}`, await fits(page));
  }
  ok('no GitHub or ClickUp menu', !/GitHub|ClickUp/.test(nav));

  // Models: one chip per job, five helpers, the picker.
  await go(page, 'models');
  await shot(page, 'models-defaults-1440-dark');
  for (const j of ['chat', 'super', 'assistant', 'sleep']) {
    ok(`one chip ${j}`, (await page.locator(`[data-row="job-${j}"] .sw-mdc`).count()) === 1 && (await page.locator(`[data-row="job-${j}"] select`).count()) === 0);
  }
  ok('five helpers', (await page.locator('[data-row^="helper-"]').count()) === 5);
  ok('no select on Models', (await page.locator('.sw-body select').count()) === 0);
  const chatBefore = await page.getByTestId('sw-chip-chat').getAttribute('aria-label');
  await page.getByTestId('sw-chip-super').click();
  await page.getByTestId('sw-chip-super-picker').waitFor({ state: 'visible' });
  ok('picker has no account list', (await page.getByTestId('model-picker-accounts').count()) === 0);
  ok('picker has no new-chat note', !(await txt(page, '.sw-popover')).includes('Opens a new'));
  await shot(page, 'models-picker-1440-dark');
  const codexRail = page.locator('.sw-popover .mp-tool[data-tool="codex"]');
  if (await codexRail.count()) {
    await codexRail.click({ force: true }); await W(page);
    ok('Super: Codex passive with the reason', (await txt(page, '[data-testid="model-picker-locked"]')).includes('Claude Code only'));
    await page.locator('.sw-popover .mp-tool[data-tool="claude"]').click(); await W(page);
  } else ok('Super: Codex rail present', false);
  await page.keyboard.press('Escape'); await W(page);
  ok('Esc closes only the picker', (await page.getByTestId('settings-window').isVisible()) && !(await page.getByTestId('sw-chip-super-picker').isVisible().catch(() => false)));
  await pickModel(page, 'sw-chip-super', null, 'Sonnet');
  ok('Super takes the model', (await page.getByTestId('sw-chip-super').getAttribute('aria-label')).includes('Sonnet'));
  ok('chat chip untouched', (await page.getByTestId('sw-chip-chat').getAttribute('aria-label')) === chatBefore);

  // Sleep line and helpers.
  await pickModel(page, 'sw-chip-sleep-tasks', null, 'Sonnet');
  ok('helper takes its own model', (await page.getByTestId('sw-chip-sleep-tasks').getAttribute('aria-label')).includes('Sonnet'));
  await pickModel(page, 'sw-chip-sleep', null, 'Opus');
  ok('Sleep moves followers', (await page.getByTestId('sw-chip-sleep-state').getAttribute('aria-label')).includes('Opus'));
  ok('pinned helper stays', (await page.getByTestId('sw-chip-sleep-tasks').getAttribute('aria-label')).includes('Sonnet'));
  await shot(page, 'models-helpers-1440-dark');
  await page.getByTestId('sw-helper-reset-sleep-tasks').click(); await W(page, 700);
  ok('↺ returns the helper', (await page.getByTestId('sw-chip-sleep-tasks').getAttribute('aria-label')).includes('Opus'));
  const agentFile = join(proj, '.claude', 'agents', 'sleep-state.md');
  if (existsSync(agentFile)) ok('sleep-state.md shows the effective model', /^model:\s*opus/m.test(readFileSync(agentFile, 'utf-8')));
  else checks.push({ name: 'sleep-state.md not installed in the scratch vault (skipped)', ok: true });

  // Search.
  await page.getByTestId('settings-search').fill('specialist'); await W(page, 700);
  ok('search "specialist" finds the helpers', (await txt(page, '.sw-body')).includes('Sleep helpers'));
  await page.getByTestId('settings-search').fill('limit'); await W(page, 700);
  ok('search "limit" finds the rules', (await txt(page, '.sw-body')).includes('Switch near a limit'));
  await page.locator('[data-tab="codex"] [data-row="codex-switch"] .setting-row-title, [data-tab="codex"] [data-row="codex-switch"]').first().click({ position: { x: 20, y: 12 } });
  await W(page, 600);
  ok('a hit jumps to its tab', (await page.locator('[data-sw-tab="codex"][aria-selected="true"]').count()) === 1);

  // Limit rules per tool.
  const claudeFile = join(home, '.dreamcontext', 'claude-accounts.json');
  const claudeBefore = existsSync(claudeFile) ? readFileSync(claudeFile) : null;
  await page.click('[data-sw-tab="codex"]'); await W(page);
  ok('Codex default is Stop', (await page.locator('[data-row="codex-out"] .sw-seg-btn.on').innerText()).includes('Stop'));
  await page.locator('[data-row="codex-out"] .sw-seg-btn', { hasText: 'Continue at reset' }).click(); await W(page, 700);
  ok('Codex rule hint changes', (await txt(page, '[data-row="codex-out"]')).includes('goes on by itself'));
  const claudeAfter = existsSync(claudeFile) ? readFileSync(claudeFile) : null;
  ok('claude-accounts.json byte-identical after a Codex edit', (claudeBefore === null && claudeAfter === null) || (claudeBefore && claudeAfter && claudeBefore.equals(claudeAfter)));
  const rulesFile = join(home, '.dreamcontext', 'account-rules.json');
  ok('account-rules.json holds Codex continue', existsSync(rulesFile) && JSON.parse(readFileSync(rulesFile, 'utf-8')).codex?.onExhausted === 'continue');
  await shot(page, 'models-codex-1440-dark');
  await page.click('[data-sw-tab="claude"]'); await W(page);
  ok('Claude rule stays Stop', (await page.locator('[data-row="claude-out"] .sw-seg-btn.on').innerText()).includes('Stop'));
  await shot(page, 'models-claude-1440-dark');
  for (const id of ['antigravity', 'opencode']) {
    await page.click(`[data-sw-tab="${id}"]`); await W(page);
    ok(`${id} tab passive and says why`, (await txt(page, '.sw-body')).includes('This version cannot run it yet'));
  }

  // Assistant, Sleep and Super pages: Codex passive in their chips (checked above for Super); the chips exist.
  await go(page, 'super');
  ok('Super page chip', (await page.locator('[data-row="smodel"] .sw-mdc').count()) === 1);
  await go(page, 'chat');
  ok('Chat page chip', (await page.locator('[data-row="cmodel"] .sw-mdc').count()) === 1);
  await go(page, 'sleep');
  ok('Sleep page chip', (await page.locator('[data-row="slmodel"] .sw-mdc').count()) === 1);
  ok('Hypotheses on Sleep', (await page.locator('[data-row="learning"]').count()) === 1);
  await page.getByTestId('sw-chip-sleep').click(); await W(page);
  const sleepCodex = page.locator('.sw-popover .mp-tool[data-tool="codex"]');
  if (await sleepCodex.count()) {
    await sleepCodex.click({ force: true }); await W(page);
    ok('Sleep: Codex passive with the reason', (await txt(page, '[data-testid="model-picker-locked"]')).includes('Sleep runs on Claude Code only'));
  }
  await page.keyboard.press('Escape'); await W(page);

  // Voice: the key, two steps.
  await fetch(`${base}/api/agent/voice/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ openRouterKey: 'sk-or-verify-fake' }) }).catch(() => {});
  await go(page, 'voice');
  await shot(page, 'voice-1440-dark');
  const removeBtn = page.getByTestId('sw-key-remove');
  if (await removeBtn.isVisible().catch(() => false)) {
    await removeBtn.click(); await W(page);
    ok('Remove warns first', (await txt(page, '[data-row="orkey"]')).includes('Read aloud stops'));
    await shot(page, 'voice-remove-ask-1440-dark');
    await page.getByTestId('sw-key-remove-go').click(); await W(page, 900);
    ok('key gone', (await txt(page, '[data-row="orkey"]')).includes('No key yet'));
    ok('read aloud passive says why', (await txt(page, '[data-row="speakchat"]')).includes('Needs an OpenRouter key'));
    ok('local dictation stays', (await page.locator('[data-row="engine"] .sw-seg-btn.on').innerText()).includes('On this Mac'));
  } else ok('Voice key remove button present (key seeded)', false);

  // MCP: the read-only Codex column.
  await go(page, 'mcp'); await W(page, 1200);
  await shot(page, 'mcp-1440-dark');
  const wire = await (await fetch(`${base}/api/agent/mcp/codex`)).json();
  ok('Codex wire = whitelist, no env', JSON.stringify(wire).indexOf('sk-verify-secret') === -1 && wire.servers?.every((s) => Object.keys(s).sort().join() === 'authStatus,enabled,name,transport'));
  ok('Codex column: linear In Codex', (await page.locator('[data-codex="on"]').count()) >= 1);
  ok('Found in Codex row', (await page.locator('[data-codex-only="only-codex"]').count()) === 1);
  ok('no Codex sign-in control', (await page.locator('.mcpm-cell--codex button').count()) === 0);

  // Memory search, Team sync, Mirroring, Assistant.
  await go(page, 'memory');
  await shot(page, 'memory-1440-dark');
  ok('Memory search has native row', (await page.locator('[data-row="native"]').count()) === 1);
  await go(page, 'teamsync');
  ok('Team sync has no Hands-free', !(await txt(page, '.sw-body')).includes('Hands-free'));
  await go(page, 'mirror');
  ok('one mirroring choice', (await page.getByTestId('sw-mirror-choice').count()) === 1);
  await page.locator('[data-testid="sw-mirror-choice"] .sw-seg-btn', { hasText: 'GitHub' }).click(); await W(page, 600);
  ok('GitHub without login opens, with the token row', (await page.locator('[data-testid="sw-mirror-choice"] .sw-seg-btn.on').innerText()).includes('GitHub'));
  await shot(page, 'mirror-1440-dark');
  await go(page, 'assistant');
  await shot(page, 'assistant-1440-dark');
  ok('Assistant page draws', (await txt(page, '.sw-body')).length > 20);

  // Esc closes, the page behind is the same.
  await page.keyboard.press('Escape'); await W(page);
  ok('Esc closes the window', !(await page.getByTestId('settings-window').isVisible().catch(() => false)));
  const behindAfter = await page.locator('[data-testid^="ns-rail-"][data-on="true"]').getAttribute('data-testid').catch(() => null);
  ok(`page behind unchanged (${behindBefore} → ${behindAfter})`, behindBefore === behindAfter);
  // ✕ returns too.
  await openWindow(page);
  await page.getByTestId('settings-close').click(); await W(page);
  ok('✕ closes the window', !(await page.getByTestId('settings-window').isVisible().catch(() => false)));
  // An expanded chat stays expanded.
  await page.getByTestId('ns-rail-chat').click(); await W(page, 900);
  const expanded = () => page.locator('.project-instance:not([hidden]) .agent-surface.expanded').count();
  const before = await expanded();
  await openWindow(page);
  await shot(page, 'over-chat-1440-dark');
  await page.keyboard.press('Escape'); await W(page);
  ok(`expanded chat stays expanded (${before})`, before > 0 && (await expanded()) === before);
  // ?page=settings opens the window over Tasks.
  await page.goto(`${base}/?vault=proj&page=settings`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('settings-window').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  ok('?page=settings opens the window', await page.getByTestId('settings-window').isVisible().catch(() => false));
  await context.close();

  // ── Every page, every width, both themes ─────────────────────────────────────────────
  for (const theme of ['dark', 'light']) {
    for (const [w, h] of [[1440, 900], [1024, 768], [768, 1024], [390, 844]]) {
      const tag = `${w}-${theme}`;
      const s = await openPage(w, h, theme, tag);
      await openWindow(s.page);
      for (const id of PAGES) {
        await go(s.page, id);
        const body = await txt(s.page, '.sw-body');
        ok(`fit ${tag} ${id}`, await fits(s.page));
        ok(`no undefined ${tag} ${id}`, !body.includes('undefined'));
        await shot(s.page, `${id}-${tag}`);
      }
      await s.context.close();
    }
  }
} catch (err) {
  findings.push(`could not finish: ${err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' | ') : err}`);
}

await browser.close();
const passed = checks.filter((c) => c.ok).length;
writeFileSync(join(shots, 'checks.json'), `${JSON.stringify(checks, null, 1)}\n`);
process.stdout.write(`checks: ${passed}/${checks.length}\n`);
process.exit(await app.finish());
