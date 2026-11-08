#!/usr/bin/env node
/**
 * Antigravity's readiness in the real app (Track T W5): the picker's three states and the Settings
 * panel, on the real server against a scratch HOME. Install and sign-in are files T3 would write,
 * laid down here between the states, so no download and no Google account.
 *
 *   dreamcontext builder heavy -- node scripts/verify/tool-antigravity.mjs
 *
 * Shots at 1440/1024/390 in dark and light, with console errors and failed requests recorded.
 * SHOTS_DIR copies the screenshots there.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApp, WIDTHS } from './lib/app.mjs';

WIDTHS.splice(1, 0, { name: 'tablet', width: 1024, height: 768 });

// `desktop`: the accounts panel sits in Settings' Agents section, which only the Mac app's server draws.
const app = await openApp({ suite: 'tool-antigravity', build: true, desktop: true });
const t3 = join(app.home, '.dreamcontext', 't3');
// The kit's `claude` exits at once, which ends the session and closes the picker mid-look.
writeFileSync(join(app.home, '.local', 'bin', 'claude'), '#!/bin/sh\nexec cat >/dev/null\n');

const install = () => {
  const dir = join(t3, 'tools', 'antigravity-acp', `${process.platform}-${process.arch}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'active.json'), '{}');
};
const signIn = () => {
  const key = createHash('sha256').update('antigravity').digest('hex');
  const dir = join(t3, 'state', 'providers', 'antigravity', key, 'antigravity-acp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'acp_token.json'), '{}');
};

/** The same way in as verify:tool-codex-chat: the surface expanded, then a chat started. */
async function openChat(page, w) {
  await page.waitForTimeout(3_000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1_500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click({ timeout: 8_000 }).catch(() => {});
  const trigger = page.locator('.chat-cmp-modeltrigger[title^="Model and reasoning effort"]:visible').first();
  await trigger.waitFor({ timeout: 20_000 }).catch(async () => {
    await page.screenshot({ path: join(app.shots, `no-composer-${w.name}.png`) });
    app.findings.push(`${w.name}: the composer did not appear`);
  });
}

const theme = (name) => (page) => page.evaluate((n) => { localStorage.setItem('dreamcontext-theme', n); document.documentElement.setAttribute('data-theme', n); }, name);

async function picker(page, w, { expect, button }) {
  await openChat(page, w);
  await page.locator('.chat-cmp-modeltrigger[title^="Model and reasoning effort"]:visible').first().click();
  await page.locator('[data-testid="model-picker"] [data-tool="antigravity"]:visible').click({ timeout: 10_000 });
  for (const text of expect) {
    const seen = await page.locator('[data-testid="model-picker"]:visible').getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
    if (!seen) app.findings.push(`${w.name}: "${text}" is not in the picker`);
  }
  if (button) {
    const has = await page.locator('[data-testid="codex-fix"]:visible').filter({ hasText: button }).count();
    if (!has) app.findings.push(`${w.name}: no "${button}" button on the Antigravity row`);
  } else if (await page.locator('[data-testid="model-picker-signin"]:visible').count()) {
    app.findings.push(`${w.name}: a ready tool still shows a blocker`);
  }
}

try {
  for (const mode of ['dark', 'light']) {
    await app.look('/?vault=proj', async (page, w) => { await theme(mode)(page); await picker(page, w, { expect: ['Antigravity'], button: 'Install' }); }, { name: `install-${mode}` });
  }
  install();
  for (const mode of ['dark', 'light']) {
    await app.look('/?vault=proj', async (page, w) => { await theme(mode)(page); await picker(page, w, { expect: ['Antigravity'], button: 'Sign in' }); }, { name: `signin-${mode}` });
  }
  signIn();
  for (const mode of ['dark', 'light']) {
    await app.look('/?vault=proj', async (page, w) => { await theme(mode)(page); await picker(page, w, { expect: ['Gemini'] }); }, { name: `ready-${mode}` });
  }
  await app.look('/?vault=proj', async (page, w) => {
    // The app's own way to Settings: the picker's "Models" link.
    await openChat(page, w);
    await page.locator('.chat-cmp-modeltrigger[title^="Model and reasoning effort"]:visible').first().click();
    await page.locator('[data-testid="model-picker"]:visible').getByText('Models', { exact: false }).last().click({ timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    // Search draws every section at once, so the panel is found the way an owner would find it.
    await page.getByPlaceholder('Search settings').first().fill('Antigravity').catch(() => {});
    await page.waitForTimeout(1_000);
    const panel = page.locator('[data-testid="antigravity-accounts"]');
    const seen = await panel.first().waitFor({ state: 'attached', timeout: 8_000 }).then(() => true, () => false);
    if (seen) await panel.first().scrollIntoViewIfNeeded().catch(() => {});
    else app.findings.push(`${w.name}: the Antigravity accounts panel is not in Settings`);
  }, { name: 'settings' });
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
const code = await app.finish();
if (process.env.SHOTS_DIR) {
  mkdirSync(process.env.SHOTS_DIR, { recursive: true });
  cpSync(app.shots, process.env.SHOTS_DIR, { recursive: true });
}
process.exit(code);
