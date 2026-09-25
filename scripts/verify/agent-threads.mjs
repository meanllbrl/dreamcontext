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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { contrast, distIndex, overlapArea, rect, scratchDir, setTheme, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);

const SCRATCH = scratchDir('dc-ui-agent-threads');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const AUTOMATIONS_DIR = join(CONTEXT_ROOT, 'automations');
const SHOTS = shotsDir(REPO, 'agent-threads');

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

if (slug === 'failer') {
  // is_error with a real report: the reason is the result's first line, and the report
  // carries a code block (the answer card's Copy button).
  const tick = String.fromCharCode(96).repeat(3);
  out({ session_id: 'standin-failer', is_error: true,
    result: 'Could not reach the analytics API: 401 Unauthorized.\\n\\n## What I tried\\n\\n' + tick + 'ts\\nconst r = await fetch(url);\\n' + tick + '\\n',
    total_cost_usd: 0.02, num_turns: 1, duration_ms: 3000, permission_denials: [] });
  process.exit(0);
}

if (slug === 'holder') {
  // Holds the run slot for longer than one feed poll, so a page that only learns about
  // runs from the feed still sees this one while it is live.
  const until = Date.now() + 25000;
  while (Date.now() < until) { /* hold the run slot */ }
  out({ session_id: 'standin-holder', is_error: false, result: 'Held.\\n', total_cost_usd: 0.01,
    num_turns: 1, duration_ms: 25000, permission_denials: [] });
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
  cli(['automations', 'create', 'failer', '--title', 'Analytics puller', '--days', 'daily', '--at', '15:00']);
  cli(['automations', 'create', 'holder', '--title', 'Nightly importer', '--days', 'daily', '--at', '16:00']);

  // This project's skills and commands, as the chat caches them at connect (T7): Turkish
  // names whose case does not fold with toLowerCase().
  writeFileSync(join(CONTEXT_ROOT, 'state', '.slash-commands.json'),
    JSON.stringify({ commands: ['review', 'release', 'İçerik-planı', 'ılık-özet', 'çözüm-raporu'] }));

  const digestPath = join(AUTOMATIONS_DIR, 'digest.md');
  writeFileSync(digestPath,
    readFileSync(digestPath, 'utf-8').replace(/^photo: null$/m, 'photo: automations/photos/digest.png'));

  for (const slug of ['digest', 'asker', 'oncall', 'slowpoke', 'offline', 'orphan', 'orphan2', 'failer', 'holder']) {
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
    await page.locator('.sidebar-item', { hasText: 'Agentic Automations' }).first().click();
    check('the channel opens', await until(async () => (await page.locator('.agent-msg').count()) >= 2, 20000));

    const digestMsg = page.locator('.agent-msg', { hasText: 'Daily insight digest' }).first();
    check('the body is the agent\'s own post', (await digestMsg.locator('.agent-msg-md').innerText()).trim() === POSTED);

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
    // A10: whether a board DRAWS is the SERVER's call (its desktop gate on `/api/agent/*`),
    // not the tab's. This tab has no Tauri bridge, but the server it talks to is the desktop
    // one, so the board draws. (Off a desktop server it degrades to a card: agent-attachments.)
    // Asserted in the thread, where every visual of a post is drawn in full.
    await digestMsg.locator('.agent-thread-bar').click();
    const a10Panel = page.locator('.agent-thread');
    await until(async () => (await a10Panel.count()) === 1, 8000);
    check('[A10] a browser tab served by a DESKTOP server draws the board (absent pre-fix: a card said boards open in the desktop app)',
      await until(async () => (await a10Panel.locator('.chat-board canvas').count()) > 0, 15000),
      `boards=${await a10Panel.locator('.chat-board').count()} cards=${await a10Panel.locator('.agent-msg-file--board').count()}`);
    await a10Panel.locator('.agent-thread-close').click();
    await until(async () => (await page.locator('.agent-thread').count()) === 0, 5000);

    await digestMsg.locator('.agent-msg-file--doc').first().click();
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
    await digestMsg.locator('.agent-thread-bar').click();
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

    // `busy`, round 2 (owner decision 4): the run slot is PER AGENT. A reply to an agent whose
    // own run is in flight is refused; a reply to ANY OTHER agent is not, where it used to be
    // (one slot per project). The same-agent case needs a bound session to get past
    // `not_bound`, so the slow agent completes one run first.
    runAgent('slowpoke');
    const slowRuns = () => [...new Set(threadEntries('slowpoke').map((e) => e.runId))];
    const firstSlowRuns = slowRuns().length;
    await page.evaluate(async () => {
      await fetch('/api/automations/slowpoke/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    });
    await until(async () => slowRuns().length > firstSlowRuns, 10000);
    const slowRun = slowRuns().sort().pop();
    const digestBefore = threadEntries('digest').length;
    const other = await replyTo('digest', { text: 'while another agent runs', runId: digestRun });
    const own = await replyTo('slowpoke', { text: 'while you run', runId: slowRun });
    check('[R2-4] a reply to a DIFFERENT agent while one runs is accepted, 202 (was 409 busy naming the other agent)',
      other.status === 202, JSON.stringify(other).slice(0, 240));
    check('[R2-4] a reply to the agent that is running is refused 409 busy, "Slow crawler is still running. Try again when it finishes." (was "… One run at a time for now …")',
      own.status === 409 && /"busy"/.test(own.body) && /Slow crawler is still running\. Try again when it finishes\./.test(own.body)
        && !/One run at a time/.test(own.body), JSON.stringify(own).slice(0, 240));
    // The accepted reply resumes the digest's own session; let it settle before the next
    // section talks to the same agent (the per-agent run lock would refuse an overlap).
    if (other.status === 202) {
      await until(async () => threadEntries('digest').slice(digestBefore)
        .some((e) => e.kind === 'system' && ['replied', 'failed'].includes(e.event ?? '')), 60000);
    }

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
    await deskPage.locator('.sidebar-item', { hasText: 'Agentic Automations' }).first().click();
    // In the THREAD: the feed row now draws only a post's first visual and folds the rest
    // into cards (A4), and this post's first visual is its picture.
    await deskPage.locator('.agent-msg', { hasText: 'Daily insight digest' }).first().locator('.agent-thread-bar').click();
    const deskDigest = deskPage.locator('.agent-thread');
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
    await page.locator('.sidebar-item', { hasText: 'Agentic Automations' }).first().click();
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

    // ══ THE AUDIT PASS (goal-skill v2) ══════════════════════════════════════════════
    // Seeded after every check above, so those keep meaning what they said. Every check
    // MEASURES what painted; labels name the finding and the pre-fix value.
    console.log('\n═══ 12. The thread panel, measured ═══');
    const peerHits = [];
    await page.route(/\/api\/peer\/peers/, (route) => {
      peerHits.push(Date.now());
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ peers: [{ vault: 'tilki', agent: 'peer-tilki', whatItIs: 'A connected project', logo: false }] }) });
    });
    const openChannel = async (p = page) => {
      await p.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(2000);
      for (let i = 0; i < 4; i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(200); }
      await p.locator('.sidebar-item', { hasText: 'Agentic Automations' }).first().click();
      await p.locator('.agent-msg').first().waitFor({ timeout: 20000 }).catch(() => {});
    };
    const namedRow = (title, p = page) => p.locator('article.agent-msg', { has: p.locator('.agent-msg-name', { hasText: title }) }).first();
    const thread = page.locator('.agent-thread');
    const openThreadOf = async (row) => {
      await row.locator('.agent-thread-bar').click();
      await until(async () => (await thread.count()) === 1, 8000);
      await until(async () => (await thread.locator('.agent-thread-sys, .agent-thread-post').count()) > 0, 10000);
    };
    const closePanel = async () => {
      if (await thread.count()) {
        await thread.locator('.agent-thread-close').click({ timeout: 5000 });
        await until(async () => (await thread.count()) === 0, 5000);
      }
    };
    const slotFree = () => until(async () => {
      const j = await page.evaluate(async () => (await fetch('/api/automations/runs')).json().catch(() => null));
      return !j?.job || j.job.status !== 'running';
    }, 60000);

    runAgent('failer');
    await openChannel();
    const failer = namedRow('Analytics puller');
    const peersBefore = peerHits.length;
    await openThreadOf(failer);
    await until(async () => (await thread.locator('.agent-thread-answer').count()) > 0, 10000);
    await page.screenshot({ path: join(SHOTS, '12-failed-thread.png') });

    // T19 — the scheduled root, read while the run is still unread.
    const root = thread.locator('article.agent-msg').first();
    const rootEdge = await root.evaluate((el) => getComputedStyle(el).borderLeftColor).catch(() => null);
    const rootName = thread.locator('.agent-msg--root .agent-msg-head .agent-msg-name--plain');
    check('[T19] the scheduled root has its own head: the agent\'s name and time (absent pre-fix: the missing head is the bug)',
      (await rootName.count()) > 0 && (await rootName.innerText()).trim() === 'Analytics puller'
      && (await thread.locator('.agent-msg--root .agent-msg-time').count()) > 0);
    check('[T19] …and no unread bar inside the panel (was the accent rule)', rootEdge === 'rgba(0, 0, 0, 0)', `border-left-color=${rootEdge}`);

    // T9 — the real reason leads, and the report sits before the Failed row.
    const rootText = await root.innerText().catch(() => '');
    const panelText = await thread.innerText();
    check('[T9] the failed root leads with the run\'s real reason (was "claude reported is_error: true")',
      rootText.includes('401 Unauthorized') && !panelText.includes('is_error'), `root="${rootText.slice(0, 120)}"`);
    const order = await thread.evaluate((el) => {
      const answer = el.querySelector('.agent-thread-answer');
      const failed = [...el.querySelectorAll('.agent-thread-sys')].find((n) => /Failed/.test(n.textContent));
      if (!answer || !failed) return 'missing';
      return answer.compareDocumentPosition(failed) & Node.DOCUMENT_POSITION_FOLLOWING ? 'answer-first' : 'failed-first';
    });
    check('[T9] …and its report sits BEFORE the Failed row (was after it)', order === 'answer-first', order);

    // T13, T14 — targets.
    const closeR = await rect(thread.locator('.agent-thread-close'));
    const headR = await rect(thread.locator('.agent-thread-head'));
    const centreGap = Math.abs((closeR.top + closeR.height / 2) - (headR.top + headR.height / 2));
    check('[T13] the close button is a centred 24px target (was 18x29 pinned to the top)',
      closeR.width >= 24 && closeR.height >= 24 && centreGap <= 1, `${Math.round(closeR.width)}x${Math.round(closeR.height)} centre gap=${centreGap}`);
    const pillR = await rect(thread.locator('.agent-thread-answer-file').first());
    const copyR = await rect(thread.locator('.agent-thread-answer .chat-code-copy').first());
    check('[T14] the report\'s file pill and its code Copy are 24px targets (was 21 / 21)', pillR.height >= 24 && copyR.height >= 24,
      `pill=${pillR.height} copy=${copyR.height}`);

    // T16 — one rule line across the feed and the thread.
    const rules = await page.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const cmp = document.querySelector('.agent-thread-composer .chat-cmp');
      return {
        chips: r('.agents-chips')?.bottom, head: r('.agent-thread-head')?.bottom,
        strip: r('.agents-composer')?.top, foot: r('.agent-thread-foot')?.top,
        cmpBorder: cmp ? getComputedStyle(cmp).borderTopWidth : null,
      };
    });
    check('[T16] chips and thread head share one bottom rule, composer strips share one top rule, one rule in the thread (was 7px, 21px, 1px)',
      Math.abs(rules.chips - rules.head) <= 1 && Math.abs(rules.strip - rules.foot) <= 1 && rules.cmpBorder === '0px', JSON.stringify(rules));

    // T17 — the thread line and the / menu speak their state.
    const failerBar = failer.locator('.agent-thread-bar');
    const barAria = { expanded: await failerBar.getAttribute('aria-expanded'), controls: await failerBar.getAttribute('aria-controls') };
    check('[T17] the open thread\'s line says so: aria-expanded and aria-controls (was neither)',
      barAria.expanded === 'true' && barAria.controls === 'agents-thread-panel', JSON.stringify(barAria));
    const tInput = thread.locator('.chat-cmp-input');
    await tInput.click();
    await tInput.fill('');
    await tInput.type('/');
    await until(async () => (await thread.locator('.chat-cmp-slash-row').count()) >= 3, 5000);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const act = await tInput.evaluate((el) => ({
      active: el.getAttribute('aria-activedescendant'),
      selected: el.closest('.chat-cmp')?.querySelector('[role="option"][aria-selected="true"]')?.id || null,
    }));
    check('[T17] the field names the highlighted / option (aria-activedescendant; was absent)', !!act.active && act.active === act.selected, JSON.stringify(act));
    await page.keyboard.press('Escape');
    check('[guard] Esc with the / menu open closes the menu and leaves the thread open',
      (await thread.locator('.chat-cmp-slash-row').count()) === 0 && (await thread.count()) === 1);

    // T7 — Turkish case, both composers.
    const slashFinds = async (scope, typed, want) => {
      const input = scope.locator('.chat-cmp-input');
      await input.click();
      await input.fill('');
      await input.type(typed);
      await page.waitForTimeout(300);
      const rows = await scope.locator('.chat-cmp-slash-row').allInnerTexts();
      await page.keyboard.press('Escape');
      await input.fill('');
      return rows.some((row) => row.includes(want)) ? null : `${typed} → ${JSON.stringify(rows)}`;
    };
    const misses = [];
    for (const scope of [thread, page.locator('.agents-composer')]) {
      for (const [typed, want] of [['/içerik', 'İçerik-planı'], ['/ILIK', 'ılık-özet'], ['/cozum', 'çözüm-raporu']]) {
        const miss = await slashFinds(scope, typed, want);
        if (miss) misses.push(miss);
      }
    }
    check('[T7] / finds İçerik-planı, ılık-özet and çözüm-raporu from /içerik, /ILIK and /cozum in both composers (was 0 rows)',
      misses.length === 0, misses.join(' | '));

    // T11 — the thread composer offers no connected projects.
    await tInput.click();
    await tInput.type('@');
    await page.waitForTimeout(500);
    const threadMentions = await thread.locator('.chat-cmp-mention-row').count();
    await tInput.fill('');
    check('[T11] @ in a thread lists no connected project, and the panel never asks for them (was the project listed)',
      threadMentions === 0 && peerHits.length === peersBefore, `rows=${threadMentions} peer requests=${peerHits.length - peersBefore}`);

    // T12 — the panel resizes, remembers, and clamps.
    const handle = thread.locator('.agent-thread-resize');
    if ((await handle.count()) === 0) {
      check('[T12] the thread panel has a resize handle (absent pre-fix: the missing handle is the bug)', false, 'no .agent-thread-resize');
    } else {
      const w0 = (await rect(thread)).width;
      const h = await rect(handle);
      await page.mouse.move(h.left + h.width / 2, h.top + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(h.left + h.width / 2 - 200, h.top + h.height / 2, { steps: 8 });
      await page.mouse.up();
      const w1 = (await rect(thread)).width;
      await handle.focus();
      await page.keyboard.press('ArrowLeft');
      const w2 = (await rect(thread)).width;
      await openChannel();
      await openThreadOf(namedRow('Analytics puller'));
      const w3 = (await rect(thread)).width;
      const h2 = await rect(thread.locator('.agent-thread-resize'));
      await page.mouse.move(h2.left + h2.width / 2, h2.top + h2.height / 2);
      await page.mouse.down();
      await page.mouse.move(h2.left + 2000, h2.top + h2.height / 2, { steps: 8 });
      await page.mouse.up();
      const wMin = (await rect(thread)).width;
      const h3 = await rect(thread.locator('.agent-thread-resize'));
      await page.mouse.move(h3.left + h3.width / 2, h3.top + h3.height / 2);
      await page.mouse.down();
      await page.mouse.move(0, h3.top + h3.height / 2, { steps: 8 });
      await page.mouse.up();
      const wMax = (await rect(thread)).width;
      const parentW = await thread.evaluate((el) => el.parentElement.getBoundingClientRect().width);
      check('[T12] the thread panel resizes by drag (+200) and by arrow (+16), remembers its width, and clamps to [360, 60%]',
        Math.abs(w1 - w0 - 200) <= 2 && Math.abs(w2 - w1 - 16) <= 2 && Math.abs(w3 - w2) <= 2
        && Math.abs(wMin - 360) <= 1 && wMax <= parentW * 0.6 + 1,
        JSON.stringify({ w0, w1, w2, w3, wMin, wMax, parentW }));
      await page.evaluate(() => localStorage.removeItem('dreamcontext.agents.threadWidth'));
      await openChannel();
      await openThreadOf(namedRow('Analytics puller'));
    }

    // T4 — keyboard: Enter opens and focuses, Esc and the close button return focus.
    await closePanel();
    const bar4 = namedRow('Analytics puller').locator('.agent-thread-bar');
    await bar4.evaluate((el) => { el.dataset.probe = 'opener'; el.focus(); });
    await page.keyboard.press('Enter');
    await until(async () => (await thread.count()) === 1, 8000);
    await page.waitForTimeout(400);
    const onOpen = await page.evaluate(() => document.activeElement?.className ?? '');
    check('[T4] opening a thread from the keyboard moves focus to its close button (was left on the thread line)',
      onOpen.includes('agent-thread-close'), `active="${onOpen}"`);
    await thread.locator('.chat-cmp-input').click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const afterEsc = { open: await thread.count(), probe: await page.evaluate(() => document.activeElement?.dataset?.probe ?? document.activeElement?.tagName) };
    check('[T4] Esc closes the thread and gives focus back to the line that opened it (was: panel stayed, focus on BODY)',
      afterEsc.open === 0 && afterEsc.probe === 'opener', JSON.stringify(afterEsc));
    if (await thread.count()) await closePanel();
    await bar4.click();
    await until(async () => (await thread.count()) === 1, 8000);
    await thread.locator('.agent-thread-close').click();
    await page.waitForTimeout(400);
    const afterClose = await page.evaluate(() => document.activeElement?.dataset?.probe ?? document.activeElement?.tagName);
    check('[T4] closing with ✕ returns focus to the thread line (was BODY)', afterClose === 'opener', `active=${afterClose}`);
    await openThreadOf(namedRow('Analytics puller'));
    await thread.locator('.agent-thread-answer-file').first().click();
    await until(async () => (await page.locator('.chat-slideover-panel').count()) > 0, 8000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    check('[guard] Esc over a document opened from the thread closes the document, not the thread',
      (await page.locator('.chat-slideover-panel').count()) === 0 && (await thread.count()) === 1);

    // F14/T6 — the floating Agent button against the thread, at four widths.
    for (const w of [1500, 1100, 900, 760]) {
      await page.setViewportSize({ width: w, height: 950 });
      await page.waitForTimeout(600);
      const fab = page.locator('.agent-fab').first();
      const fabR = (await fab.count()) ? await rect(fab) : null;
      const footR = await rect(thread.locator('.agent-thread-foot'));
      await thread.locator('.agent-thread-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(300);
      const lastR = await rect(thread.locator('.agent-thread-body > *').last());
      check(`[F14/T6] at ${w} the floating Agent button clears the thread foot and its last row (was straddling the seam)`,
        !!fabR && fabR.bottom <= footR.top + 0.5 && overlapArea(lastR, fabR) === 0,
        `fab=${JSON.stringify(fabR && { top: Math.round(fabR.top), bottom: Math.round(fabR.bottom) })} footTop=${Math.round(footR.top)} overlap=${overlapArea(lastR, fabR)}`);
    }
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.screenshot({ path: join(SHOTS, '13-thread-measured.png') });

    // T2 — a draft stays with its own agent.
    const DRAFT = 'draft for the analytics puller only';
    await thread.locator('.chat-cmp-input').fill(DRAFT);
    await namedRow('Daily insight digest').locator('.agent-thread-bar').click();
    await until(async () => (await page.locator('.agent-thread-sub').innerText()).includes('Daily insight digest'), 8000);
    await page.waitForTimeout(500);
    const inOther = await thread.locator('.chat-cmp-input').inputValue();
    await namedRow('Analytics puller').locator('.agent-thread-bar').click();
    await until(async () => (await page.locator('.agent-thread-sub').innerText()).includes('Analytics puller'), 8000);
    await page.waitForTimeout(500);
    const backHome = await thread.locator('.chat-cmp-input').inputValue();
    check('[T2] a draft stays with its agent: empty in the next thread, back in its own (was carried into the other agent\'s thread)',
      inOther === '' && backHome === DRAFT, JSON.stringify({ inOther, backHome }));
    await thread.locator('.chat-cmp-input').fill('');

    // T1 — the scheduled post, once.
    await namedRow('Daily insight digest').locator('.agent-thread-bar').click();
    await until(async () => (await page.locator('.agent-thread-sub').innerText()).includes('Daily insight digest'), 8000);
    await page.waitForTimeout(1200);
    const postTimes = await thread.evaluate((el, s) => [...el.querySelectorAll('.agent-msg-md, .agent-thread-post-text')]
      .filter((n) => !n.closest('.agent-thread-answer') && n.textContent.includes(s)).length, POSTED);
    check('[T1] a scheduled run\'s post appears ONCE in its thread (was root + the same post as a reply)', postTimes === 1, `occurrences=${postTimes}`);
    await closePanel();

    // T3 + T20 — a refused reply keeps its words, and the refusal speaks plainly.
    console.log('\n═══ 13. Refusals keep what you typed ═══');
    const orphanRow = page.locator('.agent-msg', { hasText: 'Interrupted agent' }).first();
    await openThreadOf(orphanRow);
    const REFUSED = 'please retry the import from yesterday';
    await thread.locator('.chat-cmp-input').fill(REFUSED);
    await thread.locator('.chat-cmp-input').press('Enter');
    const errNote = thread.locator('.agent-thread-note.agents-composer-note--error');
    await until(async () => (await errNote.count()) > 0, 10000);
    const kept = await thread.locator('.chat-cmp-input').inputValue();
    const noteText = await errNote.innerText().catch(() => '');
    check('[T3] a refused reply leaves the typed text in the field (was emptied)', kept === REFUSED, `field="${kept}"`);
    check('[T20] the refusal speaks plainly: "has no session to talk to yet", no em dash (was "this automation … — it has not completed …")',
      noteText.includes('has no session to talk to yet') && !noteText.includes('—'), `note="${noteText}"`);
    await thread.locator('.chat-cmp-input').fill('');
    await closePanel();
    const channelField = page.locator('.agents-composer .chat-cmp-input');
    const SAY_OFF = '@offline please check the import';
    await channelField.fill(SAY_OFF);
    await channelField.press('Enter');
    await until(async () => (await page.locator('.agents-composer-note--error').count()) > 0, 10000);
    await page.waitForTimeout(400);
    const channelKept = await channelField.inputValue();
    check('[T3] a refused @mention leaves the typed text in the channel field (was emptied)', channelKept === SAY_OFF, `field="${channelKept}"`);
    await channelField.fill('');

    // T10 — @ finds an agent by its name and shows its face.
    await channelField.click();
    await channelField.type('@deep');
    await page.waitForTimeout(500);
    const byName = await page.locator('.agents-composer .chat-cmp-mention-row').count();
    check('[T10] @deep finds "Deep researcher" by its name (was 0 rows: only the slug matched)', byName === 1, `rows=${byName}`);
    await channelField.fill('');
    await channelField.type('@');
    await page.waitForTimeout(500);
    const faces = await page.evaluate(() => ({
      rows: document.querySelectorAll('.agents-composer .chat-cmp-mention-row').length,
      glyphs: document.querySelectorAll('.agents-composer .chat-cmp-mention-glyph').length,
      initials: document.querySelectorAll('.agents-composer .chat-cmp-mention-row .agent-av').length,
    }));
    check('[T10] every agent in the @ menu wears its face: photo or initials, never the ◈ project glyph (was ◈)',
      faces.rows > 0 && faces.glyphs === 0 && faces.initials > 0, JSON.stringify(faces));
    await page.keyboard.press('Escape');
    await channelField.fill('');

    // T20 — the delivery notes, in words a person uses.
    console.log('\n═══ 14. Delivery notes ═══');
    const lastAsk = page.locator('.agent-msg--you').filter({ hasText: 'and the trial step?' }).first();
    await openThreadOf(lastAsk);
    await thread.locator('.chat-cmp-input').fill('one more thing: the paid step');
    await thread.locator('.chat-cmp-input').press('Enter');
    const seen = new Set();
    const settledNote = await until(async () => {
      const n = await thread.locator('.agent-thread-note').allInnerTexts().catch(() => []);
      n.forEach((x) => seen.add(x.trim()));
      return n.some((x) => /delivered|finished/i.test(x));
    }, 60000);
    const notes = [...seen];
    check('[T20] the reply settles as "Reply delivered", never "Mac" or "turn" (was "Session resumed on this Mac", "Reply turn finished")',
      settledNote && notes.some((x) => x === 'Reply delivered') && !notes.some((x) => /Mac|turn/.test(x)), JSON.stringify(notes));
    await closePanel();

    // T8 + R2-4 — the thread composer honours the run slot, for a run the page did not start,
    // and since round 2 only for the agent that is actually running.
    console.log('\n═══ 15. A run the page did not start ═══');
    await slotFree();
    await fetch(`${base}/api/automations/holder/run`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dreamcontext-vault': 'proj' }, body: '{}',
    });
    await openChannel();
    // Wait until the FEED knows the run (the importer's row reads "running"), then one more
    // fast poll, so the fields are read after the page has had every chance to react.
    await until(async () => (await namedRow('Nightly importer').locator('.agent-msg-status--running').count()) > 0, 20000);
    await page.waitForTimeout(2500);
    await openThreadOf(namedRow('Analytics puller'));
    await page.waitForTimeout(800);
    const otherDown = await thread.locator('.chat-cmp-input').isDisabled();
    check('[R2-4] while ANOTHER agent runs, this thread\'s composer stays open (was read-only for every thread)', !otherDown,
      `disabled=${otherDown} placeholder="${await thread.locator('.chat-cmp-input').getAttribute('placeholder')}"`);
    await closePanel();
    await openThreadOf(namedRow('Nightly importer'));
    const ownDown = await until(async () => thread.locator('.chat-cmp-input').isDisabled(), 8000);
    check('[guard] while an agent runs, its OWN thread\'s composer is read-only and says so', ownDown
      && /Nightly importer is still running/.test((await thread.locator('.chat-cmp-input').getAttribute('placeholder')) ?? ''),
      `disabled=${ownDown} placeholder="${await thread.locator('.chat-cmp-input').getAttribute('placeholder')}"`);
    await closePanel();
    await slotFree();

    // R2-2 (owner decision 2a) — below ~900px of channel the thread OVERLAYS the feed like
    // Chat's SlideOver (scrim, no resize handle, the feed keeps its width); at 900 and wider it
    // stays the resizable split. With the 220px sidebar, a 1100 window leaves an 880 channel.
    console.log('\n═══ 15b. The thread at narrow widths ═══');
    const geometry = () => page.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, width: b.width, height: b.height }; };
      return {
        feed: r('.agents-feed'), main: r('.agents-feed-main'), aside: r('aside.agent-thread'),
        scrim: document.querySelectorAll('.chat-slideover-scrim').length,
        handle: document.querySelectorAll('.agent-thread-resize').length,
      };
    });
    await openChannel();
    await openThreadOf(namedRow('Analytics puller'));
    const wide = await geometry();
    check('[guard] at 1500 the thread is still the resizable split: no scrim, a handle, feed + panel fill the row',
      wide.scrim === 0 && wide.handle === 1 && !!wide.main && !!wide.aside
        && Math.abs(wide.main.width + wide.aside.width - wide.feed.width) <= 1, JSON.stringify(wide));
    await closePanel();
    for (const w of [1100, 760]) {
      await page.setViewportSize({ width: w, height: 950 });
      await openChannel();
      const opener = namedRow('Analytics puller').locator('.agent-thread-bar');
      await opener.evaluate((el) => { el.dataset.probe = 'opener'; });
      await openThreadOf(namedRow('Analytics puller'));
      await page.waitForTimeout(500);
      const g = await geometry();
      await page.screenshot({ path: join(SHOTS, `15b-thread-${w}.png`) });
      const want = g.feed ? Math.min(440, 0.92 * g.feed.width) : 0;
      check(`[R2-2] at ${w} the thread overlays the channel: the feed keeps its full width (was squeezed beside a >=360px panel)`,
        !!g.main && !!g.feed && Math.abs(g.main.width - g.feed.width) <= 1, JSON.stringify(g));
      check(`[R2-2] at ${w} the overlay is Chat's SlideOver: min(440, 92%) wide, on the channel's right edge (was the 360px split panel)`,
        !!g.aside && Math.abs(g.aside.width - want) <= 1 && Math.abs(g.aside.right - g.feed.right) <= 1,
        `aside=${JSON.stringify(g.aside)} want=${want}`);
      check(`[R2-2] at ${w} the overlay has no resize handle (was 1)`, g.handle === 0, `handles=${g.handle}`);
      const probeTa = await thread.locator('.chat-cmp-input').evaluate((el) => {
        const b = el.getBoundingClientRect();
        return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === el;
      });
      check(`[guard] at ${w} the thread's text field is on top where it paints`, probeTa);
      await page.mouse.click(g.feed.left + 10, g.feed.top + g.feed.height / 2);
      await page.waitForTimeout(600);
      const afterScrim = { open: await thread.count(), focus: await page.evaluate(() => document.activeElement?.dataset?.probe ?? document.activeElement?.tagName) };
      check(`[R2-2] at ${w} a click on the scrim closes the thread and returns focus to its line (was: the click hit the feed, the panel stayed)`,
        afterScrim.open === 0 && afterScrim.focus === 'opener', JSON.stringify(afterScrim));
      if (await thread.count()) await closePanel();
      await openThreadOf(namedRow('Analytics puller'));
      await page.waitForTimeout(400);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      check(`[guard] at ${w} Esc closes the thread`, (await thread.count()) === 0);
      if (await thread.count()) await closePanel();
    }
    await page.setViewportSize({ width: 1500, height: 1000 });

    // T15 — placeholders in dark.
    console.log('\n═══ 16. Dark ═══');
    const darkCtx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await setTheme(darkCtx, 'dark');
    const dp = await darkCtx.newPage();
    await openChannel(dp);
    await namedRow('Analytics puller', dp).locator('.agent-thread-bar').click();
    await dp.locator('.agent-thread .chat-cmp-input').waitFor({ timeout: 10000 });
    // Measured twice. First straight away: the feed still reports the importer's run slot for
    // up to one poll, so both fields are usually disabled here and the placeholder is the busy
    // sentence. Then once the fields come back: the idle placeholder, which is what most reads.
    const tField = dp.locator('.agent-thread .chat-cmp-input');
    const cField = dp.locator('.agents-composer .chat-cmp-input');
    const busyState = { thread: await tField.isDisabled(), channel: await cField.isDisabled() };
    const phThread = await contrast(tField, '::placeholder');
    const phChannel = await contrast(cField, '::placeholder');
    check('[T15] both composers\' placeholders read at >=4.5:1 in dark while the run slot shows busy (disabled fields) (was 3.56 / 2.12)',
      phThread >= 4.5 && phChannel >= 4.5, `thread=${phThread} channel=${phChannel} disabled=${JSON.stringify(busyState)}`);
    const idle = await (async () => {
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        if (!(await tField.isDisabled()) && !(await cField.isDisabled())) return true;
        await dp.waitForTimeout(250);
      }
      return false;
    })();
    const idleThread = idle ? await contrast(tField, '::placeholder') : null;
    const idleChannel = idle ? await contrast(cField, '::placeholder') : null;
    check('[T15] …and once the slot frees, the idle placeholders read at >=4.5:1 in dark too (was 3.56)',
      idle && idleThread >= 4.5 && idleChannel >= 4.5, `idle=${idle} thread=${idleThread} channel=${idleChannel}`);
    await dp.screenshot({ path: join(SHOTS, '16-dark-thread.png') });
    await darkCtx.close();

    // T20 — a turned-off agent's thread offers the way back. LAST: it turns an agent off.
    console.log('\n═══ 17. A turned-off agent ═══');
    cli(['automations', 'disable', 'failer']);
    await openChannel();
    await openThreadOf(namedRow('Analytics puller'));
    const turnOn = thread.locator('.agent-thread-blocked-action');
    const hasTurnOn = (await turnOn.count()) > 0;
    if (hasTurnOn) await turnOn.first().click();
    const enabledAgain = hasTurnOn && await until(async () => {
      const list = await page.evaluate(async () => (await fetch('/api/automations')).json().catch(() => null));
      return list?.automations?.find((a) => a.slug === 'failer')?.enabled === true;
    }, 10000);
    check('[T20] a turned-off agent\'s thread offers "Turn on", and it turns the agent on (absent pre-fix: the missing button is the bug)',
      enabledAgain && await until(async () => (await thread.locator('.chat-cmp-input').count()) > 0, 8000), `button=${hasTurnOn}`);
    await closePanel();
    await page.unroute(/\/api\/peer\/peers/);

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
