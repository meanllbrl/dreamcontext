#!/usr/bin/env node
/**
 * measure.mjs: before/after sizes for the instructions-slim wave.
 *
 *   node eval/instructions-slim/measure.mjs [--json] [--root <dir>]
 *
 * Files are measured in BYTES (what `wc -c` reports and what the goal states in
 * KB). The SubagentStart briefing is measured in CHARS (JS string length), the
 * unit the harness limit and the briefing budget are defined in; its bytes are
 * shown for information only, because the pinned banners carry multi-byte
 * Turkish characters.
 *
 * The "after" briefing comes from the BUILT CLI (`dist/index.js`), so run
 * `npm run build` first. DREAMCONTEXT_SNAPSHOT_BUDGET is removed from the
 * child's environment so the briefing is measured at its default budget.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BaselineError, DEFAULT_ROOT, UsageError, readBaseline, verifyBaseline,
} from './lib.mjs';

function parseArgs(argv) {
  const opts = { json: false, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--root') {
      const value = argv[++i];
      if (!value) throw new UsageError('--root needs a directory');
      opts.root = resolve(value);
    } else throw new UsageError(`Unknown argument: ${arg}`);
  }
  return opts;
}

function fileBytes(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function agentsSum(root) {
  const dir = join(root, 'agents');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .reduce((total, f) => total + statSync(join(dir, f)).size, 0);
}

function currentBriefing(root) {
  const cli = join(root, 'dist', 'index.js');
  if (!existsSync(cli)) throw new UsageError(`No built CLI at ${cli}. Run \`npm run build\` first.`);
  const env = { ...process.env };
  delete env.DREAMCONTEXT_SNAPSHOT_BUDGET;
  const stdout = execFileSync(process.execPath, [cli, 'hook', 'subagent-start'], {
    cwd: root, env, input: '', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new UsageError(`hook subagent-start did not print JSON (${err.message}); first 200 chars: ${stdout.slice(0, 200)}`);
  }
  const text = parsed?.hookSpecificOutput?.additionalContext;
  if (typeof text !== 'string') throw new UsageError('hook subagent-start JSON has no hookSpecificOutput.additionalContext');
  return text;
}

function row(name, unit, before, after) {
  const delta = before === 0 ? null : ((after - before) / before) * 100;
  return { name, unit, before, after, deltaPct: delta === null ? null : Math.round(delta * 10) / 10 };
}

function measure(root) {
  const verified = verifyBaseline(root);
  const sizes = JSON.parse(readBaseline(root, verified, 'sizes.json'));
  const baselineAgentsSum = Object.values(sizes.agents).reduce((a, b) => a + b, 0);
  const bytesOf = (name) => Buffer.byteLength(readBaseline(root, verified, name), 'utf8');

  const rows = [
    row('skill/SKILL.md', 'B', bytesOf('SKILL.md'), fileBytes(join(root, 'skill', 'SKILL.md'))),
    row('agents/sleep-tasks.md', 'B', bytesOf('sleep-tasks.md'), fileBytes(join(root, 'agents', 'sleep-tasks.md'))),
    row('agents/sleep-product.md', 'B', bytesOf('sleep-product.md'), fileBytes(join(root, 'agents', 'sleep-product.md'))),
    row('agents/sleep-state.md', 'B', bytesOf('sleep-state.md'), fileBytes(join(root, 'agents', 'sleep-state.md'))),
    row('agents/*.md (sum)', 'B', baselineAgentsSum, agentsSum(root)),
    row('skill-agent-core/SKILL.md', 'B', sizes.agentCore, fileBytes(join(root, 'skill-agent-core', 'SKILL.md'))),
  ];

  const beforeBriefing = readBaseline(root, verified, 'briefing.txt');
  const afterBriefing = currentBriefing(root);
  rows.push(row('SubagentStart briefing', 'chars', beforeBriefing.length, afterBriefing.length));
  rows.push(row('SubagentStart briefing (info)', 'B',
    Buffer.byteLength(beforeBriefing, 'utf8'), Buffer.byteLength(afterBriefing, 'utf8')));
  return rows;
}

function printTable(rows) {
  const header = ['what', 'unit', 'before', 'after', 'delta'];
  const body = rows.map((r) => [
    r.name, r.unit, String(r.before), String(r.after),
    r.deltaPct === null ? 'n/a' : `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct}%`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => `| ${cells.map((c, i) => (i >= 2 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join(' | ')} |`;
  console.log(line(header));
  console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  for (const b of body) console.log(line(b));
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const rows = measure(opts.root);
  if (opts.json) console.log(JSON.stringify({ rows }, null, 2));
  else printTable(rows);
} catch (err) {
  if (err instanceof BaselineError || err instanceof UsageError) {
    console.error(`measure: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
