#!/usr/bin/env node
/**
 * Hackathon, one REAL small run, recorded end to end (no staged data): a fictional static site in
 * a scratch vault, two Claude teams on the cheapest model, two shortest rounds, real team turns,
 * real peek/similarity, real presentation screenshots, real jury, the owner's pick in the UI.
 *
 *   dreamcontext builder heavy -- node scripts/verify/hackathon-real.mjs --out <dir>
 *
 * Needs the built app (the route launches the conductor from dist) and the machine's own signed-in
 * `claude` (linked through the login keychain into the fake HOME). The jury may pick Codex: it is
 * reached through the real CODEX_HOME, as on the owner's Mac. Everything else is the fake HOME.
 * Writes: a video of the whole flow (1440), step screenshots at 1440 and 390, timeline.json with
 * every state change, wall time and the cost the transcripts report. Exit 0 = the run reached a
 * pick, 1 = it did not (findings printed).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';
import { openApp, ownerShellScript } from './lib/app.mjs';
import { distIndex, markAnnouncementsSeen } from './lib/measure.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, rounds: { type: 'string' }, minutes: { type: 'string' } } });
const OUT = values.out ?? join(process.cwd(), 'tmp', 'hackathon-real');
mkdirSync(OUT, { recursive: true });
const REAL_HOME = homedir();
process.env.CODEX_HOME ??= join(REAL_HOME, '.codex');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(REAL_HOME, 'Library', 'Caches', 'ms-playwright');

const t0 = Date.now();
const timeline = [];
const mark = (what, extra = {}) => { const e = { at: new Date().toISOString(), min: +((Date.now() - t0) / 60_000).toFixed(1), what, ...extra }; timeline.push(e); console.log(`[${e.min}m] ${what}`); writeFileSync(join(OUT, 'timeline.json'), `${JSON.stringify(timeline, null, 2)}\n`); };

const KEY = randomBytes(32).toString('base64url');
const app = await openApp({ suite: 'hackathon-real', build: true, claude: 'real', ownerKey: KEY });
const V = 'proj';
const ctx = join(app.proj, '_dream_context');
const findings = [];
const check = (ok, what) => { if (!ok) { findings.push(what); mark(`FINDING: ${what}`); } };
const api = async (method, path, body) => {
  const r = await fetch(`${app.base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': V }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ─── A tiny fictional site (synthetic fixture) ──────────────────────────────

const site = join(app.proj, 'site');
mkdirSync(site, { recursive: true });
writeFileSync(join(site, 'index.html'), `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pusula Dil Kursu</title><link rel="stylesheet" href="style.css"></head>
<body>
<header class="nav"><b>Pusula Dil Kursu</b><nav><a href="#kurslar">Kurslar</a> <a href="#fiyat">Fiyatlar</a> <a href="#iletisim">İletişim</a></nav></header>
<section class="hero">
  <h1>Pusula Dil Kursu'na hoş geldiniz</h1>
  <p>2014'ten beri İngilizce, Almanca ve İspanyolca kursları veriyoruz. Deneyimli öğretmenlerimiz, modern sınıflarımız ve esnek ders saatlerimizle hizmetinizdeyiz. Kurslarımız hakkında daha fazla bilgi almak için aşağıdaki bağlantıları inceleyebilirsiniz.</p>
  <a class="btn" href="#kurslar">Daha fazla bilgi</a>
</section>
<section id="kurslar"><h2>Kurslar</h2><ul><li>İngilizce A1-C1</li><li>Almanca A1-B2</li><li>İspanyolca A1-B1</li></ul></section>
<section id="fiyat"><h2>Fiyatlar</h2><p>Aylık 1.900 TL'den başlayan paketler. İlk deneme dersi ücretsiz.</p></section>
<footer id="iletisim">Kadıköy, İstanbul · 0216 000 00 00</footer>
</body></html>
`);
writeFileSync(join(site, 'style.css'), `body{margin:0;font-family:Georgia,serif;color:#333}
.nav{display:flex;justify-content:space-between;padding:16px 32px;background:#eee}
.hero{padding:40px 32px;background:#f7f7f7}
.hero h1{font-size:28px}
.btn{color:#06c}
section{padding:24px 32px}
`);
writeFileSync(join(site, 'README.md'), '# Pusula Dil Kursu\n\nStatik tanıtım sitesi: `index.html` + `style.css`. Derleme yok; `index.html` doğrudan açılır.\n');
const git = (args) => spawnSync('git', args, { cwd: site, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 'Ornek', GIT_AUTHOR_EMAIL: 'ornek@example.com', GIT_COMMITTER_NAME: 'Ornek', GIT_COMMITTER_EMAIL: 'ornek@example.com' } });
git(['init', '-q', '-b', 'main']); git(['add', '-A']); git(['commit', '-qm', 'site']);

// ─── The design the chat agent would write, then `hackathon start` ──────────

const ROUNDS = Number(values.rounds ?? 2);
const MINUTES = Number(values.minutes ?? 10);
const designFile = join(app.proj, 'hk-design.json');
writeFileSync(designFile, JSON.stringify({
  kind: 'screen',
  problem: "Pusula Dil Kursu ana sayfasının hero bölümü: ziyaretçi daha çok 'ücretsiz deneme dersi' kaydı yapsın",
  target: site,
  teams: [
    { id: 'sade', name: 'Sade', persona: 'Az kelime, tek büyük çağrı; fazlalığı kesen bir dönüşüm tasarımcısı.', tool: 'claude', model: 'haiku', inner: 'solo' },
    { id: 'kanitci', name: 'Kanıtçı', persona: 'Güveni kanıtla kuran ürün analisti: sayılar, yorumlar, somut vaat.', tool: 'claude', model: 'haiku', inner: 'trio' },
  ],
  rounds: ROUNDS, roundMinutes: MINUTES,
  limit: { weeklyShareCeiling: 15, sessionGuard: 80 },
  mcpTools: [],
}, null, 2));
const installed = await api('POST', '/plugins/hackathon/install', {});
check(installed.status < 300, `hackathon install answered ${installed.status}`);
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
const cliEnv = { ...clean, HOME: app.home, PATH: `${join(app.home, '.local', 'bin')}:${process.env.PATH}` };
const started = spawnSync('node', [distIndex(join(import.meta.dirname, '..', '..')), 'hackathon', 'start', '--design', designFile], { cwd: app.proj, env: cliEnv, encoding: 'utf-8' });
writeFileSync(join(OUT, 'hackathon-start.txt'), `${started.stdout}\n${started.stderr}`);
const RUN = /"run":"([^"]+)"/.exec(started.stdout ?? '')?.[1];
check(!!RUN, `hackathon start printed no run id: ${(started.stderr || started.stdout).slice(0, 300)}`);
if (!RUN) { app.findings.push(...findings); process.exit(await app.finish()); }
mark(`run created: ${RUN}`);

// ─── The browser: one recorded desktop page for the whole flow, phone shots beside it ─────

const browser = await chromium.launch();
const vctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: join(OUT, 'video-raw'), size: { width: 1440, height: 900 } } });
await vctx.addInitScript(ownerShellScript(KEY));
await markAnnouncementsSeen(vctx, app.base);
const page = await vctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/\/@vite\/|favicon|\/ws\b/.test(m.text())) consoleErrors.push(`${((Date.now() - t0) / 60_000).toFixed(1)}m ${m.text().slice(0, 200)}`); });
page.on('pageerror', (e) => consoleErrors.push(`crash ${String(e.message).slice(0, 200)}`));

const visible = (p, sel, ms = 8_000) => p.locator(sel).first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const go = async (p) => {
  await p.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  const row = p.locator('[data-testid="ns-rail-hackathon"]');
  if (await row.isVisible().catch(() => false)) await row.click();
  else { await p.locator('[data-testid="ns-rail-more"]').click(); await p.locator('[data-testid="ns-more-hackathon"]').click(); }
  await p.waitForTimeout(600);
};
const openRun = async (p) => { await go(p); await p.locator('.hk-run').first().click(); await p.waitForTimeout(1200); };
const home = async (p) => { await p.goto(`${app.base}/?vault=${V}`, { waitUntil: 'domcontentloaded' }); await openRun(p); };

/** The desktop shot from the recorded page, the phone shot from a fresh 390 context doing `act`. */
const shots = async (name, act = async () => {}) => {
  await page.screenshot({ path: join(OUT, `${name}-1440.png`), fullPage: true }).catch((e) => findings.push(`${name}: desktop shot failed ${e.message}`));
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await pctx.addInitScript(ownerShellScript(KEY));
  await markAnnouncementsSeen(pctx, app.base);
  const pp = await pctx.newPage();
  try { await home(pp); await act(pp); await pp.waitForTimeout(800); await pp.screenshot({ path: join(OUT, `${name}-390.png`), fullPage: true }); }
  catch (e) { findings.push(`${name}: phone shot failed ${e instanceof Error ? e.message.split('\n')[0] : e}`); }
  await pctx.close();
  mark(`shot ${name}`);
};

const runRec = async () => (await api('GET', `/hackathon/${RUN}`)).body;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pickedTeam = null;
try {
  await home(page);
  check(await visible(page, '.hk-card--start button.hk-btn--primary'), 'no Başlat on the start card');
  await page.waitForTimeout(1500);
  await shots('01-start-card');

  await page.locator('.hk-card--start button.hk-btn--primary').click();
  mark('owner pressed Başlat');
  let began = false;
  for (let i = 0; i < 30 && !began; i++) { await sleep(2000); began = (await runRec())?.state !== 'awaiting-owner'; }
  if (!began) {
    const err = await page.locator('.hk-error, [role=alert]').allInnerTexts().catch(() => []);
    check(false, `Başlat did not start the run: ${err.join(' | ') || 'no error shown'}`);
    throw new Error('not started');
  }

  const seen = new Set();
  let last = '';
  const deadline = Date.now() + (ROUNDS * MINUTES + 15 + 25) * 60_000 + 20 * 60_000;
  let roomShot = false;
  let liveShot = false;
  for (;;) {
    if (Date.now() > deadline) { check(false, 'run did not reach judging with a jury before the time limit'); break; }
    const r = await runRec();
    const rec = r?.run ?? r;
    const key = `${rec?.state}|${rec?.phase ?? ''}|${rec?.round ?? ''}`;
    if (key !== last) { mark(`state ${key}`, { strip: rec?.strip, conductor: rec?.conductor }); last = key; }
    if (rec?.state === 'stopped') { check(false, `run stopped: ${rec.stopReason ?? '?'}`); break; }

    if (rec?.state === 'running' && !liveShot && Date.now() - t0 > 2.5 * 60_000) {
      await home(page); await page.waitForTimeout(3000);
      await shots('02-live-r1'); liveShot = true;
    }
    if (rec?.state === 'running' && liveShot && !roomShot && Date.now() - t0 > 5 * 60_000) {
      const openRoom = async (p) => {
        const table = p.locator('.hk-live__tables > *').first();
        await table.locator('button').first().click().catch(async () => { await table.click(); });
        await p.waitForTimeout(1500);
      };
      await home(page); await openRoom(page);
      await shots('03-team-room', openRoom); roomShot = true;
      await page.waitForTimeout(10_000);
      await home(page);
    }
    if (rec?.state === 'running' && (rec?.round ?? 0) >= 2 && !seen.has('peek')) {
      seen.add('peek');
      const openPeek = async (p) => { const s = p.locator('.hk-step__btn').first(); if (await s.isVisible().catch(() => false)) { await s.click(); await p.waitForTimeout(1200); } };
      await home(page); await openPeek(page);
      await shots('04-peek-after-r1', openPeek);
      await page.waitForTimeout(8000);
      await home(page); await page.waitForTimeout(2000);
      await shots('05-live-r2');
    }
    if (rec?.state === 'presenting' && !seen.has('presenting')) {
      seen.add('presenting');
      await home(page); await page.waitForTimeout(3000);
      await shots('06-presenting');
    }
    if (rec?.state === 'judging' && !seen.has('judging')) {
      seen.add('judging');
      await home(page); await page.waitForTimeout(3000);
      await shots('07-judging');
    }
    const result = rec?.state === 'judging' ? (await api('GET', `/hackathon/${RUN}/result`)).body : null;
    if (result?.jury?.ranking?.length) {
      mark('jury done', { jury: result.jury });
      await home(page); await page.waitForTimeout(2500);
      await shots('08-results');
      // Each team's presentation, opened on the stage.
      const teams = await page.locator('.hk-results__cols > *').count();
      for (let i = 0; i < teams; i++) {
        const openPres = async (p) => { await p.locator('.hk-results__cols > *').nth(i).locator('.hk-result__foot button').first().click(); await p.waitForTimeout(1500); const screen = p.locator('.hk-present button, .hk-stage button').filter({ hasText: /./ }); if (await screen.count()) { await screen.nth(Math.min(1, (await screen.count()) - 1)).click().catch(() => {}); await p.waitForTimeout(1200); } };
        await home(page); await openPres(page);
        await page.waitForTimeout(4000);
        await shots(`09-presentation-${i + 1}`, openPres);
      }
      // The owner picks the jury's first.
      await home(page); await page.waitForTimeout(1500);
      const first = result.jury.ranking[0];
      const names = await page.locator('.hk-results__cols > *').allInnerTexts();
      const teamName = (await api("GET", `/hackathon/${RUN}/design`)).body?.teams?.find?.((t) => t.id === first)?.name ?? first;
      const idx = Math.max(0, names.findIndex((n) => n.includes(teamName)));
      const pickBtn = page.locator('.hk-results__cols > *').nth(idx).locator('.hk-result__foot button').nth(1);
      check(await pickBtn.isVisible().catch(() => false), 'no pick button on the results');
      await pickBtn.click();
      mark(`owner picked ${teamName}`);
      for (let i = 0; i < 60; i++) { const s = await runRec(); if ((s?.run ?? s)?.state === 'picked') break; await sleep(2000); }
      const after = await runRec();
      check((after?.run ?? after)?.state === 'picked', `after the pick the state is ${(after?.run ?? after)?.state}`);
      pickedTeam = teamName;
      await home(page); await page.waitForTimeout(3000);
      await shots('10-picked');
      break;
    }
    await sleep(15_000);
  }
} catch (err) {
  findings.push(`could not finish: ${err instanceof Error ? err.stack : err}`);
}

// ─── Evidence: video, cost, team outputs ────────────────────────────────────

await page.waitForTimeout(2000);
const videoPath = await page.video()?.path();
await vctx.close();
await browser.close();
if (videoPath && existsSync(videoPath)) copyFileSync(videoPath, join(OUT, 'flow-1440.webm'));

const runFolder = join(ctx, 'hackathon', RUN);
let cost = 0; let turns = 0; const perTeam = {};
const teamsDir = join(runFolder, 'teams');
for (const team of existsSync(teamsDir) ? readdirSync(teamsDir) : []) {
  for (const f of readdirSync(join(teamsDir, team)).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(teamsDir, team, f), 'utf-8').split('\n')) {
      try { const j = JSON.parse(line); if (j.type === 'result') { cost += j.total_cost_usd ?? 0; turns++; perTeam[team] = (perTeam[team] ?? 0) + (j.total_cost_usd ?? 0); perTeam[`${team}:${f}`] = { cost: j.total_cost_usd, ms: j.duration_ms, turns: j.num_turns, subtype: j.subtype }; } } catch { /* not json */ }
    }
  }
}
const evidence = join(OUT, 'run-files');
mkdirSync(evidence, { recursive: true });
spawnSync('cp', ['-R', runFolder, join(evidence, 'brain-run')]);
const ws = join(app.home, '.dreamcontext-hackathon', RUN);
for (const team of existsSync(ws) ? readdirSync(ws).filter((n) => !n.startsWith('.')) : []) {
  spawnSync('cp', ['-R', join(ws, team, 'out'), join(evidence, `${team}-out`)]);
  spawnSync('git', ['-C', join(ws, team, 'repo'), 'diff', 'HEAD', '--stat'], { encoding: 'utf-8' });
  const d = spawnSync('git', ['-C', join(ws, team, 'repo'), 'diff', 'HEAD'], { encoding: 'utf-8' });
  writeFileSync(join(evidence, `${team}.diff`), d.stdout ?? '');
}
if (existsSync(join(ws, '.conductor', 'shots'))) spawnSync('cp', ['-R', join(ws, '.conductor', 'shots'), join(evidence, 'conductor-shots')]);
const summary = { run: RUN, wallMinutes: +((Date.now() - t0) / 60_000).toFixed(1), teamCostUsd: +cost.toFixed(4), teamTurns: turns, perTeam, pickedTeam, findings, consoleErrors, scratch: app.home };
writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
mark('done', summary);
for (const f of findings) app.findings.push(f);
process.exit(await app.finish());
