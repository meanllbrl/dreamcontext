#!/usr/bin/env node
/**
 * Settings → Dependencies → "Update dreamcontext automatically" (the CLI self-update switch),
 * driven in the real dashboard on a scratch vault.
 *
 *   npm run build && node scripts/verify/self-update-settings.mjs
 *
 * Checks, at a desktop (1440) and a phone (390) width: the switch is there and ON by default,
 * the last outcome line reads the recorded self-update, flipping it OFF writes the marker the
 * server job and the prompt hook read (~/.dreamcontext/cli-auto-update-off) and the line says
 * so, flipping it back ON removes it. Console errors and failed requests are recorded; any is a
 * failure. Screenshots land in tmp/verify-self-update-settings/.
 *
 * SCRATCH HOME, ALWAYS: nothing here touches the developer's real ~/.dreamcontext.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dc-verify-self-update-settings');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-self-update-settings');
const MARKER = join(HOME, '.dreamcontext', 'cli-auto-update-off');

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const r = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
  // What the server job records after a real upgrade (src/lib/self-update.ts).
  const at = Date.parse('2026-10-27T09:05:00Z');
  writeFileSync(join(HOME, '.dreamcontext', 'self-update.json'), JSON.stringify({
    checkedAt: at, at, installed: '0.36.0', latest: '0.36.0', state: 'updated', from: '0.35.0', to: '0.36.0', attemptedFor: '0.36.0', lastAttemptAt: at,
  }));
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer(port) {
  // DREAMCONTEXT_DESKTOP=1 for the desktop hint; no DREAMCONTEXT_PARENT_PID, so the self-update
  // job itself stays off (it only runs in the app-owned server).
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('server did not come up');
}

let pass = 0;
let fail = 0;
function check(label, ok, ev) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
}

async function openSection(page, base) {
  await page.goto(`${base}/?vault=proj&page=settings`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 6; i += 1) {
    await page.waitForTimeout(500);
    if (await page.locator('.announcements-modal-scrim').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
  }
  await page.getByRole('button', { name: 'Dependencies' }).first().click();
  await page.getByText('Update dreamcontext automatically').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
}

async function run(base) {
  const browser = await chromium.launch();
  const errors = [];
  for (const [label, viewport] of [['desktop-1440', { width: 1440, height: 1000 }], ['phone-390', { width: 390, height: 844 }]]) {
    console.log(`\n${label}`);
    const page = await browser.newPage({ viewport, colorScheme: 'dark' });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
    page.on('requestfailed', (r) => errors.push(`${label} request failed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
    page.on('response', (r) => { if (r.status() >= 500) errors.push(`${label} ${r.status()} ${r.url()}`); });
    await openSection(page, base);
    const row = page.locator('.setting-row', { hasText: 'Update dreamcontext automatically' });
    const sw = row.getByRole('switch');
    check('the switch is there and on by default', await sw.isChecked());
    const status = page.getByTestId('self-update-status');
    check('the last outcome line reads the record', (await status.innerText()).includes('Updated 0.35.0 → 0.36.0'), await status.innerText());
    await row.scrollIntoViewIfNeeded();
    const box = await row.boundingBox();
    check('the row fits the viewport width', !!box && box.x >= 0 && box.x + box.width <= viewport.width + 1, JSON.stringify(box));
    await page.screenshot({ path: join(SHOTS, `${label}-on.png`), fullPage: false });

    await sw.click();
    await page.waitForTimeout(600);
    check('off writes the marker the job and the hook read', existsSync(MARKER));
    check('the line says it is off', (await status.innerText()).startsWith('Off:'), await status.innerText());
    await page.screenshot({ path: join(SHOTS, `${label}-off.png`), fullPage: false });
    await sw.click();
    await page.waitForTimeout(600);
    check('on again removes the marker', !existsSync(MARKER));
    await page.close();
  }
  await browser.close();
  check('no console errors, failed requests or 5xx', errors.length === 0, errors.join('\n      '));
}

setup();
const port = await freePort();
const srv = await startServer(port);
try {
  await run(`http://127.0.0.1:${port}`);
} finally {
  srv.kill();
}
console.log(`\n${pass} passed, ${fail} failed. Screenshots: ${SHOTS}`);
process.exit(fail ? 1 : 0);
