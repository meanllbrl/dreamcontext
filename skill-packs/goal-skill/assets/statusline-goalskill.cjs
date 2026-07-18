#!/usr/bin/env node
// Live goal-skill v2 cycle strip for the Claude Code statusline.
// Renders ONLY while a run is active: the orchestrator (single writer) maintains
// _dream_context/tmp/.goal-skill-live.json at every phase transition and deletes it
// when the run completes or escalates. No file (or a stale one) → empty statusline.
const fs = require('fs');
const path = require('path');

const FILE = path.join(process.cwd(), '_dream_context', 'tmp', '.goal-skill-live.json');
const ESC = '\x1b[';
const R = ESC + '0m';
const c = (code, s) => ESC + code + 'm' + s + R;

let st;
try {
  st = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  process.exit(0); // no active run
}

const upd = Date.parse(st.updated || st.started || 0);
if (!upd || Date.now() - upd > 3 * 3600 * 1000) process.exit(0); // abandoned run

const ORDER = ['plan', 'review', 'task', 'impl', 'codereview', 'validate'];
const LABEL = { plan: 'PLAN', review: 'REVIEW', task: 'TASK', impl: 'IMPL', codereview: 'CODE-REV', validate: 'VALIDATE' };
const cur = st.phase === 'done' ? ORDER.length : Math.max(0, ORDER.indexOf(st.phase));
const iters = st.iters || {};

// loop heat: ×2 yellow · ×3 bright yellow · ≥4 bright red — the more a phase looped, the hotter it glows
const heat = (n) => (n >= 4 ? c('1;91', '×' + n) : n === 3 ? c('1;93', '×' + n) : n === 2 ? c('33', '×' + n) : '');

const seg = ORDER.map((p, i) => {
  const x = heat(iters[p] || 0);
  let body;
  if (st.phase === 'done' || i < cur) body = c('32', '✓' + LABEL[p]) + (x ? x : '');
  else if (i === cur) body = c('1;96', '▶' + LABEL[p]) + (x ? x : '');
  else body = c('90', '·' + LABEL[p]);
  if (p === 'impl' && st.impl && (i <= cur || st.phase === 'done')) {
    const dots = (st.impl.forks || [])
      .map((f) => (f.s === 'done' ? c('32', '●') : f.s === 'run' ? c('1;93', '◐') : f.s === 'fail' ? c('1;91', '✗') : c('90', '○')))
      .join('');
    const wave = st.impl.waves ? c('36', 'W' + (st.impl.wave || 1) + '/' + st.impl.waves) : '';
    body += (dots ? ' ' + dots : '') + (wave ? ' ' + wave : '');
  }
  return body;
});

const started = Date.parse(st.started || 0);
const mins = started ? Math.round((Date.now() - started) / 60000) : null;
const head = c('1;95', '⛬ goal-skill') + (st.goal ? c('90', ' ' + String(st.goal).slice(0, 24)) : '');
const tail = (st.phase === 'done' ? c('1;32', ' DONE') : '') + (mins != null ? c('90', ' ' + mins + 'm') : '');
process.stdout.write(head + c('90', ' │ ') + seg.join(c('90', ' ─ ')) + tail);
