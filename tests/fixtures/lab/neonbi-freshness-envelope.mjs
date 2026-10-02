// NeonBI-shaped freshness fixture for the Lab freshness gate (tests only).
//
// A product vault's `lab/scripts/lib-neonbi.mjs` reads a NeonBI table whose
// metadata carries `tableLastModified` (when the warehouse table was last
// written) and `dataThrough` (the last complete day in it). This fixture plays
// that source offline and maps it onto the GENERIC freshness envelope the engine
// understands — nothing NeonBI-specific lives in the engine:
//
//   tableLastModified → marker   (changes exactly when the data can have changed)
//   dataThrough       → asOf
//   a short sentence  → note     (surfaced as `freshnessNote`, plain text)
//
// State comes from `lab/scripts/neonbi-state.json` beside the copied script;
// every call appends one line (`freshness` or `data`) to
// `lab/scripts/neonbi-calls.log` so a test can count probes vs fetches.

import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function scriptsDir(ctx) {
  // manifest.path = <ctx>/lab/insights/<slug>.md → <ctx>/lab/scripts
  return join(dirname(dirname(ctx.manifest.path)), 'scripts');
}

function readTable(ctx) {
  return JSON.parse(readFileSync(join(scriptsDir(ctx), 'neonbi-state.json'), 'utf-8'));
}

function log(ctx, what) {
  appendFileSync(join(scriptsDir(ctx), 'neonbi-calls.log'), `${what}\n`);
}

function toFreshness(meta) {
  return {
    marker: meta.tableLastModified,
    asOf: meta.dataThrough,
    note: `NeonBI table refreshed ${meta.tableLastModified}, data through ${meta.dataThrough}`,
  };
}

/** The cheap question: has the table been written since last time? */
export async function freshness(ctx) {
  log(ctx, 'freshness');
  return toFreshness(readTable(ctx).meta);
}

/** The real query: rows plus the marker they were read under. */
export default async function (ctx) {
  log(ctx, 'data');
  const table = readTable(ctx);
  return {
    data: [{ name: 'default', points: table.rows.map((r) => ({ t: r.date, v: r.value })) }],
    freshness: toFreshness(table.meta),
  };
}
