#!/usr/bin/env node
/**
 * Super v3 "denge" frames, shot from the app beside the approved mockups (task super-sunum-ekranlari,
 * plan super-v3 criterion 16):
 *
 *   dreamcontext builder heavy -- node scripts/verify/super-v3.mjs --mock <brain>/_dream_context/tmp/super [--only 05-sekiz-oturum,B-onbes]
 *
 * Scratch HOME and project (lib/app.mjs, no build), a fictional project with live jobs seeded in
 * the Super record (no tokens). For each frame: `<frame>-<w>-<theme>-build.png` and a montage
 * `<frame>-<w>-<theme>-montage.png` (mockup left, build right), plus measured Dock tiles. Exit 1 on
 * a console error or a failed check.
 */
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const { values } = parseArgs({ options: { mock: { type: 'string' }, only: { type: 'string' }, out: { type: 'string' } } });
const MOCK = values.mock ? resolve(values.mock) : null;

const JOBS = ['Ödeme ekranı: tek adım', 'Hatırlatma bildirimleri', 'Giriş hatasını bul', "Rapor PDF'i", 'Onboarding metni', 'Test kapsamını artır',
  'Bağımlılık güncelle', 'Karanlık mod renkleri', 'Arama hızlandır', 'E-posta şablonu', 'Fatura dışa aktarma', 'Erişilebilirlik taraması', 'Sürüm notları'];
const NEEDS = ['Fiyat: yıllık plan onayı', 'Mağaza ekran görüntüleri'];

/** Frame → what the record holds, which mockup shot it sits beside, and at which sizes. */
const FRAMES = {
  '03-bes-mesaj': { needs: 1, jobs: 4, minis: 0, mock: 'super-jakob-v3/v3/03-bes-mesaj.png', sizes: [[1440, 900]] },
  '05-sekiz-oturum': { needs: 1, jobs: 7, minis: 0, mock: 'super-jakob-v3/v3/05-sekiz-oturum.png', sizes: [[1440, 900], [1180, 800]] },
  '09b-kucult-3': { needs: 1, jobs: 7, minis: 1, mock: 'super-jakob-v3/v3/09b-kucult-3.png', sizes: [[1440, 900]] },
  'B-onbes': { needs: 2, jobs: 13, minis: 0, mock: 'super-ux-denetim/kareler/B-onbes.png', sizes: [[1440, 900], [1180, 800]], light: true },
  // W1 Lane B: the head's List view (v2 list), the members' cards (T1, T5), the red light's sheet (09a).
  '05-liste': { needs: 1, jobs: 7, minis: 0, list: true, mock: 'super-jakob-v2/yeni/05-sekiz-oturum.png', sizes: [[1440, 900]] },
  'T1-sonra': { needs: 1, jobs: 2, minis: 0, members: ['sage', 'mira'], mock: 'super-ux-denetim/kareler/T1-sonra.png', sizes: [[1440, 900]], light: true },
  'T5-sonra': { needs: 1, jobs: 2, minis: 0, members: ['sage'], approval: 'sage', mock: 'super-ux-denetim/kareler/T5-sonra.png', sizes: [[1440, 900]] },
  '09a-kapat-2': { needs: 0, jobs: 4, minis: 0, redLight: true, mock: 'super-jakob-v3/v3/09a-kapat-2.png', sizes: [[1440, 900]] },
};
/** The fictional AI Team the member frames seed through the real CLI (`agents create`). */
const MEMBERS = {
  sage: { title: 'Sage', prompt: 'Strategy: prices, plans and positioning for the product.', brief: 'Fiyat sayfası: compare 3 competitor prices and suggest a yearly price' },
  mira: { title: 'Mira', prompt: 'Research: reads reviews and the market and reports back.', brief: 'Mağaza açıklaması: read 12 store reviews and draft the copy', global: true },
};
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const made = new Set();
function makeMember(slug) {
  if (made.has(slug)) return;
  const m = MEMBERS[slug];
  const args = ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), 'agents', 'create', slug, '--title', m.title, '--prompt', m.prompt, ...(m.global ? ['--scope', 'global'] : [])];
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME: app.home, npm_config_cache: join(process.env.HOME ?? app.home, '.npm') };
  const r = spawnSync('npx', args, { cwd: app.proj, env, encoding: 'utf-8' });
  if (r.status !== 0) fail(`agents create ${slug}: ${(r.stderr || r.stdout).slice(0, 200)}`); else made.add(slug);
}
const only = values.only ? new Set(values.only.split(',')) : null;

const app = await openApp({ suite: 'super-v3', target: '/?vault=proj' });
const OUT = resolve(values.out ?? join(app.shots, 'frames'));
mkdirSync(OUT, { recursive: true });
const fail = (m) => { app.findings.push(m); console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

writeFileSync(join(app.home, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
writeFileSync(join(app.home, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: false, drawerExpanded: ['proj'], projectOrder: ['proj'], lastVault: 'proj' }));

function seed(f) {
  const now = Date.now();
  const titles = [...NEEDS.slice(0, f.needs), ...JOBS.slice(0, f.jobs)];
  const kids = titles.map((title) => ({ id: randomUUID(), title }));
  const children = Object.fromEntries(kids.map((k, i) => [k.id, { sessionId: k.id, brief: k.title, adopted: false, startedAt: now - 60_000 * (i + 1), row: i < f.needs ? 'asking' : 'working', rowAt: now }]));
  const containers = [
    { id: 'ag', kind: 'agenda', ref: 'agenda', shape: 'square', place: 'float', by: 'super', size: 'large' },
    ...kids.map((k, i) => ({ id: `c${i}`, kind: 'chat', ref: k.id, shape: 'portrait', place: 'float', by: 'super', title: k.title })),
    ...Array.from({ length: f.minis }, (_, i) => ({ id: `m${i}`, kind: 'web', ref: 'docs/panel.html', shape: 'square', place: 'others', by: 'super', title: 'Panel · aylık özet' })),
  ];
  const queue = kids.slice(0, f.needs).map((k, i) => ({ id: `q${i}`, sessionId: k.id, kind: 'question', state: 'escalated', createdAt: now - 1000 * (i + 1), ownerText: 'Yıllık plan fiyatı ne olsun? 990 ₺, 1.190 ₺ ya da 790 ₺' }));
  const superSession = randomUUID();
  const team = (f.members ?? []).map((slug, i) => {
    makeMember(slug);
    return { id: `team-${slug}`, member: slug, runId: new Date(now - 60_000 * (3 + 3 * i)).toISOString(), jobKind: 'run', queued: false, brief: MEMBERS[slug].brief, startedAt: now - 60_000 * (3 + 3 * i), open: true };
  });
  for (const [i, j] of team.entries()) containers.push({ id: `t${i}`, kind: 'team', ref: j.id, shape: 'square', place: 'float', by: 'super', title: MEMBERS[j.member].title });
  if (f.approval) queue.push({ id: 'qa', sessionId: superSession, kind: 'approval', member: f.approval, state: 'escalated', createdAt: now - 500 });
  // The member must really wait on him: `agents create` approves it, and the server settles an
  // approval question about an approved member (super.ts settleApprovals). Drop its grant.
  if (f.approval) {
    const reg = join(app.home, '.dreamcontext', 'automations.json');
    try {
      const r = JSON.parse(readFileSync(reg, 'utf-8'));
      for (const p of Object.values(r.projects ?? {})) { if (p.agentApprovals) delete p.agentApprovals[f.approval]; if (p.approvals) delete p.approvals[f.approval]; }
      writeFileSync(reg, JSON.stringify(r, null, 2));
    } catch (e) { fail(`unapprove ${f.approval}: ${e.message}`); }
  }
  const sessions = kids.map((k, i) => ({ title: k.title, kind: 'chat', sessionId: k.id, pane: i, active: i === 0, window: 'main', size: 1 }));
  const state = join(app.proj, '_dream_context', 'state');
  mkdirSync(join(app.proj, 'docs'), { recursive: true });
  writeFileSync(join(app.proj, 'docs', 'panel.html'), '<!doctype html><h1 style="font-family:system-ui">Panel · aylık özet</h1>');
  writeFileSync(join(state, '.agent-sessions.json'), JSON.stringify({ sessions, activePane: 0, chatPermissionMode: 'auto', windows: [{ id: 'main', name: 'Chat', activePane: 0 }], generation: Date.now() }));
  writeFileSync(join(state, '.super-agent.json'), JSON.stringify({
    v: 1, session: superSession, enabled: true, containers, groups: [], view: { mode: 'float' }, children, queue,
    notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team,
  }));
}

const browser = await chromium.launch();
async function shoot(name, f, [w, h], dark) {
  const theme = dark ? 'dark' : 'light';
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
  await ctx.addInitScript((d) => { try { localStorage.setItem('dreamcontext-theme', d ? 'dark' : 'light'); } catch { /* */ } }, dark);
  await markAnnouncementsSeen(ctx, app.base);
  const p = await ctx.newPage();
  const where = `${name}@${w}-${theme}`;
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource|\/ws\b/.test(m.text())) fail(`${where} console: ${m.text().slice(0, 200)}`); });
  p.on('pageerror', (e) => fail(`${where} crash: ${String(e).slice(0, 200)}`));
  await p.route('**/api/onboarding/readiness**', async (r) => { try { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); } catch { /* closed */ } });
  await p.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('[data-testid="super-centre"]', { timeout: 60_000 }).catch(() => fail(`${where}: the Super stage never drew`));
  await p.waitForTimeout(2500);
  if (f.list) {
    await p.locator('[data-testid="super-view-list"]').click({ timeout: 10_000 }).catch(() => fail(`${where}: no List switch`));
    await p.waitForTimeout(1200);
  }
  if (f.redLight) {
    const card = p.locator('[data-testid="super-container"][data-where="float"][data-kind="chat"]').first();
    await card.hover().catch(() => {});
    await p.waitForTimeout(300);
    await card.locator('[data-testid="super-card-close"], [data-light="close"]').first().click({ timeout: 5000 }).catch(() => fail(`${where}: no red light on a working card`));
    await p.waitForTimeout(500);
  }
  if (!f.redLight) await p.mouse.move(2, h - 2);
  await p.evaluate(() => document.getAnimations().forEach((a) => { try { a.pause(); a.currentTime = 1300; } catch { /* */ } }));
  const file = join(OUT, `${name}-${w}-${theme}-build.png`);
  await p.screenshot({ path: file });
  const dock = await p.evaluate(() => {
    const d = document.querySelector('[data-testid="super-dock"]');
    if (!d) return null;
    const box = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }; };
    return { rect: box(d), tiles: [...d.querySelectorAll('.sdock-tile')].map((t) => ({ kind: t.dataset.kind, ...box(t) })) };
  });
  const floats = await p.locator('[data-testid="super-container"][data-where="float"]').count();
  await ctx.close();
  // The montage: the mockup frame left, the build right, at the same height.
  let montage = null;
  const mockFile = MOCK ? join(MOCK, f.mock) : null;
  if (mockFile && existsSync(mockFile)) {
    montage = join(OUT, `${name}-${w}-${theme}-montage.png`);
    const mctx = await browser.newContext({ viewport: { width: 2 * 1440 + 24, height: 960 } });
    const mp = await mctx.newPage();
    const b64 = (x) => `data:image/png;base64,${readFileSync(x).toString('base64')}`;
    await mp.setContent(`<body style="margin:0;background:#111;display:flex;gap:24px;align-items:flex-start;font:14px system-ui;color:#ccc">
      <figure style="margin:0;width:1440px"><figcaption style="padding:6px">mockup · ${f.mock}</figcaption><img style="width:1440px" src="${b64(mockFile)}"></figure>
      <figure style="margin:0;width:1440px"><figcaption style="padding:6px">build · ${w}x${h} ${theme}</figcaption><img style="width:${Math.min(1440, w)}px" src="${b64(file)}"></figure></body>`);
    await mp.waitForTimeout(200);
    await mp.screenshot({ path: montage, fullPage: true });
    await mctx.close();
  }
  return { file, montage, dock, floats };
}

const results = {};
try {
  for (const [name, f] of Object.entries(FRAMES)) {
    if (only && !only.has(name)) continue;
    console.log(`\n── ${name}`);
    seed(f);
    for (const size of f.sizes) {
      for (const dark of f.light ? [true, false] : [true]) {
        const r = await shoot(name, f, size, dark);
        results[`${name}@${size[0]}-${dark ? 'dark' : 'light'}`] = r;
        console.log(`  shot ${r.file}${r.montage ? `\n  montage ${r.montage}` : ''}`);
        const total = f.needs + f.jobs;
        if (f.list || f.members || f.redLight) { ok(`${name}: shot`); continue; }
        if (name === '03-bes-mesaj') {
          if (r.dock && r.dock.tiles.some((t) => t.kind === 'job')) fail(`${name}: 5 jobs fit, yet jobs docked`); else ok(`${name}: 5 jobs float (${r.floats} floating cards)`);
          continue;
        }
        if (!r.dock) { fail(`${name}@${size[0]}: no Dock drawn`); continue; }
        const needs = r.dock.tiles.filter((t) => t.kind === 'needs').length;
        const jobs = r.dock.tiles.filter((t) => t.kind === 'job').length;
        if (needs + jobs !== total) fail(`${name}@${size[0]}: ${needs + jobs} job tiles for ${total} jobs`); else ok(`${name}@${size[0]}: every job has a tile (${needs} needs you, ${jobs} running)`);
        if (r.dock.tiles[0]?.kind !== 'needs' && r.dock.tiles[0]?.kind !== 'today') fail(`${name}: needs-you is not first`);
        const rows = new Set(r.dock.tiles.map((t) => t.y + t.height));
        if (rows.size !== 1) fail(`${name}@${size[0]}: the Dock wrapped`); else ok(`${name}@${size[0]}: one row`);
        const right = r.dock.rect.x + r.dock.rect.width;
        if (r.dock.tiles.filter((t) => t.kind === 'needs').some((t) => t.x + t.width > right + 1)) fail(`${name}@${size[0]}: a needs-you tile is hidden at rest`);
        if (f.minis && !r.dock.tiles.some((t) => t.kind === 'mini')) fail(`${name}: the minimized card has no tile`);
        console.log(`    tiles ${r.dock.tiles.map((t) => `${t.kind}:${t.width}x${t.height}`).join(' ')}`);
      }
    }
  }
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(results, null, 1)}\n`);
await browser.close();
process.exit(await app.finish());
