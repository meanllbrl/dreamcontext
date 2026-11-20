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
import { deflateSync } from 'node:zlib';
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
  // W2: the Super chat frames (D7-D10, K7, Ü3). `chat` = the Super's own transcript, seeded as the
  // CLI writes it; `cards: false` = no card on stage (the chat alone, as frame E).
  'E-bos': { needs: 1, jobs: 4, done: 3, minis: 0, cards: false, perms: 1, away: true, mock: 'super-ux-denetim/kareler/E-bos.png', sizes: [[1440, 900], [1180, 800]], light: true },
  'I-durum': { needs: 2, jobs: 3, done: 2, minis: 0, chat: 'jobs', mock: 'super-ux-denetim/kareler/I-durum.png', sizes: [[1440, 900]], light: true },
  // C: the asking job's card stays off stage: a mounted child with no live claude holds no pending
  // question, and its card then draws nothing (SuperQuestionCard); off stage the record's text draws.
  'C-soru': { needs: 1, jobs: 3, minis: 0, chat: 'ask', cards: 'noAsking', mock: 'super-ux-denetim/kareler/C-soru.png', sizes: [[1440, 900]], light: true },
  'H-ajanda': { needs: 1, jobs: 3, minis: 0, chat: 'ask', pad: true, agendaTap: true, mock: 'super-ux-denetim/kareler/H-ajanda.png', sizes: [[1440, 900]], light: true },
  'A-izin': { needs: 1, jobs: 3, minis: 0, perms: 1, allows: true, chat: 'allow', mock: 'super-ux-denetim/kareler/A-izin.png', sizes: [[1440, 900], [1180, 800]], light: true },
  // W3: the presentation window (K14, D14): a phone shot in front, a PDF waiting as a background tab.
  '08-kuyruk': { needs: 1, jobs: 4, minis: 0, present: true, mock: 'super-jakob-v3/v3/08-kuyruk-2.png', sizes: [[1440, 900], [1180, 800]], light: true },
  // W3 Lane A/B: the window as wide as what it shows (07a phone, 07b PDF, 07c desktop page), a group
  // as one tab (09d), a question about the shown report asked under it (K8), a member's tab (T2).
  '07a-sunum-dar': { needs: 1, jobs: 4, minis: 0, present: 'phone', mock: 'super-jakob-v3/v3/07a-sunum-dar.png', sizes: [[1440, 900], [1180, 800]] },
  '07b-sunum-orta': { needs: 1, jobs: 4, minis: 0, present: 'pdf', mock: 'super-jakob-v3/v3/07b-sunum-orta.png', sizes: [[1440, 900], [1180, 800]] },
  '07c-sunum-genis': { needs: 1, jobs: 4, minis: 0, present: 'desk', mock: 'super-jakob-v3/v3/07c-sunum-genis.png', sizes: [[1440, 900], [1180, 800]] },
  '09d-grup': { needs: 1, jobs: 4, minis: 0, present: 'group', mock: 'super-jakob-v3/v3/09d-grup-kapat-1.png', sizes: [[1440, 900]] },
  'K8-rapor-soru': { needs: 0, jobs: 3, minis: 0, present: 'ask', mock: null, sizes: [[1440, 900], [1180, 800]], light: true },
  'T2-sonra': { needs: 1, jobs: 6, minis: 0, members: ['sage'], present: 'member', mock: 'super-ux-denetim/kareler/T2-sonra.png', sizes: [[1440, 900]], light: true },
  'T3-sonra': { needs: 0, jobs: 2, minis: 0, members: ['sage'], memberDone: 'sage', chat: 'member', mock: 'super-ux-denetim/kareler/T3-sonra.png', sizes: [[1440, 900]], light: true },
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
  const done = f.done ?? 0;
  const titles = [...NEEDS.slice(0, f.needs), ...JOBS.slice(0, f.jobs + done)];
  const kids = titles.map((title) => ({ id: randomUUID(), title }));
  const rowOf = (i) => (i < f.needs ? 'asking' : i >= f.needs + f.jobs ? 'done' : 'working');
  const children = Object.fromEntries(kids.map((k, i) => [k.id, { sessionId: k.id, brief: k.title, adopted: false, startedAt: now - 60_000 * (i + 1), row: rowOf(i), rowAt: now - (rowOf(i) === 'done' ? 60_000 * (20 + i) : 60_000 * (i + 1)), ...(rowOf(i) === 'done' ? { finishedAt: now - 60_000 * (20 + i) } : {}) }]));
  // The Super's own allows on the first running job (D8's folded line).
  if (f.allows) children[kids[f.needs].id].allows = [{ at: now - 90_000, summary: 'npm run lint' }, { at: now - 60_000, summary: 'git status' }];
  const containers = [
    { id: 'ag', kind: 'agenda', ref: 'agenda', shape: 'square', place: 'float', by: 'super', size: 'large' },
    ...kids.filter((_, i) => f.cards !== false && rowOf(i) !== 'done' && !(f.cards === 'noAsking' && rowOf(i) === 'asking')).map((k, i) => ({ id: `c${i}`, kind: 'chat', ref: k.id, shape: 'portrait', place: 'float', by: 'super', title: k.title })),
    ...Array.from({ length: f.minis }, (_, i) => ({ id: `m${i}`, kind: 'web', ref: 'docs/panel.html', shape: 'square', place: 'others', by: 'super', title: 'Panel · aylık özet' })),
  ];
  const queue = kids.slice(0, f.needs).map((k, i) => ({ id: `q${i}`, sessionId: k.id, kind: 'question', state: 'escalated', createdAt: now - 1000 * (i + 1), ownerText: 'Yıllık plan fiyatı ne olsun? 990 ₺, 1.190 ₺ ya da 790 ₺' }));
  const superSession = randomUUID();
  // A permission a running job waits on (the band's line, the card's waiting line).
  for (let i = 0; i < (f.perms ?? 0); i++) {
    const k = kids[f.needs + i];
    if (k) { children[k.id].row = 'asking'; queue.push({ id: `p${i}`, sessionId: k.id, kind: 'permission', state: 'escalated', createdAt: now - 2000, requestId: `req-${i}`, toolName: 'Bash', text: 'npm test -- checkout' }); }
  }
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
  if (f.memberDone) {
    const j = team.find((x) => x.member === f.memberDone);
    if (j) { j.open = undefined; j.outcome = 'done'; j.endedAt = undefined; }
  }
  const pad = f.pad ? kids.map((k, i) => ({ id: `n${i + 1}`, section: rowOf(i) === 'done' ? 'done' : rowOf(i) === 'asking' ? 'waiting' : 'now', text: k.title, at: now - 60_000 * (i + 1), for: k.id })) : undefined;
  const away = f.away ? { since: now - 150 * 60_000, events: 4, until: now - 5 * 60_000, viaTelegram: 2 } : { since: null, events: 0 };
  if (f.chat) writeTranscript(superSession, f, kids, team, now);
  let view = { mode: 'float' };
  let presentQueue;
  let groups = [];
  if (f.present && f.present !== true) {
    mkdirSync(join(app.proj, 'docs'), { recursive: true });
    writeFileSync(join(app.proj, 'docs', 'hatirlatma.png'), png(390, 844));
    writeFileSync(join(app.proj, 'docs', 'fiyat.pdf'), '%PDF-1.4\n1 0 obj << /Type /Page /MediaBox [0 0 595 842] >> endobj\n%%EOF\n');
    writeFileSync(join(app.proj, 'docs', 'rapor.html'), '<!doctype html><body style="font-family:system-ui;padding:24px"><h1>Fiyat raporu</h1><p>Üç rakip yıllıkta 990 ile 1.290 arası alıyor.</p><table><tr><td>Rakip A</td><td>990</td></tr><tr><td>Rakip B</td><td>1.190</td></tr><tr><td>Rakip C</td><td>1.290</td></tr></table></body>');
    const card = {
      phone: { id: 'img1', kind: 'image', ref: 'docs/hatirlatma.png', title: 'Hatırlatmalar · sonra', aspect: 0.462 },
      pdf: { id: 'pdf1', kind: 'pdf', ref: 'docs/fiyat.pdf', title: 'Fiyat önerisi', aspect: 0.707 },
      desk: { id: 'web1', kind: 'web', ref: 'docs/panel.html', title: 'Panel · aylık özet' },
      ask: { id: 'web1', kind: 'web', ref: 'docs/rapor.html', title: 'Fiyat raporu' },
    }[f.present];
    if (card) { containers.push({ ...card, shape: 'tall', place: 'float', by: 'super' }); view = { mode: 'present', cards: [card.id], layout: 'spotlight' }; }
    if (f.present === 'group') {
      const ids = ['img1', 'img2', 'img3'];
      ids.forEach((id, i) => containers.push({ id, kind: 'image', ref: 'docs/hatirlatma.png', shape: 'tall', place: 'float', by: 'super', title: `Ekran ${i + 1}`, aspect: 0.462 }));
      groups = [{ id: 'g1', name: 'Ekranlar', cards: ids, place: 'float' }];
      view = { mode: 'present', cards: ids, layout: 'grid' };
    }
    if (f.present === 'member') view = { mode: 'present', cards: ['t0'], layout: 'spotlight' };
    if (f.present === 'ask') queue.push({ id: 'qs', sessionId: superSession, kind: 'ask', state: 'escalated', createdAt: now - 3000, read: ['web1'], ownerText: 'Yıllık plan hangi fiyatla öne çıksın?', options: ['990 ₺', '1.190 ₺', '1.290 ₺'] });
  }
  if (f.present === true) {
    mkdirSync(join(app.proj, 'docs'), { recursive: true });
    writeFileSync(join(app.proj, 'docs', 'hatirlatma.png'), png(390, 844));
    writeFileSync(join(app.proj, 'docs', 'fiyat.pdf'), '%PDF-1.4\n1 0 obj << /Type /Page /MediaBox [0 0 595 842] >> endobj\n%%EOF\n');
    containers.push(
      { id: 'img1', kind: 'image', ref: 'docs/hatirlatma.png', shape: 'tall', place: 'float', by: 'super', title: 'Hatırlatmalar · sonra', aspect: 0.462 },
      { id: 'pdf1', kind: 'pdf', ref: 'docs/fiyat.pdf', shape: 'tall', place: 'others', by: 'super', title: 'Fiyat önerisi', aspect: 0.707 },
    );
    view = { mode: 'present', cards: ['img1'], layout: 'spotlight' };
    presentQueue = { items: [{ id: 'pq1', cards: ['img1'], layout: 'spotlight', at: now - 60_000, shown: true }, { id: 'pq2', cards: ['pdf1'], at: now - 10_000 }], seen: 0, seq: 2, showing: 'pq1' };
  }
  const sessions = kids.map((k, i) => ({ title: k.title, kind: 'chat', sessionId: k.id, pane: i, active: i === 0, window: 'main', size: 1 }));
  const state = join(app.proj, '_dream_context', 'state');
  mkdirSync(join(app.proj, 'docs'), { recursive: true });
  writeFileSync(join(app.proj, 'docs', 'panel.html'), '<!doctype html><h1 style="font-family:system-ui">Panel · aylık özet</h1>');
  writeFileSync(join(state, '.agent-sessions.json'), JSON.stringify({ sessions, activePane: 0, chatPermissionMode: 'auto', windows: [{ id: 'main', name: 'Chat', activePane: 0 }], generation: Date.now() }));
  writeFileSync(join(state, '.super-agent.json'), JSON.stringify({
    v: 1, session: superSession, enabled: true, containers, groups, view, children, queue, ...(presentQueue ? { presentQueue } : {}),
    notes: {}, away, dismissed: [], pool: [], ownerBatches: [], team, ...(pad ? { pad, padSeq: pad.length } : {}),
  }));
}

/** A plain PNG (rows of grey with a dark header band): a fictional phone shot, no real screen in it. */
function png(w, h) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const v = y < 120 ? 40 : Math.floor(y / 70) % 2 ? 236 : 248;
    for (let x = 0; x < w; x++) raw.fill(v, y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The Super's transcript, rows as the CLI writes them (`~/.claude/projects/<dir>/<session>.jsonl`). */
function writeTranscript(session, f, kids, team, now) {
  const dir = join(app.home, '.claude', 'projects', 'verify-super-v3');
  mkdirSync(dir, { recursive: true });
  const rows = [];
  let t = now - 10 * 60_000;
  const add = (role, content) => rows.push({ type: role, message: { role, content }, sessionId: session, uuid: randomUUID(), timestamp: new Date(t += 20_000).toISOString(), cwd: app.proj });
  const fence = (body) => `<untrusted-project-output vault="proj">${body}</untrusted-project-output>`;
  if (f.chat === 'jobs') {
    add('user', 'ne durumdayız?');
    add('assistant', [{ type: 'text', text: 'İşlerin durumu bu, iki iş senden cevap bekliyor.\n\n```dream-view\n{"type":"jobs"}\n```' }]);
  } else if (f.chat === 'ask' || f.chat === 'allow') {
    add('user', 'Ödeme ekranı üç adım sürüyor, tek adıma indir.');
    add('assistant', [{ type: 'text', text: f.chat === 'allow' ? 'Ödeme ekranını tek adıma indirdim. Şimdi testleri çalıştırmam lazım.' : 'Başlattım. Fiyat için senden bir karar lazım, soruyu aşağıya koydum.' }]);
  } else if (f.chat === 'member') {
    const j = team[0];
    add('user', 'Sage fiyat sayfası için rakipleri karşılaştırsın.');
    add('assistant', [{ type: 'text', text: "Sage'e verdim, cevabı gelince sana getiririm." }]);
    add('user', [`[super events] batch=b1 items=1`, `- item=q9 team=${j.id} member=${j.member} event=done status=done`, fence(`Brief: ${j.brief}`), fence('Answer: Three competitors charge 990 to 1.290 a year; 1.190 sits in the middle and keeps the monthly plan 20% dearer. Suggest 1.190 yearly with a 7 day trial.')].join('\n'));
    add('assistant', [{ type: 'text', text: 'Sage karşılaştırmayı bitirdi: yıllık 1.190 öneriyor.' }]);
  }
  writeFileSync(join(dir, `${session}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
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
  if (f.agendaTap) {
    await p.locator('[data-testid="super-agenda-row"][data-live="true"][data-state="now"]').first().click({ timeout: 10_000, position: { x: 60, y: 12 } }).catch(() => fail(`${where}: no live agenda line to tap`));
    await p.waitForTimeout(800);
    if (!(await p.locator('[data-testid="super-job-filter-bar"]').count())) fail(`${where}: the agenda tap did not narrow the chat`);
  }
  if (f.chat === 'member' && !(await p.locator('.super-event-with-quotes').count())) fail(`${where}: no member quote card`);
  if (f.away && !(await p.locator('[data-testid="super-away"]').count())) fail(`${where}: no away tiles`);
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
  const ask = { dock: await p.locator('[data-testid="super-ask-dock"]').count(), full: await p.locator('[data-testid="super-question-card"]').count(), rows: await p.locator('[data-testid="super-ask-row"]').count() };
  const memberTab = await p.locator('[data-testid="super-member-tab"]').count();
  const win = await p.evaluate(() => { const el = document.querySelector('.super-win'); if (!el) return null; const b = el.getBoundingClientRect(); return { width: Math.round(b.width), height: Math.round(b.height) }; });
  await ctx.close();
  // The montage: the mockup frame left, the build right, at the same height.
  let montage = null;
  const mockFile = MOCK && f.mock ? join(MOCK, f.mock) : null;
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
  return { file, montage, dock, floats, ask, memberTab, win };
}

const where0 = (name, size, dark) => `${name}@${size[0]}-${dark ? 'dark' : 'light'}`;
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
        if (f.present === 'ask') {
          if (!r.ask.dock) fail(`${where0(name, size, dark)}: no question docked under the report`);
          else if (r.ask.full !== 1) fail(`${where0(name, size, dark)}: ${r.ask.full} full question cards (want 1)`);
          else ok(`${name}@${size[0]}: the question sits under the report, the chat holds one row (${r.ask.rows})`);
          continue;
        }
        if (f.present === 'member') { if (!r.memberTab) fail(`${name}: no member tab in the window`); else ok(`${name}: member tab in the window`); continue; }
        if (f.present && f.present !== true && r.win) ok(`${name}@${size[0]}: window ${r.win.width}x${r.win.height}`);
        if (f.list || f.members || f.redLight || f.chat || f.away) { ok(`${name}: shot`); continue; }
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
