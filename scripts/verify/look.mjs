#!/usr/bin/env node
/**
 * Look at a page with no script of your own and no build:
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/look.mjs '/?vault=proj' --expect 'Tasks'
 *
 * Opens each path at 390 and 1440 px on the Vite dev server against a scratch vault, takes the
 * screenshots, and reports console errors, failed requests and sideways overflow. Exit 0 = clean,
 * 1 = findings, 78 = HARNESS: the servers, the build or the first path's shell never came up, so
 * nothing of the product was looked at (and builder heavy does not count the run).
 * --expect <text> must be on the page; --click <text> clicks it first; --build uses dist/ (live
 * chat streaming, which the dev proxy does not carry). See ./lib/app.mjs for a longer check.
 */
import { parseArgs } from 'node:util';
import { openApp } from './lib/app.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    expect: { type: 'string', multiple: true, default: [] },
    click: { type: 'string', multiple: true, default: [] },
    build: { type: 'boolean', default: false },
    name: { type: 'string', default: 'look' },
  },
});

const paths = positionals.length ? positionals : ['/?vault=proj'];
const app = await openApp({ suite: values.name, build: values.build, target: paths[0] });
try {
  for (const [i, path] of paths.entries()) {
    await app.look(path, async (page, w) => {
      for (const text of values.click) await page.getByText(text, { exact: false }).first().click({ timeout: 10_000 });
      for (const text of values.expect) {
        const seen = await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
        if (!seen) app.findings.push(`${values.name}@${w.name}: "${text}" is not on the page`);
      }
    }, { name: `page${i + 1}` });
  }
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
process.exit(await app.finish());
