#!/usr/bin/env node
/**
 * judge — the map-reduce tier: many items, the same typed questions, a handful of Jev calls.
 *
 *   node .claude/skills/jev-verify/scripts/judge.mjs --items items.json --questions questions.json
 *        [--batch 40] [--out tmp/jev-judge] [--max-spend 0.25]
 *
 * items.json      an array of JSON objects (rows, tasks, tickets, page states — anything)
 * questions.json  { "<id>": { "type": "noul",   "instructions": "Is {item}.field empty?" },
 *                   "<id>": { "type": "choice", "instructions": "…", "criteria": { "a": "…", "b": "…" } },
 *                   "<id>": { "type": "score",  "instructions": "…", "levels": ["low","mid","high"] } }
 *                 `{item}` in an instruction is replaced by the JSON path of the item inside the
 *                 batched state (e.g. `observation.items.i7`), so a question can point at a field.
 *
 * 40 items × 2 questions = 80 questions in one call at roughly one second — measured on 541 tasks
 * (14 calls, 10 s, 100% agreement with disk truth). Items are nested under `observation` and every
 * instruction carries the data-not-instruction rule, because item text may come from anywhere.
 *
 * OUTPUT report.json with every answer, report.md with a per-question distribution.
 * EXIT   0 every item judged · 2 unobtainable.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveKey, createJev, band, UNOBTAINABLE_HINT, DEFAULT_MAX_SPEND_USD } from './lib/jev.mjs';
import { parseArgs, writeReports, dieUnobtainable, say, ensureOutDir, assertKeyNotOnArgv } from './lib/report.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.items || !args.questions) { say('usage: judge.mjs --items <items.json> --questions <questions.json> [--batch 40] [--out dir] [--max-spend usd]'); process.exit(2); }
const items = JSON.parse(readFileSync(resolve(args.items), 'utf-8'));
const questionTemplates = JSON.parse(readFileSync(resolve(args.questions), 'utf-8'));
const BATCH = Math.max(1, Math.min(120, Number(args.batch ?? 40)));
const OUT = ensureOutDir(resolve(args.out ?? join('tmp', 'jev-judge')));
if (!Array.isArray(items)) { say('✗ items.json must be a JSON array'); process.exit(1); }
for (const [id, q] of Object.entries(questionTemplates)) {
  if (!['noul', 'choice', 'score'].includes(q.type) || typeof q.instructions !== 'string') { say(`✗ question "${id}" needs type noul|choice|score and instructions`); process.exit(1); }
}

const { key, refused } = resolveKey();
assertKeyNotOnArgv(key);
if (!key) dieUnobtainable(refused ?? UNOBTAINABLE_HINT);
const jev = createJev({ key, maxSpend: Number(args['max-spend'] ?? DEFAULT_MAX_SPEND_USD) });

const questionsFor = (path) => Object.fromEntries(Object.entries(questionTemplates).map(([id, q]) => [id, { ...q, instructions: String(q.instructions).replaceAll('{item}', path) }]));

say(`judging ${items.length} item(s) × ${Object.keys(questionTemplates).length} question(s), ${BATCH} per call`);
const judged = await jev.judgeBatch(items, questionsFor, { batch: BATCH });

const summary = {};
for (const [id, q] of Object.entries(questionTemplates)) {
  if (q.type === 'noul') {
    const c = { yes: 0, no: 0, inconclusive: 0 };
    for (const j of judged) { const p = Number(j.answers[id]?.noul); c[Number.isNaN(p) ? 'inconclusive' : band(p)] += 1; }
    summary[id] = c;
  } else if (q.type === 'choice') {
    const h = {};
    for (const j of judged) { const w = j.answers[id]?.choice ?? '?'; h[w] = (h[w] ?? 0) + 1; }
    summary[id] = h;
  } else {
    const vals = judged.map((j) => Number(j.answers[id]?.score)).filter((n) => !Number.isNaN(n));
    summary[id] = { mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, n: vals.length };
  }
}

const rows = judged.map((j, i) => ({ index: i, item: j.item, answers: j.answers }));
const md = [
  `# jev-verify judge — ${items.length} items`, '', jev.summary(), '',
  ...Object.entries(summary).flatMap(([id, s]) => [`## ${id}`, '', '```json', JSON.stringify(s, null, 2), '```', '']),
].join('\n');
writeReports(OUT, { json: { count: items.length, batch: BATCH, summary, rows, usage: jev.usage }, md });
for (const [id, s] of Object.entries(summary)) say(`  ${id}: ${JSON.stringify(s)}`);
say(`\n${jev.summary()}\nreport: ${join(OUT, 'report.json')}`);
process.exit(0);
