#!/usr/bin/env node
/**
 * Every chat card and the agent's own tools, on the REAL Claude, Codex and Antigravity.
 *
 *   npm run build:cli && dreamcontext builder heavy -- node scripts/verify/tool-cards-real.mjs [claude,codex,antigravity]
 *
 * SPENDS REAL TOKENS on the owner's own signed-in accounts: one short chat per tool, six turns.
 * A smoke, not a suite: run it once per change to the briefing, the card rules or the bridge.
 *
 * WHAT IT DRIVES: the same children the chat server starts, fed the same briefing: `claude -p` in
 * stream-json with `--append-system-prompt-file`, and the BUILT `dreamcontext t3-chat --tool <codex|
 * antigravity> --briefing-file` bridge (T3's adapters inside). It needs the real HOME, because a
 * sign-in lives there; the only thing it adds is a scratch project ("Lumen Notes", fictional) in
 * the OS tmp folder, and the tool's own thread files for it. Nothing reads or writes the owner's chats.
 *
 * WHAT IT JUDGES: each answer goes through the app's own parser (`parseChatActions`, the code that
 * draws the chat), so "works" means the card would really be drawn; a skip notice is quoted as the
 * app would show it. Tools are judged from the tool frames and the files on disk.
 *
 * The card-feedback turn: when an answer had a skipped card, the server tells the agent in a hidden
 * turn (card-feedback.ts). This script plays the server's part with the same function when it is
 * built (`--feedback`), so the after-table shows whether the model fixes its card once told.
 *
 * Node 22 or newer runs it (the bridge needs node:sqlite). ANTIGRAVITY_ACCOUNT / CODEX_ACCOUNT pick an
 * account other than the first; <TOOL>_MODEL a model.
 *
 * Output: a table on stdout and `<OUT>/tool-cards-<tool>.json` (every answer and tool row), OUT =
 * $OUT_DIR or the scratch folder.
 *
 * `--judge <tool-cards-*.json>...` spends nothing: it prints the table of runs already saved, with
 * the read row worked out again from their tool rows (when the accounts are out of quota).
 *
 * The read row counts every file read the chat showed (main agent and sub-agent): how many came back
 * failed, and how many of those failures named a path other than the read's own. That second number
 * is Antigravity failing a sub-agent's open reads with a later step's refusal (AntigravityProtocol.ts
 * makeAntigravityReadRepair), not a read that really failed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
if (!existsSync(CLI)) { console.error('dist/index.js is missing: run npm run build:cli first'); process.exit(2); }
const TOOLS = (process.argv.find((a) => /^(claude|codex|antigravity)(,|$)/.test(a)) ?? 'claude,codex,antigravity').split(',');
const FEEDBACK = process.argv.includes('--feedback');
const TURN_LIMIT_MS = Number(process.env.TURN_LIMIT_MS || 6 * 60_000);

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'dc-tool-cards-')));
const OUT = process.env.OUT_DIR || SCRATCH;
mkdirSync(OUT, { recursive: true });

// ── The app's own code, bundled once: the briefing, the chat parser, the server's feedback ─────
const entry = join(SCRATCH, 'entry.ts');
const hasFeedback = existsSync(join(REPO, 'src', 'server', 'card-feedback.ts'));
writeFileSync(entry, [
  `export { CHAT_SURFACE_BRIEFING } from ${JSON.stringify(join(REPO, 'src/server/chat-surface.ts'))};`,
  `export { parseChatActions } from ${JSON.stringify(join(REPO, 'dashboard/src/components/sleepy/chat/chatActions.ts'))};`,
  hasFeedback ? `export { cardFeedback } from ${JSON.stringify(join(REPO, 'src/server/card-feedback.ts'))};` : 'export const cardFeedback = null;',
].join('\n'));
const bundle = join(SCRATCH, 'app.mjs');
const esb = spawnSync(join(REPO, 'node_modules', '.bin', 'esbuild'), [entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`, '--log-level=error'], { encoding: 'utf8', cwd: join(REPO, 'dashboard') });
if (esb.status !== 0) { console.error(esb.stderr); process.exit(2); }
const app = await import(pathToFileURL(bundle).href);

// ── The scratch project ───────────────────────────────────────────────────────────────────────
/** One project per tool, so one tool's files never answer for another's. */
function makeProject(tool) {
  const proj = join(SCRATCH, tool, 'lumen-notes');
  mkdirSync(proj, { recursive: true });
  const git = (...a) => spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: proj });
  git('init', '-q');
  writeFileSync(join(proj, 'README.md'), '# Lumen Notes\n\nA note app for night owls (fictional fixture).\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  spawnSync(process.execPath, [CLI, 'init', '-y', '--name', 'lumen-notes', '--description', 'A note app for night owls'], { cwd: proj, stdio: 'ignore' });
  return proj;
}
// The shim: every `dreamcontext` the agent runs is this build.
const BIN = join(SCRATCH, 'bin');
mkdirSync(BIN, { recursive: true });
writeFileSync(join(BIN, 'dreamcontext'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
const BRIEF = join(SCRATCH, 'briefing.md');
writeFileSync(BRIEF, app.CHAT_SURFACE_BRIEFING, { mode: 0o600 });

const TURNS = [
  { key: 'tools', text: 'Use your own tools, no cards: run `pwd` in the shell, write a file notes/hello.txt containing the word lumen, read it back, and run `dreamcontext tasks list`. Then say in one line what each gave.' },
  { key: 'cards1', text: 'Now show me these chat cards in this one answer, each exactly as your surface instructions describe: a run card for `git status --short`, a secret card asking for API key DEMO_TOKEN, a checklist with two steps for setting up a fictional App Store key, and an MCP card for the server posthog.' },
  { key: 'cards1b', text: 'Now, in one answer: a pin for a dev server on port 5173, and a title for this tab.' },
  { key: 'cards2', text: 'Now in one answer: a dream-actions block with one "ask" button, a dream-html diagram of four nodes where one decision node branches into two, a separate dream-html block with two tabs, and mention the file notes/hello.txt as a clickable path.' },
  { key: 'multiline', text: 'Give me a run card that runs these two commands one after the other, exactly as written on two lines:\nls\npwd' },
  { key: 'subagent', text: 'Call one sub-agent. Tell it to run `pwd` and `dreamcontext snapshot | head -5` in the shell and to read README.md, then report what each gave. Tell me its report.' },
];

// ── One chat ──────────────────────────────────────────────────────────────────────────────────
function childFor(tool, PROJ) {
  const env = { ...process.env, PATH: `${BIN}:${process.env.PATH}` };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|DREAMCONTEXT_TAB_SESSION|DREAMCONTEXT_AGENT_TOOL)/.test(k)) delete env[k];
  if (tool === 'claude') {
    return spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
      '--model', process.env.CLAUDE_MODEL || 'sonnet', '--append-system-prompt-file', BRIEF], { cwd: PROJ, env, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return spawn(process.execPath, [CLI, 't3-chat', '--tool', tool, '--mode', 'bypassPermissions', '--briefing-file', BRIEF, '--cwd', PROJ,
    ...(process.env[`${tool.toUpperCase()}_MODEL`] ? ['--model', process.env[`${tool.toUpperCase()}_MODEL`]] : []),
    // A tool's second account, when its first is out of quota (the owner's own account ids).
    ...(process.env[`${tool.toUpperCase()}_ACCOUNT`] ? ['--account', process.env[`${tool.toUpperCase()}_ACCOUNT`]] : [])], { cwd: PROJ, env, stdio: ['pipe', 'pipe', 'pipe'] });
}

async function runChat(tool) {
  const proj = makeProject(tool);
  const child = childFor(tool, proj);
  let buf = '';
  let stderr = '';
  const frames = [];
  let waiter = null;
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
  child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let f; try { f = JSON.parse(line); } catch { continue; }
      frames.push(f);
      if (f.type === 'result' && !f.dc_synthetic && !f.parent_tool_use_id && waiter) { const w = waiter; waiter = null; w(f); }
    }
  });
  const send = (text) => new Promise((done) => {
    const from = frames.length;
    const timer = setTimeout(() => { waiter = null; done({ from, to: frames.length, timeout: true }); }, TURN_LIMIT_MS);
    waiter = (res) => { clearTimeout(timer); done({ from, to: frames.length, res }); };
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
  });
  const turns = [];
  const only = process.env.TURNS ? process.env.TURNS.split(',') : null;
  for (const t of TURNS.filter((x) => !only || only.includes(x.key))) {
    const r = await send(t.text);
    const slice = frames.slice(r.from, r.to);
    const turn = { key: t.key, ...readTurn(slice), timeout: !!r.timeout, error: r.res?.is_error ? String(r.res.result ?? '').slice(0, 300) : null };
    // The server's part: a skipped card goes back to the agent in a hidden turn (W2).
    if (FEEDBACK && app.cardFeedback) {
      const fb = app.cardFeedback(turn.answer);
      if (fb) {
        const r2 = await send(fb);
        turn.feedback = fb;
        turn.retry = readTurn(frames.slice(r2.from, r2.to));
      }
    }
    turns.push(turn);
    process.stderr.write(`  ${tool} ${t.key}: ${turn.timeout ? 'TIMEOUT' : 'done'}${turn.error ? ` error ${turn.error}` : ''}\n`);
  }
  child.stdin.end();
  setTimeout(() => child.kill('SIGTERM'), 5_000).unref();
  return { tool, proj, turns, stderr };
}

/** The main agent's answer text (every text block, joined) and its tool rows, sub-agents' apart. */
function readTurn(frames) {
  const texts = [];
  const tools = [];
  const results = new Map();
  for (const f of frames) {
    const content = f?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (f.type === 'assistant' && b.type === 'text' && !f.parent_tool_use_id && f.message.model !== '<synthetic>') texts.push(b.text);
      if (f.type === 'assistant' && b.type === 'tool_use') tools.push({ id: b.id, name: b.name, input: b.input, sub: !!f.parent_tool_use_id });
      if (f.type === 'user' && b.type === 'tool_result') results.set(b.tool_use_id, { error: !!b.is_error, text: (Array.isArray(b.content) ? b.content.map((x) => x.text ?? '').join('') : String(b.content ?? '')).slice(0, 600) });
    }
  }
  return { answer: texts.join('\n\n'), tools: tools.map((t) => ({ ...t, input: JSON.stringify(t.input).slice(0, 400), result: results.get(t.id) ?? null })) };
}

// ── Judging ───────────────────────────────────────────────────────────────────────────────────
function judgeCards(answer) {
  const parsed = app.parseChatActions(answer);
  const views = parsed.views ?? [];
  const blocks = parsed.blocks ?? [];
  const has = (type) => views.some((v) => v?.type === type);
  const html = blocks.filter((b) => b.kind === 'html').map((b) => b.html ?? b.source ?? JSON.stringify(b));
  return { parsed, has, html, notices: parsed.notices ?? [] };
}

const cell = (ok, partial = false) => (ok ? 'works' : partial ? 'partial' : 'broken');

const READ_TOOL = /^(Read|mcp__Read|view_file|client_view_file|read_file)$/;
/** Every read row of a chat: `failed/total`, and how many failures named another path. */
function readRow(chat) {
  const reads = chat.turns.flatMap((t) => t.tools ?? []).filter((x) => READ_TOOL.test(x.name) && x.result);
  const failed = reads.filter((x) => x.result.error);
  const otherPath = failed.filter((x) => {
    const named = /Access to path \\?["']([^"'\\]+)\\?["'] is denied/.exec(x.result.text)?.[1];
    return named !== undefined && !x.input.includes(named);
  });
  if (!reads.length) return 'n/a (no read)';
  return `${failed.length}/${reads.length} failed${otherPath.length ? `, ${otherPath.length} with another path's error` : ''}`;
}

function judge(chat) {
  const PROJ = chat.proj;
  const T = Object.fromEntries(chat.turns.map((t) => [t.key, t]));
  const rows = {};
  const t0 = T.tools;
  const ran = (re) => t0?.tools.some((x) => !x.sub && re.test(x.input) && x.result && !x.result.error);
  rows['shell command'] = cell(ran(/\bpwd\b/));
  const wrote = existsSync(join(PROJ, 'notes', 'hello.txt')) && /lumen/i.test(readFileSync(join(PROJ, 'notes', 'hello.txt'), 'utf8'));
  rows['file write'] = cell(wrote);
  rows['file read'] = cell(t0?.tools.some((x) => !x.sub && /hello\.txt/.test(x.input) && x.result && !x.result.error && /lumen/i.test(x.result.text)) || /lumen/i.test(t0?.answer ?? ''));
  rows['dreamcontext CLI'] = cell(ran(/dreamcontext\s+tasks\s+list/));
  const c1 = judgeCards(T.cards1?.answer ?? '');
  for (const k of ['run', 'secret', 'checklist', 'mcp']) rows[`card: ${k}`] = cell(c1.has(k));
  const c1b = judgeCards(T.cards1b?.answer ?? '');
  for (const k of ['pin', 'title']) rows[`card: ${k}`] = cell(c1b.has(k));
  const c2 = judgeCards(T.cards2?.answer ?? '');
  rows['card: dream-actions'] = cell((c2.parsed.actions ?? []).length > 0);
  rows['card: dream-html graph'] = cell(c2.html.some((h) => /dc-graph/.test(h) && /dc-edge/.test(h)), c2.html.some((h) => /dc-graph/.test(h)));
  rows['card: dream-html tabs'] = cell(c2.html.some((h) => /dc-tabs/.test(h) && /dc-tab\b/.test(h)));
  rows['path chip'] = cell(/`notes\/hello\.txt`/.test(T.cards2?.answer ?? ''));
  const ml = judgeCards(T.multiline?.answer ?? '');
  const mlRetry = T.multiline?.retry ? judgeCards(T.multiline.retry.answer) : null;
  rows['multi-line run: card shown'] = ml.has('run') ? 'works' : mlRetry?.has('run') ? 'works after feedback' : 'broken';
  rows['multi-line run: skip reaches agent'] = T.multiline?.feedback ? 'yes' : ml.notices.length ? 'no (skipped silently)' : 'n/a (no skip)';
  const sub = T.subagent;
  const spawned = sub?.tools.some((x) => x.name === 'Agent' || x.name === 'Task');
  const subRan = sub?.tools.some((x) => x.sub && /\bpwd\b/.test(x.input) && x.result && !x.result.error);
  const subSnap = /lumen-notes|Lumen Notes|night owls/i.test(sub?.answer ?? '') || sub?.tools.some((x) => x.sub && /snapshot/.test(x.input) && x.result && !x.result.error);
  const subErr = sub?.tools.filter((x) => x.sub && x.result?.error).map((x) => x.result.text.slice(0, 120));
  rows['sub-agent: starts'] = cell(spawned);
  rows['sub-agent: shell + snapshot'] = spawned ? cell(subRan && subSnap, subRan || subSnap) : 'n/a';
  rows['file reads: failed'] = readRow(chat);
  return { rows, notices: { cards1: c1.notices, cards1b: c1b.notices, cards2: c2.notices, multiline: ml.notices }, subErrors: subErr ?? [] };
}

const JUDGE = process.argv.includes('--judge') ? process.argv.slice(process.argv.indexOf('--judge') + 1).filter((a) => a.endsWith('.json')) : null;
const results = [];
if (JUDGE) for (const file of JUDGE) {
  const chat = JSON.parse(readFileSync(file, 'utf8'));
  // The saved rows stand (the scratch project is gone); only the read row is worked out again.
  results.push({ tool: chat.tool, verdict: { ...chat.verdict, rows: { ...chat.verdict.rows, 'file reads: failed': readRow(chat) } } });
}
for (const tool of JUDGE ? [] : TOOLS) {
  process.stderr.write(`${tool}: starting\n`);
  const chat = await runChat(tool);
  const verdict = judge(chat);
  writeFileSync(join(OUT, `tool-cards-${tool}.json`), JSON.stringify({ ...chat, verdict }, null, 2));
  results.push({ tool, verdict });
}

const keys = Object.keys(results[0]?.verdict.rows ?? {});
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('capability', 36)}${results.map((r) => pad(r.tool, 26)).join('')}`);
for (const k of keys) console.log(`${pad(k, 36)}${results.map((r) => pad(r.verdict.rows[k], 26)).join('')}`);
for (const r of results) {
  for (const [turn, list] of Object.entries(r.verdict.notices)) for (const n of list) console.log(`  ${r.tool} ${turn} notice: ${n}`);
  for (const e of r.verdict.subErrors) console.log(`  ${r.tool} sub-agent tool error: ${e}`);
}
console.log(`\nfull answers: ${OUT}/tool-cards-<tool>.json · projects under ${SCRATCH}`);
