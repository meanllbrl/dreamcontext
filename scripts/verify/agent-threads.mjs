#!/usr/bin/env node
/**
 * Agents steps 3 & 4 — runtime proof that a message carries real content and
 * that a reply reaches the run's own session.
 *
 *   npm run build && npm run verify:agent-threads
 *
 * Driven against the REAL dashboard server, the REAL `/api/automations/*` and
 * `/api/graph/content` routes, the REAL runner (it spawns a scripted stand-in
 * for `claude` and the runner writes its own thread entries), and the REAL
 * React surface in Chromium. Nothing here is asserted by reading source.
 *
 * WHAT IT PROVES, one checkpoint per acceptance criterion:
 *   A1  A run that asked with `propose --choice` shows THOSE buttons; pressing
 *       one answers through the existing question route and the run reads `done`.
 *   A2  `--kv` rows land as a summary block, and the CLI refuses an over-cap
 *       `--kv` / `--choice` without writing anything.
 *   A3  Four files, four renderings: a doc chip, an inline image served by the
 *       NON-desktop-gated vault route WITH its CSP, an `.svg` that is not
 *       rendered as an image, and a board that draws on desktop and degrades to
 *       a chip off it.
 *   A6  The thread composer is the chat's real `Composer`; a reply returns 202
 *       and the terminal row carries a duration.
 *   A7/D9/D10  Every rung of the refusal ladder speaks the server's sentence.
 *   A8  An @mention runs a call-mode agent once and opens its thread.
 *   A10 A reply orphaned by a server restart is closed exactly once, by a
 *       derived `~r` id, and re-reconciling does not double it.
 *   A13 `Open session` ACKs true.
 *   A15 A resumed run reaches a terminal status word rather than reading
 *       `running` for ever.
 *   D11 The PDF the Knowledge page frames carries NO `Content-Security-Policy`
 *       — the image hardening must not have blanked a shipped viewer.
 *
 * ONE LEG IS DELIBERATELY NOT AUTOMATED. "A Knowledge PDF still RENDERS inline"
 * needs Chrome's internal PDF plugin to have painted, which Playwright cannot
 * honestly assert — so this file proves the header contract and the owner's
 * gate checklist carries the human step. Faking it would be worse than naming it.
 *
 * WHAT IT DOES NOT TOUCH — your machine. Isolated fake HOME, a scratch project,
 * and a stand-in on PATH instead of `claude`: no model runs, no tokens, no auth.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = join(REPO, 'dist', 'index.js');

const SCRATCH = join(tmpdir(), 'dc-ui-agent-threads');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const AUTOMATIONS_DIR = join(CONTEXT_ROOT, 'automations');
const SHOTS = join(REPO, 'tmp', 'verify-agent-threads');

/** The marker every thread entry block opens with (`types.ts`). */
const THREAD_ENTRY_MARKER = '<!-- dc-thread-entry -->';

const POSTED = 'Signups fell 12% after the pricing change; the trial step is where they drop.';
const ASK_TITLE = 'Ship the pricing rollback?';
const ASK_BODY = 'Signups are down 12%. I can revert the pricing page or leave it and keep measuring.';
const CHOICE_A = 'Revert it';
const CHOICE_B = 'Keep measuring';

const report = { pass: 0, fail: 0 };
function check(label, ok, ev = '') {
  if (ok) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fail++; console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const BIN_PATH = () =>
  [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');

function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [DIST_INDEX, ...args], {
    cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8',
  });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`cli ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return { out: r.stdout, err: r.stderr, status: r.status };
}

/**
 * The stand-in for `claude`, branching on DREAMCONTEXT_AUTOMATION_SLUG.
 *
 * Every `dreamcontext` call it makes passes NO run id and NO `--run`: the run
 * binding is the environment the runner exported, so a broken binding makes the
 * CLI refuse and the disk assertions fail. That is the end-to-end proof the unit
 * tests cannot give.
 */
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const slug = process.env.DREAMCONTEXT_AUTOMATION_SLUG || '';
const DC = ${JSON.stringify(DIST_INDEX)};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const run = (args) => spawnSync(process.execPath, [DC, ...args], { encoding: 'utf-8' });

const prompt = (() => { const i = process.argv.indexOf('-p'); return i === -1 ? '' : (process.argv[i + 1] || ''); })();
const isResume = process.argv.includes('--resume');

// A RESUMED turn — a thread reply or an answered question. It answers in the
// THREAD, which is what the thread-surface preamble tells it to do.
if (isResume) {
  const msg = (prompt.match(/--- THE HUMAN'S MESSAGE \\(verbatim\\) ---\\n([\\s\\S]*?)\\n--- END MESSAGE ---/) || [])[1];
  if (msg) run(['automations', 'post', slug, 'Reply noted: ' + msg.trim()]);
  out({ session_id: 'standin-' + slug, is_error: false, result: 'Done.', total_cost_usd: 0.02,
    num_turns: 1, duration_ms: 4000, permission_denials: [] });
  process.exit(0);
}

const askMatch = prompt.match(/--- THE OWNER JUST ASKED YOU THIS, IN THE #agents CHANNEL ---\\n([\\s\\S]*?)\\n--- END OF WHAT THEY SAID ---/);
const ask = askMatch ? askMatch[1].trim() : '';
if (ask) {
  run(['automations', 'post', slug, 'You asked for: ' + ask]);
  out({ session_id: 'standin-ask-' + slug, is_error: false, result: 'Answered.\\n\\n## Detail\\n\\nRows.\\n',
    total_cost_usd: 0.04, num_turns: 2, duration_ms: 9000, permission_denials: [] });
  process.exit(0);
}

if (slug === 'digest') {
  // THE RICH POST: four files, one of each rendering, plus a bounded summary.
  const r = run(['automations', 'post', slug, ${JSON.stringify(POSTED)},
    '--file', 'automations/output/digest/note.md',
    '--file', 'automations/output/digest/shot.png',
    '--file', 'automations/output/digest/logo.svg',
    '--file', 'automations/output/digest/plan.excalidraw.md',
    '--kv', 'Signups=-12%', '--kv', 'Trial starts=-31%', '--kv', 'Revenue=flat']);
  if (r.status !== 0) process.stderr.write('POST FAILED: ' + (r.stderr || r.stdout) + '\\n');
}

if (slug === 'asker') {
  // propose is guarded by the sidecar's process GROUP, so only a real run's
  // own child can call it — which is exactly what this is.
  const r = run(['automations', 'propose', slug, '--title', ${JSON.stringify(ASK_TITLE)},
    '--body', ${JSON.stringify(ASK_BODY)},
    '--choice', ${JSON.stringify(CHOICE_A)}, '--choice', ${JSON.stringify(CHOICE_B)}]);
  if (r.status !== 0) process.stderr.write('PROPOSE FAILED: ' + (r.stderr || r.stdout) + '\\n');
  out({ session_id: 'standin-asker', is_error: false, result: 'Proposed.\\n', total_cost_usd: 0.03,
    num_turns: 2, duration_ms: 7000, permission_denials: [] });
  process.exit(0);
}

if (slug === 'slowpoke') {
  // Long enough that a reply sent while it runs meets a live job rather than
  // racing it — the busy rung needs a run genuinely in flight.
  const until = Date.now() + 9000;
  while (Date.now() < until) { /* hold the run slot */ }
  out({ session_id: 'standin-slowpoke', is_error: false, result: 'Slow done.\\n', total_cost_usd: 0.01,
    num_turns: 1, duration_ms: 9000, permission_denials: [] });
  process.exit(0);
}

out({ session_id: 'standin-' + slug, is_error: false, result: 'Nothing notable.\\n\\n## Detail\\n\\nRows.\\n',
  total_cost_usd: 0.31, num_turns: 4, duration_ms: 252000, permission_denials: [] });
`;

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** The smallest structurally valid PDF — enough for the route to type and stream it. */
const PDF_MIN = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 99 99]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF\n',
  'utf-8',
);

/** A minimal Excalidraw board the plugin parser accepts. */
const BOARD = `---
excalidraw-plugin: parsed
---

# Excalidraw Data

## Drawing
\`\`\`json
{"type":"excalidraw","version":2,"source":"verify","elements":[],"appState":{"gridSize":null,"viewBackgroundColor":"#ffffff"},"files":{}}
\`\`\`
`;

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(AUTOMATIONS_DIR, { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'core'), { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  cli(['vaults', 'add', 'proj', PROJ]);

  const outDir = join(AUTOMATIONS_DIR, 'output', 'digest');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'note.md'), '# The note\n\nAttached by the run.\n');
  writeFileSync(join(outDir, 'shot.png'), PNG_1PX);
  // An SVG the agent posted. It must NOT come back as `image/svg+xml` — the
  // route is generic and the Knowledge page frames it same-origin.
  writeFileSync(join(outDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg>');
  writeFileSync(join(outDir, 'plan.excalidraw.md'), BOARD);
  // The PDF the Knowledge page would frame — the non-regression subject.
  writeFileSync(join(CONTEXT_ROOT, 'handbook.pdf'), PDF_MIN);

  mkdirSync(join(AUTOMATIONS_DIR, 'photos'), { recursive: true });
  writeFileSync(join(AUTOMATIONS_DIR, 'photos', 'digest.png'), PNG_1PX);

  cli(['automations', 'create', 'digest', '--title', 'Daily insight digest', '--days', 'daily', '--at', '09:00']);
  cli(['automations', 'create', 'asker', '--title', 'Pricing watch', '--days', 'daily', '--at', '10:00', '--review', 'agent']);
  cli(['automations', 'create', 'oncall', '--title', 'Deep researcher', '--mode', 'call']);
  cli(['automations', 'create', 'slowpoke', '--title', 'Slow crawler', '--days', 'daily', '--at', '11:00']);
  cli(['automations', 'create', 'offline', '--title', 'Retired watcher', '--days', 'daily', '--at', '12:00']);
  cli(['automations', 'create', 'orphan', '--title', 'Interrupted agent', '--days', 'daily', '--at', '13:00']);
  cli(['automations', 'create', 'orphan2', '--title', 'Interrupted again', '--days', 'daily', '--at', '14:00']);

  const digestPath = join(AUTOMATIONS_DIR, 'digest.md');
  writeFileSync(digestPath,
    readFileSync(digestPath, 'utf-8').replace(/^photo: null$/m, 'photo: automations/photos/digest.png'));

  for (const slug of ['digest', 'asker', 'oncall', 'slowpoke', 'offline', 'orphan', 'orphan2']) {
    cli(['automations', 'approve', slug, '--yes']);
  }
  // Turned OFF after approval, so the reply route's FIRST rung has a subject.
  cli(['automations', 'disable', 'offline']);
}

/**
 * An orphaned `user` entry — the state a server that died mid-reply leaves
 * behind: a reply on disk, no answer, no sidecar. Written straight into the day
 * file because there is no verb for it: the crash is what produces it.
 *
 * The id's timestamp is deliberately OLD, so it is older than the next server
 * process's `PROCESS_STARTED_AT` and therefore reconcilable.
 */
function seedOrphan(slug, runId) {
  const ms = Date.now() - 60 * 60 * 1000;
  const id = `${ms.toString(36).padStart(9, '0')}_00orph`;
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(AUTOMATIONS_DIR, 'threads', slug);
  mkdirSync(dir, { recursive: true });
  const entry = { id, runId, kind: 'user', at: new Date(ms).toISOString(), text: 'did it land?', via: 'dashboard' };
  writeFileSync(join(dir, `${day}.md`),
    `---\nslug: ${slug}\ndate: ${day}\nversion: 1\n---\n\n`
    + `${THREAD_ENTRY_MARKER}\n\`\`\`json\n${JSON.stringify(entry)}\n\`\`\`\n\n`);
  return id;
}

async function startServer(port) {
  const srv = spawn(process.execPath, [DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    // The board's asset route is desktop-gated SERVER-side; the CLIENT decides
    // separately (Tauri internals), which is what lets one server drive both the
    // on-desktop and off-desktop board renderings below.
    env: { ...process.env, HOME, PATH: BIN_PATH(), DREAMCONTEXT_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('server did not come up');
}

function runAgent(slug) {
  return spawnSync(process.execPath, [DIST_INDEX, 'automations', 'run', slug, '--force'], {
    cwd: PROJ, env: { ...process.env, HOME, PATH: BIN_PATH() }, encoding: 'utf-8',
  });
}

function threadEntries(slug) {
  const dir = join(AUTOMATIONS_DIR, 'threads', slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const raw = readFileSync(join(dir, f), 'utf-8');
    return [...raw.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Header-level truth about one raw vault read, straight off the wire. */
async function rawHeaders(base, path) {
  const r = await fetch(`${base}/api/graph/content?path=${encodeURIComponent(path)}&raw=1&vault=proj`);
  return {
    status: r.status,
    type: r.headers.get('content-type'),
    csp: r.headers.get('content-security-policy'),
    nosniff: r.headers.get('x-content-type-options'),
    disposition: r.headers.get('content-disposition'),
  };
}

async function main() {
  console.log('· fixture (isolated HOME, real manifests, real runner, stand-in claude)…');
  seed();

  // ── 0: real runs write the channel ────────────────────────────────────
  console.log('\n═══ 0. Real runs ═══');
  runAgent('digest');
  runAgent('asker');

  const digest = threadEntries('digest');
  const post = digest.find((e) => e.kind === 'agent');
  check('the posting run wrote started → post → ok',
    digest.map((e) => e.event ?? e.kind).join(' ') === 'started agent ok',
    digest.map((e) => e.event ?? e.kind).join(' '));
  check('…binding to its run through the ENVIRONMENT alone',
    !!post && post.text === POSTED && post.runId === digest[0]?.runId);
  check('the post carries its four files', (post?.files ?? []).length === 4, JSON.stringify(post?.files));
  check('…and a three-row summary from --kv', (post?.summary ?? []).length === 3, JSON.stringify(post?.summary));
  check('…with the keys and values it was given',
    (post?.summary ?? []).some((r) => r.key === 'Signups' && r.value === '-12%'), JSON.stringify(post?.summary));

  // The CLI is the floor for both caps, and refusing must write NOTHING.
  const before = threadEntries('digest').length;
  const overKv = cli(['automations', 'post', 'digest', 'too many rows',
    '--run', digest[0].runId,
    '--kv', 'a=1', '--kv', 'b=2', '--kv', 'c=3', '--kv', 'd=4', '--kv', 'e=5', '--kv', 'f=6', '--kv', 'g=7'],
  { allowFail: true });
  check('a 7th --kv exits non-zero', overKv.status !== 0, `status=${overKv.status}`);
  check('…and writes nothing', threadEntries('digest').length === before);

  // A `review: agent` proposal is NOT the runner's `asked` entry — that one
  // belongs to the flow-hitl and review:output gates, which ask on the run's
  // behalf. `propose` is the RUN asking for itself: it records a question and
  // the run finishes normally, so the thread reads `started ok` and what marks
  // the message is the open question, joined in by the feed.
  const askerQuestions = existsSync(join(AUTOMATIONS_DIR, 'hitl', 'asker'))
    ? readdirSync(join(AUTOMATIONS_DIR, 'hitl', 'asker')).filter((f) => f.endsWith('.json'))
    : [];
  check('the asking run recorded a question', askerQuestions.length === 1, JSON.stringify(askerQuestions));
  const askerQ = askerQuestions[0]
    ? JSON.parse(readFileSync(join(AUTOMATIONS_DIR, 'hitl', 'asker', askerQuestions[0]), 'utf-8'))
    : null;
  check('…carrying the agent\'s own two choices, capped and sanitised',
    JSON.stringify(askerQ?.choices) === JSON.stringify([CHOICE_A, CHOICE_B]), JSON.stringify(askerQ?.choices));

  // The other cap, refused at the CLI rather than silently truncated.
  const overChoice = cli(['automations', 'propose', 'asker', '--title', 'x', '--body', 'y',
    '--choice', 'a', '--choice', 'b', '--choice', 'c', '--choice', 'd', '--choice', 'e'], { allowFail: true });
  check('a 5th --choice exits non-zero', overChoice.status !== 0, `status=${overChoice.status}`);
  check('…and creates nothing', (existsSync(join(AUTOMATIONS_DIR, 'hitl', 'asker'))
    ? readdirSync(join(AUTOMATIONS_DIR, 'hitl', 'asker')).filter((f) => f.endsWith('.json')).length
    : 0) === 1);

  const orphanRunId = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const orphanId = seedOrphan('orphan', orphanRunId);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let srv = await startServer(port);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await page.waitForTimeout(150); }
    return false;
  };
  const dismissOverlays = async () => {
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      if (await page.locator('.announcements-modal-scrim').count() === 0) break;
    }
  };

  try {
    // ── 1: the raw vault route — the two-sided header contract ───────────
    console.log('\n═══ 1. What the vault route serves ═══');
    const png = await rawHeaders(base, 'automations/output/digest/shot.png');
    check('a posted PNG is served as an image', png.status === 200 && png.type === 'image/png', JSON.stringify(png));
    check('…carrying the hardening CSP', png.csp === "default-src 'none'; sandbox", `csp=${png.csp}`);
    check('…and nosniff', png.nosniff === 'nosniff', `nosniff=${png.nosniff}`);

    // THE NON-REGRESSION. `sandbox` is a DOCUMENT directive, and this route also
    // serves the .pdf the Knowledge page frames through PdfViewer — a blanket
    // header here would blank a shipped viewer to harden a type that cannot
    // carry script. The scoping is what this asserts.
    const pdf = await rawHeaders(base, 'handbook.pdf');
    check('the Knowledge PDF still streams', pdf.status === 200 && pdf.type === 'application/pdf', JSON.stringify(pdf));
    check('…with NO Content-Security-Policy on it', pdf.csp === null, `csp=${pdf.csp}`);
    check('…keeping nosniff and inline exactly as before', pdf.nosniff === 'nosniff' && /inline/.test(pdf.disposition ?? ''),
      JSON.stringify(pdf));

    const svg = await rawHeaders(base, 'automations/output/digest/logo.svg');
    check('an .svg is NOT served as image/svg+xml', svg.type !== 'image/svg+xml', `type=${svg.type}`);

    // ── 2: the message carries its content ───────────────────────────────
    console.log('\n═══ 2. A rich message ═══');
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await dismissOverlays();
    await page.locator('.sidebar-item', { hasText: 'Agents' }).first().click();
    check('the channel opens', await until(async () => (await page.locator('.agent-msg').count()) >= 2, 20000));

    const digestMsg = page.locator('.agent-msg', { hasText: 'Daily insight digest' }).first();
    check('the body is the agent\'s own post', (await digestMsg.locator('.agent-msg-text').innerText()).trim() === POSTED);

    const kv = digestMsg.locator('.agent-msg-kv-row');
    check('the --kv rows render as a summary block', await kv.count() === 3, `rows=${await kv.count()}`);
    check('…with the key and the value it was posted with',
      (await kv.first().innerText()).includes('Signups') && (await kv.first().innerText()).includes('-12%'),
      await kv.first().innerText());

    // ── 3: four files, four renderings ───────────────────────────────────
    console.log('\n═══ 3. Four files, four renderings ═══');
    const imgs = digestMsg.locator('.agent-msg-img img');
    check('the PNG renders INLINE, in a browser with no desktop flag', await imgs.count() === 1,
      `images=${await imgs.count()}`);
    const src = await imgs.first().getAttribute('src');
    check('…through the vault route, not the desktop-gated one',
      (src ?? '').includes('/graph/content') && (src ?? '').includes('raw=1'), `src=${src}`);
    check('…and it actually loaded',
      await imgs.first().evaluate((el) => el.complete && el.naturalWidth > 0));

    const chipNames = await digestMsg.locator('.agent-msg-file .agent-msg-file-name').allInnerTexts();
    check('the markdown note is a chip', chipNames.some((n) => n.includes('note.md')), chipNames.join(', '));
    check('…the .svg is a chip too, never an image', chipNames.some((n) => n.includes('logo.svg')), chipNames.join(', '));
    // Off desktop the board degrades rather than drawing an empty canvas.
    check('…and the board degrades to a chip off desktop',
      chipNames.some((n) => n.includes('plan.excalidraw.md')), chipNames.join(', '));
    check('…saying where boards open',
      (await digestMsg.locator('.agent-msg-file-note').first().innerText()).length > 0,
      await digestMsg.locator('.agent-msg-file-note').first().innerText().catch(() => '(none)'));
    check('no board canvas is drawn off desktop', await digestMsg.locator('.chat-board').count() === 0);

    await digestMsg.locator('.agent-msg-file').first().click();
    check('a chip OPENS the document', await until(async () => (await page.locator('.chat-slideover-panel').count()) > 0, 10000));
    await page.keyboard.press('Escape');
    await until(async () => (await page.locator('.chat-slideover-panel').count()) === 0, 5000);
    await page.screenshot({ path: join(SHOTS, '1-rich-message.png') });

    // ── 4: the question with the agent's own options ─────────────────────
    console.log('\n═══ 4. A question with buttons ═══');
    const askerMsg = page.locator('.agent-msg', { hasText: 'Pricing watch' }).first();
    const choices = askerMsg.locator('.agent-msg-question-choice');
    check('the asking run shows a question block', await until(async () => (await choices.count()) > 0, 10000));
    const choiceText = await choices.allInnerTexts();
    check('…carrying the agent\'s OWN two options', await choices.count() === 2
      && choiceText.some((c) => c.includes(CHOICE_A)) && choiceText.some((c) => c.includes(CHOICE_B)),
      choiceText.join(' | '));
    // A `review: agent` proposal is NOT the runner's own `asked` entry — the run
    // finished and reads `done`; what says a human is needed is the JOIN against
    // the open question, which is where `needsYou` comes from. So the marker is
    // the assertion, not the status word.
    check('…and the message is marked as waiting on the reader',
      await askerMsg.locator('.agent-msg-needs').count() === 1,
      `status="${await askerMsg.locator('.agent-msg-status').innerText()}"`);
    await page.screenshot({ path: join(SHOTS, '2-question.png') });

    // A reply while that question is open is refused by its own rung.
    const askerRun = threadEntries('asker')[0]?.runId;
    const qPending = await page.evaluate(async ([runId]) => {
      const r = await fetch('/api/automations/asker/thread/reply', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'anything', runId }),
      });
      return { status: r.status, body: await r.text() };
    }, [askerRun]);
    check('a reply while a question is open is refused 409 question_pending',
      qPending.status === 409 && /question_pending/.test(qPending.body), JSON.stringify(qPending));

    await choices.first().click();
    check('pressing a choice records the answer',
      await until(async () => (await askerMsg.locator('.agent-msg-question-receipt').count()) > 0, 20000));
    // The answer resumes the asking session, which settles ASYNCHRONOUSLY — the
    // receipt above is the click landing, not the turn finishing.
    check('…and `resumeWithAnswer` closes it with a system:replied',
      await until(() => threadEntries('asker').some((e) => e.event === 'replied'), 90000),
      threadEntries('asker').map((e) => e.event ?? e.kind).join(' '));
    check('…after which nothing is waiting on the reader any more',
      await until(async () => (await askerMsg.locator('.agent-msg-needs').count()) === 0, 30000),
      `still marked: ${await askerMsg.locator('.agent-msg-needs').count()}`);

    // ── 5: the thread composer is the chat's own ─────────────────────────
    console.log('\n═══ 5. The thread composer ═══');
    await digestMsg.locator('.agent-msg-replies').first().click();
    const panel = page.locator('.agent-thread');
    check('the thread panel opens', await until(async () => (await panel.count()) > 0, 10000));
    // The proof BY CONSTRUCTION (pattern-component-reuse-over): a regression to a
    // hand-rolled textarea makes these selectors vanish.
    check('it mounts the chat\'s real Composer — the input',
      await until(async () => (await panel.locator('.chat-cmp-input').count()) > 0, 10000));
    check('…and its Send button', await panel.locator('.chat-cmp-send').count() > 0);
    check('…and no bespoke box came back', await page.locator('.agent-thread-input').count() === 0);
    await page.screenshot({ path: join(SHOTS, '3-thread-composer.png') });

    // ── 6: a reply reaches the run's session ─────────────────────────────
    console.log('\n═══ 6. Replying ═══');
    const digestRun = digest[0].runId;
    const REPLY = 'which step exactly?';
    const accepted = await page.evaluate(async ([runId, text]) => {
      const r = await fetch('/api/automations/digest/thread/reply', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, runId }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, [digestRun, REPLY]);
    check('a reply on the newest run returns 202', accepted.status === 202, JSON.stringify(accepted));
    check('…with a reply-job id to poll', !!accepted.body?.job?.id, JSON.stringify(accepted.body?.job));
    check('…and the user entry is on disk immediately',
      threadEntries('digest').some((e) => e.kind === 'user' && e.text === REPLY));

    const settled = await until(async () => threadEntries('digest').some((e) => e.event === 'replied'), 90000);
    check('the reply turn settles with a system:replied', settled,
      threadEntries('digest').map((e) => e.event ?? e.kind).join(' '));
    const repliedRow = threadEntries('digest').find((e) => e.event === 'replied');
    check('…whose row carries the turn\'s duration', /\d+m|\d+s/.test(repliedRow?.text ?? ''), repliedRow?.text);
    check('…and the resumed session posted back into the SAME run',
      threadEntries('digest').some((e) => e.kind === 'agent' && e.text.includes('Reply noted') && e.runId === digestRun),
      JSON.stringify(threadEntries('digest').filter((e) => e.kind === 'agent').map((e) => e.text)));

    // ── 7: the refusal ladder, rung by rung ──────────────────────────────
    console.log('\n═══ 7. The refusal ladder ═══');
    const replyTo = (slug, body) => page.evaluate(async ([s, b]) => {
      const r = await fetch(`/api/automations/${s}/thread/reply`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
      });
      return { status: r.status, body: await r.text() };
    }, [slug, body]);

    const offBefore = threadEntries('offline').length;
    const disabled = await replyTo('offline', { text: 'hello', runId: digestRun });
    check('a disabled agent refuses 409 reply_disabled',
      disabled.status === 409 && /reply_disabled/.test(disabled.body), JSON.stringify(disabled));
    check('…and writes nothing', threadEntries('offline').length === offBefore);

    const badRun = await replyTo('digest', { text: 'hello', runId: 'not-a-timestamp' });
    check('a malformed run id is refused 400 bad_run',
      badRun.status === 400 && /bad_run/.test(badRun.body), JSON.stringify(badRun));

    const stale = await replyTo('digest', { text: 'hello', runId: new Date(Date.parse(digestRun) - 60000).toISOString() });
    check('an older run is refused 409 stale_run', stale.status === 409 && /stale_run/.test(stale.body), JSON.stringify(stale));
    check('…in the words a person can act on',
      /moved on/.test(stale.body) && /newest run/.test(stale.body), stale.body);

    const emptyText = await replyTo('digest', { text: '   ', runId: digestRun });
    check('an empty reply is refused 400 bad_text',
      emptyText.status === 400 && /bad_text/.test(emptyText.body), JSON.stringify(emptyText));

    // `not_bound` sits BELOW `stale_run` on the ladder, so reaching it needs an
    // agent whose newest run is the one being replied to AND which never
    // completed a run on this machine. The orphan's seeded thread is exactly
    // that: a run id with entries and no session behind it.
    const notBound = await replyTo('orphan', { text: 'hello', runId: orphanRunId });
    check('an agent with no session on this machine refuses 409 not_bound',
      notBound.status === 409 && /not_bound/.test(notBound.body), JSON.stringify(notBound));

    // `busy`: a run genuinely in flight holds the project's one run slot.
    await page.evaluate(async () => {
      await fetch('/api/automations/slowpoke/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    });
    await page.waitForTimeout(1200);
    const busy = await replyTo('digest', { text: 'while busy', runId: digestRun });
    check('a reply while a run holds the slot is refused 409 busy',
      busy.status === 409 && /busy/.test(busy.body), JSON.stringify(busy));
    check('…naming who is holding it', /Slow crawler/.test(busy.body), busy.body);

    // ── 8: calling an on-call agent by name ──────────────────────────────
    console.log('\n═══ 8. @mentioning an agent ═══');
    await until(async () => {
      const r = await page.evaluate(async () => (await fetch('/api/automations/runs')).json().catch(() => null));
      return !r?.job || r.job.status !== 'running';
    }, 30000);
    const said = await page.evaluate(async () => {
      const r = await fetch('/api/automations/threads/say', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'oncall', text: 'look at the paywall numbers' }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    });
    check('a call-mode agent accepts the message', said.status === 200, JSON.stringify(said));
    check('…and it starts a RUN rather than a resume', said.body?.mode === 'call' && said.body?.job?.kind === 'run',
      JSON.stringify(said.body));
    check('…which answers with the words that were typed',
      await until(() => threadEntries('oncall').some((e) => e.kind === 'agent' && e.text.includes('paywall')), 90000),
      JSON.stringify(threadEntries('oncall').map((e) => e.text)));
    check('…and the exchange opens with the human\'s own entry',
      threadEntries('oncall')[0]?.kind === 'user');
    await page.screenshot({ path: join(SHOTS, '4-called.png') });

    // A SCHEDULED agent with a bound session takes the other branch: it RESUMES
    // rather than running, under a fresh run id that the run cache knows nothing
    // about. That run id is the one that used to read "running" for ever, because
    // no `ok` was ever written for it — `replied` is what gives it a terminal word.
    const saidSched = await page.evaluate(async () => {
      const r = await fetch('/api/automations/threads/say', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'digest', text: 'and the trial step?' }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    });
    check('a scheduled agent with a session RESUMES instead of running',
      saidSched.status === 200 && saidSched.body?.mode === 'sched' && saidSched.body?.job?.kind === 'reply',
      JSON.stringify(saidSched));
    const schedRun = saidSched.body?.runId;
    check('…closing its own fresh run with a replied entry',
      await until(() => threadEntries('digest').some((e) => e.runId === schedRun && e.event === 'replied'), 90000),
      JSON.stringify(threadEntries('digest').filter((e) => e.runId === schedRun).map((e) => e.event ?? e.kind)));
    // THE REGRESSION THIS PINS: a fresh run id has no cache entry, so without
    // `replied` mapping to a terminal word the message reads `running` for ever.
    const schedStatus = await page.evaluate(async ([run]) => {
      const feed = await (await fetch('/api/automations/threads')).json();
      return feed.messages.find((m) => m.runId === run)?.status ?? null;
    }, [schedRun]);
    check('…and the feed gives that run a TERMINAL status word, not "running"',
      schedStatus === 'done', `status=${schedStatus}`);

    // ── 9: the board, with the desktop shell present ─────────────────────
    console.log('\n═══ 9. The board on desktop ═══');
    const deskCtx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    // `isDesktop()` reads the Tauri bridge off `window`; injecting it is what
    // makes the desktop BRANCH reachable from a browser, and the server is
    // already running with the desktop gate open.
    await deskCtx.addInitScript(() => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    });
    const deskPage = await deskCtx.newPage();
    await deskPage.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await deskPage.waitForTimeout(2500);
    for (let i = 0; i < 4; i++) { await deskPage.keyboard.press('Escape'); await deskPage.waitForTimeout(200); }
    await deskPage.locator('.sidebar-item', { hasText: 'Agents' }).first().click();
    const deskDigest = deskPage.locator('.agent-msg', { hasText: 'Daily insight digest' }).first();
    const drew = await (async () => {
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        if (await deskDigest.locator('.chat-board').count() > 0) return true;
        await deskPage.waitForTimeout(200);
      }
      return false;
    })();
    check('on desktop the board DRAWS instead of degrading', drew,
      `boards=${await deskDigest.locator('.chat-board').count()}`);
    check('…and it is the same run\'s board, named', drew
      && (await deskDigest.locator('.chat-board-name').first().innerText()).includes('plan'),
      await deskDigest.locator('.chat-board-name').first().innerText().catch(() => '(none)'));
    await deskPage.screenshot({ path: join(SHOTS, '5-board-desktop.png') });
    await deskCtx.close();

    // ── 10: a reply orphaned by a restart is closed exactly once ─────────
    console.log('\n═══ 10. Restart mid-reply ═══');
    const gone = await page.evaluate(async () => {
      const r = await fetch('/api/automations/reply-job/aj_doesnotexist');
      return { status: r.status, body: await r.text() };
    });
    check('an unknown reply job answers 404, which is TERMINAL for the poller',
      gone.status === 404 && /job_unknown/.test(gone.body), JSON.stringify(gone));

    // Orphan A was seeded before this server started, so the FIRST overview this
    // process served — the feed's own first poll, long before now — closed it.
    // The page has polled many times since, which is the idempotency claim.
    check('the orphan a previous process left is closed by the DERIVED id',
      threadEntries('orphan').some((e) => e.id === `${orphanId}~r`),
      JSON.stringify(threadEntries('orphan').map((e) => e.id)));
    check('…saying the outcome is unknown rather than inventing one',
      /unknown/i.test(threadEntries('orphan').find((e) => e.id === `${orphanId}~r`)?.text ?? ''),
      threadEntries('orphan').find((e) => e.id === `${orphanId}~r`)?.text);
    check('…exactly once, across every poll since',
      threadEntries('orphan').filter((e) => e.id === `${orphanId}~r`).length === 1,
      JSON.stringify(threadEntries('orphan').map((e) => e.id)));

    // ORPHAN B — seeded into a process that has ALREADY reconciled this vault.
    // It must stay open: reconciliation is memoized per vault per process, and
    // that is the documented behaviour, not an oversight. The next process is
    // what closes it.
    const orphanBRun = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const orphanBId = seedOrphan('orphan2', orphanBRun);
    await page.evaluate(async () => { await fetch('/api/automations/threads'); });
    await page.waitForTimeout(800);
    check('a NEW orphan is not closed by a process that already reconciled this vault',
      !threadEntries('orphan2').some((e) => e.id === `${orphanBId}~r`),
      JSON.stringify(threadEntries('orphan2').map((e) => e.id)));

    // A FRESH PROCESS closes it on its first threads-overview request.
    srv.kill();
    await new Promise((r) => setTimeout(r, 1500));
    srv = await startServer(port);
    await fetch(`${base}/api/automations/threads`, { headers: { 'x-dreamcontext-vault': 'proj' } });
    await new Promise((r) => setTimeout(r, 1000));
    check('…and the next process closes it on its first overview',
      threadEntries('orphan2').some((e) => e.id === `${orphanBId}~r`),
      JSON.stringify(threadEntries('orphan2').map((e) => e.id)));
    // Two concurrent overviews in that new process must not double it — the id is
    // derived, so even a lost memo race collapses on read.
    await Promise.all([
      fetch(`${base}/api/automations/threads`, { headers: { 'x-dreamcontext-vault': 'proj' } }),
      fetch(`${base}/api/automations/threads`, { headers: { 'x-dreamcontext-vault': 'proj' } }),
    ]);
    await new Promise((r) => setTimeout(r, 800));
    check('…exactly once, even with two overviews racing',
      threadEntries('orphan2').filter((e) => e.id === `${orphanBId}~r`).length === 1,
      JSON.stringify(threadEntries('orphan2').map((e) => e.id)));
    check('…and orphan A was not re-closed a second time either',
      threadEntries('orphan').filter((e) => e.id === `${orphanId}~r`).length === 1,
      JSON.stringify(threadEntries('orphan').map((e) => e.id)));

    // ── 11: Open session ─────────────────────────────────────────────────
    console.log('\n═══ 11. Open session ═══');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await dismissOverlays();
    await page.locator('.sidebar-item', { hasText: 'Agents' }).first().click();
    await until(async () => (await page.locator('.agent-msg').count()) >= 2, 20000);
    const openBtn = page.locator('.agent-msg', { hasText: 'Daily insight digest' }).first()
      .getByText('Open session').first();
    check('the run offers its session', await until(async () => (await openBtn.count()) > 0, 10000));
    await openBtn.click();
    // The bridge ACKs synchronously; a refusal surfaces as the page's own toast.
    const acked = await until(async () =>
      (await page.locator('.agents-toast').count()) === 0
      && (await page.locator('.agent-tab, .agent-pane, .agent-surface').count()) > 0, 12000);
    check('…and opening it is ACKed rather than silently doing nothing', acked,
      await page.locator('.agents-toast').innerText().catch(() => '(no toast)'));
    await page.screenshot({ path: join(SHOTS, '6-open-session.png') });

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    srv.kill();
  }

  console.log(`\n${report.fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${report.pass} passed, ${report.fail} failed`);
  console.log(`  screenshots: ${SHOTS}`);
  console.log('  MANUAL, on the owner\'s gate checklist: open a Knowledge page PDF and confirm it still');
  console.log('  renders inline in the viewer. The header contract is asserted above; that a script-backed');
  console.log('  plugin PAINTED is not something Playwright asserts honestly.');
  process.exit(report.fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
