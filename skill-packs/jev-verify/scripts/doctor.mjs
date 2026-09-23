#!/usr/bin/env node
/**
 * doctor — proves the pack can run HERE, before anyone writes a spec.
 *
 *   node .claude/skills/jev-verify/scripts/doctor.mjs
 *
 * Five checks, each with evidence: the key resolves (and from WHERE — never the value), Playwright
 * resolves (and from where), the Chromium binary exists (the first wall most projects hit — the
 * module installs without the browser), Chromium launches, and one 1-question Jev ping
 * round-trips with its latency and cost. Exit 0 when all hold, 2 otherwise.
 */

import { existsSync } from 'node:fs';
import { resolveKey, createJev, noul, KEY_NAME, EXIT } from './lib/jev.mjs';
import { loadPlaywright } from './lib/playwright.mjs';
import { say, assertKeyNotOnArgv } from './lib/report.mjs';

const ok = (label, detail) => say(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail) => say(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);

let healthy = true;
say('jev-verify doctor');

const { key, source, refused } = resolveKey();
assertKeyNotOnArgv(key);
if (key) ok(`${KEY_NAME} present`, `source: ${source}, ${key.length} chars`);
else if (refused) { bad(`${KEY_NAME} refused`, refused); healthy = false; }
else { bad(`${KEY_NAME} missing`, 'export it, put it in a gitignored ./.env, or (in Chat) request it with a dream-view secret card'); healthy = false; }

let pw = null;
try {
  pw = await loadPlaywright();
  ok('Playwright resolves', `source: ${pw.source}`);
} catch (e) { bad('Playwright missing', String(e.message).replace(/^unobtainable:\s*/, '')); healthy = false; }

if (pw) {
  let exe = null;
  try { exe = pw.chromium.executablePath(); } catch { /* older API */ }
  if (exe && !existsSync(exe)) { bad('Chromium binary missing', `expected at ${exe} — run: npx playwright install chromium`); healthy = false; }
  else {
    try {
      const b = await pw.chromium.launch();
      const v = b.version();
      await b.close();
      ok('Chromium launches', `v${v}`);
    } catch (e) { bad('Chromium does not launch', `${String(e.message).split('\n')[0].slice(0, 120)} — try: npx playwright install chromium`); healthy = false; }
  }
}

if (key) {
  try {
    const jev = createJev({ key });
    const { answers, ms, usage } = await jev.ask({ note: 'doctor ping from jev-verify' }, { alive: noul('Is this state a diagnostic ping?') });
    ok('Jev answers', `p=${Number(answers.alive?.noul ?? 0).toFixed(2)} in ${ms} ms · $${Number(usage.cost ?? 0).toFixed(6)}`);
  } catch (e) { bad('Jev call failed', String(e.message).slice(0, 160)); healthy = false; }
}

say(healthy ? '\nREADY' : '\nUNOBTAINABLE — fix the ✗ lines above; nothing can be judged until they pass.');
process.exit(healthy ? EXIT.PASS : EXIT.UNOBTAINABLE);
