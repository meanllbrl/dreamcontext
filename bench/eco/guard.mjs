#!/usr/bin/env node
// Spend guard for a benchmark round: measures every finished run (no grade, no judge), sums the
// list-price spend since the round's baseline plus the judges still to come, and writes $BENCH/STOP
// once that reaches the limit. Prints one line per check.
//   node bench/eco/guard.mjs <baselineUsd> <limitUsd>
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = process.env.ECO_BENCH_DIR || '/tmp/eco-benchmark';
const [baseline, limit] = process.argv.slice(2).map(Number);
const JUDGE_EST = 0.09;
spawnSync('node', [join(HERE, 'score.mjs'), '--no-grade', '--no-judge'], { cwd: BENCH, encoding: 'utf-8' });
let runs = 0, judges = 0, unjudged = 0, n = 0;
for (const f of readdirSync(join(BENCH, 'results')).filter((x) => x.endsWith('.json'))) {
  const r = JSON.parse(readFileSync(join(BENCH, 'results', f), 'utf-8'));
  runs += r.usage?.usd ?? 0; n++;
  if (r.judge?.judgeCostUsd) judges += r.judge.judgeCostUsd;
  else if (r.mode === 'off' || r.mode === 'plus') unjudged++;
}
const round = runs + judges - baseline + unjudged * JUDGE_EST;
const stop = round >= limit;
if (stop && !existsSync(join(BENCH, 'STOP'))) writeFileSync(join(BENCH, 'STOP'), `round spend ${round.toFixed(2)} >= ${limit}\n`);
console.log(`${new Date().toISOString().slice(11, 19)} runs=${n} round=$${round.toFixed(2)} (runs $${runs.toFixed(2)} judges $${judges.toFixed(2)} pending ${unjudged}) ${stop ? 'STOP' : 'ok'}`);
