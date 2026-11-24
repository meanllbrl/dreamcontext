#!/usr/bin/env node
// Proves a task's hidden tests: they must FAIL on the starting code (template + the task's setup/)
// and fully PASS once the task's refsol/ is laid over it. Run through `builder heavy` (vitest + tsc).
//   node bench/eco/validate-tasks.mjs <task> [<task> ...]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = process.env.ECO_BENCH_DIR || '/tmp/eco-benchmark';
let bad = 0;
for (const task of process.argv.slice(2)) {
  const T = join(HERE, 'tasks', task);
  const out = {};
  for (const variant of ['base', 'ref']) {
    const dir = join(BENCH, 'refcheck', `${task}-${variant}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    spawnSync('git', ['clone', '-q', join(BENCH, 'template'), dir]);
    symlinkSync(join(BENCH, 'shared', 'node_modules'), join(dir, 'node_modules'));
    if (existsSync(join(T, 'setup'))) cpSync(join(T, 'setup'), dir, { recursive: true });
    if (variant === 'ref') cpSync(join(T, 'refsol'), dir, { recursive: true });
    const r = spawnSync('node', [join(HERE, 'grade.mjs'), task, dir], { encoding: 'utf-8' });
    out[variant] = JSON.parse(r.stdout.trim().split('\n').pop());
  }
  const ok = out.ref.success === true && out.base.success !== true && out.ref.hiddenTotal > 0;
  if (!ok) bad++;
  console.log(`${task}: base ${out.base.hiddenPassed}/${out.base.hiddenTotal} tsc=${out.base.tscErrors} · ref ${out.ref.hiddenPassed}/${out.ref.hiddenTotal} tsc=${out.ref.tscErrors} · ${ok ? 'VALID' : 'INVALID'}`);
}
process.exit(bad ? 1 : 0);
