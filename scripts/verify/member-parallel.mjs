#!/usr/bin/env node
/**
 * One AI Team member, several jobs at once, on the real path: the real server and runner with a
 * slow stand-in for `claude` that logs when each child starts and ends and answers with the
 * question's own token. Proves overlap from that log, each answer in its own thread, the app's
 * path beside the owner's, a follow-up in its own session, and the count on the AI Team row.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './lib/app.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = await openApp({ suite: 'member-parallel', build: true, desktop: true });
const log = join(app.home, 'claude.jsonl');
const hold = join(app.home, 'hold-seconds');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { app.findings.push(m); process.stdout.write(`FAIL ${m}\n`); };
const check = (ok, m) => { process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${m}\n`); if (!ok) app.findings.push(m); };

writeFileSync(hold, '4');
writeFileSync(join(app.home, '.local', 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('node:fs'); const { randomUUID } = require('node:crypto');
const a = process.argv.slice(2);
if (a[0] === '--version' || a.includes('--version')) { console.log('2.0.0 (Claude Code)'); process.exit(0); }
const prompt = a[a.indexOf('-p') + 1] || '';
const q = (prompt.match(/QQ[a-z0-9]+/g) || []).pop() || 'none';
const resume = a.includes('--resume') ? a[a.indexOf('--resume') + 1] : null;
const session = resume || randomUUID();
const wait = Number(fs.readFileSync(${JSON.stringify(hold)}, 'utf-8')) * 1000;
const line = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(o) + '\\n');
line({ e: 'start', q, at: Date.now(), resume, session, run: process.env.DREAMCONTEXT_AUTOMATION_RUN });
setTimeout(() => {
  line({ e: 'end', q, at: Date.now() });
  console.log(JSON.stringify({ session_id: session, is_error: false, result: 'Answer for ' + q, total_cost_usd: 0.01, num_turns: 1, permission_denials: [] }));
}, wait);
`);
chmodSync(join(app.home, '.local', 'bin', 'claude'), 0o755);

const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME: app.home };
const cli = (...args) => {
  const r = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args], { cwd: app.proj, env, encoding: 'utf-8' });
  if (r.status !== 0) fail(`cli ${args.join(' ')}: ${(r.stdout + r.stderr).slice(-300)}`);
};
async function windowUrl() {
  const file = JSON.parse(readFileSync(join(app.home, '.dreamcontext', 'desktop-server.json'), 'utf-8'));
  const r = await fetch(`${app.base}/api/apps/launch-window`, {
    method: 'POST',
    headers: { authorization: `Bearer ${file.launchToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectRoot: realpathSync(app.proj), slug: 'demo' }),
  });
  if (!r.ok) throw new Error(`launch-window ${r.status}: ${await r.text()}`);
  return (await r.json()).url;
}
const api = async (method, path, body) => {
  const r = await fetch(`${app.base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'proj' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const events = () => { try { return readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const until = async (ok, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ok()) return true; await sleep(100); }
  fail(`timed out: ${what}`);
  return false;
};
const answer = async (runId) => (await api('GET', `/api/automations/desk/thread?run=${encodeURIComponent(runId)}`)).json;

try {
  cli('agents', 'create', 'desk', '--title', 'Desk', '--prompt', 'Answer.');
  cli('automations', 'approve', 'desk', '--yes');
  cli('apps', 'new', 'demo', '--name', 'Demo Ads');

  // `ROW_ONLY=1`: only the AI Team row, a shorter look.
  if (!process.env.ROW_ONLY) {
  // ── Two owner questions, at once ──
  const [a, b] = await Promise.all([
    api('POST', '/api/automations/threads/say', { slug: 'desk', text: 'first QQalpha' }),
    api('POST', '/api/automations/threads/say', { slug: 'desk', text: 'second QQbeta' }),
  ]);
  process.stdout.write(`say: ${a.status} ${b.status}\n`);
  check(a.status === 200 && b.status === 200, 'both owner questions were accepted while the member was busy');
  const runs = [a, b].filter((r) => r.status === 200).map((r) => r.json.runId);
  check(new Set(runs).size === runs.length, `each question has its own run id: ${runs.join(' ')}`);

  await until(() => events().filter((e) => e.e === 'start').length === runs.length, 'all children to start');
  const feed = (await api('GET', '/api/automations/threads')).json;
  process.stdout.write(`working.desk: ${JSON.stringify(feed.working?.desk)}\n`);
  check(feed.working?.desk?.count === runs.length, `the feed counts ${runs.length} jobs on the member`);
  await until(() => events().filter((e) => e.e === 'end').length === runs.length, 'all children to end');
  const ev = events();
  for (const e of ev) process.stdout.write(`  ${e.e.padEnd(5)} ${e.q} +${e.at - ev[0].at}ms\n`);
  const lastStart = Math.max(...ev.filter((e) => e.e === 'start').map((e) => e.at));
  const firstEnd = Math.min(...ev.filter((e) => e.e === 'end').map((e) => e.at));
  check(lastStart < firstEnd, `every child started before any ended: last start ${lastStart - ev[0].at}ms, first end ${firstEnd - ev[0].at}ms`);

  // ── Each answer in its own place ──
  const tokens = ['QQalpha', 'QQbeta'];
  await until(async () => (await Promise.all(runs.map(answer))).every((t) => t.answer?.text), 'the answers to land');
  for (let i = 0; i < runs.length; i++) {
    const t = await answer(runs[i]);
    const others = tokens.filter((x) => x !== tokens[i]);
    process.stdout.write(`  ${tokens[i]} -> ${JSON.stringify(t.answer?.text)}\n`);
    check(t.answer?.text?.includes(tokens[i]) && !others.some((o) => t.answer.text.includes(o)), `${tokens[i]}'s thread holds its own answer and no other`);
    check(t.entries.filter((e) => e.kind === 'user').length === 1, `${tokens[i]}'s thread holds one question`);
  }

  // ── Follow-ups: each reaches its own session, both side by side ──
  const session = (q) => ev.find((e) => e.q === q && e.e === 'start').session;
  writeFileSync(hold, '3');
  const [ra, rb] = await Promise.all([
    api('POST', '/api/automations/desk/thread/reply', { runId: runs[0], text: 'more QQalphatwo' }),
    api('POST', '/api/automations/desk/thread/reply', { runId: runs[1], text: 'more QQbetatwo' }),
  ]);
  check(ra.status === 202 && rb.status === 202, `replies on two runs accepted (${ra.status} ${rb.status}, older run included)`);
  await until(() => events().filter((e) => e.e === 'start' && e.q.endsWith('two')).length === 2, 'both follow-ups to start');
  const fu = events().filter((e) => e.e === 'start' && e.q.endsWith('two'));
  check(fu.find((e) => e.q === 'QQalphatwo')?.resume === session('QQalpha'), 'the first follow-up resumed the first session');
  check(fu.find((e) => e.q === 'QQbetatwo')?.resume === session('QQbeta'), 'the second follow-up resumed the second session');
  await until(() => events().filter((e) => e.e === 'end' && e.q.endsWith('two')).length === 2, 'both follow-ups to end');
  await sleep(500);

  // ── The embedded chat of an app: two questions, the second while the first runs ──
  writeFileSync(hold, '6');
  const appRuns = [];
  await app.look('/?vault=proj', async (page, w) => {
    await page.goto(await windowUrl(), { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.body.innerHTML = '';
      const f = document.createElement('iframe');
      f.src = '/__dc/embed/chat?member=desk';
      f.style.cssText = 'border:0;width:100vw;height:100vh;display:block';
      document.body.append(f);
    });
    await page.waitForTimeout(3000);
    const frame = page.frames().find((f) => f !== page.mainFrame());
    const box = frame.locator('textarea, [contenteditable="true"]').first();
    for (const q of [`QQapp${w.name}one`, `QQapp${w.name}two`]) {
      const said = page.waitForResponse((r) => /\/api\/apps\/demo\/say$/.test(r.url()), { timeout: 10_000 }).catch(() => null);
      await box.fill(q);
      await box.press('Enter');
      const r = await said;
      const body = r ? await r.json().catch(() => ({})) : {};
      check(r?.status() === 200, `embedded chat @${w.name}: ${q} answered ${r?.status() ?? 'nothing'}`);
      if (body.runId) appRuns.push({ q, runId: body.runId });
    }
    await until(() => events().filter((e) => e.e === 'start' && e.q.startsWith(`QQapp${w.name}`)).length === 2, `both app questions @${w.name}`);
    const live = events().filter((e) => e.q.startsWith(`QQapp${w.name}`));
    const second = live.filter((e) => e.e === 'start')[1];
    check(!live.some((e) => e.e === 'end' && e.at < second.at), `@${w.name}: the second app question started while the first ran`);
    await page.waitForTimeout(1000);
  }, { name: 'embed' });
  await until(() => events().filter((e) => e.e === 'end' && e.q.startsWith('QQapp')).length === 4, 'the app answers');
  await until(async () => (await Promise.all(appRuns.map((r) => answer(r.runId)))).every((t) => t.answer?.text), 'the app answers to land');
  for (const r of appRuns) {
    const t = await answer(r.runId);
    process.stdout.write(`  ${r.q} -> ${JSON.stringify(t.answer?.text)}\n`);
    check(t.answer?.text === `Answer for ${r.q}`, `${r.q}: its request's run holds its own answer`);
  }

  }

  // ── What the owner sees while three jobs run ──
  writeFileSync(hold, '120');
  for (const q of ['QQone', 'QQtwo', 'QQthree']) await api('POST', '/api/automations/threads/say', { slug: 'desk', text: `hold ${q}` });
  await until(() => events().filter((e) => e.e === 'start' && ['QQone', 'QQtwo', 'QQthree'].includes(e.q)).length === 3, 'three held jobs');
  await app.look('/?vault=proj', async (page, w) => {
    await page.locator('[aria-label="AI Team"]:visible').first().click({ timeout: 10_000 });
    await page.waitForTimeout(2500);
    const body = await page.locator('body').innerText();
    const shown = (await page.locator('[data-working-count="3"]').count()) > 0;
    process.stdout.write(`row@${w.name}: ${shown ? 'shows 3 jobs' : 'no count'}\n`);
    if (/working on something else/i.test(body)) app.findings.push(`blocked line on screen @${w.name}`);
    if (!shown) app.findings.push(`the row does not say 3 jobs @${w.name}`);
  }, { name: 'team' });
} catch (err) {
  fail(`could not finish: ${err instanceof Error ? `${err.message} ${err.cause ?? ''}` : err}`);
}
spawnSync('pkill', ['-f', join(app.home, '.local', 'bin', 'claude')]);
process.exit(await app.finish());
