#!/usr/bin/env node
/**
 * The "Does the Super Agent raise token use?" card (StatsSuperEffect.tsx) in every state of the
 * approved drawing (super-cocuk-tasarruf criterion 15): data (reduces), increase, no difference,
 * too few, no Super, loading. A scratch HOME and a real server; the stats answer is the server's
 * own, with only `dc.superEffect` (and `scanning` for loading) swapped for a synthetic fixture of a
 * fictional "Acme" workload. Shots of the card at 390 and 1440 px, light and dark.
 *
 *   dreamcontext builder heavy -- node scripts/verify/stats-super.mjs <out-dir>
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openApp } from './lib/app.mjs';

const out = process.argv[2];
if (!out) { process.stderr.write('usage: stats-super.mjs <out-dir>\n'); process.exit(2); }
mkdirSync(out, { recursive: true });
const app = await openApp({ suite: 'stats-super' });
const { findings } = app;

const DAY = 86_400_000;
const now = Date.now();
const row = (o) => ({
  mode: 'develop', model: 'opus', superSessions: 14, plainSessions: 22, superRatio: 1, plainRatio: 1,
  superMedian: 1_420_000, plainMedian: 1_780_000, diffPct: -20, window: 'range', windowFrom: now - 30 * DAY, windowTo: now, ...o,
});
const base = {
  verdict: 'reduces', diffPct: -18, measure: 'tokensPerOutput',
  strata: [
    row({}),
    row({ mode: 'plan', model: 'opus', superSessions: 11, plainSessions: 6, plainMedian: 990_000, superMedian: 870_000, diffPct: -12, window: 'before', windowFrom: now - 75 * DAY, windowTo: now - 45 * DAY }),
    row({ mode: 'basic', model: 'sonnet', superSessions: 4, plainSessions: 31, superMedian: 410_000, plainMedian: 380_000, diffPct: null }),
  ],
  overhead: { tokens: 3_200_000, attributed: true }, totals: { super: 41_000_000, plain: 52_000_000 },
  cacheShare: { super: 0.96, plain: 0.95 }, costDiff: -1.4, top: { mode: 'develop', model: 'opus' },
  missing: { strata: 1, unlinkedSuccessors: 2, plainShort: 0, superShort: 4, short: null },
};
const STATES = {
  data: { effect: base },
  increase: { effect: { ...base, verdict: 'increases', diffPct: 14, costDiff: 1.1, strata: [row({ diffPct: 22, superMedian: 2_100_000 }), base.strata[2]] } },
  same: { effect: { ...base, verdict: 'same', diffPct: 4, costDiff: 0.2, strata: [row({ diffPct: 4, superMedian: 1_810_000 })] } },
  tooFew: { effect: { ...base, verdict: 'unknown', diffPct: null, costDiff: null, top: null, strata: [row({ superSessions: 3, diffPct: null })], missing: { strata: 1, unlinkedSuccessors: 0, plainShort: 0, superShort: 3, short: 'super' } } },
  noSuper: { effect: { ...base, verdict: 'noSuper', diffPct: null, costDiff: null, top: null, strata: [], overhead: { tokens: 0, attributed: false }, totals: { super: 0, plain: 52_000_000 }, missing: { strata: 0, unlinkedSuccessors: 0, plainShort: 0, superShort: 0, short: null } } },
  loading: { effect: { ...base, verdict: 'unknown', diffPct: null, strata: [], missing: { strata: 0, unlinkedSuccessors: 0, plainShort: 0, superShort: 0, short: 'ownOnly' } }, scanning: { done: 3, total: 9 } },
};

for (const theme of ['light', 'dark']) {
  for (const [state, fx] of Object.entries(STATES)) {
    await app.look('/?vault=proj', async (page, w) => {
      await page.route('**/api/agent/stats**', async (route) => {
        const res = await route.fetch();
        const json = await res.json().catch(() => null);
        if (!json?.dc) { findings.push(`${state}@${w.name}: the stats answer had no dc block`); return route.fulfill({ response: res }); }
        json.dc.superEffect = fx.effect;
        json.scanning = fx.scanning ?? null;
        return route.fulfill({ response: res, json });
      });
      await page.evaluate((t) => localStorage.setItem('dreamcontext-theme', t), theme);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.keyboard.press('Meta+u');
      await page.getByTestId('stats-page').waitFor({ timeout: 15_000 });
      await page.getByRole('tab', { name: 'dreamcontext', exact: true }).click();
      const card = page.getByTestId('stats-super-effect');
      await card.waitFor({ timeout: 10_000 });
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const want = state === 'loading' ? 'loading' : fx.effect.verdict;
      const got = await card.getAttribute('data-verdict');
      if (got !== want) findings.push(`${state}@${w.name}-${theme}: card shows ${got}, want ${want}`);
      if (await card.evaluate((el) => el.scrollWidth - el.clientWidth) > 1) findings.push(`${state}@${w.name}-${theme}: the card overflows sideways`);
      // A row's grey jobs line must not be cut off (r1 frontend minor, checked here).
      const clipped = await card.locator('.st-tr .dim').evaluateAll((els) => els.filter((e) => e.scrollWidth - e.clientWidth > 1).length);
      if (clipped) findings.push(`${state}@${w.name}-${theme}: ${clipped} grey row line(s) cut off`);
      await card.screenshot({ path: join(out, `super-${state}-${w.width}-${theme}.png`) });
    }, { name: `super-${state}-${theme}` });
  }
}
process.exit(await app.finish());
