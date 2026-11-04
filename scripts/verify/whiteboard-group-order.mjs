#!/usr/bin/env node
/**
 * The board explorer's group order (owner, 2026-11-04: "can I reorder the groups by drag and
 * drop?"), in a real browser, no build:
 *
 *   dreamcontext builder heavy -- node scripts/verify/whiteboard-group-order.mjs [shots-dir]
 *
 *   O1  groups start by name (Alpha, Beta, Gamma); Ungrouped stays under them;
 *   O2  dragging the Gamma header onto Alpha's top half puts it first, on disk
 *       (`whiteboards/.groups.json`) and on screen;
 *   O3  a BOARD dragged onto a group header still moves the board (the two drags do not mix);
 *   O4  the group ⋯ menu's "Move up" reorders from the keyboard;
 *   O5  the order survives a reload.
 * Before/after screenshots go to [shots-dir] (default: the harness's own folder).
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApp } from './lib/app.mjs';

const OUT = process.argv[2];
const app = await openApp({ suite: 'whiteboard-group-order' });
const results = [];
const ok = (name, cond, detail = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail && !cond ? ` (${detail})` : ''}`); if (!cond) app.findings.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150); } return false; };

const wb = join(app.proj, '_dream_context', 'whiteboards');
const orderOnDisk = () => { try { return JSON.parse(readFileSync(join(wb, '.groups.json'), 'utf-8')).order; } catch { return null; } };
const groupOnDisk = (slug) => readFileSync(join(wb, slug, `${slug}.excalidraw.md`), 'utf-8').match(/^"?group"?: "?([^"\n]*)"?$/m)?.[1] ?? null;

const seed = async (name, group) => {
  const res = await fetch(`${app.base}/api/whiteboards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'proj' },
    body: JSON.stringify({ name, description: '', ...(group ? { group } : {}) }),
  });
  if (!res.ok) throw new Error(`seed ${name}: ${res.status} ${await res.text()}`);
  return (await res.json()).slug;
};
const gamma = await seed('Roadmap', 'Gamma');
await seed('Metrics', 'Alpha');
await seed('Funnel', 'Beta');
const loose = await seed('Loose notes');

const groupNames = (page) => page.locator('.wbx-row--group .wbx-name').allInnerTexts();
const groupHead = (page, name) => page.locator('.wbx-group', { has: page.locator('.wbx-row--group .wbx-name', { hasText: new RegExp(`^${name}$`) }) }).locator('.wbx-row--group');
const shot = async (page, name) => {
  const file = join(app.shots, `${name}.png`);
  await page.screenshot({ path: file, clip: await page.locator('.wbx').boundingBox() });
  if (OUT) { mkdirSync(OUT, { recursive: true }); copyFileSync(file, join(OUT, `${name}.png`)); }
  app.taken.push(file);
};

try {
  await app.look('/?vault=proj', async (page, w) => {
    if (w.name !== 'desktop') return;
    if (await page.locator('.announcements-modal-scrim').count()) await page.keyboard.press('Escape');
    await page.locator('[data-testid="ns-rail-whiteboards"]').click();
    await page.locator('.wbx').waitFor({ timeout: 15000 });
    await waitFor(async () => (await groupNames(page)).length === 3);
    ok('O1 groups start by name', (await groupNames(page)).join(',') === 'Alpha,Beta,Gamma', (await groupNames(page)).join(','));
    await shot(page, 'once');

    // O2: Gamma's header onto Alpha's top half, by a real mouse drag.
    await groupHead(page, 'Gamma').dragTo(groupHead(page, 'Alpha'), { targetPosition: { x: 40, y: 4 } });
    const moved = await waitFor(() => JSON.stringify(orderOnDisk()) === JSON.stringify(['Gamma', 'Alpha', 'Beta']));
    ok('O2 drag stores the order on disk', moved, JSON.stringify(orderOnDisk()));
    ok('O2 drag shows the new order', (await groupNames(page)).join(',') === 'Gamma,Alpha,Beta', (await groupNames(page)).join(','));
    ok('O2 Gamma kept its board', groupOnDisk(gamma) === 'Gamma');

    // O3: a board dropped on a group header is still a board move.
    const looseRow = page.locator('.wbx-ungrouped .wbx-row', { has: page.locator('.wbx-name', { hasText: /^Loose notes$/ }) });
    await looseRow.dragTo(groupHead(page, 'Beta'));
    ok('O3 a board drag still moves the board', await waitFor(() => groupOnDisk(loose) === 'Beta'), String(groupOnDisk(loose)));
    ok('O3 and leaves the group order alone', JSON.stringify(orderOnDisk()) === JSON.stringify(['Gamma', 'Alpha', 'Beta']), JSON.stringify(orderOnDisk()));

    // O4: keyboard, through the ⋯ menu.
    await groupHead(page, 'Beta').locator('.wbx-more').last().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Move up' }).click();
    ok('O4 Move up from the menu', await waitFor(() => JSON.stringify(orderOnDisk()) === JSON.stringify(['Gamma', 'Beta', 'Alpha'])), JSON.stringify(orderOnDisk()));

    // O5: reload.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (await page.locator('.announcements-modal-scrim').count()) await page.keyboard.press('Escape');
    await page.locator('[data-testid="ns-rail-whiteboards"]').click();
    await page.locator('[data-testid="ns-rail-whiteboards"][aria-current="page"]').waitFor({ timeout: 15000 });
    await page.locator('.wbx').waitFor({ timeout: 15000 });
    await sleep(800);
    await waitFor(async () => (await groupNames(page)).length === 3);
    ok('O5 the order survives a reload', (await groupNames(page)).join(',') === 'Gamma,Beta,Alpha', (await groupNames(page)).join(','));
    await shot(page, 'sonra');
  }, { name: 'group-order' });
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
for (const r of results) process.stdout.write(`${r}\n`);
process.exit(await app.finish());
