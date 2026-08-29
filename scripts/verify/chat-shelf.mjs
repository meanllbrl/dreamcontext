#!/usr/bin/env node
/**
 * The chat shelf's two READ routes — end-to-end verification against the real server.
 *
 *   npm run build:cli && npm run verify:chat-shelf
 *
 * WHAT IT DRIVES — the real dashboard server (`dist/index.js dashboard`), the real routes,
 * real task files and a real git repository (plus a real linked worktree) on disk. Nothing
 * is imported and called directly; every check is an HTTP request, exactly as the shelf
 * makes it.
 *
 * WHAT IT PROVES
 *   1-4. the progress number is DERIVED FROM DISK — 7 of 11 ticked reads 64%, ticking an
 *        eighth on disk moves it to 73% on the next poll, and the three degenerate shapes
 *        (no criteria, all ticked, no such task) each degrade LOUDLY with a notice instead
 *        of a NaN or a silent empty row;
 *   5.   a hostile slug is refused with a 400 before the filesystem is consulted;
 *   6-7. the session facts name the branch, and tell a plain checkout apart from a linked
 *        worktree — including the main checkout the worktree belongs to;
 *   8.   with the desktop gate off, both routes answer a renderable shape, never a 500;
 *   9.   the facts follow the SESSION, not the vault: a chat that emits a real `EnterWorktree`
 *        frame moves, and the route's answer for that session id changes branch with it while
 *        every other caller keeps reading the project root.
 *
 * WHAT IT DOES NOT SPEND — tokens. The real `claude` is never spawned; check 9 puts a SCRIPTED
 * stand-in on PATH that replays two frames captured from a real transcript and exits.
 *
 * WHAT IT NEVER TOUCHES — the developer's real home. The server runs under an isolated
 * scratch `$HOME` (the `past-chats.mjs:34,146` env pattern), so its vault registry and any
 * `~/.claude*` lookup can only ever see this fixture. No verify script reads or writes the
 * real `~/.claude.json`.
 *
 * The BROWSER half of the shelf's verification (resting state, row open/close, the ceiling,
 * scroll-invariance geometry) is `scripts/verify/chat-shelf-ui.mjs` — a separate script, for
 * the UI that renders these numbers.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST (matching verify/past-chats.mjs): every check
 * prints ✓/✗ with evidence and the run continues. Exit 0 iff everything passed.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-shelf');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const WT = join(SCRATCH, 'worktree');
/** Two more REAL repos, for the fresh-session branch guard: one clean and one dirty, both
 *  sitting on a leftover branch with `main` available to go back to. */
const LEFT = join(SCRATCH, 'leftover');
const LEFT_DIRTY = join(SCRATCH, 'leftover-dirty');

const BRANCH = 'feat/pin-surface';
const WT_BRANCH = 'feat/side-quest';
const LEFT_BRANCH = 'feat/left-behind';

/** The session id check 9 drives the chat with. Must be a canonical UUID — `sanitizeUuid`
 *  rejects anything else, and the server keys the checkout registry on it. */
const SESSION_ID = '9f1c7a2e-4b3d-4c8e-9a11-2d5e6f7a8b90';

/** The session id the checkout-CLAIM check drives. Its own id, because the claim outranks the
 *  transcript and check 9's session must keep proving the frame path on its own. */
const CLAIM_SESSION_ID = 'c1a11000-4b3d-4c8e-9a11-2d5e6f7a8b91';

/**
 * A scripted `claude` that replays one of three answers, chosen by the text it is sent.
 *
 * `GO` replays a real `EnterWorktree` move. The two frames are VERBATIM shapes captured from
 * `~/.claude/projects/**\/*.jsonl` on 2026-08-24 — the call carries no path (its `input` is
 * `{name}`), the RESULT carries it in prose. That asymmetry is the whole reason the server
 * parses the result, so a stand-in that put the path in the call would verify the wrong thing.
 *
 * `CLAIM` / `RESET` answer with a `dream-view` checkout block in ordinary assistant text —
 * no tool call, no `cd`, nothing an observer could see. That is the case the block exists for.
 */
const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const WT = ${JSON.stringify(WT)};
const PJ = ${JSON.stringify(PROJ)};
let answered = false;
function answer(text) {
  if (answered) return;
  answered = true;
  out({ type: 'system', subtype: 'init', session_id: 'verify-chat-shelf', cwd: process.cwd(), slash_commands: [] });
  if (text === 'SILENT-EDIT') {
    out({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_verify_brain', name: 'Write',
        input: { file_path: PJ + '/_dream_context/state/note.md' } },
      { type: 'tool_use', id: 'toolu_verify_edit', name: 'Edit',
        input: { file_path: WT + '/README.md' } },
    ] } });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  } else if (text === 'CLAIM' || text === 'RESET') {
    const payload = text === 'CLAIM'
      ? '{"type":"checkout","path":"' + WT + '"}'
      : '{"type":"checkout","reset":true}';
    out({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'Working here.\\n\\n\\u0060\\u0060\\u0060dream-view\\n' + payload + '\\n\\u0060\\u0060\\u0060\\n' },
    ] } });
  } else {
    out({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_verify_enter', name: 'EnterWorktree', input: { name: 'worktree' } },
    ] } });
    out({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_verify_enter',
        content: 'Created worktree at ' + WT + ' on branch feat/side-quest. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.' },
    ] } });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'moved' }] } });
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'verify-chat-shelf' });
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'user') {
      const parts = o.message && o.message.content;
      const t = Array.isArray(parts) && parts[0] && typeof parts[0].text === 'string' ? parts[0].text.trim() : '';
      answer(t);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// ─── fixture ──────────────────────────────────────────────────────────────────────────

/** A task whose Acceptance Criteria hold `total` checkboxes, `done` of them ticked. */
function taskFile(total, done) {
  const criteria = Array.from({ length: total }, (_, i) =>
    `- [${i < done ? 'x' : ' '}] criterion number ${i + 1}`).join('\n');
  return [
    '---',
    'id: task_verify',
    'status: in_progress',
    '---',
    '## Acceptance Criteria',
    '',
    criteria,
    '',
    '## Changelog',
    '<!-- LIFO: newest at top. -->',
    '',
    '### 2026-08-23 - Session Update',
    '- the newest thing that happened',
    '### 2026-08-22 - Created',
    '- Task created.',
    '',
  ].join('\n');
}

/**
 * A task written the way this repo actually writes them — criteria under `### ` milestone
 * headings — so the route's grouping is verified against the real shape and not a flat list
 * nobody authors.
 */
function groupedTaskFile() {
  return [
    '---',
    'id: task_grouped',
    'status: in_progress',
    '---',
    '## Acceptance Criteria',
    '',
    '### Part A — the payload',
    '- [x] A1 ships the list',
    '- [x] A2 carries the group',
    '- [ ] A3 caps each line',
    '',
    '### Validation',
    '- [ ] V1 tsc is clean',
    '',
    '## Changelog',
    '',
    '### 2026-08-24 - Session Update',
    '- part A landed',
    '',
  ].join('\n');
}

function writeTask(root, slug, body) {
  const dir = join(root, '_dream_context', 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), body, 'utf-8');
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });

  // A REAL repo on a named branch — the branch chip has to come from somewhere true.
  git(PROJ, 'init', '-q', '-b', BRANCH);
  git(PROJ, 'config', 'user.email', 'verify@example.com');
  git(PROJ, 'config', 'user.name', 'Verify');
  writeFileSync(join(PROJ, 'README.md'), '# fixture\n', 'utf-8');
  git(PROJ, 'add', 'README.md');
  git(PROJ, 'commit', '-qm', 'initial');

  // …and a REAL linked worktree of it, which must be told apart from the checkout above.
  git(PROJ, 'worktree', 'add', '-q', '-b', WT_BRANCH, WT);
  mkdirSync(join(WT, '_dream_context', 'state'), { recursive: true });

  // The fresh-session branch guard's two arms, each a REAL repo. Both have `main` (so there
  // IS a default to return to) and both are parked on a leftover branch, exactly as a previous
  // session's `git checkout -b` would have left them. The second one is DIRTY.
  for (const [root, dirty] of [[LEFT, false], [LEFT_DIRTY, true]]) {
    mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'verify@example.com');
    git(root, 'config', 'user.name', 'Verify');
    writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf-8');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-qm', 'initial');
    git(root, 'checkout', '-q', '-b', LEFT_BRANCH);
    if (dirty) writeFileSync(join(root, 'README.md'), '# edited, uncommitted\n', 'utf-8');
  }

  writeTask(PROJ, 'seven-of-eleven', taskFile(11, 7));
  writeTask(PROJ, 'no-boxes', '---\nid: task_nb\n---\n## Acceptance Criteria\n\nProse only.\n');
  writeTask(PROJ, 'all-ticked', taskFile(5, 5));
  writeTask(PROJ, 'grouped', groupedTaskFile());
  writeTask(PROJ, 'runaway', taskFile(214, 3));

  // The scripted `claude` check 9 drives. Installed under the scratch HOME, and reached only
  // because startServer PREPENDS this dir to PATH — the real binary is never shadowed
  // outside this fixture.
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  for (const [name, path] of [['proj', PROJ], ['wt', WT], ['left', LEFT], ['leftdirty', LEFT_DIRTY]]) {
    const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', name, path],
      { env: { ...process.env, HOME }, encoding: 'utf-8' });
    if (add.status !== 0) throw new Error(`vaults add ${name} failed: ${add.stderr || add.stdout}`);
  }
}

// ─── harness ──────────────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(port, { desktop = true } = {}) {
  // PREPEND rather than replace: the routes under test shell out to `git`, so the real PATH
  // has to survive. Only `claude` is shadowed, and only inside this fixture's HOME.
  const env = {
    ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1',
    PATH: `${join(HOME, '.local', 'bin')}:${process.env.PATH || ''}`,
  };
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

const report = { pass: 0, fails: [] };
function ok(label, cond, evidence = '') {
  if (cond) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fails.push(label); console.log(`  ✗ ${label}${evidence ? `\n      ${evidence}` : ''}`); }
}

async function getJson(base, path, vault) {
  const res = await fetch(`${base}${path}`, { headers: { 'X-Dreamcontext-Vault': vault } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const progress = (base, slug, vault = 'proj') =>
  getJson(base, `/api/agent/task-progress?slug=${encodeURIComponent(slug)}`, vault);
const facts = (base, vault = 'proj', session = null) => getJson(
  base, `/api/agent/session-facts${session ? `?session=${encodeURIComponent(session)}` : ''}`, vault);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── run ──────────────────────────────────────────────────────────────────────────────

let server = null;
/** Drives one chat turn; set by the EnterWorktree check, reused by the checkout-claim check
 *  that follows it, so both go through exactly the same socket handling. */
let turn = null;
try {
  console.log('· building the fixture (isolated HOME, real repo + worktree, real task files)…');
  setup();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);

  console.log('\nPROGRESS — the number is read off the task file, not asserted');
  const seven = await progress(base, 'seven-of-eleven');
  ok('7 of 11 ticked reads 64%', seven.status === 200 && seven.body?.percent === 64,
    JSON.stringify(seven.body));
  ok('…and reports the raw count behind it', seven.body?.done === 7 && seven.body?.total === 11,
    JSON.stringify({ done: seven.body?.done, total: seven.body?.total }));
  ok('…names the criterion in flight', seven.body?.now === 'criterion number 8', String(seven.body?.now));
  ok('…and what was just done, from the changelog',
    seven.body?.last === 'the newest thing that happened', String(seven.body?.last));
  ok('a healthy reading carries no notice', seven.body?.notice === null, String(seven.body?.notice));

  console.log('\nTHE CHECKLIST — every criterion, not the two strings the panel used to draw');
  // The defect: the header said `8/20` and the body rendered TWO rows, because the route only
  // ever derived `now` and `last`. The list is what makes the fraction checkable.
  ok('the list is as long as the total above it',
    Array.isArray(seven.body?.criteria) && seven.body.criteria.length === seven.body.total,
    JSON.stringify({ criteria: seven.body?.criteria?.length, total: seven.body?.total }));
  ok('…with exactly the ticked ones marked done',
    seven.body?.criteria?.filter((c) => c.done).length === seven.body?.done,
    JSON.stringify({ done: seven.body?.criteria?.filter((c) => c.done).length, want: seven.body?.done }));
  ok('…in document order', seven.body?.criteria?.[0]?.text === 'criterion number 1'
    && seven.body?.criteria?.[10]?.text === 'criterion number 11',
    JSON.stringify([seven.body?.criteria?.[0]?.text, seven.body?.criteria?.[10]?.text]));
  ok('…and the row and the list agree on what is in flight',
    seven.body?.criteria?.find((c) => !c.done)?.text === seven.body?.now,
    JSON.stringify({ list: seven.body?.criteria?.find((c) => !c.done)?.text, row: seven.body?.now }));
  ok('a healthy reading reports nothing truncated', seven.body?.truncated === 0,
    String(seven.body?.truncated));

  const grouped = await progress(base, 'grouped');
  ok('criteria carry the ### milestone heading they were written under',
    JSON.stringify(grouped.body?.criteria?.map((c) => c.group))
      === JSON.stringify(['Part A — the payload', 'Part A — the payload', 'Part A — the payload', 'Validation']),
    JSON.stringify(grouped.body?.criteria?.map((c) => c.group)));
  ok('…and the per-group tally the panel draws is derivable from it',
    grouped.body?.criteria?.filter((c) => c.group === 'Part A — the payload' && c.done).length === 2,
    JSON.stringify(grouped.body?.criteria));

  const runaway = await progress(base, 'runaway');
  ok('past the cap the list truncates at 200', runaway.body?.criteria?.length === 200,
    String(runaway.body?.criteria?.length));
  ok('…the total stays honest — it is the number tasks doctor reports',
    runaway.body?.total === 214, String(runaway.body?.total));
  ok('…and the shortfall is REPORTED, not swallowed', runaway.body?.truncated === 14,
    String(runaway.body?.truncated));
  ok('…while the reading itself is still not degenerate',
    runaway.body?.state === 'ok' && runaway.body?.notice === null,
    JSON.stringify({ state: runaway.body?.state, notice: runaway.body?.notice }));

  console.log('\nREFRESH — it follows the file, it is not frozen at first read');
  await sleep(50); // so the mtime is measurably later, not merely equal
  writeTask(PROJ, 'seven-of-eleven', taskFile(11, 8));
  const eight = await progress(base, 'seven-of-eleven');
  ok('ticking an eighth criterion on disk moves the reading to 73%', eight.body?.percent === 73,
    JSON.stringify({ before: seven.body?.percent, after: eight.body?.percent }));
  ok('…the in-flight criterion moves with it', eight.body?.now === 'criterion number 9', String(eight.body?.now));
  ok('…and updatedAt advanced', eight.body?.updatedAt > seven.body?.updatedAt,
    JSON.stringify({ before: seven.body?.updatedAt, after: eight.body?.updatedAt }));
  // The panel's flash is derived by diffing two payloads client-side, so what it needs from the
  // server is exactly this: the same criterion, identified the same way, with `done` flipped.
  ok('…and criterion 8 flipped in the LIST — which is what the just-ticked flash diffs',
    seven.body?.criteria?.[7]?.done === false && eight.body?.criteria?.[7]?.done === true
      && seven.body?.criteria?.[7]?.text === eight.body?.criteria?.[7]?.text,
    JSON.stringify({ before: seven.body?.criteria?.[7], after: eight.body?.criteria?.[7] }));

  console.log('\nDEGRADATION — loudly, never a NaN and never a silent empty row');
  const none = await progress(base, 'no-boxes');
  ok('zero criteria → percent null (not NaN, not 0)', none.body?.percent === null, JSON.stringify(none.body));
  ok('…and says why', none.body?.state === 'no-criteria' && !!none.body?.notice, JSON.stringify(none.body));
  ok('…and carries an EMPTY list, never a half-drawn panel',
    Array.isArray(none.body?.criteria) && none.body.criteria.length === 0 && none.body?.truncated === 0,
    JSON.stringify({ criteria: none.body?.criteria, truncated: none.body?.truncated }));

  const all = await progress(base, 'all-ticked');
  ok('an all-ticked task reads 100%', all.body?.percent === 100, JSON.stringify(all.body));
  ok('…is flagged all-done with nothing in flight',
    all.body?.state === 'all-done' && all.body?.now === null, JSON.stringify(all.body));
  ok('…and still carries a notice — a full bar is not self-explanatory', !!all.body?.notice,
    String(all.body?.notice));
  ok('…and STILL ships its list — 100% is a reading, not an empty panel',
    all.body?.criteria?.length === 5 && all.body.criteria.every((c) => c.done),
    JSON.stringify(all.body?.criteria));

  const missing = await progress(base, 'no-such-task-here');
  ok('a well-formed slug with no file is a 200 STATE, not a failed request',
    missing.status === 200 && missing.body?.state === 'unknown-slug', JSON.stringify(missing));
  ok('…with a notice naming the slug', String(missing.body?.notice).includes('no-such-task-here'),
    String(missing.body?.notice));
  ok('…and an empty list', missing.body?.criteria?.length === 0, JSON.stringify(missing.body?.criteria));

  console.log('\nSLUG SAFETY — refused before the filesystem is consulted');
  for (const slug of ['../../etc/passwd', '../secrets', '/etc/passwd', '']) {
    const bad = await progress(base, slug);
    ok(`a hostile slug is 400 (${JSON.stringify(slug)})`,
      bad.status === 400 && bad.body?.error === 'invalid_slug', JSON.stringify(bad));
  }

  console.log('\nSESSION FACTS — which checkout is this session acting on?');
  const main = await facts(base, 'proj');
  ok('the branch is reported', main.body?.branch === BRANCH, JSON.stringify(main.body));
  ok('…a plain checkout is NOT called a worktree',
    main.body?.worktree === false && main.body?.mainRoot === null, JSON.stringify(main.body));
  ok('…and it is recognised as a repo', main.body?.isRepo === true, JSON.stringify(main.body));

  const linked = await facts(base, 'wt');
  ok('a linked worktree reports its own branch', linked.body?.branch === WT_BRANCH, JSON.stringify(linked.body));
  ok('…is marked as a worktree', linked.body?.worktree === true, JSON.stringify(linked.body));
  ok('…and names the main checkout it belongs to',
    linked.body?.mainRoot === realpathSync(PROJ),
    JSON.stringify({ got: linked.body?.mainRoot, want: realpathSync(PROJ) }));

  console.log('\nTHE FACTS FOLLOW THE SESSION — an EnterWorktree frame moves the branch');
  {
    let WebSocket;
    try { ({ WebSocket } = await import('ws')); }
    catch { throw new Error('the `ws` package is required (it is a root dependency — run npm install)'); }

    const before = await facts(base, 'proj', SESSION_ID);
    ok('before the move, the session reads the project root',
      before.body?.branch === BRANCH && before.body?.worktree === false, JSON.stringify(before.body));

    // Drive one real chat turn. The scripted claude answers with the captured EnterWorktree
    // frames; the server observes them on the same NDJSON relay it already parses.
    //
    // Returns every `_meta` frame the server sent, because for the CLAIM check below the
    // banner IS half the contract — a refusal the agent cannot see is the failure mode.
    turn = async (sessionId, text) => new Promise((resolve, reject) => {
      const metas = [];
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&sessionId=${sessionId}`);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* closing */ } reject(new Error('chat turn timed out')); }, 20_000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'user', text })));
      ws.on('close', () => { clearTimeout(timer); reject(new Error('socket closed before the turn finished')); });
      ws.on('message', (raw) => {
        let o; try { o = JSON.parse(raw.toString('utf-8')); } catch { return; }
        if (o.type === '_meta') metas.push(o);
        if (o.type !== 'result') return;
        clearTimeout(timer);
        try { ws.close(); } catch { /* closing */ }
        resolve(metas);
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    await turn(SESSION_ID, 'GO');
    // The route memoises a reading for 12s per directory, but the WORKTREE is a directory it
    // has not read yet — so the move shows on the next request, with no wait.
    const after = await facts(base, 'proj', SESSION_ID);
    ok('after EnterWorktree, that session reports the WORKTREE branch',
      after.body?.branch === WT_BRANCH, JSON.stringify(after.body));
    ok('…is marked as a worktree and NAMES it',
      after.body?.worktree === true && after.body?.worktreeName === 'worktree', JSON.stringify(after.body));

    const untouched = await facts(base, 'proj');
    ok('…while a caller with no session id still reads the project root',
      untouched.body?.branch === BRANCH && untouched.body?.worktree === false, JSON.stringify(untouched.body));
    const other = await facts(base, 'proj', '00000000-0000-4000-8000-000000000000');
    ok('…and so does a DIFFERENT session that never moved',
      other.body?.branch === BRANCH, JSON.stringify(other.body));
    const hostile = await facts(base, 'proj', '../../etc');
    ok('a session param that is not a UUID is ignored, not used as a key',
      hostile.body?.branch === BRANCH, JSON.stringify(hostile.body));
  }

  console.log('\nTHE AGENT SAYS WHERE ITS WORK IS — a dream-view checkout claim');
  {
    // The case NEITHER observer can report: the session stands in the project root (its
    // transcript says so, truthfully) and its work is in the worktree. No EnterWorktree frame,
    // no `cd`. The claim is the only thing that moves the chip — and it has to OUTRANK the
    // transcript, or it could never say anything the server did not already know.
    const dir = join(HOME, '.claude', 'projects', 'verify-proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${CLAIM_SESSION_ID}.jsonl`),
      JSON.stringify({ type: 'assistant', cwd: PROJ, message: { content: [] } }) + '\n', 'utf-8');

    const before = await facts(base, 'proj', CLAIM_SESSION_ID);
    ok('before the claim, the session reads the checkout it is standing in',
      before.body?.branch === BRANCH && before.body?.worktree === false, JSON.stringify(before.body));

    const claimed = await turn(CLAIM_SESSION_ID, 'CLAIM');
    const after = await facts(base, 'proj', CLAIM_SESSION_ID);
    ok('a claim in ordinary assistant text moves the shelf to the claimed worktree',
      after.body?.branch === WT_BRANCH && after.body?.worktree === true, JSON.stringify(after.body));
    ok('…and the claim OUTRANKS the transcript, which still says the project root',
      after.body?.worktreeName === 'worktree', JSON.stringify(after.body));
    ok('…and the user is told, on the branch banner',
      claimed.some((m) => m.subtype === 'branch_start' && /shelf now reads/i.test(String(m.message || ''))),
      JSON.stringify(claimed.map((m) => m.subtype)));

    const other = await facts(base, 'proj', '00000000-0000-4000-8000-000000000000');
    ok('…and no other session is moved by it', other.body?.branch === BRANCH, JSON.stringify(other.body));

    const reset = await turn(CLAIM_SESSION_ID, 'RESET');
    const back = await facts(base, 'proj', CLAIM_SESSION_ID);
    ok('a reset withdraws the claim and hands the answer back to the transcript',
      back.body?.branch === BRANCH && back.body?.worktree === false, JSON.stringify(back.body));
    ok('…and that is announced too', reset.some((m) => m.subtype === 'branch_start'),
      JSON.stringify(reset.map((m) => m.subtype)));
  }

  console.log('\nTHE AGENT SAYS NOTHING — the chip warns about where the writes went');
  {
    // Option A, chosen by the owner on 2026-08-28 over auto-following the edits: the shelf
    // keeps naming the checkout the session is in and MARKS it with where the work landed.
    const EDIT_SESSION_ID = 'ed17ed00-4b3d-4c8e-9a11-2d5e6f7a8b92';
    const before = await facts(base, 'proj', EDIT_SESSION_ID);
    ok('before any write, there is nothing to warn about', before.body?.elsewhere == null,
      JSON.stringify(before.body?.elsewhere));

    await turn(EDIT_SESSION_ID, 'SILENT-EDIT');
    const after = await facts(base, 'proj', EDIT_SESSION_ID);
    ok('a write into another checkout is reported, by name and count',
      after.body?.elsewhere?.name === 'worktree' && after.body?.elsewhere?.count === 1,
      JSON.stringify(after.body?.elsewhere));
    ok('…and the BRAIN write in the same turn was not counted',
      after.body?.elsewhere?.count === 1, JSON.stringify(after.body?.elsewhere));
    ok('…while the checkout itself is UNCHANGED — a warning, never a move',
      after.body?.branch === BRANCH && after.body?.worktree === false, JSON.stringify(after.body));

    const other = await facts(base, 'proj', '00000000-0000-4000-8000-000000000000');
    ok('…and no other session is warned', other.body?.elsewhere == null,
      JSON.stringify(other.body?.elsewhere));
  }

  console.log('\nA MOVE WITH NO FRAME AT ALL — the transcript is what the shelf reads');
  {
    // The defect the owner photographed on 2026-08-25: a whole run in a worktree the session
    // reached by a manual `git worktree add` + `cd`, under a tag that still read the main
    // checkout. NO EnterWorktree frame is emitted anywhere in this block — the only thing that
    // changes is the conversation's own transcript, exactly as the real CLI writes it.
    const TSID = '3c9e1b44-77aa-4d21-bc10-9e2f5a6c1d33';
    const dir = join(HOME, '.claude', 'projects', 'verify-proj');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${TSID}.jsonl`);
    const entry = (cwd) => JSON.stringify({ type: 'assistant', cwd, message: { content: [] } }) + '\n';
    // A `queue-operation` last line, which is how every real transcript in this project ends —
    // so "read the last line" would answer nothing and the backward scan is load-bearing.
    const tail = JSON.stringify({ type: 'queue-operation', sessionId: TSID }) + '\n';

    writeFileSync(file, entry(WT) + tail, 'utf-8');
    const moved = await facts(base, 'proj', TSID);
    ok('a session the server saw NO frame from still reports the worktree it is in',
      moved.body?.branch === WT_BRANCH && moved.body?.worktree === true, JSON.stringify(moved.body));
    ok('…and names it', moved.body?.worktreeName === 'worktree', JSON.stringify(moved.body));

    // The Bash tool's cwd persists, so it drifts DOWN the tree. Git answers the same branch
    // from a subdirectory, so a naive pass looks right — but worktreeName is basename(dir).
    const deep = join(WT, '_dream_context', 'state');
    writeFileSync(file, entry(deep) + tail, 'utf-8');
    const sub = await facts(base, 'proj', TSID);
    ok('a cwd that drifted into a SUBDIRECTORY still names the checkout, not the subfolder',
      sub.body?.worktreeName === 'worktree' && sub.body?.branch === WT_BRANCH, JSON.stringify(sub.body));

    // A `cd` back out — the case the override registry, once set, could never take back.
    writeFileSync(file, entry(PROJ) + tail, 'utf-8');
    const home = await facts(base, 'proj', TSID);
    ok('…and a cd back OUT of the worktree is followed too',
      home.body?.branch === BRANCH && home.body?.worktree === false, JSON.stringify(home.body));

    // A transcript is not a licence to point the shelf anywhere on disk.
    writeFileSync(file, entry(LEFT) + tail, 'utf-8');
    const foreign = await facts(base, 'proj', TSID);
    ok('a transcript naming ANOTHER repository is refused, falling back to the project root',
      foreign.body?.branch === BRANCH && foreign.body?.worktree === false, JSON.stringify(foreign.body));
  }

  console.log('\nA FRESH SESSION STARTS ON THE DEFAULT BRANCH');
  {
    let WebSocket;
    try { ({ WebSocket } = await import('ws')); }
    catch { throw new Error('the `ws` package is required (it is a root dependency — run npm install)'); }

    /** Connect a fresh chat and collect the `_meta branch_start` frame, if one is sent. The
     *  guard runs BEFORE the spawn and the frame is sent at connect time, so no turn is needed. */
    const connect = (vault) => new Promise((resolve, reject) => {
      const sid = randomUUID();
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/agent/chat?vault=${vault}&bypass=0&sessionId=${sid}`);
      let seen = null;
      const done = () => { try { ws.close(); } catch { /* closing */ } resolve(seen); };
      const timer = setTimeout(done, 6_000);
      ws.on('message', (raw) => {
        let o; try { o = JSON.parse(raw.toString('utf-8')); } catch { return; }
        if (o.type === '_meta' && o.subtype === 'branch_start') {
          seen = o;
          clearTimeout(timer);
          done();
        }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });

    const branchOf = (root) =>
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim();

    ok('the leftover branch is really checked out before we start', branchOf(LEFT) === LEFT_BRANCH, branchOf(LEFT));
    const switched = await connect('left');
    ok('a CLEAN checkout parked on a leftover branch is moved back to the default',
      branchOf(LEFT) === 'main', branchOf(LEFT));
    ok('…and the move is REPORTED, never silent',
      switched?.kind === 'switched' && /moved the main checkout/.test(switched?.message || ''),
      JSON.stringify(switched));

    const blocked = await connect('leftdirty');
    ok('a DIRTY checkout is never switched — the tree is left exactly as it was',
      branchOf(LEFT_DIRTY) === LEFT_BRANCH, branchOf(LEFT_DIRTY));
    ok('…and the refusal is reported too, which is the arm that matters most',
      blocked?.kind === 'blocked-dirty' && /staying on/.test(blocked?.message || ''),
      JSON.stringify(blocked));

    // The verify fixture's own project has no `main`/`master` and no remote, so there is no
    // default to return to. Asserted rather than relied on: every branch expectation in this
    // whole file depends on PROJ still being on `feat/pin-surface` after a chat connects.
    const quiet = await connect('proj');
    ok('a repo with no resolvable default branch is left alone, and says nothing',
      quiet === null && branchOf(PROJ) === BRANCH, JSON.stringify({ quiet, branch: branchOf(PROJ) }));
  }

  console.log('\nTHE DESKTOP GATE — an unavailable reading is empty, never a 500');
  server.kill();
  server = await startServer(port, { desktop: false });
  const gatedProgress = await progress(base, 'seven-of-eleven');
  ok('task-progress answers 200 with a renderable shape',
    gatedProgress.status === 200 && gatedProgress.body?.percent === null && !!gatedProgress.body?.notice
      && gatedProgress.body?.criteria?.length === 0,
    JSON.stringify(gatedProgress));
  const gatedFacts = await facts(base, 'proj');
  ok('session-facts answers 200 with the unknown shape',
    gatedFacts.status === 200 && gatedFacts.body?.isRepo === false && gatedFacts.body?.branch === null,
    JSON.stringify(gatedFacts));
  const gatedBad = await progress(base, '../../etc/passwd');
  ok('…and a hostile slug is STILL a 400, gate or no gate',
    gatedBad.status === 400, JSON.stringify(gatedBad));
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
