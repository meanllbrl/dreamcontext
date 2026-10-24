#!/usr/bin/env node
/**
 * The eval's `dreamcontext` shim, first on PATH inside the scratch vault.
 *   - `dreamcontext super <verb>`: recorded to calls.jsonl and answered by handler.mjs
 *     (no app, no children); `super --help` passes through.
 *   - the verbs the sleep-eval shim refuses (anything that reaches outside the vault): recorded,
 *     not run, exit 1 (the same lists, written into config.json by the runner).
 *   - everything else passes through to the real built CLI with HOME pinned to the scratch home
 *     (read verbs: memory recall, tasks list, ...).
 * State lives in SUPER_EVAL_DIR: config.json (read), turn.txt (read), calls.jsonl, counters.json,
 * started.json (written).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { handleSuper } from './handler.mjs';

const dir = process.env.SUPER_EVAL_DIR;
if (!dir) { process.stderr.write('super-orchestration eval: SUPER_EVAL_DIR is not set\n'); process.exit(2); }
const readJson = (f, d) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')); } catch { return d; } };
const config = readJson('config.json', {});
const turn = Number.parseInt(existsSync(join(dir, 'turn.txt')) ? readFileSync(join(dir, 'turn.txt'), 'utf-8') : '1', 10) || 1;
const argv = process.argv.slice(2);
const record = (extra = {}) => appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ turn, tool: 'super', argv, ...extra })}\n`);

function passthrough() {
  const r = spawnSync(config.nodeBin, [config.cliEntry, ...argv], { stdio: 'inherit', env: { ...process.env, HOME: config.home } });
  process.exit(r.status ?? 1);
}

if (argv[0] === 'super') {
  const ctx = {
    machine: config.machine ?? 'ok',
    children: config.children ?? [],
    counters: readJson('counters.json', { child: 0, pool: 0, ask: 0 }),
    started: readJson('started.json', []),
  };
  const r = handleSuper(argv, ctx);
  if (r.passthrough) passthrough();
  record(r.held ? { held: true } : {});
  writeFileSync(join(dir, 'counters.json'), JSON.stringify(ctx.counters));
  writeFileSync(join(dir, 'started.json'), JSON.stringify(ctx.started));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.exit);
}

const pair = `${argv[0] ?? ''} ${argv[1] ?? ''}`;
if ((config.refusedPairs ?? []).some((p) => pair === p)) {
  record({ refused: true });
  process.stdout.write(`super eval: \`dreamcontext ${pair}\` is recorded, not run, in the scratch vault.\n`);
  process.exit(0);
}
if ((config.refusedVerbs ?? []).includes(argv[0])) {
  record({ refused: true });
  process.stderr.write(`super eval: \`dreamcontext ${argv[0]}\` is disabled in the scratch vault.\n`);
  process.exit(1);
}
passthrough();
