#!/usr/bin/env node
// Dummy goal-skill run: drives the live state file through every phase so the
// viewer (localhost:4747) can be watched end-to-end. No real agents are spawned.
//   node .claude/goal-skill-demo.cjs
const fs = require('fs');
const path = require('path');
const FILE = path.join(process.cwd(), '_dream_context', 'tmp', '.goal-skill-live.json');
fs.mkdirSync(path.dirname(FILE), { recursive: true });
const started = new Date().toISOString();
const F = (s) => ({ s });

// [seconds-to-hold, phase, iters, impl]
const BEATS = [
  [8,  'plan',       { plan: 1 },                                    null],
  [8,  'review',     { plan: 1, review: 1 },                         null],
  [7,  'plan',       { plan: 2, review: 1 },                         null],
  [7,  'review',     { plan: 2, review: 2 },                         null],
  [6,  'plan',       { plan: 3, review: 2 },                         null],
  [6,  'review',     { plan: 3, review: 3 },                         null],
  [5,  'task',       { plan: 3, review: 3 },                         null],
  [8,  'impl',       { plan: 3, review: 3 }, { wave: 1, waves: 3, forks: [F('run'), F('run'), F('run')] }],
  [5,  'impl',       { plan: 3, review: 3 }, { wave: 1, waves: 3, forks: [F('done'), F('run'), F('run')] }],
  [8,  'impl',       { plan: 3, review: 3 }, { wave: 2, waves: 3, forks: [F('done'), F('done'), F('done'), F('run'), F('run')] }],
  [6,  'impl',       { plan: 3, review: 3 }, { wave: 2, waves: 3, forks: [F('done'), F('done'), F('done'), F('run'), F('fail')] }],
  [6,  'impl',       { plan: 3, review: 3 }, { wave: 2, waves: 3, forks: [F('done'), F('done'), F('done'), F('done'), F('run')] }],
  [8,  'impl',       { plan: 3, review: 3 }, { wave: 3, waves: 3, forks: [F('done'), F('done'), F('done'), F('done'), F('done'), F('run')] }],
  [7,  'codereview', { plan: 3, review: 3, codereview: 1 }, { wave: 3, waves: 3, forks: Array(6).fill(F('done')) }],
  [6,  'impl',       { plan: 3, review: 3, codereview: 2 }, { wave: 3, waves: 3, forks: [...Array(5).fill(F('done')), F('run')] }],
  [6,  'codereview', { plan: 3, review: 3, codereview: 2 }, { wave: 3, waves: 3, forks: Array(6).fill(F('done')) }],
  [7,  'validate',   { plan: 3, review: 3, codereview: 2, validate: 1 }, { wave: 3, waves: 3, forks: Array(6).fill(F('done')) }],
  [90, 'done',       { plan: 3, review: 3, codereview: 2, validate: 1 }, { wave: 3, waves: 3, forks: Array(6).fill(F('done')) }],
];

let i = 0;
function step() {
  if (i >= BEATS.length) {
    fs.rmSync(FILE, { force: true });
    console.log('demo finished — state cleared');
    return;
  }
  const [hold, phase, iters, impl] = BEATS[i];
  const st = { goal: 'demo-dummy-goal', started, updated: new Date().toISOString(), phase, iters };
  // Scope the demo run to the launching session (if any) — same contract as a real run.
  if (process.env.CLAUDE_CODE_SESSION_ID) st.session = process.env.CLAUDE_CODE_SESSION_ID;
  if (impl) st.impl = impl;
  fs.writeFileSync(FILE, JSON.stringify(st));
  console.log(`beat ${i + 1}/${BEATS.length}: ${phase}` + (impl ? ` wave ${impl.wave}/${impl.waves}` : ''));
  i++;
  setTimeout(step, hold * 1000);
}
step();
