#!/usr/bin/env node
/**
 * A whiteboard gets an agent card: end-to-end proof in the real dashboard, in real Chromium.
 *
 *   npm run build && npm run verify:whiteboard-agent
 *
 * Boots the REAL dashboard server from the BUILT dashboard + CLI on an isolated scratch vault
 * (fake HOME, no user state touched, no network, no tokens): `claude` is a stand-in on that
 * HOME's PATH. Spawned by the Chat bridge (`--input-format stream-json`, an agent card's own
 * session) it records its argv, DREAMCONTEXT_* env and briefing file once, then for every user
 * frame runs the project's real UserPromptSubmit hook (`dreamcontext hook user-prompt-submit`,
 * as Claude Code would) and records the message and what the hook added, and answers in
 * stream-json. Spawned as a run (`-p … --output-format json`) it records the call and answers
 * like that. A no-op `osascript` shadows the real one, so nothing pops a banner on this Mac.
 *
 * The fixture is fictional (Northwind Outfitters): the default board "Control Panel" holds a
 * long note ("Pricing note") and three cards of an existing agent, "Copy Desk", at S, M and XL.
 * Then, in the page, as a user does it:
 *
 *   W1  the palette's Agent… picker attaches the existing agent: a fourth Copy Desk card.
 *   W2  Agent… → New agent opens the create dialog; Name fills itself from the description;
 *       the manifest is `mode: call`, `learning: true`, `whiteboard: control-panel`, approved,
 *       and its card lands on the board.
 *   W3  opening the board spawns no card session; an S card never gets a composer; an M, L or
 *       XL card shows its start hint, and its first activation opens its chat (a composer).
 *   W4  typing in the active card leaves Excalidraw on the selection tool and draws nothing;
 *       the message goes over the card's own chat socket (cardAgent + cardBoard), never to the
 *       agent's thread, and no run starts; the stand-in's argv has `--permission-mode dontAsk`,
 *       `--setting-sources project`, `--allowedTools` with the home-board rules, the env has
 *       DREAMCONTEXT_AGENT_BOARD/_SELF/_SCRATCH and _CARD_AGENT/_CARD_BOARD, its briefing says
 *       who it is and carries the pattern, the message arrives exactly as typed, and the hook
 *       puts the whole board beside it.
 *   W5  the second message goes to the same live session, with the board again (fresh nonce).
 *   W6  the note dragged onto the card goes back to the same x/y (in memory and in the saved
 *       board file), a ref chip appears, the sent bubble shows a Board element chip and no
 *       token, and the hook's reference block carries the whole note. Undo sentinel, twice
 *       (the note unselected, then already selected): make an edit, drop the note on the card,
 *       press Cmd+Z ONCE: the edit survives and the note is not on the card.
 *   W7  the attached agent runs under the pane's own mode (no board scope) and the hook gives
 *       it only the board's index.
 *   W11 New conversation (the card's ⋯ menu) starts a fresh session.
 *   W9  Edit agent (the card's ⋯ menu) puts the agent on a schedule, keeping its board.
 *   W8  removing the card keeps the manifest, and the Agents page shows the board chip.
 *   W10 no console or page errors.
 *
 * The whole flow runs once per theme (light, then dark), each on a FRESH scratch vault and
 * server, so the second theme never inherits the first one's agent, runs or chips.
 *
 * Reading Excalidraw's live scene: the canvas exposes no handle to the page, so (as in
 * whiteboard.mjs) the script reads the App instance off the React fiber of `.excalidraw`,
 * read-only: the viewport transform, the active tool and the element list.
 *
 * COLLECT-DON'T-FAIL-FAST: every check reports; the exit code is non-zero if any failed.
 * Screenshots: tmp/verify-whiteboard-agent/.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
const SHOTS = join(REPO, 'tmp', 'verify-whiteboard-agent');
const SCRATCH_ROOT = join(tmpdir(), 'dc-ui-whiteboard-agent');

const BOARD = 'control-panel';
const ATTACHED = { slug: 'copy-desk', title: 'Copy Desk' };
const NOTE_TITLE = 'Pricing note';
/** Past the 300-char cut a board block makes of a note, so only a full reference carries it. */
const NOTE_TAIL = 'TAIL-MARKER-NW-7Q4';
const NOTE_BODY = [
  '# Northwind Outfitters: beta pricing',
  '',
  'Three tiers for the spring beta. Trail is free for one pack and two trips. Summit is 9 a month',
  'for unlimited packs, shared lists and offline maps. Basecamp is 24 a month for a team of five,',
  'with a shared gear library and a weekly digest of who carries what.',
  '',
  'Open questions: does Summit need a yearly price, and is five seats the right Basecamp floor?',
  'The survey from the March meetup says most groups are four to six people, so five may be fine.',
  'Annual billing would land at ten months for the price of twelve, matching the outfitter shop.',
  '',
  `Last line, kept for the reference check: ${NOTE_TAIL}`,
].join('\n');
const NEW_AGENT_DESCRIPTION = 'Watch the launch board. Flag pricing notes that contradict each other.';
/** `nameFromDescription`: the description's first clause. */
const NEW_AGENT_NAME = 'Watch the launch board';
const LESSON = 'Lead with the tier name before the price.';
const MSG1 = 'Summarise what this board says about pricing.';
const MSG2 = 'Thanks, now list the open questions.';
const MSG3 = 'What does this note decide?';
const MSG_ATTACHED = 'Draft one headline for the Summit tier.';
const MSG_FRESH = 'Start over: what is the first thing on this board?';

// ─── reporting ──────────────────────────────────────────────────────────────────────────────

const report = { pass: 0, fail: 0 };
const check = (label, ok, ev = '') => {
  if (ok) { report.pass += 1; console.log(`  ✓ ${label}`); }
  else { report.fail += 1; console.log(`  ✗ ${label}${ev ? `\n      ${String(ev).slice(0, 600)}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    try { v = await fn(); } catch { v = undefined; }
    if (v) return v;
    await sleep(step);
  }
  return v;
}

// ─── fixture ────────────────────────────────────────────────────────────────────────────────

/** The stand-in `claude`. As a chat (stream-json) it records its spawn, then each turn with
 *  what the project's real UserPromptSubmit hook added, and answers in stream-json. As a run
 *  it records the call and answers like `-p --output-format json`. */
function standin(callsDir) {
  return [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const crypto = require('node:crypto');",
    "const { spawnSync } = require('node:child_process');",
    'const argv = process.argv.slice(2);',
    "if (argv.includes('--version')) { process.stdout.write('2.1.285 (Claude Code)\\n'); process.exit(0); }",
    'const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };',
    'const env = {};',
    "for (const [k, v] of Object.entries(process.env)) if (k.startsWith('DREAMCONTEXT_')) env[k] = v;",
    `const dir = ${JSON.stringify(callsDir)};`,
    'fs.mkdirSync(dir, { recursive: true });',
    "const record = (o) => fs.writeFileSync(path.join(dir, `${Date.now()}-${process.pid}-${crypto.randomUUID().slice(0, 6)}.json`), JSON.stringify(o));",
    "if (flag('--input-format') === 'stream-json') {",
    "  const sessionId = flag('--resume') || flag('--session-id') || crypto.randomUUID();",
    "  let briefing = null;",
    "  try { briefing = fs.readFileSync(flag('--append-system-prompt-file'), 'utf-8'); } catch { /* none */ }",
    "  const base = { pid: process.pid, argv, env, briefing, sessionId, cwd: process.cwd() };",
    "  record({ kind: 'spawn', ...base });",
    "  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "  let turn = 0;",
    "  let buf = '';",
    "  process.stdin.on('data', (c) => {",
    "    buf += c.toString('utf-8');",
    "    let nl;",
    "    while ((nl = buf.indexOf('\\n')) !== -1) {",
    "      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);",
    "      if (!line) continue;",
    "      let o; try { o = JSON.parse(line); } catch { continue; }",
    "      if (o.type !== 'user') continue;",
    "      const content = (o.message && o.message.content) || [];",
    "      const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('');",
    "      turn += 1;",
    `      const hook = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'hook', 'user-prompt-submit'], {`,
    "        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: text, session_id: sessionId, cwd: process.cwd() }),",
    "        encoding: 'utf-8', cwd: process.cwd(), env: process.env,",
    "      });",
    "      record({ kind: 'turn', turn, prompt: text, hookOut: hook.stdout || '', hookErr: hook.stderr || '', ...base });",
    "      if (turn === 1) out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-5-5', cwd: process.cwd(), permissionMode: flag('--permission-mode'), slash_commands: [] });",
    "      const answer = turn === 1 ? 'Stand-in answer: the board is in order.' : 'Stand-in reply: noted.';",
    "      out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });",
    "      out({ type: 'result', subtype: 'success', is_error: false, result: answer, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sessionId });",
    "    }",
    "  });",
    "  process.stdin.on('end', () => process.exit(0));",
    "} else {",
    "  const r = argv.indexOf('--resume');",
    '  const sessionId = r >= 0 ? argv[r + 1] : crypto.randomUUID();',
    "  record({ kind: 'run', argv, env, prompt: flag('-p'), sessionId, cwd: process.cwd() });",
    "  const result = r >= 0 ? 'Stand-in reply: noted.' : 'Stand-in answer: the board is in order.';",
    "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: sessionId, num_turns: 1, total_cost_usd: 0, usage: {} }) + '\\n');",
    "}",
    '',
  ].join('\n');
}

/** The parent session's own agent env must not leak into the server: a set
 *  DREAMCONTEXT_AGENT_BOARD would make the CLI refuse every other board. */
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CLAUDE') || k.startsWith('DREAMCONTEXT_')) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function paths(theme) {
  const scratch = join(SCRATCH_ROOT, theme);
  const home = join(scratch, 'home');
  const proj = join(scratch, 'proj');
  return {
    scratch, home, proj,
    calls: join(scratch, 'calls'),
    dc: join(proj, '_dream_context'),
    boardFile: join(proj, '_dream_context', 'whiteboards', BOARD, `${BOARD}.excalidraw.md`),
  };
}

function cliFor(p) {
  return (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: p.proj, env: cleanEnv({ HOME: p.home }), encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`dreamcontext ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
    return r.stdout;
  };
}

function setup(p) {
  rmSync(p.scratch, { recursive: true, force: true });
  mkdirSync(join(p.home, '.local', 'bin'), { recursive: true });
  mkdirSync(join(p.home, '.dreamcontext'), { recursive: true });
  mkdirSync(join(p.dc, 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: p.proj });
  const dc = cliFor(p);
  dc(['vaults', 'add', 'proj', p.proj]);
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort */ }

  // Everything below goes through the REAL CLI, so the fixture is the format the routes read.
  dc(['whiteboard', 'create', 'Control Panel']);
  const promptFile = join(p.scratch, 'copy-desk-prompt.md');
  writeFileSync(promptFile, 'Write short, plain product copy for Northwind Outfitters when asked.\n');
  dc(['automations', 'create', ATTACHED.slug, '--title', ATTACHED.title, '--mode', 'call', '--no-notify', '--prompt-file', promptFile]);
  const noteFile = join(p.scratch, 'pricing-note.md');
  writeFileSync(noteFile, `${NOTE_BODY}\n`);
  const add = (args) => JSON.parse(dc(['whiteboard', 'add', BOARD, ...args, '--json'])).id;
  const ids = {
    note: add(['note', '--title', NOTE_TITLE, '--file', noteFile, '--size', 'm', '--at', '0,0']),
    s: add(['agent', '--ref', ATTACHED.slug, '--size', 's', '--at', '0,196']),
    m: add(['agent', '--ref', ATTACHED.slug, '--size', 'm', '--at', '196,196']),
    xl: add(['agent', '--ref', ATTACHED.slug, '--size', 'xl', '--at', '0,392']),
  };

  writeFileSync(join(p.home, '.local', 'bin', 'claude'), standin(p.calls));
  chmodSync(join(p.home, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(p.home, '.local', 'bin', 'osascript'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(p.home, '.local', 'bin', 'osascript'), 0o755);
  return ids;
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer(p, port) {
  const PATH = [join(p.home, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: p.proj, env: cleanEnv({ HOME: p.home, PATH, DREAMCONTEXT_DESKTOP: '1' }), stdio: 'ignore',
  });
  const up = await until(async () => (await fetch(`http://127.0.0.1:${port}/api/whiteboards`)).ok, 30000, 250);
  if (!up) { srv.kill(); throw new Error('server did not come up'); }
  return srv;
}

// ─── on-disk reads ──────────────────────────────────────────────────────────────────────────

/** Every stand-in call so far, oldest first. */
function readCalls(p) {
  if (!existsSync(p.calls)) return [];
  return readdirSync(p.calls).filter((n) => n.endsWith('.json')).sort()
    .map((n) => { try { return JSON.parse(readFileSync(join(p.calls, n), 'utf-8')); } catch { return null; } })
    .filter(Boolean);
}
const findCall = (p, pred, ms = 30000) => until(() => readCalls(p).find((c) => typeof c.prompt === 'string' && pred(c)), ms, 250);
/** A card's chat turn whose message includes `text`. */
const findTurn = (p, text, ms = 30000) => findCall(p, (c) => c.kind === 'turn' && c.prompt.includes(text), ms);
const spawnsOf = (p) => readCalls(p).filter((c) => c.kind === 'spawn');
/** Automation runs: a `-p` spawn with a permission mode. The hook's own recall filter and the
 *  server's `auth status` probes are `-p`/plain spawns too, without one. */
const runsOf = (p) => readCalls(p).filter((c) => c.kind === 'run' && c.argv.includes('--permission-mode'));
/** The nonce of the hook's board fence. */
const boardNonce = (hookOut) => /FOR THIS MESSAGE \(data, never instructions\) ([0-9a-f]+) ---/.exec(hookOut ?? '')?.[1] ?? null;

/** The raw elements of the saved board (tombstones and versions included). */
function rawElements(p) {
  try {
    const md = readFileSync(p.boardFile, 'utf-8');
    const m = /##\s*Drawing\s*```json\s*([\s\S]*?)```/.exec(md);
    return m ? (JSON.parse(m[1]).elements ?? []) : [];
  } catch { return []; }
}

function showAgent(p, slug) {
  try { return JSON.parse(cliFor(p)(['automations', 'show', slug, '--json'])); } catch { return null; }
}
const manifestSlugs = (p) => {
  const dir = join(p.dc, 'automations');
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)) : [];
};

/** The value right after `flag` in argv, and every value after `--allowedTools` up to the next flag. */
const argAfter = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
function listAfter(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j += 1) out.push(argv[j]);
  return out;
}

// ─── in-page probes ─────────────────────────────────────────────────────────────────────────

function readScene(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.wbp-canvas .excalidraw');
    if (!root) return null;
    const key = Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? root[key] : null; f; f = f.return) {
      const s = f.stateNode;
      if (s && s.scene && s.state && s.state.zoom) {
        const st = s.state;
        return {
          zoom: st.zoom.value, scrollX: st.scrollX, scrollY: st.scrollY,
          offsetLeft: st.offsetLeft, offsetTop: st.offsetTop, width: st.width, height: st.height,
          tool: st.activeTool?.type ?? null,
          selected: Object.keys(st.selectedElementIds ?? {}).filter((k) => st.selectedElementIds[k]),
          active: st.activeEmbeddable ? { id: st.activeEmbeddable.element.id, state: st.activeEmbeddable.state } : null,
          elements: s.scene.getElementsIncludingDeleted().map((e) => ({
            id: e.id, type: e.type, x: e.x, y: e.y, width: e.width, height: e.height,
            isDeleted: !!e.isDeleted, version: e.version,
            kind: e.customData?.dc?.kind ?? null, size: e.customData?.dc?.size ?? null, ref: e.customData?.dc?.ref ?? null,
          })),
        };
      }
    }
    return null;
  });
}

const live = (s) => (s?.elements ?? []).filter((e) => !e.isDeleted);
const toClient = (s, x, y) => ({ x: (x + s.scrollX) * s.zoom + s.offsetLeft, y: (y + s.scrollY) * s.zoom + s.offsetTop });
const centreOf = (s, el) => toClient(s, el.x + el.width / 2, el.y + el.height / 2);
const grabOf = (s, el) => toClient(s, el.x + el.width * 0.12, el.y + el.height * 0.1);
const inside = (el, box) => {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  return cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height;
};

/** A client point on EMPTY canvas with room for a `size` box centred on it (whiteboard.mjs). */
function emptySpot(s, size) {
  const w = size.w * s.zoom;
  const h = size.h * s.zoom;
  const pad = 24;
  const left = s.offsetLeft + 260;
  const right = s.offsetLeft + s.width - 90;
  const top = s.offsetTop + 90;
  const bottom = s.offsetTop + s.height - 90;
  const boxes = live(s).map((e) => {
    const a = toClient(s, e.x, e.y);
    return { x1: a.x, y1: a.y, x2: a.x + e.width * s.zoom, y2: a.y + e.height * s.zoom };
  });
  for (let cy = top + h / 2; cy + h / 2 <= bottom; cy += 40) {
    for (let cx = left + w / 2; cx + w / 2 <= right; cx += 40) {
      const box = { x1: cx - w / 2 - pad, y1: cy - h / 2 - pad, x2: cx + w / 2 + pad, y2: cy + h / 2 + pad };
      if (boxes.every((b) => box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2)) {
        return { x: Math.round(cx), y: Math.round(cy) };
      }
    }
  }
  return null;
}

// ─── one theme, end to end ──────────────────────────────────────────────────────────────────

async function runTheme(theme) {
  console.log(`\n═══ ${theme} ═══`);
  const p = paths(theme);
  const ids = setup(p);
  check('fixture: a note and three Copy Desk cards on the board', Object.values(ids).every(Boolean), JSON.stringify(ids));
  const port = await freePort();
  const server = await startServer(p, port);
  const ORIGIN = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, colorScheme: theme, locale: 'en-US' });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    // The console's "Failed to load resource" names no URL: the response and the message's own
    // location do, so a failure says WHICH request failed.
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const at = m.location()?.url;
      consoleErrors.push(`${m.text()}${at ? ` [at ${at}]` : ''}`);
    });
    const badResponses = [];
    page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
    const sent = [];
    page.on('request', (r) => {
      if (r.method() !== 'POST') return;
      const url = r.url();
      if (!/\/automations\/threads\/say$|\/thread\/reply$/.test(url)) return;
      let body = null;
      try { body = r.postDataJSON(); } catch { /* not JSON */ }
      sent.push({ kind: url.endsWith('/threads/say') ? 'say' : 'reply', url, body });
    });

    // Every frame a page socket sends, with the socket's URL: the card's messages go here.
    const wsSent = [];
    page.on('websocket', (ws) => {
      ws.on('framesent', (f) => {
        const payload = typeof f.payload === 'string' ? f.payload : '';
        let o = null;
        try { o = JSON.parse(payload); } catch { /* not JSON */ }
        wsSent.push({ url: ws.url(), type: o?.type ?? null, text: typeof o?.text === 'string' ? o.text : JSON.stringify(o?.message ?? '') });
      });
    });

    const setTheme = () => page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), theme);
    const shoot = (name) => page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
    const scene = () => readScene(page);
    const focusCanvas = () => page.locator('.wbp-canvas .excalidraw-container').first().focus();
    const spot = async (size) => {
      for (let i = 0; i < 14; i += 1) {
        const pt = emptySpot(await scene(), size);
        if (pt) return pt;
        await page.locator('.excalidraw .zoom-out-button').click();
        await sleep(250);
      }
      return null;
    };
    const clearSelection = async () => {
      const pt = await spot({ w: 40, h: 40 });
      if (pt) await page.mouse.click(pt.x, pt.y);
      await focusCanvas();
      await page.keyboard.press('Escape');
      await sleep(200);
    };
    const fit = async () => {
      await clearSelection();
      await page.keyboard.press('Shift+1');
      await sleep(700);
    };
    /** The DOM card drawn for scene element `el`: the agent widget whose box centre is nearest. */
    const cardFor = async (el) => {
      const s = await scene();
      const live_ = live(s).find((e) => e.id === el.id) ?? el;
      const c = centreOf(s, live_);
      const idx = await page.evaluate(({ x, y }) => {
        const cards = [...document.querySelectorAll('.wb-widget[data-widget-kind="agent"]')];
        let best = -1;
        let bestD = Infinity;
        cards.forEach((n, i) => {
          const r = n.getBoundingClientRect();
          const d = Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y);
          if (d < bestD) { bestD = d; best = i; }
        });
        return best;
      }, c);
      return page.locator('.wb-widget[data-widget-kind="agent"]').nth(Math.max(idx, 0));
    };
    const activate = async (el) => {
      const s = await scene();
      const c = centreOf(s, live(s).find((e) => e.id === el.id) ?? el);
      await page.mouse.click(c.x, c.y);
      return until(async () => (await scene())?.active?.id === el.id && (await scene())?.active?.state === 'active', 4000);
    };
    const drawRect = async (pt) => {
      await page.locator('.wbp-canvas label:has([data-testid="toolbar-rectangle"])').first().click();
      await page.mouse.move(pt.x - 30, pt.y - 20);
      await page.mouse.down();
      await page.mouse.move(pt.x, pt.y, { steps: 4 });
      await page.mouse.move(pt.x + 30, pt.y + 20, { steps: 4 });
      await page.mouse.up();
      await focusCanvas();
      await page.keyboard.press('Escape');
      await sleep(250);
    };
    /** Drag `el` from its header corner until the pointer rests on `target`'s centre. */
    const dragOnto = async (el, target) => {
      const s = await scene();
      const from = grabOf(s, el);
      const to = centreOf(s, live(s).find((e) => e.id === target.id) ?? target);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
      await page.mouse.move(to.x, to.y, { steps: 6 });
      await page.mouse.up();
      await sleep(700);
    };
    const sendFrom = async (cardEl, text) => {
      await activate(cardEl);
      const card = await cardFor(cardEl);
      const input = card.locator('.chat-cmp-input').first();
      await input.click();
      await input.type(text, { delay: 8 });
      await page.keyboard.press('Enter');
    };

    await page.goto(`${ORIGIN}/?vault=proj`, { waitUntil: 'networkidle' });
    await setTheme();
    if (await until(() => page.locator('.announcements-modal-scrim').count(), 3000)) {
      await page.keyboard.press('Escape');
      await sleep(300);
    }
    await page.locator('.sidebar-item', { hasText: /Whiteboard(?!s)/ }).first().click();
    check('the board opens with its four widgets',
      !!await until(() => page.locator('[data-widget-kind]').count().then((n) => n >= 4), 20000));
    await setTheme();
    await fit();
    const agentCards = (s) => live(s).filter((e) => e.kind === 'agent');

    // ── W1: attach the existing agent through the palette ──────────────────────────────────
    const room = { w: 376 + 196, h: 376 + 196 };
    let pt = await spot(room);
    check('W1 there is room on the canvas for a card', !!pt);
    if (pt) {
      await page.mouse.click(pt.x, pt.y, { button: 'right' });
      await page.locator('.wb-palette-item', { hasText: /^Agent/ }).first().click();
      await page.locator('.wb-picker-row', { hasText: ATTACHED.title }).first().click({ timeout: 10000 }).catch(() => {});
    }
    const w1 = await until(async () => {
      const cards = agentCards(await scene()).filter((e) => e.ref === ATTACHED.slug);
      return cards.length === 4 ? cards : null;
    }, 8000);
    check('W1 the picker puts a fourth Copy Desk card on the board', !!w1,
      JSON.stringify(agentCards(await scene()).map((e) => e.ref)));
    const attachedCard = w1 ? w1.find((e) => ![ids.s, ids.m, ids.xl].includes(e.id)) : null;
    check('W1 …at the agent default size, L', attachedCard?.size === 'l', String(attachedCard?.size));
    check('W1 …and it is saved', !!await until(() => rawElements(p).some((e) => e.id === attachedCard?.id && !e.isDeleted), 8000));

    // ── W2: New agent from the palette ─────────────────────────────────────────────────────
    const slugsBefore = new Set(manifestSlugs(p));
    pt = await spot(room);
    if (pt) {
      await page.mouse.click(pt.x, pt.y, { button: 'right' });
      await page.locator('.wb-palette-item', { hasText: /^Agent/ }).first().click();
      await page.locator('.wb-palette-btn', { hasText: 'New agent' }).first().click();
    }
    const dialog = page.locator('.agent-modal');
    check('W2 "New agent" opens the create dialog', !!await until(() => dialog.count(), 5000));
    await dialog.locator('.agent-textarea').fill(NEW_AGENT_DESCRIPTION);
    const autoName = await until(async () => (await dialog.locator('.agent-input').first().inputValue()).trim(), 3000);
    check('W2 Name fills itself from the description', autoName === NEW_AGENT_NAME, JSON.stringify(autoName));
    check('W2 …and the dialog starts on "Only when I call it"',
      await dialog.locator('.agent-chip', { hasText: 'Only when I call it' }).getAttribute('aria-pressed') === 'true');
    await shoot('new-agent-dialog');
    await dialog.locator('.agent-btn--primary').click();
    check('W2 the dialog closes after the create', !!await until(async () => (await dialog.count()) === 0, 10000));
    const newSlug = await until(() => manifestSlugs(p).find((s) => !slugsBefore.has(s)), 8000);
    const created = newSlug ? showAgent(p, newSlug) : null;
    check('W2 a new manifest exists', !!created, String(newSlug));
    check('W2 …mode: call', created?.manifest?.mode === 'call', String(created?.manifest?.mode));
    check('W2 …learning: true', created?.manifest?.learning === true, String(created?.manifest?.learning));
    check(`W2 …whiteboard: ${BOARD}`, created?.manifest?.whiteboard === BOARD, String(created?.manifest?.whiteboard));
    check('W2 …approved on this machine', created?.approved === true, String(created?.approvalReason));
    const homeCard = await until(async () => agentCards(await scene()).find((e) => e.ref === newSlug), 8000);
    check('W2 the new agent\'s card lands on the board', !!homeCard);
    // A pattern is what earlier runs leave behind; the real CLI writes one so W4 can see it.
    if (newSlug) cliFor(p)(['automations', 'learn', newSlug, '--lesson', LESSON]);

    // ── W3: lazy sessions, composer by size ───────────────────────────────────────────────
    await fit();
    await setTheme();
    await shoot('board');
    check('W3 opening the board spawns no card session', spawnsOf(p).length === 0, `${spawnsOf(p).length} spawns`);
    for (const el of agentCards(await scene())) {
      const card = await cardFor(el);
      const size = await card.getAttribute('data-widget-size');
      const label = String(el.size).toUpperCase();
      if (el.size === 's') {
        await activate(el);
        await sleep(400);
        check('W3 an S card has no composer, even active', await card.locator('.chat-cmp-input').count() === 0, `size=${size}`);
        await clearSelection();
        continue;
      }
      check(`W3 an inactive ${label} card shows its start hint, no composer`,
        await card.locator('.wb-agent-idle').count() === 1 && await card.locator('.chat-cmp-input').count() === 0, `size=${size}`);
      await activate(el);
      const opened = await until(() => card.locator('.chat-cmp-input').count(), 15000);
      check(`W3 activating an ${label} card opens its chat`, !!opened && size === el.size, `size=${size} inputs=${opened}`);
      await clearSelection();
    }
    check('W3 the selector the plan names finds the composers',
      await page.locator('.wb-widget--agent .chat-cmp-input').count() >= 4);
    // A session's claude starts through a login shell, after its composer is already drawn: wait
    // for the M+ spawns, then make sure there is not one more (the S card's).
    const wanted = agentCards(await scene()).filter((e) => e.size !== 's').length;
    await until(() => spawnsOf(p).length >= wanted, 20000, 250);
    await sleep(1500);
    check('W3 one session per activated M+ card, none for the S card', spawnsOf(p).length === wanted,
      `${spawnsOf(p).length} spawns, ${wanted} wanted`);

    if (!homeCard || !newSlug) throw new Error('no home agent card: W4-W9 cannot run');

    // ── W4: first message from the home card ───────────────────────────────────────────────
    await clearSelection();
    const before4 = await scene();
    await activate(homeCard);
    const homeDom = await cardFor(homeCard);
    const input = homeDom.locator('.chat-cmp-input').first();
    await input.click();
    // Every one of these is an Excalidraw tool key outside a text field (r, o, d, a, l, t, p, e).
    await input.type('rodalt pe', { delay: 15 });
    const typed = await scene();
    check('W4 typing in the active card leaves Excalidraw on the selection tool', typed?.tool === 'selection', String(typed?.tool));
    check('W4 …and draws nothing', live(typed).length === live(before4).length, `${live(before4).length} -> ${live(typed).length}`);
    await input.fill('');
    await input.type(MSG1, { delay: 8 });
    await page.keyboard.press('Enter');
    const frame1 = await until(() => wsSent.find((f) => f.text.includes(MSG1)), 8000);
    check('W4 the message goes over the card\'s own chat socket',
      !!frame1 && frame1.url.includes(`cardAgent=${newSlug}`) && frame1.url.includes(`cardBoard=${BOARD}`), JSON.stringify(frame1));
    const call1 = await findTurn(p, MSG1);
    check('W4 the stand-in claude got the message', !!call1);
    check('W4 nothing went to the agent\'s thread (no say, no reply)', sent.length === 0, JSON.stringify(sent));
    check('W4 …and no run started', runsOf(p).length === 0, `${runsOf(p).length} runs`);
    if (call1) {
      const allowed = listAfter(call1.argv, '--allowedTools');
      check('W4 argv: --permission-mode dontAsk', argAfter(call1.argv, '--permission-mode') === 'dontAsk', call1.argv.join(' '));
      check('W4 argv: --setting-sources project', argAfter(call1.argv, '--setting-sources') === 'project');
      check('W4 argv: no bypassPermissions, no auto', !call1.argv.includes('bypassPermissions') && !call1.argv.includes('auto'));
      for (const rule of [
        `Bash(dreamcontext whiteboard add ${BOARD}:*)`,
        `Bash(dreamcontext whiteboard update ${BOARD}:*)`,
        `Bash(dreamcontext automations post ${newSlug}:*)`,
        'Bash(dreamcontext whiteboard show:*)',
      ]) check(`W4 --allowedTools has ${rule}`, allowed.includes(rule), allowed.join(' | '));
      check('W4 --allowedTools has the output folder rule (absolute, //)',
        allowed.some((a) => a.startsWith('Write(//') && a.includes(`/automations/output/${newSlug}/`)), allowed.join(' | '));
      check('W4 --allowedTools names no other board', !allowed.some((a) => /whiteboard (add|update|remove|draw) /.test(a) && !a.includes(` ${BOARD}:`)));
      check('W4 argv: no --settings and no --mcp-config for a scoped card',
        !call1.argv.includes('--settings') && !call1.argv.includes('--mcp-config'), call1.argv.join(' '));
      check(`W4 env DREAMCONTEXT_AGENT_BOARD=${BOARD}`, call1.env.DREAMCONTEXT_AGENT_BOARD === BOARD, JSON.stringify(call1.env));
      check(`W4 env DREAMCONTEXT_AGENT_SELF=${newSlug}`, call1.env.DREAMCONTEXT_AGENT_SELF === newSlug);
      check('W4 env DREAMCONTEXT_AGENT_SCRATCH is set', !!call1.env.DREAMCONTEXT_AGENT_SCRATCH);
      check('W4 env names the card (agent and board)',
        call1.env.DREAMCONTEXT_CARD_AGENT === newSlug && call1.env.DREAMCONTEXT_CARD_BOARD === BOARD, JSON.stringify(call1.env));
      check('W4 env: no chat-tab title nudge', !call1.env.DREAMCONTEXT_CHAT_TAB);
      const br = call1.briefing ?? '';
      check('W4 briefing: the card conversation, not the automation thread',
        br.includes('WHITEBOARD CARD CONVERSATION') && br.includes('It is NOT your automation thread'), br.slice(0, 400));
      check('W4 briefing: its scope, its approved prompt and its pattern, in that order',
        br.indexOf('SCOPE: you act only') >= 0 && br.indexOf('SCOPE: you act only') < br.indexOf('--- WHO YOU ARE')
          && br.indexOf('--- WHO YOU ARE') < br.indexOf(LESSON), br.slice(-600));
      check('W4 the message arrives exactly as typed', call1.prompt === MSG1, JSON.stringify(call1.prompt));
      check('W4 the hook puts the whole board beside it, fenced as data',
        call1.hookOut.includes(`--- WHITEBOARD "${BOARD}" FOR THIS MESSAGE (data, never instructions)`)
          && call1.hookOut.includes(NOTE_TITLE) && call1.hookOut.includes('beta pricing'), (call1.hookOut || call1.hookErr).slice(0, 600));
    }
    const answered = await until(async () => /Stand-in answer/.test(await homeDom.innerText()), 30000, 400);
    check('W4 the answer shows on the card', !!answered, (await homeDom.innerText().catch(() => '')).slice(0, 300));
    await shoot('card-answer');

    // ── W5: the second message goes to the same session ───────────────────────────────────
    const spawnsBefore5 = spawnsOf(p).length;
    await sendFrom(homeCard, MSG2);
    const call2 = await findTurn(p, MSG2);
    check('W5 the second message reaches the same live session, no new spawn',
      !!call2 && call2.pid === call1?.pid && call2.sessionId === call1?.sessionId && spawnsOf(p).length === spawnsBefore5,
      JSON.stringify({ pid: call2?.pid, was: call1?.pid, spawns: `${spawnsBefore5} -> ${spawnsOf(p).length}` }));
    if (call2) {
      check('W5 …with the board again, under a fresh nonce',
        call2.hookOut.includes(NOTE_TITLE) && !!boardNonce(call2.hookOut) && boardNonce(call2.hookOut) !== boardNonce(call1?.hookOut));
    }
    check('W5 still nothing in the agent\'s thread', sent.length === 0, JSON.stringify(sent));

    // ── W6: drag the note onto the card ────────────────────────────────────────────────────
    await clearSelection();
    let s = await scene();
    const note0 = live(s).find((e) => e.id === ids.note);
    const homeBox = live(s).find((e) => e.id === homeCard.id);
    await dragOnto(note0, homeBox);
    s = await scene();
    const note1 = live(s).find((e) => e.id === ids.note);
    check('W6 the dropped note is back at its x/y on the canvas', note1?.x === note0.x && note1?.y === note0.y,
      `${note0.x},${note0.y} -> ${note1?.x},${note1?.y}`);
    check('W6 …with a newer version (a real write, not an untouched element)', (note1?.version ?? 0) > note0.version);
    const saved = await until(() => {
      const d = rawElements(p).find((e) => e.id === ids.note);
      return d && d.version >= note1.version && d;
    }, 10000);
    check('W6 …and at the same x/y in the saved board file', !!saved && saved.x === note0.x && saved.y === note0.y,
      JSON.stringify(saved && { x: saved.x, y: saved.y, v: saved.version }));
    const chip = homeDom.locator('.chat-cmp-attachment-ref');
    check('W6 a ref chip appears in the card\'s composer', !!await until(() => chip.count(), 5000));
    check('W6 …naming the note', (await chip.first().innerText().catch(() => '')).includes(NOTE_TITLE),
      await chip.first().innerText().catch(() => ''));
    await shoot('card-chip');
    await sendFrom(homeCard, MSG3);
    const frame3 = await until(() => wsSent.find((f) => f.text.includes(MSG3)), 8000);
    check('W6 the send carries the reference token',
      !!frame3 && frame3.text.includes(`dcref:wb/${BOARD}/${ids.note}`), JSON.stringify(frame3));
    const bubble = await until(async () => {
      const texts = await homeDom.locator('.chat-msg-user-bubble').allInnerTexts();
      return texts.find((t) => t.includes(MSG3)) ?? null;
    }, 15000);
    check('W6 the sent bubble shows the message without the token', !!bubble && !bubble.includes('dcref:'), String(bubble));
    check('W6 …and a Board element chip beside it', await homeDom.locator('.chat-msg-user-ref').count() >= 1);
    const call3 = await findTurn(p, MSG3);
    const refBlock = call3 ? call3.hookOut.slice(call3.hookOut.indexOf('--- REFERENCED BOARD ELEMENTS')) : '';
    check('W6 the hook\'s reference block carries the whole note',
      !!call3 && refBlock.startsWith('--- REFERENCED BOARD ELEMENTS') && refBlock.includes(NOTE_TAIL),
      call3 ? call3.hookOut.slice(-400) : 'no call');

    // The undo sentinel: an edit, a drop, ONE Cmd+Z. Unselected note first, then a selected one.
    for (const variant of ['unselected', 'already selected']) {
      await clearSelection();
      const before = await scene();
      const rectSpot = await spot({ w: 80, h: 60 });
      await drawRect(rectSpot);
      const rect = live(await scene()).find((e) => e.type === 'rectangle' && !live(before).some((b) => b.id === e.id));
      check(`W6 sentinel (${variant}): the edit made a rectangle`, !!rect);
      s = await scene();
      const noteBefore = live(s).find((e) => e.id === ids.note);
      if (variant === 'unselected') {
        // As a user does it: done drawing, click empty canvas and press Escape, so the fresh
        // rectangle is no longer the selection. Then the drag starts from the same header point
        // the main W6 drop grabs, on an idle board.
        await clearSelection();
        const idle = await until(async () => {
          const now = await scene();
          return now?.tool === 'selection' && now.selected.length === 0 && now.active?.state !== 'active';
        }, 3000);
        const st = await scene();
        check('W6 sentinel (unselected): the board is idle before the drag (selection tool, nothing selected or active)', !!idle,
          JSON.stringify({ tool: st?.tool, selected: st?.selected, active: st?.active }));
      }
      if (variant === 'already selected') {
        // As a user does it: click away from the rectangle just drawn (it is still the
        // selection), then drag a selection box around the note. Not a click: a click on a
        // widget also ACTIVATES it (subscribeWidgetActivation), and an active widget takes the
        // pointer, so its header could no longer be dragged. A box selection selects only.
        await clearSelection();
        s = await scene();
        const n = live(s).find((e) => e.id === ids.note);
        const box = { x: n.x - 30, y: n.y - 30, width: n.width + 40, height: n.height + 40 };
        const caught = live(s).filter((e) => e.x >= box.x && e.y >= box.y
          && e.x + e.width <= box.x + box.width && e.y + e.height <= box.y + box.height).map((e) => e.id);
        check('W6 sentinel (already selected): the selection box holds only the note',
          caught.length === 1 && caught[0] === ids.note, JSON.stringify(caught));
        const from = toClient(s, box.x, box.y);
        const to = toClient(s, box.x + box.width, box.y + box.height);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
        await page.mouse.move(to.x, to.y, { steps: 5 });
        await page.mouse.up();
        const picked = await until(async () => {
          const now = await scene();
          return now?.selected.length === 1 && now.selected[0] === ids.note && now.active?.state !== 'active';
        }, 3000);
        const st = await scene();
        const typeOf = (id) => live(st).find((e) => e.id === id)?.type ?? '?';
        check('W6 sentinel (already selected): the note, and only the note, is selected before the drag', !!picked,
          JSON.stringify({ selected: st?.selected.map((id) => `${id}:${typeOf(id)}`), active: st?.active, tool: st?.tool, note: ids.note }));
      }
      // A REAL drop, proven before the undo: the x comparison alone also passes when nothing
      // was dragged at all. The restore writes a newer version, and the drop adds a chip.
      const sentinelCard = await cardFor(homeCard);
      const noteChips = () => sentinelCard.locator('.chat-cmp-attachment-ref', { hasText: NOTE_TITLE }).count();
      const chipsBefore = await noteChips();
      const versionBefore = live(await scene()).find((e) => e.id === ids.note)?.version ?? noteBefore.version;
      await dragOnto(noteBefore, homeBox);
      const dropped = live(await scene()).find((e) => e.id === ids.note);
      check(`W6 sentinel (${variant}): the drop put the note back`, dropped?.x === noteBefore.x && dropped?.y === noteBefore.y,
        `${noteBefore.x},${noteBefore.y} -> ${dropped?.x},${dropped?.y}`);
      check(`W6 sentinel (${variant}): …a real drop: the note's version went up`, (dropped?.version ?? 0) > versionBefore,
        `${versionBefore} -> ${dropped?.version}`);
      const chipsAfter = await until(async () => { const c = await noteChips(); return c > chipsBefore ? c : 0; }, 4000);
      check(`W6 sentinel (${variant}): …and a chip naming the note joined the card's composer`, !!chipsAfter,
        `chips naming "${NOTE_TITLE}": ${chipsBefore} -> ${await noteChips()}`);
      await focusCanvas();
      await page.keyboard.press('ControlOrMeta+z');
      await sleep(600);
      const after = await scene();
      const noteAfter = live(after).find((e) => e.id === ids.note);
      const cardAfter = live(after).find((e) => e.id === homeCard.id);
      check(`W6 sentinel (${variant}): one Cmd+Z keeps the edit`, !!rect && live(after).some((e) => e.id === rect.id),
        JSON.stringify(live(after).filter((e) => e.type === 'rectangle').map((e) => e.id)));
      check(`W6 sentinel (${variant}): …and the note is not on the card`,
        !!noteAfter && !!cardAfter && !inside(noteAfter, cardAfter) && noteAfter.x === noteBefore.x && noteAfter.y === noteBefore.y,
        `note ${noteAfter?.x},${noteAfter?.y} (was ${noteBefore.x},${noteBefore.y}); card ${cardAfter?.x},${cardAfter?.y}`);
    }
    const settled = await until(() => {
      const d = rawElements(p).find((e) => e.id === ids.note);
      return d && d.x === note0.x && d.y === note0.y && d;
    }, 10000);
    check('W6 after the sentinel the saved file still has the note where it was', !!settled);

    // ── W7: the attached agent keeps the pane's own mode and gets only the index ──────────
    await clearSelection();
    await sendFrom(attachedCard, MSG_ATTACHED);
    const call4 = await findTurn(p, MSG_ATTACHED);
    check('W7 the attached agent got the message in its own card session', !!call4 && call4.pid !== call1?.pid);
    if (call4) {
      check('W7 argv: the pane\'s mode (auto), no board scope',
        argAfter(call4.argv, '--permission-mode') === 'auto' && !call4.argv.includes('dontAsk') && !call4.argv.includes('--setting-sources'),
        call4.argv.join(' ').slice(0, 300));
      check('W7 env carries no board scope, only the card',
        !call4.env.DREAMCONTEXT_AGENT_BOARD && !call4.env.DREAMCONTEXT_AGENT_SELF && call4.env.DREAMCONTEXT_CARD_AGENT === ATTACHED.slug,
        JSON.stringify(call4.env));
      check('W7 briefing: who it is, no scope line',
        (call4.briefing ?? '').includes(ATTACHED.title) && !(call4.briefing ?? '').includes('SCOPE:'));
      check('W7 the hook gives the board index and the show command',
        call4.hookOut.includes(`WHITEBOARD "${BOARD}" FOR THIS MESSAGE`) && call4.hookOut.includes(`dreamcontext whiteboard show ${BOARD}`)
          && call4.hookOut.includes(NOTE_TITLE), call4.hookOut.slice(-600));
      check('W7 …and no note body', !call4.hookOut.includes('beta pricing') && !call4.hookOut.includes(NOTE_TAIL));
    }
    check('W7 no run and no thread message for either agent', runsOf(p).length === 0 && sent.length === 0,
      JSON.stringify({ runs: runsOf(p).length, sent }));

    // ── W11: New conversation starts a fresh session ──────────────────────────────────────
    await clearSelection();
    await activate(homeCard);
    await (await cardFor(homeCard)).locator('.wb-agent-menu-btn').click();
    await page.locator('.wb-agent-menu-item', { hasText: 'New conversation' }).click();
    await sendFrom(homeCard, MSG_FRESH);
    const call5 = await findTurn(p, MSG_FRESH);
    check('W11 New conversation: the next message lands in a new session',
      !!call5 && call5.pid !== call1?.pid && call5.sessionId !== call1?.sessionId,
      JSON.stringify({ pid: call5?.pid, sid: call5?.sessionId, was: call1?.sessionId }));
    const freshDom = await cardFor(homeCard);
    check('W11 …and the card no longer shows the old conversation',
      !!await until(async () => { const t = await freshDom.innerText(); return t.includes(MSG_FRESH) && !t.includes(MSG1); }, 10000),
      (await freshDom.innerText().catch(() => '')).slice(0, 300));

    // ── W9: Edit agent puts it on a schedule ───────────────────────────────────────────────
    await clearSelection();
    await activate(homeCard);
    const homeDom2 = await cardFor(homeCard);
    await homeDom2.locator('.wb-agent-menu-btn').click();
    await page.locator('.wb-agent-menu-item', { hasText: 'Edit agent' }).click();
    const edit = page.locator('.agent-modal');
    check('W9 Edit agent opens the dialog', !!await until(() => edit.count(), 5000));
    const promptLoaded = await until(async () => (await edit.locator('.agent-textarea').getAttribute('readonly')) === null
      && (await edit.locator('.agent-textarea').inputValue()).length > 0, 10000);
    check('W9 …with the full prompt read', !!promptLoaded);
    await edit.locator('.agent-chip', { hasText: 'On a schedule' }).click();
    await sleep(300);
    await shoot('edit-schedule');
    await edit.locator('.agent-btn--primary').click();
    check('W9 the dialog closes after the save', !!await until(async () => (await edit.count()) === 0, 10000));
    const edited = await until(() => { const a = showAgent(p, newSlug); return a?.manifest?.mode === 'sched' && a; }, 8000);
    check('W9 the agent is on a schedule', !!edited && (edited.manifest.schedule?.slots?.length ?? 0) >= 1,
      JSON.stringify(showAgent(p, newSlug)?.manifest?.schedule ?? null));
    check('W9 …still homed on the board, and re-approved', edited?.manifest?.whiteboard === BOARD && edited?.approved === true,
      JSON.stringify({ whiteboard: edited?.manifest?.whiteboard, approved: edited?.approved }));

    // ── W8: removing the card keeps the agent ──────────────────────────────────────────────
    await clearSelection();
    s = await scene();
    const g = grabOf(s, live(s).find((e) => e.id === homeCard.id));
    await page.mouse.click(g.x, g.y);
    check('W8 the card is selected', !!await until(async () => (await scene())?.selected.includes(homeCard.id), 3000));
    await focusCanvas();
    await page.keyboard.press('Delete');
    check('W8 the card is removed from the board', !!await until(() => {
      const d = rawElements(p).find((e) => e.id === homeCard.id);
      return !d || d.isDeleted;
    }, 10000));
    check('W8 …and the agent\'s manifest is still there', existsSync(join(p.dc, 'automations', `${newSlug}.md`)) && !!showAgent(p, newSlug));
    await page.locator('.sidebar-item', { hasText: /Automations|Agents/ }).first().click();
    await sleep(800);
    if (!(await page.locator('.agent-card').count())) await page.locator('.agents-switch-opt', { hasText: 'Agents' }).click().catch(() => {});
    const chipText = await until(async () => {
      const cards = page.locator('.agent-card', { hasText: edited?.manifest?.title ?? autoName ?? newSlug });
      return (await cards.count()) ? (await cards.first().locator('.agent-card-board').innerText().catch(() => '')) : '';
    }, 10000);
    check(`W8 the Agents page shows the board chip (${BOARD})`, String(chipText).includes(BOARD), String(chipText));
    await shoot('agents-page');

    // ── W10 ───────────────────────────────────────────────────────────────────────────────
    check('W10 no page errors', pageErrors.length === 0, pageErrors.join(' | '));
    check('W10 no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
    check('W10 no failed requests', badResponses.length === 0, badResponses.join(' | '));
  } catch (err) {
    // One theme's stop is reported and the other theme still runs.
    check(`the ${theme} run finished`, false, err && err.stack ? err.stack : err);
  } finally {
    await browser.close();
    server.kill();
  }
}

for (const theme of ['light', 'dark']) {
  try {
    await runTheme(theme);
  } catch (err) {
    // A fixture or server that would not start: reported, and the next theme still runs.
    check(`the ${theme} fixture and server came up`, false, err && err.stack ? err.stack : err);
  }
}
console.log(`\n${report.fail === 0 ? '✓ PASS' : '✗ FAIL'}: ${report.pass} passed, ${report.fail} failed`);
console.log(`Screenshots: ${SHOTS}`);
process.exit(report.fail === 0 ? 0 : 1);
