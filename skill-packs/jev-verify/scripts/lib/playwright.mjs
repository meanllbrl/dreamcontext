/**
 * Playwright is NOT shipped with this pack and is not a dreamcontext dependency. These scripts
 * live under `.claude/skills/jev-verify/scripts/` in the USER's project, so `import('playwright')`
 * from here would resolve against this folder, not the project. We resolve explicitly, in order:
 *
 *   1. the project's own node_modules (cwd) — `playwright`, then `@playwright/test`
 *   2. the global npm root — `npm root -g`
 *
 * and fail with the exact install command otherwise. `unobtainable` here means the harness could
 * not run at all, which is a different verdict from FAIL and gets exit code 2.
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const INSTALL_HINT = 'unobtainable: Playwright is not installed. Run `npm i -D playwright && npx playwright install chromium` in this project (or `npm i -g playwright && npx playwright install chromium`). Nothing was judged.';

function tryResolve(fromDir, name) {
  try {
    return createRequire(join(fromDir, 'package.json')).resolve(name);
  } catch {
    return null;
  }
}

/** Returns `{ chromium, devices, source }`; throws an Error whose message starts with `unobtainable:`. */
export async function loadPlaywright({ cwd = process.cwd() } = {}) {
  const candidates = [
    { dir: cwd, name: 'playwright', source: 'project' },
    { dir: cwd, name: '@playwright/test', source: 'project (@playwright/test)' },
  ];
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (globalRoot) {
      candidates.push({ dir: globalRoot, name: 'playwright', source: 'global' });
      candidates.push({ dir: globalRoot, name: '@playwright/test', source: 'global (@playwright/test)' });
    }
  } catch { /* npm missing: only project candidates */ }

  for (const c of candidates) {
    const resolved = tryResolve(c.dir, c.name);
    if (!resolved) continue;
    const mod = await import(pathToFileURL(resolved).href);
    const pw = mod.default?.chromium ? mod.default : mod;
    if (pw.chromium) return { chromium: pw.chromium, devices: pw.devices ?? {}, source: c.source };
  }
  throw new Error(INSTALL_HINT);
}

/** A named device preset or a desktop viewport. `desktop` is the default. */
export function contextOptions(devices, device = 'desktop') {
  if (device === 'desktop' || !device) return { viewport: { width: 1440, height: 1000 }, locale: 'en-US' };
  const preset = devices[device] ?? devices[{ iphone: 'iPhone 13', android: 'Pixel 7', ipad: 'iPad (gen 7)' }[device] ?? ''];
  if (!preset) throw new Error(`unknown device "${device}" — use desktop, iphone, android, ipad, or a Playwright device name`);
  return { ...preset, locale: 'en-US' };
}
