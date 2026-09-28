#!/usr/bin/env node
// Dummy goal-skill run: drives the live state file through every phase so the in-app
// quest map (and the standalone viewer at localhost:4747) can be watched end-to-end.
// No real agents are spawned, and every number here is FICTIONAL (the `ctx` values
// included): a real run gets them from `dreamcontext goal-live --context-of`, never
// from a hand-written file.
//   node .claude/goal-skill-demo.cjs
const fs = require('fs');
const path = require('path');
const FILE = path.join(process.cwd(), '_dream_context', 'tmp', '.goal-skill-live.json');
fs.mkdirSync(path.dirname(FILE), { recursive: true });
const started = new Date().toISOString();
const DEMO_CTX = 182000;

const F = (s, id, name) => ({ s, id, name, role: 'implementer' });
const J = (s, id, v) => (v ? { s, id, role: id, v } : { s, id, role: id });
const LENSES = ['critic', 'pragmatist', 'edge-cases'];
const lenses = (s, v) => LENSES.map((id) => J(s, id, v && v[id]));

// Each beat: [seconds-to-hold, phase, iters, impl, judges, lineage events added by this beat]
// Lineage events are appended in order, the way the CLI would record them.
const BEATS = [
  [8, 'plan', { plan: 1 }, null, null,
    [{ a: 'planner', role: 'planner', k: 'spawn', r: 1 }]],
  [8, 'review', { plan: 1, review: 1 }, null, lenses('run'),
    LENSES.map((id) => ({ a: id, role: id, k: 'fresh', r: 1 }))],
  [6, 'review', { plan: 1, review: 1 }, null, lenses('done', { critic: 'NEEDS_WORK', pragmatist: 'SOLID', 'edge-cases': 'SOLID' }), []],
  [7, 'plan', { plan: 2, review: 1 }, null, null,
    [{ a: 'planner', role: 'planner', k: 'resume', r: 2 }]],
  [7, 'review', { plan: 2, review: 2 }, null, lenses('run'),
    LENSES.map((id) => ({ a: id, role: id, k: 'fresh', r: 2 }))],
  [5, 'review', { plan: 2, review: 2 }, null, lenses('done', { critic: 'SOLID', pragmatist: 'SOLID', 'edge-cases': 'SOLID' }), []],
  [5, 'task', { plan: 2, review: 2, task: 1 }, null, null, []],
  [8, 'impl', { plan: 2, review: 2, task: 1, impl: 1 },
    { wave: 1, waves: 2, forks: [F('run', 'T1', 'Role registry'), F('run', 'T2', 'Tokens'), F('run', 'T3', 'Verify lane')] }, null,
    [['T1', 'Role registry'], ['T2', 'Tokens'], ['T3', 'Verify lane']]
      .map(([a, name]) => ({ a, role: 'implementer', k: 'fork', from: 'planner', name, ctx: DEMO_CTX }))],
  [6, 'impl', { plan: 2, review: 2, task: 1, impl: 1 },
    { wave: 1, waves: 2, forks: [F('done', 'T1', 'Role registry'), F('run', 'T2', 'Tokens'), F('fail', 'T3', 'Verify lane')] }, null, []],
  [6, 'impl', { plan: 2, review: 2, task: 1, impl: 1 },
    { wave: 2, waves: 2, forks: [F('done', 'T1', 'Role registry'), F('done', 'T2', 'Tokens'), F('run', 'T3', 'Verify lane')] }, null,
    [{ a: 'T3', role: 'implementer', k: 'resume', r: 2, name: 'Verify lane' }]],
  [7, 'codereview', { plan: 2, review: 2, task: 1, impl: 1, codereview: 1 },
    { wave: 2, waves: 2, forks: [F('done', 'T1', 'Role registry'), F('done', 'T2', 'Tokens'), F('done', 'T3', 'Verify lane')] },
    [J('run', 'reviewer')], [{ a: 'reviewer', role: 'reviewer', k: 'fresh', r: 1 }]],
  [7, 'validate', { plan: 2, review: 2, task: 1, impl: 1, codereview: 1, validate: 1 },
    { wave: 2, waves: 2, forks: [F('done', 'T1', 'Role registry'), F('done', 'T2', 'Tokens'), F('done', 'T3', 'Verify lane')] },
    [J('run', 'validator')], [{ a: 'validator', role: 'validator', k: 'fresh', r: 1 }]],
  [90, 'done', { plan: 2, review: 2, task: 1, impl: 1, codereview: 1, validate: 1 },
    { wave: 2, waves: 2, forks: [F('done', 'T1', 'Role registry'), F('done', 'T2', 'Tokens'), F('done', 'T3', 'Verify lane')] },
    [J('done', 'validator', 'PASS')], []],
];

const history = [];
const lineage = [];
let i = 0;
function step() {
  if (i >= BEATS.length) {
    // Like a real success end, the done file STAYS so the win beat and the receipt remain
    // reachable; the dashboard ages it out after 3h, and the next demo run overwrites it.
    console.log('demo finished; the done state stays until it ages out (3h) or the next run');
    return;
  }
  const [hold, phase, iters, impl, judges, events] = BEATS[i];
  const now = new Date().toISOString();
  if (history.length === 0 || history[history.length - 1].p !== phase) history.push({ p: phase, at: now });
  for (const ev of events) lineage.push({ ...ev, at: now });

  const st = { goal: 'demo-dummy-goal', started, updated: now, phase, iters, history, lineage };
  // Scope the demo run to the launching session (if any): same contract as a real run.
  if (process.env.CLAUDE_CODE_SESSION_ID) st.session = process.env.CLAUDE_CODE_SESSION_ID;
  if (impl) st.impl = impl;
  if (judges) st.judges = judges;
  fs.writeFileSync(FILE, JSON.stringify(st));
  console.log(`beat ${i + 1}/${BEATS.length}: ${phase}` + (impl ? ` wave ${impl.wave}/${impl.waves}` : ''));
  i++;
  setTimeout(step, hold * 1000);
}
step();
