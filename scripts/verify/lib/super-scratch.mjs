/**
 * Shared skeleton for the verify scripts that drive SEVERAL Super Agents in one project (plan-r10
 * Wave 3: main Super plus one Super per AI Team member): a scratch HOME, the real dashboard server
 * from the built dist, a scripted stand-in `claude` that plays main Super, a member's Super
 * (`mode: 'super'` + a chatAgent: its process carries DREAMCONTEXT_MEMBER_SUPER=<slug>) and the
 * children of either, and the small browser helpers the scripts share. No tokens are spent and
 * nothing touches the real ~/.dreamcontext.
 *
 *   import { superStandin, ... } from './lib/super-scratch.mjs';
 *
 * The stand-in writes one NDJSON line per event to `reports` (`spawn`, `<role>-turn`, and whatever
 * the role bodies report) and a Claude-shaped transcript per session under
 * $HOME/.claude/projects/<cwd>/<session>.jsonl, so a conversation reopened later has history.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** A clean environment: none of the calling session's Claude or dreamcontext variables. */
export function cleanEnv(home, extra = {}) {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_')));
  return { ...e, HOME: home, DREAMCONTEXT_DESKTOP: '1', ...extra };
}

/** The real dashboard server from the built dist, its log in `logFile`. */
export async function startServer({ cli, cwd, home, port, logFile, extraEnv = {} }) {
  const PATH = [join(home, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [cli, 'dashboard', '--no-open', '-p', String(port)], { cwd, env: { ...cleanEnv(home, extraEnv), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(logFile, { flags: 'a' });
  srv.stdout.pipe(log);
  srv.stderr.pipe(log);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

export const readNd = (path) => { try { return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; } };

/** The pass/fail tally every script prints: 'N passed M failed'. */
export function reporter() {
  const result = { pass: 0, fails: [] };
  const ok = (label, cond, detail) => {
    if (cond) { result.pass++; console.log(`  ✓ ${label}`); }
    else { result.fails.push(label); console.log(`  ✗ ${label}${detail !== undefined && detail !== '' ? `\n      ${String(detail).slice(0, 900)}` : ''}`); }
    return !!cond;
  };
  const summary = () => `${result.pass} passed ${result.fails.length} failed${result.fails.length ? `:\n  - ${result.fails.join('\n  - ')}` : ''}`;
  return { result, ok, summary };
}

export const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};

/**
 * The theme, switched live: the app follows the system scheme while nothing is stored
 * (`ThemeContext`, 'system' is the default of a fresh origin), so emulating the scheme flips it.
 * If a stored choice pins it, the attribute is set directly so the shot still shows that theme.
 */
export async function applyTheme(page, theme) {
  await page.emulateMedia({ colorScheme: theme });
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    if ((await page.evaluate(() => document.documentElement.getAttribute('data-theme')).catch(() => null)) === theme) return true;
    await page.waitForTimeout(100);
  }
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme).catch(() => {});
  return false;
}

/** Console errors, page crashes and failed requests of ONE page, for the end-of-run check. */
export function watchPage(page, name, { expected = [] } = {}) {
  const errors = [];
  const failed = [];
  const allowed = (s) => expected.some((re) => re.test(s));
  page.on('console', (m) => { if (m.type() === 'error' && !allowed(m.text())) errors.push(`${name} console: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => errors.push(`${name} crash: ${String(e).slice(0, 300)}`));
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? '';
    // A request the page itself cancelled (a navigation, a superseded poll) is no finding.
    if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(why)) return;
    const line = `${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')} ${why}`;
    if (!allowed(line)) failed.push(`${name} failed request: ${line}`);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const line = `${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`;
    if (!allowed(line)) failed.push(`${name} ${line}`);
  });
  return { errors, failed };
}

/** One Super's stage on screen: main's (`data-super-id="main"`, or none on an older build) or a member's. */
export function stage(page, superId = 'main') {
  return superId === 'main'
    ? page.locator('[data-testid="super-surface"][data-super-id="main"]:visible, [data-testid="super-surface"]:not([data-super-id]):visible').first()
    : page.locator(`[data-testid="super-surface"][data-super-id="${superId}"]:visible`).first();
}

/** The composer of a Super's stage (its centre slot, else any composer inside the stage). */
export async function stageComposer(page, superId = 'main') {
  const s = stage(page, superId);
  const centre = s.locator('[data-super-slot="centre"] .chat-cmp-input');
  if (await centre.count()) return centre.first();
  return s.locator('.chat-cmp-input').first();
}

export async function sayOnStage(page, superId, text) {
  const input = await stageComposer(page, superId);
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}

/** `requestOpenAgents({ slug, task? })`: the member's stage (dashboard/src/lib/openAgents.ts). */
export const openMember = (page, slug, task) => page.evaluate(([s, t]) => window.dispatchEvent(new CustomEvent('dreamcontext-open-agents', { detail: t ? { slug: s, task: t } : { slug: s } })), [slug, task ?? null]);
/** `requestManageMembers({ slug? })`: the "Üyeleri yönet" modal. */
export const openManageMembers = (page, slug) => page.evaluate((s) => window.dispatchEvent(new CustomEvent('dreamcontext-manage-members', { detail: s ? { slug: s } : {} })), slug ?? null);

/** A fetch from the app's own page (it carries the page's Origin, so owner-page routes accept it). */
export const pageFetch = (page, vault, method, path, body) => page.evaluate(async ([v, m, p, b]) => {
  const r = await fetch(`/api${p}`, { method: m, headers: { 'X-Dreamcontext-Vault': v, ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let json = null; try { json = await r.json(); } catch { /* no body */ }
  return { status: r.status, json };
}, [vault, method, path, body ?? null]);

/** Main's Super row in the drawer (or the classic sidebar): it opens main's stage. */
export async function toMainStage(page) {
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click().catch(() => {});
  return until(page, async () => (await stage(page, 'main').count()) > 0, 15000);
}

/**
 * The stand-in `claude`. `main`, `member` and `child` are JS function BODIES (source text) run for
 * one user turn with `text` (the turn's first text block), `slug` (the member, '' on main), `crew`
 * (a child's member, from DREAMCONTEXT_MEMBER_CREW), `cli(...args)`, `report(o)` and `sleep(ms)`
 * in scope. A body returns the line to answer, or `null` to HOLD the turn (the chat stays working,
 * the way a long child job does). `headless` is the body for a `claude -p` run (prompt in `prompt`):
 * it returns the result line.
 */
export function superStandin({ reports, cli, main = "return 'ok';", member = "return 'ok';", child = "return 'ok';", headless = "return 'ok';" }) {
  return `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const report = (o) => appendFileSync(${JSON.stringify(reports)}, JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cli)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
if (!argv.includes('stream-json')) {
  if (argv.includes('-p')) {
    const prompt = argv[argv.indexOf('-p') + 1] || '';
    report({ kind: 'headless-run', prompt: prompt.slice(0, 2000) });
    let said = 'ok';
    try { said = await (async () => { ${headless} })(); } catch (e) { said = 'error ' + e; }
    out({ type: 'result', subtype: 'success', is_error: false, result: said, session_id: at('--resume') || randomUUID(), num_turns: 1, total_cost_usd: 0, duration_ms: 5 });
  } else out({});
  process.exit(0);
}
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const slug = process.env.DREAMCONTEXT_MEMBER_SUPER || '';
const crew = process.env.DREAMCONTEXT_MEMBER_CREW || '';
const role = slug ? 'member' : /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = at('--session-id') || at('--resume') || randomUUID();
const tdir = join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
try { mkdirSync(tdir, { recursive: true }); } catch {}
const row = (o) => { try { appendFileSync(join(tdir, sid + '.jsonl'), JSON.stringify({ ...o, cwd: process.cwd(), uuid: randomUUID(), timestamp: new Date().toISOString(), sessionId: sid }) + '\\n'); } catch {} };
report({ kind: 'spawn', role, slug, crew, sid });
const bodies = {
  super: async (text) => { ${main} },
  member: async (text) => { ${member} },
  child: async (text) => { ${child} },
};
const TAG = role === 'super' ? 'SUPER ' : role === 'member' ? slug.toUpperCase() + ' SUPER ' : 'CHILD ';
let inited = false;
async function turn(blocks, content) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  const text = blocks.join('\\n');
  report({ kind: role + '-turn', slug, crew, sid, text: text.slice(0, 4000), blocks: blocks.length });
  // The turn exactly as the server sent it (string or blocks), as Claude Code records it.
  row({ type: 'user', message: { role: 'user', content } });
  let said = 'ok';
  try { said = await bodies[role](text); } catch (e) { said = 'error ' + e; }
  if (said === null) return new Promise(() => {});
  const line = TAG + said;
  row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: line }] } });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: line }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
}
let buf = '';
let chain = Promise.resolve();
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    // On arrival, before the turn chain: a turn that never runs is then the stand-in's, not the server's.
    report({ kind: 'stdin-user', role, slug, sid, text: blocks.join('\\n').slice(0, 200) });
    chain = chain.then(() => turn(blocks, content));
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;
}

/** `- item=<id> event=request` lines of a delivered `[super events]` turn (inbox.ts requestItemLines). */
export const REQUEST_ITEM_RE = /- item=(\S+) event=request/;
