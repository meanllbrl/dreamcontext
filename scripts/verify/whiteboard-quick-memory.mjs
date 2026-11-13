#!/usr/bin/env node
/**
 * Hızlı düzenle knows the project (owner, 13 Nov: "quick edit'e de memory olsun ve arama yapabilsin"):
 * the real dashboard on a scratch vault, the machine's real `claude` (Sonnet).
 *
 *   dreamcontext builder heavy -- node scripts/verify/whiteboard-quick-memory.mjs
 *   ... --timing-only    plain edits only (run the same on an older checkout for the "before" time)
 *
 * 1. Timing: three plain adds ("elma ekle"), which need no memory, through the API; the median
 *    of the job's own timing (spawn → answer, whole job, and the memory block's time).
 * 2. Memory: "draw the cargo return flow" on a board that knows nothing of it. Its steps
 *    (Zümrüt, Pelikan, Turkuaz) live only in a knowledge file of the brain. The board must carry
 *    them, and the brain must be unchanged by the run. Screenshots at 390 and 1440 px.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { parseArgs } from 'node:util';
import { openApp } from './lib/app.mjs';

const { values } = parseArgs({ options: { 'timing-only': { type: 'boolean', default: false } } });
const app = await openApp({ suite: values['timing-only'] ? 'whiteboard-quick-memory-timing' : 'whiteboard-quick-memory', claude: 'real', build: !values['timing-only'] });
const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass });
  process.stdout.write(`${pass ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}\n`);
};
const api = (method, path, body) => fetch(`${app.base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
const median = (xs) => { const a = [...xs].sort((p, q) => p - q); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };

async function quick(slug, text) {
  const t0 = Date.now();
  const start = await api('POST', `/api/whiteboards/${slug}/quick-edit`, { text });
  if (!start.job) return { state: 'refused', error: JSON.stringify(start), wallMs: Date.now() - t0 };
  for (;;) {
    const v = await api('GET', `/api/whiteboards/${slug}/quick-edit/${start.job}`);
    if (['done', 'failed', 'stopped'].includes(v.state)) return { ...v, wallMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── the brain: one flow only it knows, among a few unrelated pages ──
const pages = {
  'kargo-iade-akisi': ['Kargo iade akışının adımları', 'Kargo iade akışı dört adımdır: 1. Müşteri iade talebi açar. 2. Depo Zümrüt etiketini basar. 3. Kurye Pelikan paketi alır. 4. Muhasebe Turkuaz onayını verir ve para üç günde döner.'],
  'odeme-sistemi': ['Ödeme sistemi', 'Ödeme sistemi Stripe ile çalışır, fatura her ayın başında kesilir.'],
  'bildirimler': ['Bildirim saatleri', 'Bildirimler sabah dokuzda gider, sessiz saatlerde beklenir.'],
  'raporlar': ['Haftalık rapor', 'Haftalık rapor pazartesi hazırlanır ve Slack kanalına gönderilir.'],
};
// Written as files (`knowledge create` asks questions with no terminal to answer them).
mkdirSync(join(app.proj, '_dream_context', 'knowledge'), { recursive: true });
for (const [slug, [desc, body]] of Object.entries(pages)) {
  writeFileSync(join(app.proj, '_dream_context', 'knowledge', `${slug}.md`), `---\nname: ${slug}\ndescription: ${desc}\n---\n\n${body}\n`);
}
const created = await api('POST', '/api/whiteboards', { name: 'Süreçler' });
const SLUG = created.slug;
ok('a scratch board', !!SLUG);

// ── 1. timing: plain adds, no memory needed ──
const plain = [];
for (const words of ['Buraya küçük bir elma ekle', 'Buraya bir yıldız ekle', 'Buraya küçük bir güneş çiz']) {
  const v = await quick(SLUG, words);
  ok(`plain edit "${words}" is done`, v.state === 'done', `${v.wallMs} ms${v.error ? ` · ${v.error}` : ''}${v.reply ? ` · ${v.reply}` : ''}`);
  plain.push({ words, wallMs: v.wallMs, ...(v.timing ?? {}), costUsd: v.costUsd ?? null });
}
const summary = {
  plain,
  medianWallMs: median(plain.map((p) => p.wallMs)),
  medianModelMs: median(plain.map((p) => p.modelMs).filter((x) => typeof x === 'number')),
  medianMemoryMs: median(plain.map((p) => p.memoryMs).filter((x) => typeof x === 'number')),
  medianCostUsd: median(plain.map((p) => p.costUsd).filter((x) => typeof x === 'number')),
};

if (!values['timing-only']) {
  // ── 2. memory: a drawing only the brain can tell ──
  const brain = join(app.proj, '_dream_context');
  const snapshot = () => {
    const out = {};
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        const rel = relative(brain, p);
        // Every file but the boards themselves and recall's own derived cache: a hook's ledger
        // entry or a stray write anywhere else in the brain shows up here.
        if (rel.startsWith('whiteboards') || n === '.recall-cache' || n === '.git') continue;
        const st = statSync(p);
        if (st.isDirectory()) walk(p); else out[rel] = readFileSync(p, 'utf-8');
      }
    };
    walk(brain);
    return out;
  };
  const before = snapshot();
  const v = await quick(SLUG, 'Kargo iade akışının adımlarını akış şeması olarak çiz');
  ok('the memory edit is done', v.state === 'done', `${v.wallMs} ms · ${v.reply ?? v.error ?? ''}`);
  const boardFile = join(brain, 'whiteboards', SLUG, `${SLUG}.excalidraw.md`);
  const board = readFileSync(boardFile, 'utf-8');
  const found = ['Zümrüt', 'Pelikan', 'Turkuaz'].filter((w) => board.includes(w));
  ok('the board carries the steps only the brain knows (Zümrüt, Pelikan, Turkuaz)', found.length === 3, found.join(', '));
  const after = snapshot();
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
  ok('the run changed nothing in the brain outside the board', changed.length === 0, changed.join(', '));
  summary.memoryEdit = { wallMs: v.wallMs, ...(v.timing ?? {}), costUsd: v.costUsd ?? null, reply: v.reply ?? null, found };

  // ── 3. the model's own search: recall injection off, so only its own recall-and-read can know ──
  writeFileSync(join(brain, 'state', '.sleep.json'), `${JSON.stringify({ recall_mode: 'off' })}\n`);
  const SEARCH = (await api('POST', '/api/whiteboards', { name: 'Arama' })).slug;
  const before2 = snapshot();
  const w = await quick(SEARCH, 'Kargo iade akışının adımlarını akış şeması olarak çiz');
  ok('with no memory block the edit is done', w.state === 'done', `${w.wallMs} ms · ${w.reply ?? w.error ?? ''}`);
  ok('no memory block was computed (injection off)', (w.timing?.memoryMs ?? 0) < 1500);
  const board2 = readFileSync(join(brain, 'whiteboards', SEARCH, `${SEARCH}.excalidraw.md`), 'utf-8');
  const found2 = ['Zümrüt', 'Pelikan', 'Turkuaz'].filter((x) => board2.includes(x));
  ok('the model searched the brain itself and drew its steps', found2.length === 3, found2.join(', '));
  const after2 = snapshot();
  const changed2 = Object.keys({ ...before2, ...after2 }).filter((k) => before2[k] !== after2[k]);
  ok('the searching run changed nothing in the brain outside the board', changed2.length === 0, changed2.join(', '));
  summary.searchEdit = { wallMs: w.wallMs, ...(w.timing ?? {}), costUsd: w.costUsd ?? null, reply: w.reply ?? null, found: found2 };

  const shoot = (slug, title, name) => app.look(`/?vault=proj#wb=${slug}`, async (page) => {
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); }
    const rail = page.getByTestId('ns-rail-whiteboards').first();
    if (await rail.isVisible().catch(() => false)) await rail.click();
    else {
      await page.getByTestId('ns-rail-more').first().click();
      await page.getByTestId('ns-more-whiteboards').first().click();
    }
    await page.waitForTimeout(1500);
    const toggle = page.locator('.wbp-explorer-toggle').first();
    if ((await page.locator('.wbx').count()) === 0 && await toggle.isVisible().catch(() => false)) await toggle.click();
    const row = page.locator('.wbx .wbx-row-open', { hasText: title }).first();
    if (await row.isVisible().catch(() => false)) await row.click();
    await page.waitForTimeout(1500);
    // Fit the whole board in view (Excalidraw: Shift+1).
    await page.locator('.wbp-canvas canvas').last().click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('Shift+1');
    await page.waitForTimeout(800);
  }, { name });
  await shoot(SLUG, 'Süreçler', 'board-memory-block');
  await shoot(SEARCH, 'Arama', 'board-own-search');
}

writeFileSync(join(app.shots, 'timings.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`timings: ${join(app.shots, 'timings.json')}\n${JSON.stringify({ medianWallMs: summary.medianWallMs, medianModelMs: summary.medianModelMs, medianMemoryMs: summary.medianMemoryMs, memoryEdit: summary.memoryEdit && { wallMs: summary.memoryEdit.wallMs, memoryMs: summary.memoryEdit.memoryMs } })}\n`);
const failed = results.filter((r) => !r.pass).length;
const code = await app.finish();
process.stdout.write(`${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 && code === 0 ? 0 : 1);
