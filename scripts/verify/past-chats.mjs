#!/usr/bin/env node
/**
 * "Past chats" end-to-end verification — the `/api/agent/chat-sessions` index that the
 * history picker lists and resumes from.
 *
 *   npm run build:cli && npm run verify:past-chats
 *
 * WHAT IT DRIVES — the real dashboard server (`dist/index.js dashboard`), the real route,
 * and real transcript files on disk. Nothing is imported and called directly; every check
 * is an HTTP request to a running server, exactly as the picker makes it.
 *
 * WHAT IT DOES NOT SPEND — tokens. `claude` is never spawned: this route only READS the
 * transcripts Claude Code leaves behind, so the fixture writes them itself, in the exact
 * shape observed on CLI 2.1.220 (a `queue-operation` preamble, a hook `attachment`,
 * `user`/`assistant` turns carrying `cwd`/`gitBranch`/`timestamp`, `last-prompt` records).
 *
 * The isolated fake HOME is what makes it honest: the route resolves
 * `~/.claude/projects/<slug>` from `homedir()`, so the server under test can only see the
 * fixture's conversations — never the developer's real ones.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST (matching verify/chat-steer.mjs): every check
 * prints ✓/✗ with evidence and the run continues. Exit 0 iff everything passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-past-chats');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const OTHER = join(SCRATCH, 'other');

const S = {
  recent: '11111111-1111-4111-8111-111111111111',
  middle: '22222222-2222-4222-8222-222222222222',
  oldest: '33333333-3333-4333-8333-333333333333',
  huge: '44444444-4444-4444-8444-444444444444',
  empty: '55555555-5555-4555-8555-555555555555',
  sidechain: '66666666-6666-4666-8666-666666666666',
  foreign: '77777777-7777-4777-8777-777777777777',
  sleepRun: '88888888-8888-4888-8888-888888888888',
  plannerRun: '99999999-9999-4999-8999-999999999999',
};

/** Real first prompts of machine-spawned sessions, copied from this repo's own
 *  `~/.claude/projects` corpus (2026-08-01) — the app's Sleep agent and a goal-skill
 *  builder. 119 of that corpus's 372 conversations look like these two. */
const SLEEP_BRIEF = 'Think hard. Run a full dreamcontext memory consolidation ("sleep") for THIS project now, fully autonomously — do NOT ask any questions.';
const PLANNER_BRIEF = 'ultrathink. You are the goal-planner in a goal-skill v2 orchestration for the dreamcontext repo. You PLAN ONLY.';

const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** A transcript in the shape the real CLI writes one. */
function transcript(prompts, { cwd = PROJ, branch = 'main', sidechain = false, tail = [] } = {}) {
  const entries = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-01T11:41:29.085Z' },
    { type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:startup', content: 'brain preload…' } },
  ];
  prompts.forEach((text, i) => {
    entries.push({
      type: 'user', isSidechain: sidechain, uuid: `u${i}`,
      timestamp: `2026-08-01T12:0${i}:00.000Z`, cwd, gitBranch: branch, version: '2.1.220',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    entries.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `ok ${i}` }] } });
  });
  return jsonl([...entries, ...tail]);
}

function claudeDir(root) {
  return join(HOME, '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
}

function writeTranscript(root, id, raw, mtimeSec) {
  const dir = claudeDir(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, raw);
  if (mtimeSec) utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(OTHER, '_dream_context', 'state'), { recursive: true });

  // Three ordinary conversations, deliberately written oldest-mtime-first so a listing that
  // forgot to sort would come back in the wrong order.
  writeTranscript(PROJ, S.oldest, transcript(['the oldest thing I ever asked']), 1_700_000_000);
  writeTranscript(PROJ, S.middle, transcript([
    'set up the migration ledger',
    'now normalise the frontmatter too',
  ], { branch: 'feat/ledger' }), 1_700_000_500);
  writeTranscript(PROJ, S.recent, transcript([
    `${PROJ}/_dream_context/tmp/agent-drops/1785585157340-Screenshot.png\n\nBuraya geçmiş chatler diye bir sekme ekleyelim`,
  ]), 1_700_001_000);

  // A transcript far past the head budget whose newest prompt is only reachable via the
  // CLI's own `last-prompt` record at the very end.
  const filler = jsonl(Array.from({ length: 900 }, (_, i) => ({
    type: 'assistant', message: { content: [{ type: 'text', text: `${'x'.repeat(300)}${i}` }] },
  })));
  writeTranscript(PROJ, S.huge, transcript(['a very long conversation']) + filler + jsonl([
    { type: 'last-prompt', lastPrompt: 'and finally ship it…', sessionId: S.huge },
  ]), 1_700_000_800);

  // Three that must NOT appear: a tab opened and never used, an old-CLI sub-agent
  // sidechain, and another project's conversation.
  writeTranscript(PROJ, S.empty, jsonl([
    { type: 'queue-operation', operation: 'enqueue' },
    { type: 'user', message: { content: '<system-reminder>preload</system-reminder>' } },
  ]), 1_700_002_000);
  writeTranscript(PROJ, S.sidechain, transcript(['dispatched sub-agent work'], { sidechain: true }), 1_700_002_000);
  writeTranscript(OTHER, S.foreign, transcript(['a different project entirely'], { cwd: OTHER }), 1_700_002_000);

  // Two machine-spawned sessions, written NEWEST of all: without the agent-run filter they
  // would sit on top of the list, which is exactly how they bury real conversations.
  writeTranscript(PROJ, S.sleepRun, transcript([SLEEP_BRIEF, 'ledger reconciled during sleep']), 1_700_003_000);
  writeTranscript(PROJ, S.plannerRun, transcript([PLANNER_BRIEF]), 1_700_002_900);

  for (const [name, path] of [['proj', PROJ], ['other', OTHER]]) {
    const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', name, path],
      { env: { ...process.env, HOME }, encoding: 'utf-8' });
    if (add.status !== 0) throw new Error(`vaults add ${name} failed: ${add.stderr || add.stdout}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startServer(port, { desktop = true } = {}) {
  const env = { ...process.env, HOME, DREAMCONTEXT_DESKTOP: desktop ? '1' : '' };
  if (!desktop) delete env.DREAMCONTEXT_DESKTOP;
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return srv;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

// ─── reporting ────────────────────────────────────────────────────────────────────────

const report = { pass: 0, fail: 0 };
function check(label, ok, evidence = '') {
  if (ok) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fail++; console.log(`  ✗ ${label}${evidence ? `\n      ${evidence}` : ''}`); }
}

async function list(base, vault, query = '', { agentRuns = false } = {}) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (agentRuns) params.set('agentRuns', '1');
  const qs = params.toString();
  const url = `${base}/api/agent/chat-sessions${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { headers: { 'X-Dreamcontext-Vault': vault } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

// ─── run ──────────────────────────────────────────────────────────────────────────────

let server = null;
try {
  console.log('· building the fixture (isolated HOME, real transcript files)…');
  setup();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);

  console.log('\nTHE INDEX');
  const t0 = Date.now();
  const all = await list(base, 'proj');
  const coldMs = Date.now() - t0;
  const ids = all.sessions.map((s) => s.id);
  const titles = all.sessions.map((s) => s.title);

  check('lists this project\'s conversations, newest activity first',
    JSON.stringify(ids) === JSON.stringify([S.recent, S.huge, S.middle, S.oldest]),
    `got ${JSON.stringify(titles)}`);
  check('total counts exactly the listable ones', all.total === 4, `total=${all.total}`);
  check('an unused session (no human prompt) is not listed', !ids.includes(S.empty));
  check('an old-CLI sub-agent sidechain is not listed', !ids.includes(S.sidechain));
  check('another project\'s conversation is not listed', !ids.includes(S.foreign));
  check('the search index is never shipped to the client',
    !all.sessions.some((s) => 'haystack' in s), JSON.stringify(Object.keys(all.sessions[0] ?? {})));

  console.log('\nWHAT A ROW SAYS');
  const recent = all.sessions.find((s) => s.id === S.recent);
  const middle = all.sessions.find((s) => s.id === S.middle);
  const huge = all.sessions.find((s) => s.id === S.huge);
  check('titles from the message, not the screenshot path it was dropped with',
    recent?.title === 'Buraya geçmiş chatler diye bir sekme ekleyelim', `title=${JSON.stringify(recent?.title)}`);
  check('previews the most recent prompt',
    middle?.preview === 'now normalise the frontmatter too', `preview=${JSON.stringify(middle?.preview)}`);
  check('a one-turn chat does not repeat its title underneath itself',
    recent?.preview === '', `preview=${JSON.stringify(recent?.preview)}`);
  check('reads past the head budget via the CLI\'s own last-prompt record',
    huge?.preview === 'and finally ship it…', `preview=${JSON.stringify(huge?.preview)}`);
  check('carries the branch and the transcript size',
    middle?.gitBranch === 'feat/ledger' && huge?.sizeBytes > 128 * 1024,
    `branch=${middle?.gitBranch} size=${huge?.sizeBytes}`);
  check('carries a start time the picker can bucket by day',
    typeof recent?.startedAt === 'number' && recent.startedAt > 0, `startedAt=${recent?.startedAt}`);

  console.log('\nSEARCH');
  const q1 = await list(base, 'proj', 'ledger');
  check('matches a word that appears only in the body, not in any title',
    q1.sessions.map((s) => s.id).join() === S.middle, `got ${JSON.stringify(q1.sessions.map((s) => s.title))}`);
  const q2 = await list(base, 'proj', 'frontmatter');
  check('matches a LATER prompt in the conversation, not just the first',
    q2.sessions.map((s) => s.id).join() === S.middle, `total=${q2.total}`);
  const q3 = await list(base, 'proj', 'feat/ledger');
  check('matches the branch', q3.total === 1, `total=${q3.total}`);
  const q4 = await list(base, 'proj', 'LEDGER');
  check('is case-insensitive', q4.total === 1, `total=${q4.total}`);
  const q5 = await list(base, 'proj', 'migration frontmatter');
  check('ANDs its tokens (a second word narrows)', q5.total === 1, `total=${q5.total}`);
  const q6 = await list(base, 'proj', 'migration nonexistentword');
  check('an unmatchable token yields nothing', q6.total === 0, `total=${q6.total}`);

  console.log('\nAGENT RUNS ARE NOT YOUR CHATS');
  check('a session the app spawned for itself (Sleep) is withheld', !ids.includes(S.sleepRun));
  check('a goal-skill builder is withheld', !ids.includes(S.plannerRun));
  check('…even though both are NEWER than everything shown',
    all.sessions[0]?.id === S.recent, `top=${JSON.stringify(all.sessions[0]?.title)}`);
  check('the count of what was withheld is reported, not silently dropped',
    all.agentRuns === 2, `agentRuns=${all.agentRuns}`);

  const withRuns = await list(base, 'proj', '', { agentRuns: true });
  const runIds = withRuns.sessions.map((s) => s.id);
  check('asking for them shows them, newest first',
    runIds[0] === S.sleepRun && runIds[1] === S.plannerRun, `got ${JSON.stringify(runIds.slice(0, 3))}`);
  check('…and then nothing is being withheld', withRuns.agentRuns === 0, `agentRuns=${withRuns.agentRuns}`);
  check('each row says which kind it is',
    withRuns.sessions.find((s) => s.id === S.sleepRun)?.agentRun === true
    && withRuns.sessions.find((s) => s.id === S.recent)?.agentRun === false);

  // The withheld count must describe the CURRENT list, not the corpus: "ledger" matches one
  // real conversation and one sleep run.
  const qRuns = await list(base, 'proj', 'ledger');
  check('the withheld count follows the query',
    qRuns.total === 1 && qRuns.agentRuns === 1, `total=${qRuns.total} agentRuns=${qRuns.agentRuns}`);

  console.log('\nSCOPE + PERFORMANCE');
  const other = await list(base, 'other');
  check('the OTHER vault sees only its own conversation',
    other.sessions.map((s) => s.id).join() === S.foreign, `got ${JSON.stringify(other.sessions.map((s) => s.title))}`);
  const t1 = Date.now();
  await list(base, 'proj');
  const warmMs = Date.now() - t1;
  check('a warm listing is memoized, not re-read', warmMs <= Math.max(60, coldMs),
    `cold=${coldMs}ms warm=${warmMs}ms`);

  // A live session appends between the picker's stat and its read; the newest prompt must
  // still land rather than being cut off by a stale size.
  writeTranscript(PROJ, S.middle, transcript([
    'set up the migration ledger', 'now normalise the frontmatter too', 'one more thing — wrap the fences',
  ], { branch: 'feat/ledger' }));
  const after = await list(base, 'proj');
  check('a conversation that ran again is re-read and rises to the top',
    after.sessions[0]?.id === S.middle && after.sessions[0]?.preview === 'one more thing — wrap the fences',
    `top=${JSON.stringify(after.sessions[0]?.title)} preview=${JSON.stringify(after.sessions[0]?.preview)}`);

  console.log('\nGATING');
  server.kill();
  server = null;
  const port2 = await freePort();
  server = await startServer(port2, { desktop: false });
  const browser = await list(`http://127.0.0.1:${port2}`, 'proj');
  check('a non-desktop (browser) dashboard gets an empty list, never someone\'s chats',
    browser.sessions.length === 0 && browser.total === 0, JSON.stringify(browser));
} catch (err) {
  report.fail++;
  console.log(`\n  ✗ RUN FAILED: ${err && err.stack ? err.stack : err}`);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${report.pass} passed, ${report.fail} failed`);
process.exit(report.fail === 0 ? 0 : 1);
