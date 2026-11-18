#!/usr/bin/env node
/**
 * Hackathon, observed (plan W2 screens, criterion 14's screen half): a scratch project with four
 * fictional runs seeded on disk, one per state, looked at 390 and 1440 px.
 *
 *   dreamcontext builder heavy -- node scripts/verify/hackathon.mjs [--out <dir>]
 *
 * Screens: the empty page, the run list, the start card (awaiting-owner), Canlı (team tables in a
 * grid with the strip), the paused strip with Devam, the team room, the peek after round 1, the
 * results with the jury (judging), a presentation, the picked result. No team runs: every file a
 * conductor would write is written here. Exit 0 = clean, 1 = findings.
 */
import { copyFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { openApp, ownerShellScript } from './lib/app.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const app = await openApp({ suite: 'hackathon' });
const V = 'proj';
const ctx = join(app.proj, '_dream_context');
const wsHome = join(app.home, '.dreamcontext-hackathon');
const api = async (method, path, body) => {
  const r = await fetch(`${app.base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': V },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const check = (ok, what) => { if (!ok) app.findings.push(what); };
const visible = (page, sel, ms = 8_000) => page.locator(sel).first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const json = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`); };
const lines = (p, rows) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`); };
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();

// ─── Fictional runs ─────────────────────────────────────────────────────────

const TEAMS = [
  { id: 'sade', name: 'Sade', persona: 'Az kelime, tek büyük çağrı; her şeyi kesen tasarımcı.', tool: 'claude', model: 'sonnet', inner: 'trio' },
  { id: 'kanitci', name: 'Kanıtçı', persona: 'Her iddiayı sayıyla destekleyen ürün analisti.', tool: 'codex', model: '', inner: 'solo' },
  { id: 'hikaye', name: 'Hikâyeci', persona: 'Kullanıcının bir gününü anlatan metin yazarı.', tool: 'claude', model: 'opus', inner: 'trio' },
  { id: 'kontrol', name: 'Kontrol', persona: 'Hiç göz atmayan düz bir ekip.', tool: 'claude', model: 'sonnet', inner: 'solo' },
];
const design = (kind, problem, rounds = 3) => ({
  kind, problem, target: join(app.proj, 'site'), teams: TEAMS, rounds, roundMinutes: 30,
  peek: { neighbours: 2, questions: 1, borrow: 1, gate: 0.8 }, controlTeam: 'kontrol',
  experiment: null, limit: { endsAt: new Date(now + 3 * 3600_000).toISOString(), weeklyShareCeiling: 15, sessionGuard: 80 }, mcpTools: [],
});
const run = (id, state, d, extra = {}) => ({ version: 1, id, problem: d.problem, state, createdAt: iso(600), design: d, moments: [], ...extra });
const runDir = (id) => join(ctx, 'hackathon', id);
const out = (id, team) => join(wsHome, id, team, 'out');

const thesis = {
  sade: { thesis: 'Ana sayfa tek bir cümle ve tek bir düğmeyle daha çok kayıt alır.', claims: ['Üç bölüm yerine bir bölüm', 'Düğme ekranın ortasında', 'Fiyat ikinci ekranda'], status: 'on-track' },
  kanitci: { thesis: 'Gerçek kullanım sayıları güveni artırır ve kaydı yükseltir.', claims: ['Canlı kullanıcı sayacı', 'Üç müşteri alıntısı', 'Karşılaştırma tablosu'], status: 'on-track' },
  hikaye: { thesis: 'Bir öğretmenin gününü anlatan sayfa ziyaretçiyi kendini görmeye çağırır.', claims: ['Sabah, öğle, akşam bölümleri', 'Her bölümde bir ekran', 'Sonda kayıt çağrısı'], status: 'pivot' },
  kontrol: { thesis: 'Mevcut sayfanın başlığı ve düğmesi netleşirse kayıt artar.', claims: ['Yeni başlık', 'Daha görünür düğme', 'Daha kısa form'], status: 'on-track' },
};

// 1. Awaiting the owner's Başlat.
const R1 = '20261118-ana-sayfa';
json(join(runDir(R1), 'run.json'), run(R1, 'awaiting-owner', design('screen', 'Ana sayfanın daha iyi hali: ziyaretçi daha çok kayıt olsun')));

// 2. Running, round 2 of 3, with live transcripts, decisions and round 1's record.
const R2 = '20261117-funnel-ab';
const d2 = { ...design('experiment', 'Gelir artıracak funnel A/B testi: ödeme adımında ne değişmeli?'), baseSha: 'a'.repeat(40) };
const run2 = run(R2, 'running', d2, {
  phase: 'rounds', round: 2, startedAt: iso(50), startedHash: 'x',
  usageAtStart: { weeklyPercent: 31, weeklyResetsAt: now + 4 * 86400_000, sessionPercent: 12, sessionResetsAt: now + 3 * 3600_000, at: now - 50 * 60_000 },
  moments: [
    { at: iso(50), text: 'sahip başlattı' }, { at: iso(49), text: 'ekipler masalarında' }, { at: iso(49), text: 'tur 1 başladı' },
    { at: iso(20), text: 'yakınlık: 3 çift ölçüldü' }, { at: iso(19), text: 'tur 2 başladı' }, { at: iso(4), text: 'Hikâyeci: tez kartı düşürüldü (tez kartında tam 3 iddia olmalı)' },
  ],
});
json(join(runDir(R2), 'run.json'), run2);
const tu = (id, name, input, parent) => ({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [{ type: 'tool_use', id, name, input }] } });
const tr = (id, text) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const repo2 = (team) => join(wsHome, R2, team, 'repo');
lines(join(runDir(R2), 'teams', 'sade', 'r2.jsonl'), [
  { type: 'system', subtype: 'init' },
  tu('t1', 'Read', { file_path: join(repo2('sade'), 'src/checkout/Payment.tsx') }), tr('t1', 'export function Payment() {'),
  tu('t2', 'Agent', { subagent_type: 'yapici', description: 'Ödeme adımını tek ekrana indir' }),
  tu('t3', 'Edit', { file_path: join(repo2('sade'), 'src/checkout/Payment.tsx'), old_string: '<Steps count={3} />', new_string: '<OneStep />\n<PriceSummary compact />' }, 't2'),
]);
lines(join(runDir(R2), 'teams', 'kanitci', 'r2.jsonl'), [
  { type: 'item.completed', item: { type: 'command_execution', command: 'npm test -- checkout', aggregated_output: 'Tests: 14 passed, 14 total' } },
]);
lines(join(runDir(R2), 'teams', 'hikaye', 'r2.jsonl'), [
  { type: 'system', subtype: 'init' },
  tu('h1', 'Agent', { subagent_type: 'elestirmen', description: 'Hikâye uzun mu?' }),
  tu('h2', 'Write', { file_path: join(repo2('hikaye'), 'src/checkout/Story.tsx'), content: 'export const Story = () => (\n  <section>Sabah 08.00: Ayşe öğretmen ilk dersini açar.</section>\n);' }, 'h1'),
]);
lines(join(runDir(R2), 'teams', 'kontrol', 'r2.jsonl'), [
  { type: 'system', subtype: 'init' },
  tu('k1', 'Bash', { command: 'git diff --stat' }), tr('k1', ' src/checkout/Button.tsx | 4 ++--'),
]);
for (const t of TEAMS) {
  mkdirSync(repo2(t.id), { recursive: true });
  json(join(out(R2, t.id), 'thesis-r1.json'), thesis[t.id]);
}
mkdirSync(join(repo2('sade'), 'src', 'checkout'), { recursive: true });
writeFileSync(join(repo2('sade'), 'src', 'checkout', 'Payment.tsx'), 'export function Payment() {\n  return (\n    <main>\n      <OneStep />\n      <PriceSummary compact />\n    </main>\n  );\n}\n');
lines(join(out(R2, 'sade'), 'decisions.jsonl'), [
  { at: iso(45), role: 'kaptan', kind: 'plan', text: 'Ödeme üç adımdan bire iner; fiyat özeti hep görünür.' },
  { at: iso(40), role: 'elestirmen', kind: 'objection', text: 'Tek adım mobilde çok uzun olur; kart alanı katlanmalı.' },
  { at: iso(35), role: 'kaptan', kind: 'decision', text: 'Kart alanı katlanır; adres yalnız fiziksel üründe sorulur.' },
  { at: iso(12), role: 'yapici', kind: 'decision', text: 'Kanıtçı ekibin güven rozeti fikri ödünç alındı.', borrowed: true },
]);
json(join(runDir(R2), 'rounds', 'r1.json'), {
  round: 1, at: iso(20), cards: thesis, seen: { sade: [], kanitci: [], hikaye: [], kontrol: [] },
  questions: [{ from: 'sade', to: 'kanitci', text: 'Güven rozetini hangi sayıyla destekliyorsunuz?' }],
  pairs: [{ a: 'sade', b: 'kanitci', score: 0.42 }, { a: 'sade', b: 'hikaye', score: 0.18 }, { a: 'kanitci', b: 'hikaye', score: 0.83 }], gate: 0.8,
});

const SONNET = { tool: 'claude', model: 'sonnet' };
// 3. Judging (screen): presentations with screenshots and the jury.
const R3 = '20261116-fiyat-sayfasi';
const d3 = { ...design('screen', 'Fiyat sayfası: hangi plan daha çok seçilir?', 2), baseSha: 'b'.repeat(40) };
json(join(runDir(R3), 'run.json'), run(R3, 'judging', d3, { phase: 'jury', round: 2, startedAt: iso(300), moments: [{ at: iso(10), text: 'jüri bitti' }] }));
json(join(runDir(R3), 'jury.json'), {
  verdicts: [
    { a: 'sade', b: 'kanitci', order: 'ab', winner: 'sade', why: 'Tek plan önerisi kararı kolaylaştırıyor.', judge: SONNET, scores: { sade: { solves: 9, evidence: 7, feasible: 9, original: 7 }, kanitci: { solves: 8, evidence: 9, feasible: 7, original: 6 } } },
    { a: 'sade', b: 'kanitci', order: 'ba', winner: 'sade', why: 'Daha az seçenek, daha net fiyat.', judge: SONNET, scores: { sade: { solves: 8, evidence: 7, feasible: 9, original: 8 }, kanitci: { solves: 8, evidence: 8, feasible: 7, original: 7 } } },
    { a: 'hikaye', b: 'kontrol', order: 'ab', winner: 'hikaye', why: 'Hikâye fiyatı bir güne bağlıyor; kontrol yalnız tabloyu düzeltmiş.', judge: SONNET, scores: { hikaye: { solves: 7, evidence: 5, feasible: 7, original: 9 }, kontrol: { solves: 6, evidence: 6, feasible: 8, original: 4 } } },
  ],
  scores: { sade: 8.4, kanitci: 7.6, hikaye: 6.9, kontrol: 6.1 }, originality: { sade: 7.5, kanitci: 6.8, hikaye: 8.9, kontrol: 4.2 },
  ranking: ['sade', 'kanitci', 'hikaye', 'kontrol'], sameVendor: true, judges: [SONNET],
});

// 4. Picked (plan): the owner chose; result.json written.
const R4 = '20261115-gelir-plani';
const d4 = { ...design('plan', 'Yıllık plana geçişi artıracak üç aylık plan', 2), baseSha: 'c'.repeat(40) };
json(join(runDir(R4), 'run.json'), run(R4, 'picked', d4, { phase: 'jury', round: 2, startedAt: iso(2000), moments: [{ at: iso(1500), text: 'sahip seçti: Kanıtçı' }] }));
json(join(runDir(R4), 'jury.json'), { verdicts: [], scores: { sade: 7.1, kanitci: 8.2, hikaye: 7.4, kontrol: 6.6 }, originality: { sade: 6, kanitci: 7, hikaye: 8, kontrol: 4 }, ranking: ['kanitci', 'hikaye', 'sade', 'kontrol'], sameVendor: false, judges: [] });
json(join(runDir(R4), 'result.json'), { version: 1, run: R4, kind: 'plan', designHash: 'x', design: d4, teams: [], pick: 'kanitci', juryRanking: ['kanitci', 'hikaye', 'sade', 'kontrol'], juryOwnerAgree: true, controlDelta: 1.0, sameVendorJury: false, pr: 'none', writtenAt: iso(1500) });

// Presentations for R3 and R4, with real PNG screenshots for R3 drawn by a throwaway browser.
const shotBrowser = await chromium.launch();
const teamPage = (title, sub, accent) => `<html><body style="margin:0;font-family:-apple-system,Helvetica,sans-serif;background:#faf9fc">
<header style="padding:28px 48px;display:flex;justify-content:space-between;align-items:center"><b style="font-size:20px">Ornek Kurs</b><span style="color:#666">Giriş</span></header>
<main style="padding:60px 48px;text-align:center"><h1 style="font-size:44px;margin:0 0 16px">${title}</h1><p style="color:#555;font-size:18px;margin:0 0 32px">${sub}</p>
<a style="display:inline-block;background:${accent};color:#fff;padding:16px 32px;border-radius:10px;font-weight:600">Ücretsiz başla</a></main></body></html>`;
const PAGES = {
  sade: ['Tek plan. Tek fiyat.', 'Ayda 249 TL, istediğin zaman bırak.', '#6d4aff'],
  kanitci: ['12.400 öğretmen bu planı seçti', 'Karşılaştırma tablosu ve gerçek yorumlar.', '#1f7a5a'],
  hikaye: ['Ayşe öğretmenin pazartesisi', 'Sabah dersi, öğle ödevi, akşam veli mesajı.', '#c2410c'],
  kontrol: ['Planlar', 'Temel, Pro ve Kurum.', '#334155'],
};
for (const [team, [title, sub, accent]] of Object.entries(PAGES)) {
  const shots = join(wsHome, R3, '.conductor', 'shots', team);
  mkdirSync(shots, { recursive: true });
  for (const width of [390, 1440]) {
    const p = await shotBrowser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
    await p.setContent(teamPage(title, sub, accent));
    await p.screenshot({ path: join(shots, `screen-${width}.png`) });
    await p.close();
  }
}
await shotBrowser.close();
for (const id of [R3, R4]) {
  for (const t of TEAMS) {
    mkdirSync(join(wsHome, id, t.id, 'repo'), { recursive: true });
    json(join(out(id, t.id), 'thesis-r2.json'), thesis[t.id]);
    json(join(out(id, t.id), 'presentation', 'manifest.json'), {
      cards: id === R3 ? [{ kind: 'thesis', title: 'Tez' }, { kind: 'screen', title: 'Yeni fiyat sayfası' }] : [{ kind: 'thesis', title: 'Plan' }],
      borrowed: t.id === 'sade' ? [{ from: 'right', round: 1, idea: 'güven rozeti' }] : [],
    });
    lines(join(out(id, t.id), 'decisions.jsonl'), [{ at: iso(200), role: 'kaptan', kind: 'decision', text: 'Son sürüm bu.' }]);
  }
}

// ─── Look ───────────────────────────────────────────────────────────────────

const installed = await api('POST', '/plugins/hackathon/install', {});
check(installed.status < 300, `hackathon install answered ${installed.status}: ${JSON.stringify(installed.body)}`);

const go = async (page) => {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  const row = page.locator('[data-testid="ns-rail-hackathon"]');
  if (await row.isVisible().catch(() => false)) await row.click();
  else {
    await page.locator('[data-testid="ns-rail-more"]').click();
    await page.locator('[data-testid="ns-more-hackathon"]').click();
  }
  await page.waitForTimeout(600);
  check(await visible(page, '.hk-page'), 'the Hackathon page did not open from the rail');
};
/** Frames are live for 90 s after a transcript's last write: keep the seeded ones fresh. */
const touch = () => { const t = new Date(); for (const tm of TEAMS) { try { utimesSync(join(runDir(R2), 'teams', tm.id, 'r2.jsonl'), t, t); } catch {} } };
const dark = () => "localStorage.setItem('dreamcontext-theme','dark')";
const openRun = async (page, problem) => {
  touch();
  await go(page);
  await page.locator('.hk-run', { hasText: problem }).first().click();
  await page.waitForTimeout(800);
};

try {
  await app.look(`/?vault=${V}`, async (page, w) => {
    await go(page);
    for (const p of ['Ana sayfanın', 'Gelir artıracak', 'Fiyat sayfası', 'Yıllık plana']) check(await visible(page, `.hk-run:has-text("${p}")`, 4_000), `list@${w.name}: no row for ${p}`);
  }, { name: '01-list' });

  await app.look(`/?vault=${V}`, async (page, w) => {
    await openRun(page, 'Ana sayfanın');
    check(await visible(page, '.hk-card--start button.hk-btn--primary'), `start@${w.name}: no Başlat on the start card`);
  }, { name: '02-start-card' });

  // The design changes on disk while the card is open: Başlat waits for his confirm of the new one.
  await app.look(`/?vault=${V}`, async (page, w) => {
    const file = join(runDir(R1), 'run.json');
    const before = JSON.parse(readFileSync(file, 'utf-8'));
    await openRun(page, 'Ana sayfanın');
    await visible(page, '.hk-card--start button.hk-btn--primary');
    json(file, { ...before, design: { ...before.design, rounds: before.design.rounds + 1 } });
    check(await visible(page, '.hk-start__reread', 12_000), `start@${w.name}: a changed design redrew with Başlat still live`);
    json(file, before);
  }, { name: '11-design-changed' });

  await app.look(`/?vault=${V}`, async (page, w) => {
    await openRun(page, 'Gelir artıracak');
    check(await visible(page, '.hk-live'), `live@${w.name}: no live grid`);
    check((await page.locator('.hk-desk').count()) >= 4, `live@${w.name}: fewer than four tables`);
    // Seeded with no conductor holding its lock: the page offers Sürdür.
    check(await visible(page, '.hk-banner button'), `live@${w.name}: a run with no live conductor offers no Sürdür`);
  }, { name: '03-live' });

  await app.look(`/?vault=${V}`, async (page, w) => {
    await openRun(page, 'Gelir artıracak');
    await page.locator('.hk-top button', { hasText: /^(Durdur|Stop)$/ }).first().click();
    check(await visible(page, '.hk-confirm'), `stop@${w.name}: Durdur stopped without asking`);
  }, { name: '10-stop-confirm' });

  await app.look(`/?vault=${V}`, async (page, w) => {
    await openRun(page, 'Gelir artıracak');
    const table = page.locator('.hk-desk', { hasText: 'Sade' }).first();
    try { await table.click({ timeout: 5_000 }); } catch (e) { app.findings.push(`room@${w.name}: tap ${String(e.message).slice(0, 900)}`); }
    await page.waitForTimeout(800);
    check(await visible(page, 'text=Kart alanı katlanır'), `room@${w.name}: Sade's decisions not shown`);
  }, { name: '04-team-room' });

  // The Mac shell at phone width: the desk must still open with a tap.
  await app.look(`/?vault=${V}`, async (page, w) => {
    await openRun(page, 'Gelir artıracak');
    const table = page.locator('.hk-desk', { hasText: 'Sade' }).first();
    try { await table.click({ timeout: 5_000 }); } catch (e) { app.findings.push(`room-shell@${w.name}: tap ${String(e.message).slice(0, 1500)}`); }
    await page.waitForTimeout(800);
  }, { name: '04b-team-room-shell', init: () => ownerShellScript('k') });

  await app.look(`/?vault=${V}`, async (page, w) => {
    await openRun(page, 'Gelir artıracak');
    const step = page.locator('.hk-step__btn').first();
    if (await step.isVisible().catch(() => false)) { await step.click(); await page.waitForTimeout(600); }
    else app.findings.push(`peek@${w.name}: no peek step button on the timeline`);
  }, { name: '05-peek' });

  // The paused strip: the 5-hour guard holds new turns.
  json(join(runDir(R2), 'run.json'), { ...run2, paused: "5 saatlik pencere %84: ekipler bu turdan sonra bekliyor (Devam ile sürer)" });
  await app.look(`/?vault=${V}`, async (page, w) => {
    await openRun(page, 'Gelir artıracak');
    check(await visible(page, '.hk-banner'), `paused@${w.name}: no paused strip`);
  }, { name: '06-paused' });
  json(join(runDir(R2), 'run.json'), run2);

  await app.look(`/?vault=${V}`, async (page, w) => {
    await openRun(page, 'Fiyat sayfası');
    check((await page.locator('.hk-cols .hk-col').count()) >= 2, `results@${w.name}: the teams are not side by side`);
    check(await visible(page, '.hk-crit'), `results@${w.name}: no criteria bars`);
    check((await page.locator('.hk-btn--primary').count()) <= 1, `results@${w.name}: more than one filled button`);
    check((await page.locator('.hk-top button', { hasText: /^(Durdur|Stop)$/ }).count()) === 0, `results@${w.name}: Durdur sits beside the pick while judging`);
  }, { name: '07-results-judging' });

  await app.look(`/?vault=${V}`, async (page, w) => {
    await openRun(page, 'Fiyat sayfası');
    await page.locator('.hk-col', { hasText: 'Sade' }).first().locator('.hk-col__foot button', { hasText: /^(Sunumu aç|Open presentation)$/ }).click({ timeout: 5_000 }).catch(() => app.findings.push(`present@${w.name}: could not open Sade's presentation`));
    await page.waitForTimeout(800);
    check(await visible(page, '.hk-page img'), `present@${w.name}: no screenshot on the stage`);
  }, { name: '08-presentation' });

  await app.look(`/?vault=${V}`, async (page) => {
    await openRun(page, 'Yıllık plana');
  }, { name: '09-picked' });

  for (const [name, problem, act] of [
    ['02-start-card', 'Ana sayfanın', null],
    ['03-live', 'Gelir artıracak', null],
    ['04-team-room', 'Gelir artıracak', async (page) => { await page.locator('.hk-desk', { hasText: 'Sade' }).first().click({ timeout: 5_000 }); }],
    ['07-results-judging', 'Fiyat sayfası', null],
    ['08-presentation', 'Fiyat sayfası', async (page) => { await page.locator('.hk-col', { hasText: 'Sade' }).first().locator('.hk-col__foot button', { hasText: /^(Sunumu aç|Open presentation)$/ }).click({ timeout: 5_000 }); }],
    ['09-picked', 'Yıllık plana', null],
  ]) {
    await app.look(`/?vault=${V}`, async (page, w) => {
      await openRun(page, problem);
      if (act) await act(page).catch((e) => app.findings.push(`${name}-dark@${w.name}: ${String(e.message).slice(0, 300)}`));
      await page.waitForTimeout(600);
      check(await page.evaluate(() => document.documentElement.dataset.theme === 'dark' || document.documentElement.classList.contains('dark')), `${name}-dark@${w.name}: not dark`);
    }, { name: `${name}-dark`, init: dark });
  }

  // Empty page last: remove the runs.
  const { rmSync } = await import('node:fs');
  rmSync(join(ctx, 'hackathon'), { recursive: true, force: true });
  await app.look(`/?vault=${V}`, async (page, w) => {
    await go(page);
    check(await visible(page, '.hk-empty'), `empty@${w.name}: no empty state`);
  }, { name: '10-empty' });
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}

if (values.out) {
  mkdirSync(values.out, { recursive: true });
  for (const f of app.taken) copyFileSync(f, join(values.out, f.split('/').pop()));
}
process.exit(await app.finish());
