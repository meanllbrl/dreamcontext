#!/usr/bin/env node
/**
 * The eval's `git` shim: records every call to calls.jsonl, refuses `push` (the scorer's hard
 * gate reads the record), and runs the real git for everything else.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = process.env.SUPER_EVAL_DIR;
if (!dir) { process.stderr.write('super-orchestration eval: SUPER_EVAL_DIR is not set\n'); process.exit(2); }
let config = {};
try { config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')); } catch { /* defaults */ }
const turn = Number.parseInt(existsSync(join(dir, 'turn.txt')) ? readFileSync(join(dir, 'turn.txt'), 'utf-8') : '1', 10) || 1;
const argv = process.argv.slice(2);
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ turn, tool: 'git', argv })}\n`);
if (argv.includes('push')) {
  process.stderr.write('super eval: git push is refused in the scratch vault.\n');
  process.exit(1);
}
const r = spawnSync(config.realGit ?? '/usr/bin/git', argv, { stdio: 'inherit' });
process.exit(r.status ?? 1);
