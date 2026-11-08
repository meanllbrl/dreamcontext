#!/usr/bin/env node
/**
 * Measures the per-hook output limit of the installed Claude Code, with real headless sessions.
 *
 * Throwaway projects, each with SessionStart hooks that print exact sizes (a head marker,
 * multi-byte filler, a tail marker). After one cheap `claude -p` turn per project, the session
 * transcript records what the model got. A hook that arrived whole has its tail marker; one that
 * was replaced by the harness has the "Output too large" preview instead.
 *
 * Usage:  node scripts/verify/hook-limit.mjs
 * Result: exit 0 when the limit is still the one in lib/snapshot-budget.ts, else exit 1 with the
 * band it moved to. Then set HARNESS_PERSIST_CHAR_LIMIT from a closer run, with date and version.
 * Costs about ten haiku turns: a real measurement, so it is run by hand, never in a test suite.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const MODEL = 'haiku';
/** Keep in step with HARNESS_PERSIST_CHAR_LIMIT; 2.1.216 was 20,000, hence the probes around it. */
const EXPECTED_LIMIT = 10_000;
const PREVIEW = 'Output too large';
const base = mkdtempSync(join(tmpdir(), 'dc-hook-limit-'));

const emitter = join(base, 'emit.mjs');
writeFileSync(emitter, `
const n = Number(process.argv[2]);
const head = 'HEAD' + n + '|';
const tail = '|ZTAIL';
const unit = 'ğüşıöç a';
let f = '';
while (f.length < n - head.length - tail.length) f += unit;
process.stdout.write(head + f.slice(0, n - head.length - tail.length) + tail);
`);

function project(name, sizes) {
  const dir = join(base, name);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const hooks = sizes.map((n) => ({ type: 'command', command: `node ${emitter} ${n}` }));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks }] } }));
  return dir;
}

function runSession(dir) {
  const out = execFileSync('claude', ['-p', 'Reply with the single word ok.', '--model', MODEL,
    '--setting-sources', 'project', '--output-format', 'json'], { cwd: dir, encoding: 'utf-8' });
  return JSON.parse(out).session_id;
}

function transcriptPath(sessionId) {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const root = join(claudeDir, 'projects');
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  throw new Error(`transcript for ${sessionId} not found under ${root}`);
}

function hookDeliveries(sessionId) {
  const rows = [];
  for (const line of readFileSync(transcriptPath(sessionId), 'utf-8').split('\n')) {
    if (!line.includes('"hook_success"')) continue;
    let a;
    try { a = JSON.parse(line).attachment; } catch { continue; }
    if (!a || a.hookEvent !== 'SessionStart') continue;
    const text = Array.isArray(a.content) ? a.content.join('\n') : String(a.content ?? '');
    const head = (text.match(/HEAD(\d+)/) || [])[1];
    rows.push({ head: head ? Number(head) : null, whole: text.includes('ZTAIL'), preview: text.includes(PREVIEW), chars: text.length });
  }
  return rows;
}

const results = {};
for (const n of [2_000, 5_000, EXPECTED_LIMIT - 1, EXPECTED_LIMIT, EXPECTED_LIMIT + 1, 15_000, 20_000, 20_001]) {
  results[`one hook of ${n}`] = hookDeliveries(runSession(project(`single-${n}`, [n])));
}
const perHook = [9_900, 9_910, 9_920];
const multi = hookDeliveries(runSession(project('multi', perHook)));
results['three hooks on one event'] = multi;

let largestWhole = 0;
let smallestCut = Infinity;
for (const [label, rows] of Object.entries(results)) {
  console.log(label);
  for (const r of rows) {
    console.log(`  hook ${r.head}: ${r.whole ? 'WHOLE' : r.preview ? 'PREVIEW (cut)' : 'NOT FOUND'} (${r.chars} chars in model input)`);
    if (label === 'three hooks on one event') continue;
    if (r.whole && r.head) largestWhole = Math.max(largestWhole, r.head);
    if (r.preview) smallestCut = Math.min(smallestCut, Number(label.replace(/\D/g, '')));
  }
}
const version = execFileSync('claude', ['--version'], { encoding: 'utf-8' }).trim();
const samePerHook = multi.length === perHook.length && multi.every((r) => r.whole);
const same = largestWhole === EXPECTED_LIMIT && smallestCut === EXPECTED_LIMIT + 1 && samePerHook;
console.log(`\n${version}: largest whole ${largestWhole}, smallest cut ${smallestCut}, per hook ${samePerHook ? 'yes' : 'NO'}.`);
console.log(same ? `Limit unchanged: ${EXPECTED_LIMIT}.` : `LIMIT MOVED from ${EXPECTED_LIMIT}: fix HARNESS_PERSIST_CHAR_LIMIT and the budgets under it.`);
process.exit(same ? 0 : 1);
