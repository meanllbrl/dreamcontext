#!/usr/bin/env node
/**
 * DECLARED TASK STATUSES — proof in the real app (task_adYgpCxk).
 *
 *   npm run build && node scripts/verify/task-statuses-ui.mjs
 *
 * Scratch vault (fake HOME) declares `planned` + `cancelled` in overrides/task.md, seeds
 * tasks including a CANCELLED one with a long-past due date, then drives the built
 * dashboard with Playwright and screenshots:
 *   01 Kanban — Planned + Cancelled columns; the cancelled task shows NO overdue badge and the
 *      at-risk banner counts only the live overdue task
 *   02 Eisenhower — the cancelled task is absent
 *   03 Task detail — the status dropdown lists all six keys
 *   04 Settings › Task Format — the Statuses editor with the live column preview
 *   05 CLI — `tasks statuses`, `tasks list`, `doctor` (terminal render)
 *   06 GitHub wire — round trip + delete proof + schema drift against the fake (terminal render)
 * Screenshots land in tmp/verify/statuses/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = join(REPO, 'tmp', 'verify', 'statuses');
const PORT = 45741;
const URL = `http://127.0.0.1:${PORT}`;
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

// ── scratch vault ─────────────────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'dc-st-ui-'));
const vault = join(home, 'scratch');
const ctx = join(vault, '_dream_context');
mkdirSync(join(ctx, 'state'), { recursive: true });
mkdirSync(join(ctx, 'overrides'), { recursive: true });
mkdirSync(join(home, '.dreamcontext'), { recursive: true });
writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify({ platforms: [] }, null, 2));
writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ version: 1, vaults: [{ name: 'scratch', path: vault }] }, null, 2));
writeFileSync(join(ctx, 'overrides', 'task.md'), `---
statuses:
  - { name: Planned, key: planned, kind: open, order: 5, color: c5def5 }
  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99, color: cfd3d7, clickup: [cancelled, canceled] }
---
`);
const seed = (slug, name, status, extra = {}) => writeFileSync(
  join(ctx, 'state', `${slug}.md`),
  `---\nid: task_${slug}\nname: ${name}\ndescription: ${name}\npriority: ${extra.priority ?? 'medium'}\nurgency: ${extra.urgency ?? 'medium'}\nstatus: ${status}\n`
  + `created_at: '2026-08-01'\nupdated_at: '2026-09-01'\ntags: []\nparent_task: null\nrelated_feature: null\n`
  + (extra.due ? `start_date: '2026-08-05'\ndue_date: '${extra.due}'\n` : '')
  + `---\n\n## Why\n\nSeeded by scripts/verify/task-statuses-ui.mjs.\n`,
);
seed('ship-onboarding', 'Ship onboarding flow', 'in_progress', { due: '2026-08-20', priority: 'high', urgency: 'high' });
seed('old-idea', 'Old idea (abandoned)', 'cancelled', { due: '2026-08-01', priority: 'high', urgency: 'high' });
seed('q4-roadmap', 'Q4 roadmap draft', 'planned', { due: '2026-11-30' });
seed('landing-page', 'Landing page copy', 'completed', { due: '2026-08-10' });
seed('fix-login-bug', 'Fix login bug', 'todo', { priority: 'critical', urgency: 'critical' });
seed('review-pricing', 'Review pricing page', 'in_review');

const cli = (args) => spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args], { cwd: vault, env: { ...process.env, HOME: home, FORCE_COLOR: '0', NO_COLOR: '1' }, encoding: 'utf-8' });

// ── server ────────────────────────────────────────────────────────────────────
const server = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '--port', String(PORT)], {
  cwd: vault, env: { ...process.env, HOME: home, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const up = async () => { for (let i = 0; i < 60; i++) { try { if ((await fetch(`${URL}/api/health`)).ok) return true; } catch { /* */ } await new Promise((r) => setTimeout(r, 500)); } return false; };

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const termHtml = (title, blocks) => `<!doctype html><html><body style="margin:0;background:#0f1117;color:#e6e6e6;font-family:'JetBrains Mono',Menlo,monospace;font-size:13px;padding:22px 26px">
<div style="color:#9d8cff;font-weight:600;margin-bottom:12px;font-size:14px">${esc(title)}</div>
${blocks.map(([cmd, out]) => `<div style="margin-bottom:18px"><div style="color:#7ee787">$ ${esc(cmd)}</div><pre style="margin:6px 0 0;white-space:pre-wrap;line-height:1.5">${esc(out)}</pre></div>`).join('')}
</body></html>`;

let browser;
try {
  check('server is up', await up(), serverLog.slice(-200));
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, colorScheme: 'dark' });
  page.on('pageerror', (e) => console.log('[page error]', String(e).slice(0, 160)));
  const shot = async (name, p = page) => { await p.screenshot({ path: join(SHOTS, `${name}.png`) }); console.log(`  📸 ${name}.png`); };
  const dismiss = async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); } };
  const openBoard = async () => {
    await page.goto(`${URL}/?vault=scratch`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await dismiss();
    await page.locator('.sidebar-item', { hasText: 'Tasks' }).first().click();
    await page.waitForTimeout(1500);
  };

  // 01 — Kanban (wide viewport so all six columns are on screen)
  await page.setViewportSize({ width: 1900, height: 940 });
  await openBoard();
  const colLabels = await page.locator('.bd-scroll [class*="col"] , .bd-scroll').allInnerTexts();
  const boardText = colLabels.join(' ').replace(/\s+/g, ' ');
  check('01 Kanban shows a Planned column and a Cancelled column', /Planned/.test(boardText) && /Cancelled/.test(boardText), boardText.slice(0, 120));
  const cancelledCard = page.locator('.bd-card', { hasText: 'Old idea' }).first();
  const cancelledText = ((await cancelledCard.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  check('01 the cancelled task (due 2026-08-01) shows NO overdue badge', !/Overdue/i.test(cancelledText), cancelledText.slice(0, 80));
  const liveCard = page.locator('.bd-card', { hasText: 'Ship onboarding' }).first();
  check('01 the live overdue task DOES show an overdue badge', /Overdue/i.test(((await liveCard.innerText().catch(() => '')) || '')));
  const banner = (await page.locator('body').innerText()).match(/(\d+) overdue/i);
  check('01 the at-risk banner counts exactly 1 overdue (not the cancelled one)', banner?.[1] === '1', banner?.[0]);
  await shot('01-kanban-declared-columns');
  await page.setViewportSize({ width: 1440, height: 940 });

  // 02 — Eisenhower
  const viewChip = page.locator('.bd-chip, .bd-hover', { hasText: /^Board$|Kanban/ }).first();
  if (await viewChip.count()) {
    await viewChip.click(); await page.waitForTimeout(500);
    const row = page.locator('.bd-row', { hasText: 'Eisenhower' }).first();
    if (await row.count()) { await row.click(); await page.waitForTimeout(1200); }
  }
  const eis = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const inMatrix = /Do first|Urgent|Eliminate/i.test(eis);
  check('02 Eisenhower matrix omits the cancelled task but keeps the live ones', inMatrix && !/Old idea/.test(eis) && /Fix login bug/.test(eis), inMatrix ? 'matrix rendered' : 'could not switch layout');
  await shot('02-eisenhower-no-cancelled');

  // 03 — task detail status dropdown
  await openBoard();
  await page.locator('.bd-card', { hasText: 'Q4 roadmap' }).first().click();
  await page.waitForTimeout(1200);
  const wf = page.locator('.task-section-head', { hasText: 'Workflow' }).first();
  if (await wf.count()) { const open = await page.locator('#tf-status').count(); if (!open) { await wf.click(); await page.waitForTimeout(500); } }
  const opts = await page.locator('#tf-status option').allTextContents().catch(() => []);
  check('03 the detail status dropdown lists all six statuses in order', opts.join('|') === 'To Do|Planned|In Progress|In Review|Completed|Cancelled', opts.join('|'));
  await page.locator('#tf-status').scrollIntoViewIfNeeded().catch(() => {});
  await shot('03-task-detail-status-select');

  // 04 — Settings › Task Format (close the detail overlay first — it intercepts clicks)
  await dismiss();
  if (await page.locator('.detail-overlay').count()) await page.locator('.detail-overlay').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.waitForTimeout(500);
  await page.goto(`${URL}/?vault=scratch`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await dismiss();
  await page.locator('.sidebar-item', { hasText: 'Settings' }).first().click();
  await page.waitForTimeout(900);
  await page.locator('.settings-nav-item', { hasText: 'Task Format' }).first().click();
  await page.waitForTimeout(900);
  const preview = await page.locator('[data-testid="status-preview"]').innerText().catch(() => '');
  check('04 Settings shows the live column preview with all six statuses', /To Do.*Planned.*In Progress.*In Review.*Completed.*Cancelled/s.test(preview), preview.replace(/\s+/g, ' ').slice(0, 100));
  const lockedRemove = page.locator('button[aria-label="Remove status Completed"]');
  check('04 the shipped statuses are locked (remove disabled)', await lockedRemove.isDisabled().catch(() => false));
  await page.locator('[data-testid="status-list"]').scrollIntoViewIfNeeded();
  await shot('04-settings-statuses-editor');
  // 409 while in use
  const rm = page.locator('button[aria-label="Remove status Cancelled"]');
  await rm.click(); await page.waitForTimeout(1200);
  const alert = await page.locator('[role="alert"]').innerText().catch(() => '');
  check('04 removing a status still carried by a task is blocked (409, names the count)', /1 task\(s\) still carry status "cancelled"/.test(alert), alert);
  await shot('05-settings-delete-blocked-409');

  // 05 — CLI
  const st = cli(['tasks', 'statuses']);
  const ls = cli(['tasks', 'list']);
  const lsc = cli(['tasks', 'list', '-s', 'cancelled']);
  writeFileSync(join(ctx, 'state', 'odd.md'), `---\nname: odd\nstatus: on_hold\ncreated_at: '2026-09-01'\nupdated_at: '2026-09-01'\n---\n## Why\nx\n`);
  const doc = cli(['doctor']);
  const doctorLines = doc.stdout.split('\n').filter((l) => /override|Task status|Task override/i.test(l)).join('\n');
  check('05 `tasks statuses` lists the declared set with GitHub mapping', /cancelled.*declared/s.test(st.stdout) && /closed\+completed dc:cancelled/.test(st.stdout));
  check('05 `tasks list` hides the cancelled task, `-s cancelled` finds it', !/old-idea/.test(ls.stdout) && /old-idea/.test(lsc.stdout));
  check('05 `doctor` names the task with an undeclared status', /state\/odd\.md: status 'on_hold'/.test(doc.stdout));
  const t = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await t.setContent(termHtml('CLI — scratch vault with planned + cancelled declared', [
    ['dreamcontext tasks statuses', st.stdout.trim()],
    ['dreamcontext tasks list', ls.stdout.trim()],
    ['dreamcontext tasks list -s cancelled', lsc.stdout.trim()],
    ['dreamcontext doctor  (status lines)', doctorLines.trim()],
  ]));
  await t.screenshot({ path: join(SHOTS, '06-cli-statuses-list-doctor.png'), fullPage: true });
  console.log('  📸 06-cli-statuses-list-doctor.png');

  // 06 — GitHub wire proof
  const proofOut = join(home, 'gh-proof.txt');
  const gh = spawnSync('npx', ['tsx', join(REPO, 'scripts', 'verify', 'task-statuses-github.mts')], { cwd: REPO, env: { ...process.env, PROOF_OUT: proofOut }, encoding: 'utf-8' });
  check('06 GitHub round trip / delete / drift script ran clean', gh.status === 0 && /self-corrected/.test(gh.stdout), (gh.stderr || '').slice(-200));
  await t.setContent(termHtml('GitHub wire — real backend against the in-memory GitHub fake', [['npx tsx scripts/verify/task-statuses-github.mts', gh.stdout.trim()]]));
  await t.screenshot({ path: join(SHOTS, '07-github-wire-roundtrip.png'), fullPage: true });
  console.log('  📸 07-github-wire-roundtrip.png');
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  rmSync(home, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
