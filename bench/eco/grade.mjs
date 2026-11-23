#!/usr/bin/env node
// Hidden-test grade of one checkout: copies the task's hidden tests in, runs vitest (JSON) and the
// type-check of the agent's own code, then removes the hidden tests again.
//   node bench/eco/grade.mjs <task> <checkoutDir>   -> prints one JSON line
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const [task, dir] = process.argv.slice(2);
const hiddenDir = join(HERE, 'tasks', task, 'hidden');
const hidden = existsSync(hiddenDir) ? readdirSync(hiddenDir).filter((f) => f.endsWith('.test.ts')) : [];
const bin = (n) => join(dir, 'node_modules', '.bin', n);

// Type-check first, without the hidden tests (they are not the agent's code).
const tsc = spawnSync(bin('tsc'), ['--noEmit', '-p', '.'], { cwd: dir, encoding: 'utf-8' });
const tscErrors = (tsc.stdout.match(/error TS/g) || []).length;

let total = 0, passed = 0, loadFail = 0;
const perFile = {};
if (hidden.length) {
  for (const f of hidden) cpSync(join(hiddenDir, f), join(dir, 'tests', f));
  const out = join(dir, '.grade.vitest.json');
  spawnSync(bin('vitest'), ['run', ...hidden.map((f) => `tests/${f}`), '--reporter=json', `--outputFile=${out}`], { cwd: dir, encoding: 'utf-8', timeout: 300000 });
  try {
    const v = JSON.parse(readFileSync(out, 'utf-8'));
    for (const r of v.testResults) {
      const name = r.name.split('/').pop();
      const a = r.assertionResults || [];
      if (!a.length) loadFail++;
      // A file that fails to load (missing module) counts all of its tests as failed.
      const expected = (readFileSync(join(hiddenDir, name), 'utf-8').match(/^it\(/gm) || []).length;
      const p = a.filter((x) => x.status === 'passed').length;
      perFile[name] = { passed: p, total: Math.max(expected, a.length) };
      passed += p;
      total += Math.max(expected, a.length);
    }
  } catch { /* no report: everything failed */ }
  for (const f of hidden) if (!perFile[f]) { const n = (readFileSync(join(hiddenDir, f), 'utf-8').match(/^it\(/gm) || []).length; perFile[f] = { passed: 0, total: n }; total += n; }
  for (const f of hidden) rmSync(join(dir, 'tests', f), { force: true });
  rmSync(out, { force: true });
}
// The project's own suite (the agent's tests plus the original ones) must still pass.
const own = spawnSync(bin('vitest'), ['run', '--reporter=json', `--outputFile=${join(dir, '.grade.own.json')}`], { cwd: dir, encoding: 'utf-8', timeout: 300000 });
let ownTotal = 0, ownPassed = 0;
try { const v = JSON.parse(readFileSync(join(dir, '.grade.own.json'), 'utf-8')); ownTotal = v.numTotalTests; ownPassed = v.numPassedTests; } catch { /* none */ }
rmSync(join(dir, '.grade.own.json'), { force: true });

const res = { task, hiddenTotal: total, hiddenPassed: passed, loadFail, perFile, tscErrors, ownTotal, ownPassed, ownExit: own.status };
res.success = hidden.length ? passed === total && total > 0 && tscErrors === 0 : null;
console.log(JSON.stringify(res));
