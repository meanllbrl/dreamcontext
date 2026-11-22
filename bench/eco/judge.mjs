#!/usr/bin/env node
// Blind Opus judge of one run. It sees the task, the change (code diff, plan file) and the agent's
// final message, never the mode, the model or the cost; model names are scrubbed from what it reads.
//   node bench/eco/judge.mjs <task> <runDir> <diffFile> <finalTextFile>   -> one JSON line
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const [task, runDir, diffFile, finalFile] = process.argv.slice(2);
const T = join(HERE, 'tasks', task);
const prompt = existsSync(join(T, 'turns.json'))
  ? JSON.parse(readFileSync(join(T, 'turns.json'), 'utf-8')).turns.map((t, i) => `Request ${i + 1}:\n${t}`).join('\n\n')
  : readFileSync(join(T, 'prompt.md'), 'utf-8');
const scrub = (s) => s.replace(/\b(claude[- ])?(opus|sonnet|haiku|fable|mythos)([- ]?\d+([.-]\d+)?)?(\[1m\])?/gi, '[model]');
const MAX = 120_000;
const clip = (s) => (s.length > MAX ? `${s.slice(0, MAX)}\n…[truncated ${s.length - MAX} chars]` : s);

let diff = readFileSync(diffFile, 'utf-8');
// The brain's bookkeeping (hook state, indexes) is noise; plans and knowledge the agent wrote stay.
diff = diff.split(/^(?=diff --git )/m).filter((h) => !/^diff --git a\/_dream_context\/(state\/\.|\.|inbox\/|core\/CHANGELOG)/.test(h)).join('');
const finalText = existsSync(finalFile) ? readFileSync(finalFile, 'utf-8') : '(no final message)';
const reference = existsSync(join(T, 'judge-reference.md')) ? readFileSync(join(T, 'judge-reference.md'), 'utf-8') : '';

const instructions = `You are grading one AI coding agent's work on a small TypeScript project (a community food pantry's inventory tool). You do not know which agent or configuration produced it; judge only the work.

Score each dimension 0-10 (10 = what a strong senior engineer would hand in; 5 = usable but with real gaps; 0 = missing or wrong):
- correctness: does the change do what the request asks, without bugs you can see?
- completeness: is every part of the request covered (tests asked for, CLI, docs, plan sections)?
- quality: clear, idiomatic, minimal code (or a clear, testable plan / accurate answer).
- scope: stays inside the request; no unrelated rewrites, no invented requirements.
- communication: the final message tells the owner accurately what was done and anything left open.
Then "overall" 0-10: your holistic grade, not an average.
${reference ? `\nReference notes from the task author (facts a correct answer or plan must reflect):\n${reference}\n` : ''}
Reply with ONLY one JSON object, no prose around it:
{"correctness":n,"completeness":n,"quality":n,"scope":n,"communication":n,"overall":n,"notes":"<two sentences: the main strength and the main defect>"}

=== THE REQUEST ===
${prompt}

=== THE CHANGE (git diff against the starting commit) ===
${clip(scrub(diff)) || '(no file changes)'}

=== THE AGENT'S FINAL MESSAGE ===
${clip(scrub(finalText))}`;

const empty = mkdtempSync(join(tmpdir(), 'eco-judge-'));
const r = spawnSync('claude', ['-p', '--model', 'opus', '--effort', 'high', '--output-format', 'json',
  '--setting-sources', 'project,local', '--strict-mcp-config', '--disallowedTools', 'Bash,Read,Edit,Write,Glob,Grep,Agent,WebFetch,WebSearch,Skill'],
{ cwd: empty, input: instructions, encoding: 'utf-8', maxBuffer: 1 << 26, timeout: 20 * 60 * 1000, env: { ...process.env, HOME: process.env.ECO_JUDGE_HOME || process.env.HOME } });
rmSync(empty, { recursive: true, force: true });
let out = null, score = null;
try {
  out = JSON.parse(r.stdout);
  const m = /\{[\s\S]*\}/.exec(out.result);
  score = JSON.parse(m[0]);
} catch { /* reported below */ }
const mu = out?.modelUsage ? Object.values(out.modelUsage).reduce((s, x) => s + (x.costUSD || 0), 0) : null;
console.log(JSON.stringify({ task, runDir, score, judgeCostUsd: mu, error: score ? null : (r.stderr || r.stdout || '').slice(-500) }));
