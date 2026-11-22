#!/usr/bin/env node
// Eco benchmark driver: one (task, mode, rep) run of a real `claude -p` session on the fictional
// Pinewood Pantry project, with this checkout's dreamcontext hooks. Resumable: every finished run
// is one line in $BENCH/journal.jsonl and is skipped on the next call.
//
//   node bench/eco/run.mjs <task> <off|eco|plus> <rep>
//
// Modes are this Mac's real saving-mode setting, written into a per-mode fake HOME
// (`~/.dreamcontext/agent-ui.json`), so the owner's own setting is never touched:
//   off  = ecoMode false            -> the chat runs Opus, no handoff nudge
//   eco  = ecoMode true             -> Opus, handoff nudge past the context threshold
//   plus = ecoMode true, ecoPlus    -> a saved-default chat is lowered to Sonnet (plan eco-plus K1),
//                                      sub-agents rewritten by the PreToolUse hook, judges kept on Opus
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const WT = resolve(HERE, '../..');
const BENCH = process.env.ECO_BENCH_DIR || '/tmp/eco-benchmark';
const JOURNAL = join(BENCH, 'journal.jsonl');
const MODEL = { off: 'opus', eco: 'opus', plus: 'sonnet' };

const [task, mode, rep] = process.argv.slice(2);
if (!task || !MODEL[mode] || !rep) {
  console.error('usage: run.mjs <task> <off|eco|plus> <rep>');
  process.exit(2);
}
const key = `${task}/${mode}/${rep}`;

function journal() {
  if (!existsSync(JOURNAL)) return [];
  return readFileSync(JOURNAL, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
if (journal().some((r) => r.key === key && r.status === 'done')) {
  console.log(`skip ${key} (done)`);
  process.exit(0);
}

const TASK = join(HERE, 'tasks', task);
const DIR = join(BENCH, 'runs', task, mode, rep);
const HOME = join(BENCH, `home-${mode}`);
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r;
};

// ---- fresh checkout of the template, plus the task's setup files ----
rmSync(DIR, { recursive: true, force: true });
mkdirSync(dirname(DIR), { recursive: true });
sh('git', ['clone', '-q', join(BENCH, 'template'), DIR]);
sh('git', ['remote', 'remove', 'origin'], { cwd: DIR });
symlinkSync(join(BENCH, 'shared', 'node_modules'), join(DIR, 'node_modules'));
if (existsSync(join(TASK, 'setup'))) cpSync(join(TASK, 'setup'), DIR, { recursive: true });
const git = (args) => sh('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', ...args], { cwd: DIR });
git(['add', '-A']);
git(['commit', '-qm', 'task setup', '--allow-empty']);
const BASE = sh('git', ['rev-parse', 'HEAD'], { cwd: DIR }).stdout.trim();

// ---- the session(s) ----
const OWNER = 'The owner is away for this whole run: never wait for an answer, decide open questions yourself and say what you decided. Work only inside this checkout. Commit your work locally when done.';
const turns = existsSync(join(TASK, 'turns.json'))
  ? JSON.parse(readFileSync(join(TASK, 'turns.json'), 'utf-8')).turns
  : [readFileSync(join(TASK, 'prompt.md'), 'utf-8').trim()];

const env = {
  ...process.env,
  HOME,
  PATH: `${join(BENCH, 'bin')}:${process.env.PATH}`,
};
for (const k of Object.keys(env)) if (k.startsWith('DREAMCONTEXT_') || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];

const handoffDir = join(DIR, '_dream_context', 'state', '.handoff-requests');
const seenHandoffs = new Set();
function newHandoff() {
  if (!existsSync(handoffDir)) return null;
  for (const f of readdirSync(handoffDir).filter((n) => n.endsWith('.json')).sort()) {
    const rec = JSON.parse(readFileSync(join(handoffDir, f), 'utf-8'));
    const id = `${f}:${rec.at}`;
    if (seenHandoffs.has(id)) continue;
    seenHandoffs.add(id);
    return rec;
  }
  return null;
}
// The app's continue prompt (src/lib/context-watch.ts handoffContinuePrompt, task kind).
const continuePrompt = (rec) =>
  `Handoff: continue task ${rec.title} (${rec.task}). Read _dream_context/state/${rec.task}.md first, then carry on from its latest changelog entry.`;

const sessions = [];
let sid = null;
const t0 = Date.now();
function claude(prompt, resume) {
  const args = ['-p', prompt, '--model', MODEL[mode], '--permission-mode', 'bypassPermissions', '--output-format', 'json',
    '--setting-sources', 'project,local', '--strict-mcp-config'];
  if (resume) args.push('--resume', sid);
  else { sid = randomUUID(); args.push('--session-id', sid); }
  const s0 = Date.now();
  const r = spawnSync('claude', args, { cwd: DIR, env, encoding: 'utf-8', maxBuffer: 1 << 28, timeout: 90 * 60 * 1000 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* recorded as error */ }
  sessions.push({ sid, resume: !!resume, ms: Date.now() - s0, exit: r.status, signal: r.signal, out, stderr: (r.stderr || '').slice(-2000) });
  return out;
}

for (let i = 0; i < turns.length; i++) {
  const prompt = i === 0 ? `${turns[i]}\n\n${OWNER}` : turns[i];
  claude(prompt, i > 0);
  // Eco: the app rotates a pane whose session wrote a handoff record: a fresh session opens on the
  // continue prompt, and the owner's next message lands there.
  const rec = newHandoff();
  if (rec && i < turns.length - 1) claude(continuePrompt(rec), false);
}
const wallMs = Date.now() - t0;

// ---- snapshot of the result for grading and judging ----
git(['add', '-A']);
const diff = sh('git', ['diff', '--cached', BASE, '--', '.', ':(exclude)node_modules'], { cwd: DIR }).stdout;
writeFileSync(join(DIR, '..', `${rep}.diff`), diff);
writeFileSync(join(DIR, '..', `${rep}.sessions.json`), JSON.stringify(sessions, null, 1));
const last = sessions[sessions.length - 1]?.out;
const ok = sessions.every((s) => s.exit === 0 && s.out && !s.out.is_error);
appendFileSync(JOURNAL, JSON.stringify({
  key, task, mode, rep: Number(rep), status: 'done', ok, base: BASE, wallMs,
  sessions: sessions.map((s) => ({ sid: s.sid, resume: s.resume, ms: s.ms, exit: s.exit })),
  finalText: last?.result ?? null,
  at: new Date().toISOString(),
}) + '\n');
console.log(`${key} done ok=${ok} wall=${Math.round(wallMs / 1000)}s sessions=${sessions.length}`);
