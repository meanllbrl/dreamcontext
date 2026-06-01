import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BASE = 'http://127.0.0.1:4173';
mkdirSync('e2e/shots', { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(BASE, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
for (const [name, label] of [['settings', 'Settings'], ['packs', 'Packs'], ['sleep', 'Sleep State']]) {
  const btn = p.locator('.sidebar-item', { hasText: label });
  if (await btn.count()) { await btn.first().click(); await p.waitForTimeout(800); }
  await p.screenshot({ path: `e2e/shots/${name}.png`, fullPage: false });
  console.log(`shot: ${name}`);
}
// Packs detail modal: navigate to Packs, click the first card, capture the modal.
const packsBtn = p.locator('.sidebar-item', { hasText: 'Packs' });
if (await packsBtn.count()) { await packsBtn.first().click(); await p.waitForTimeout(600); }
const card = p.locator('.packs-card').first();
if (await card.count()) {
  await card.click();
  await p.waitForTimeout(500);
  await p.screenshot({ path: 'e2e/shots/packs-modal.png', fullPage: false });
  console.log('shot: packs-modal');
}
await b.close();
