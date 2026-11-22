#!/usr/bin/env node
// Scores every finished run in the journal once (tokens + $, hidden tests, blind judge) into
// $BENCH/results/<task>__<mode>__<rep>.json. Resumable: a run with a complete result is skipped.
//   node bench/eco/score.mjs [--no-judge]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureRun } from './measure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = process.env.ECO_BENCH_DIR || '/tmp/eco-benchmark';
const OUT = join(BENCH, 'results');
mkdirSync(OUT, { recursive: true });
const noJudge = process.argv.includes('--no-judge');
const noGrade = process.argv.includes('--no-grade');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

const rows = readFileSync(join(BENCH, 'journal.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 'done');
for (const r of rows) {
  if (only && !r.key.startsWith(only)) continue;
  const file = join(OUT, `${r.key.replaceAll('/', '__')}.json`);
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {};
  if (prev.at === r.at && (noGrade || prev.grade) && (noJudge || prev.judge?.score)) continue;
  const dir = join(BENCH, 'runs', r.task, r.mode, String(r.rep));
  const res = { ...prev, key: r.key, task: r.task, mode: r.mode, rep: r.rep, at: r.at, ok: r.ok, wallMs: r.wallMs, sessions: r.sessions.length };
  res.usage = measureRun(dir, r.sessions.map((s) => s.sid));
  if (!noGrade && (!prev.grade || prev.at !== r.at)) {
    const g = spawnSync('node', [join(HERE, 'grade.mjs'), r.task, dir], { encoding: 'utf-8' });
    res.grade = JSON.parse(g.stdout.trim().split('\n').pop());
  }
  if (!noJudge && (!prev.judge?.score || prev.at !== r.at)) {
    const finalFile = join(dir, '..', `${r.rep}.final.txt`);
    writeFileSync(finalFile, r.finalText ?? '');
    const j = spawnSync('node', [join(HERE, 'judge.mjs'), r.task, dir, join(dir, '..', `${r.rep}.diff`), finalFile],
      { encoding: 'utf-8', env: { ...process.env, ECO_JUDGE_HOME: join(BENCH, 'home-judge') } });
    try { res.judge = JSON.parse(j.stdout.trim().split('\n').pop()); } catch { res.judge = { error: j.stderr.slice(-500) }; }
  }
  writeFileSync(file, JSON.stringify(res, null, 1));
  console.log(`${r.key} usd=${res.usage.usd.toFixed(3)} hidden=${res.grade?.hiddenPassed ?? '-'}/${res.grade?.hiddenTotal ?? '-'} judge=${res.judge?.score?.overall ?? '-'}`);
}
