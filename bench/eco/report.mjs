#!/usr/bin/env node
// Builds the Eco / Eco Plus benchmark report: statistics over $BENCH/results, the Eco history replay,
// SVG charts (inline in the HTML, theme-following) and PNG exports (light + dark) via Playwright.
//   node bench/eco/report.mjs <out.html> <pngDir>
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BENCH = process.env.ECO_BENCH_DIR || '/tmp/eco-benchmark';
const [outHtml, pngDir] = process.argv.slice(2);
const MODES = ['off', 'plus'];
const MODE_NAME = { off: 'Kapalı (Opus)', plus: 'Eco Plus' };
const TASKS = [
  ['t1-fix', 'Küçük düzeltme'], ['t2-feature', 'Küçük özellik'], ['t3-debug', 'Hata ayıklama'], ['t4-develop', 'Çok dosyalı develop'],
  ['t5-plan', 'Plan'], ['t6-super', 'Super delegasyonu'], ['t7-memory', 'Hafızayla cevap'], ['t8-long', 'Uzun oturum (7 istek)'],
];
const CODE_TASKS = new Set(['t1-fix', 't2-feature', 't3-debug', 't4-develop', 't6-super', 't8-long']);

const results = readdirSync(join(BENCH, 'results')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(BENCH, 'results', f), 'utf-8')))
  .filter((r) => MODES.includes(r.mode) && TASKS.some(([t]) => t === r.task));
const cell = (t, m) => results.filter((r) => r.task === t && r.mode === m);

// ---------- statistics ----------
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const resample = (a) => a.map(() => pick(a));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
const B = 4000;
const metric = {
  usd: (r) => r.usage.usd,
  tokens: (r) => r.usage.tokens,
  wall: (r) => r.wallMs / 60000,
  judge: (r) => r.judge?.score?.overall ?? NaN,
  hidden: (r) => (r.grade?.hiddenTotal ? r.grade.hiddenPassed / r.grade.hiddenTotal : NaN),
  success: (r) => (r.grade?.success === null || r.grade?.success === undefined ? NaN : r.grade.success ? 1 : 0),
};
const vals = (t, m, k) => cell(t, m).map(metric[k]).filter((x) => !Number.isNaN(x));
const tasksWith = (k) => TASKS.map(([t]) => t).filter((t) => MODES.every((m) => vals(t, m, k).length));

// Suite ratio (Eco Plus over Off) of the sum of per-task means, bootstrapped within each cell.
function suiteRatio(k) {
  const ts = tasksWith(k);
  const point = ts.reduce((s, t) => s + mean(vals(t, 'plus', k)), 0) / ts.reduce((s, t) => s + mean(vals(t, 'off', k)), 0);
  const boots = [];
  for (let b = 0; b < B; b++) {
    let p = 0, o = 0;
    for (const t of ts) { p += mean(resample(vals(t, 'plus', k))); o += mean(resample(vals(t, 'off', k))); }
    boots.push(p / o);
  }
  return { point, lo: pct(boots, 0.025), hi: pct(boots, 0.975), tasks: ts.length };
}
// Suite total of per-task means for one mode, with an interval.
function suiteSum(k, m) {
  const ts = tasksWith(k);
  const point = ts.reduce((s, t) => s + mean(vals(t, m, k)), 0);
  const boots = [];
  for (let b = 0; b < B; b++) boots.push(ts.reduce((s, t) => s + mean(resample(vals(t, m, k))), 0));
  return { point, lo: pct(boots, 0.025), hi: pct(boots, 0.975) };
}
// Equal-weight mean over tasks of the per-task mean, with an interval.
function taskMean(k, m, only) {
  const ts = tasksWith(k).filter((t) => !only || only.has(t));
  const point = mean(ts.map((t) => mean(vals(t, m, k))));
  const boots = [];
  for (let b = 0; b < B; b++) boots.push(mean(ts.map((t) => mean(resample(vals(t, m, k))))));
  return { point, lo: pct(boots, 0.025), hi: pct(boots, 0.975), n: ts.reduce((s, t) => s + vals(t, m, k).length, 0) };
}
function taskDiff(k, only) {
  const ts = tasksWith(k).filter((t) => !only || only.has(t));
  const point = mean(ts.map((t) => mean(vals(t, 'plus', k)) - mean(vals(t, 'off', k))));
  const boots = [];
  for (let b = 0; b < B; b++) boots.push(mean(ts.map((t) => mean(resample(vals(t, 'plus', k))) - mean(resample(vals(t, 'off', k))))));
  return { point, lo: pct(boots, 0.025), hi: pct(boots, 0.975) };
}
function wilson(k, n) {
  if (!n) return { point: NaN, lo: NaN, hi: NaN };
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return { point: p, lo: Math.max(0, c - h), hi: Math.min(1, c + h), k, n };
}
const successOf = (m) => { const v = TASKS.flatMap(([t]) => vals(t, m, 'success')); return wilson(v.filter((x) => x === 1).length, v.length); };
function cellRatio(t, k) {
  const p = vals(t, 'plus', k), o = vals(t, 'off', k);
  if (!p.length || !o.length) return null;
  const boots = [];
  for (let b = 0; b < B; b++) boots.push(mean(resample(p)) / mean(resample(o)));
  return { point: mean(p) / mean(o), lo: pct(boots, 0.025), hi: pct(boots, 0.975), n: [o.length, p.length] };
}
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : 0; };

const S = {
  usage: suiteRatio('usd'), tokens: suiteRatio('tokens'), wall: suiteRatio('wall'),
  usdSum: Object.fromEntries(MODES.map((m) => [m, suiteSum('usd', m)])),
  tokSum: Object.fromEntries(MODES.map((m) => [m, suiteSum('tokens', m)])),
  wallSum: Object.fromEntries(MODES.map((m) => [m, suiteSum('wall', m)])),
  success: Object.fromEntries(MODES.map((m) => [m, successOf(m)])),
  hidden: Object.fromEntries(MODES.map((m) => [m, taskMean('hidden', m, CODE_TASKS)])),
  judge: Object.fromEntries(MODES.map((m) => [m, taskMean('judge', m)])),
  judgeDiff: taskDiff('judge'), hiddenDiff: taskDiff('hidden', CODE_TASKS),
};
const perTask = TASKS.map(([t, name]) => ({
  t, name,
  n: Object.fromEntries(MODES.map((m) => [m, cell(t, m).length])),
  usd: Object.fromEntries(MODES.map((m) => [m, { mean: mean(vals(t, m, 'usd')), sd: sd(vals(t, m, 'usd')) }])),
  wall: Object.fromEntries(MODES.map((m) => [m, mean(vals(t, m, 'wall'))])),
  judge: Object.fromEntries(MODES.map((m) => [m, { mean: mean(vals(t, m, 'judge')), sd: sd(vals(t, m, 'judge')), v: vals(t, m, 'judge') }])),
  hidden: Object.fromEntries(MODES.map((m) => [m, mean(vals(t, m, 'hidden'))])),
  success: Object.fromEntries(MODES.map((m) => [m, vals(t, m, 'success')])),
  ratio: cellRatio(t, 'usd'),
  sonnetShare: (() => { const rs = cell(t, 'plus'); const tot = rs.reduce((s, r) => s + r.usage.usd, 0); return tot ? rs.reduce((s, r) => s + (r.usage.usdByFamily.sonnet ?? 0), 0) / tot : NaN; })(),
}));
const eco = existsSync(join(BENCH, 'eco-history.json')) ? JSON.parse(readFileSync(join(BENCH, 'eco-history.json'), 'utf-8')) : null;
if (eco) {
  const boots = [];
  const ph = eco.perHandoff;
  for (let b = 0; b < B; b++) { const s = resample(ph); const a = s.reduce((x, r) => x + r[0], 0), n = s.reduce((x, r) => x + r[1], 0); boots.push(a / (a + n)); }
  eco.shareLo = pct(boots, 0.025); eco.shareHi = pct(boots, 0.975);
}
const runsTotal = results.length;
const spend = { runs: results.reduce((s, r) => s + r.usage.usd, 0), judges: results.reduce((s, r) => s + (r.judge?.judgeCostUsd ?? 0), 0) };
writeFileSync(join(BENCH, 'summary.json'), JSON.stringify({ S, perTask, eco: eco && { ...eco, hist: undefined, perHandoff: undefined }, runsTotal, spend }, null, 1));

// ---------- charts ----------
const COLORS = { light: { off: '#2a78d6', plus: '#1baf7a', ink: '#0b0b0b', ink2: '#52514e', grid: '#e4e3df', bg: '#fcfcfb' },
  dark: { off: '#3987e5', plus: '#199e70', ink: '#f0efec', ink2: '#c3c2b7', grid: '#3a3a37', bg: '#1a1a19' } };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');

// One vertical bar chart: bars [{label, value, lo, hi, mode, text}], y from 0 to max.
function bars({ title, sub, items, max, foot, theme, unit = '' }) {
  const c = COLORS[theme] || null;
  const ink = c ? c.ink : 'currentColor', ink2 = c ? c.ink2 : 'currentColor', grid = c ? c.grid : 'currentColor';
  const W = 1200, H = 675, L = 120, R = 80, T = 150, Bm = 150;
  const ph = H - T - Bm, bw = Math.min(220, (W - L - R) / items.length * 0.5), gap = (W - L - R) / items.length;
  const y = (v) => T + ph - (v / max) * ph;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" style="width:100%;height:auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">`;
  if (c) s += `<rect width="${W}" height="${H}" fill="${c.bg}"/>`;
  s += `<text x="${L - 60}" y="62" font-size="34" font-weight="650" fill="${ink}">${esc(title)}</text>`;
  s += `<text x="${L - 60}" y="104" font-size="22" fill="${ink2}" opacity="${c ? 1 : 0.75}">${esc(sub)}</text>`;
  for (let i = 0; i <= 4; i++) { const v = (max / 4) * i; s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${grid}" stroke-width="1" opacity="${c ? 1 : 0.18}"/><text x="${L - 12}" y="${y(v) + 7}" font-size="18" text-anchor="end" fill="${ink2}" opacity="${c ? 1 : 0.7}">${fmt(v, max < 5 ? 1 : 0)}${unit}</text>`; }
  items.forEach((it, i) => {
    const cx = L + gap * i + gap / 2, x = cx - bw / 2, top = y(it.value);
    const col = c ? c[it.mode] : (it.mode === 'off' ? '#3080dd' : '#1aa676');
    s += `<path d="M${x},${y(0)} V${top + 4} q0,-4 4,-4 H${x + bw - 4} q4,0 4,4 V${y(0)} Z" fill="${col}"><title>${esc(it.label)}: ${esc(it.text)}</title></path>`;
    if (Number.isFinite(it.lo) && Number.isFinite(it.hi)) {
      s += `<line x1="${cx}" x2="${cx}" y1="${y(it.hi)}" y2="${y(it.lo)}" stroke="${ink}" stroke-width="2"/><line x1="${cx - 12}" x2="${cx + 12}" y1="${y(it.hi)}" y2="${y(it.hi)}" stroke="${ink}" stroke-width="2"/><line x1="${cx - 12}" x2="${cx + 12}" y1="${y(it.lo)}" y2="${y(it.lo)}" stroke="${ink}" stroke-width="2"/>`;
    }
    const labelY = Math.min(top, Number.isFinite(it.hi) ? y(it.hi) : top) - 14;
    s += `<text x="${cx}" y="${labelY}" font-size="30" font-weight="650" text-anchor="middle" fill="${ink}">${esc(it.text)}</text>`;
    s += `<text x="${cx}" y="${y(0) + 38}" font-size="22" text-anchor="middle" fill="${ink}">${esc(it.label)}</text>`;
  });
  s += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="${ink2}" stroke-width="1.5"/>`;
  foot.forEach((f, i) => { s += `<text x="${L - 60}" y="${H - 58 + i * 26}" font-size="17" fill="${ink2}" opacity="${c ? 1 : 0.75}">${esc(f)}</text>`; });
  return s + '</svg>';
}
// Grouped horizontal bars per task: rows [{label, values:{off,plus}, texts:{off,plus}}].
function grouped({ title, sub, rows, max, foot, theme, unit = '', refLine }) {
  const c = COLORS[theme] || null;
  const ink = c ? c.ink : 'currentColor', ink2 = c ? c.ink2 : 'currentColor', grid = c ? c.grid : 'currentColor';
  const W = 1200, L = 330, R = 140, T = 170, rowH = 64, H = T + rows.length * rowH + 120;
  const x = (v) => L + (Math.min(v, max) / max) * (W - L - R);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" style="width:100%;height:auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">`;
  if (c) s += `<rect width="${W}" height="${H}" fill="${c.bg}"/>`;
  s += `<text x="60" y="62" font-size="34" font-weight="650" fill="${ink}">${esc(title)}</text><text x="60" y="104" font-size="22" fill="${ink2}" opacity="${c ? 1 : 0.75}">${esc(sub)}</text>`;
  // legend
  MODES.forEach((m, i) => { const lx = 60 + i * 260; const col = c ? c[m] : (m === 'off' ? '#3080dd' : '#1aa676'); s += `<rect x="${lx}" y="128" width="18" height="18" rx="4" fill="${col}"/><text x="${lx + 28}" y="144" font-size="19" fill="${ink}">${esc(MODE_NAME[m])}</text>`; });
  for (let i = 0; i <= 4; i++) { const v = (max / 4) * i; s += `<line x1="${x(v)}" x2="${x(v)}" y1="${T - 6}" y2="${T + rows.length * rowH}" stroke="${grid}" opacity="${c ? 1 : 0.18}"/><text x="${x(v)}" y="${T + rows.length * rowH + 26}" font-size="16" text-anchor="middle" fill="${ink2}" opacity="${c ? 1 : 0.7}">${fmt(v, max < 5 ? 1 : 0)}${unit}</text>`; }
  if (refLine !== undefined) s += `<line x1="${x(refLine)}" x2="${x(refLine)}" y1="${T - 10}" y2="${T + rows.length * rowH}" stroke="${ink}" stroke-dasharray="6 5" stroke-width="1.5"/>`;
  rows.forEach((r, i) => {
    const y0 = T + i * rowH;
    s += `<text x="${L - 16}" y="${y0 + 36}" font-size="20" text-anchor="end" fill="${ink}">${esc(r.label)}</text>`;
    MODES.forEach((m, j) => {
      const v = r.values[m]; if (!Number.isFinite(v)) return;
      const col = c ? c[m] : (m === 'off' ? '#3080dd' : '#1aa676');
      const by = y0 + 8 + j * 26, w = Math.max(2, x(v) - L);
      s += `<path d="M${L},${by} H${L + w - 4} q4,0 4,4 V${by + 18} q0,4 -4,4 H${L} Z" fill="${col}"><title>${esc(r.label)} · ${esc(MODE_NAME[m])}: ${esc(r.texts[m])}</title></path><text x="${L + w + 8}" y="${by + 17}" font-size="16" fill="${ink}">${esc(r.texts[m])}</text>`;
    });
  });
  foot.forEach((f, i) => { s += `<text x="60" y="${H - 58 + i * 26}" font-size="17" fill="${ink2}" opacity="${c ? 1 : 0.75}">${esc(f)}</text>`; });
  return s + '</svg>';
}

const REPS = Math.max(...TASKS.map(([t]) => Math.min(...MODES.map((m) => cell(t, m).length))));
const minReps = Math.min(...TASKS.map(([t]) => Math.min(...MODES.map((m) => cell(t, m).length))));
const nLine = `n = ${TASKS.length} iş × ${minReps === REPS ? REPS : `${minReps}-${REPS}`} tekrar, ${runsTotal} koşu · çubuk üstü: %95 güven aralığı (bootstrap, 4000 örnek) · kurgu proje Pinewood Pantry · 22 Kas 2026`;
const pctTxt = (r) => `%${fmt(r.point * 100)}`;
const charts = {
  usage: (theme) => bars({ theme, title: 'Aynı işte kullanım', sub: 'Kullanım limitinden yenen pay, Kapalı = 100 (liste fiyatı oranı)', max: 120,
    items: [{ label: MODE_NAME.off, mode: 'off', value: 100, text: '100' },
      { label: MODE_NAME.plus, mode: 'plus', value: S.usage.point * 100, lo: S.usage.lo * 100, hi: S.usage.hi * 100, text: fmt(S.usage.point * 100) }],
    foot: [nLine, `Eco Plus aralığı ${fmt(S.usage.lo * 100)}-${fmt(S.usage.hi * 100)}. Abonelik limiti modele göre ağırlıklı; burada liste fiyatı oranıyla temsil edildi.`] }),
  tokens: (theme) => bars({ theme, title: 'Aynı 8 işte toplam token', sub: 'Girdi + önbellek + çıktı, milyon token, sette bir tam tur', max: Math.ceil(Math.max(S.tokSum.off.hi, S.tokSum.plus.hi) / 1e6 * 1.15),
    items: MODES.map((m) => ({ label: MODE_NAME[m], mode: m, value: S.tokSum[m].point / 1e6, lo: S.tokSum[m].lo / 1e6, hi: S.tokSum[m].hi / 1e6, text: `${fmt(S.tokSum[m].point / 1e6, 1)} M` })),
    foot: [nLine, `Token oranı Eco Plus / Kapalı: ${pctTxt(S.tokens)} (aralık %${fmt(S.tokens.lo * 100)}-%${fmt(S.tokens.hi * 100)}). Token sayısı fiyatı söylemez: Sonnet tokeni Opus'un yarı fiyatı.`] }),
  time: (theme) => bars({ theme, title: 'Aynı 8 işte süre', sub: 'Duvar saati, dakika, sette bir tam tur', max: Math.ceil(Math.max(S.wallSum.off.hi, S.wallSum.plus.hi) * 1.15),
    items: MODES.map((m) => ({ label: MODE_NAME[m], mode: m, value: S.wallSum[m].point, lo: S.wallSum[m].lo, hi: S.wallSum[m].hi, text: `${fmt(S.wallSum[m].point)} dk` })),
    foot: [nLine, 'Süre makinenin o anki yüküyle oynar; koşular aynı saatlerde karışık sırayla koştu.'] }),
  success: (theme) => bars({ theme, title: 'Görev başarısı', sub: 'Gizli kabul testlerinin hepsi geçti + tip denetimi temiz, kod yazan 6 iş', max: 100, unit: '',
    items: MODES.map((m) => ({ label: MODE_NAME[m], mode: m, value: S.success[m].point * 100, lo: S.success[m].lo * 100, hi: S.success[m].hi * 100, text: `%${fmt(S.success[m].point * 100)}` })),
    foot: [`${S.success.off.k}/${S.success.off.n} ve ${S.success.plus.k}/${S.success.plus.n} koşu başarılı · aralık: Wilson %95 · gizli testler ajanın görmediği dosyalar, referans çözüm 25/25 geçiyor`, nLine] }),
  quality: (theme) => bars({ theme, title: 'Kalite puanı', sub: 'Kör Opus hakem, 0-10 (mod ve model adı gizli), 8 işin ortalaması', max: 10,
    items: MODES.map((m) => ({ label: MODE_NAME[m], mode: m, value: S.judge[m].point, lo: S.judge[m].lo, hi: S.judge[m].hi, text: fmt(S.judge[m].point, 1) })),
    foot: [nLine, `Fark (Eco Plus - Kapalı): ${fmt(S.judgeDiff.point, 1)} puan, aralık ${fmt(S.judgeDiff.lo, 1)} / ${fmt(S.judgeDiff.hi, 1)}.`] }),
  byTaskUsage: (theme) => grouped({ theme, title: 'İş türüne göre kullanım', sub: 'Liste fiyatı, dolar, koşu başına ortalama', max: Math.max(...perTask.map((p) => Math.max(p.usd.off.mean || 0, p.usd.plus.mean || 0))) * 1.25,
    rows: perTask.map((p) => ({ label: p.name, values: { off: p.usd.off.mean, plus: p.usd.plus.mean },
      texts: { off: `${fmt(p.usd.off.mean, 2)} $`, plus: `${fmt(p.usd.plus.mean, 2)} $${p.ratio ? ` · ${fmt(p.ratio.point * 100)}` : ''}` } })),
    foot: ['Eco Plus satırındaki ikinci sayı: Kapalı = 100 iken Eco Plus kullanımı.', nLine] }),
  byTaskQuality: (theme) => grouped({ theme, title: 'İş türüne göre kalite', sub: 'Kör hakem puanı 0-10, koşu ortalaması (yanında: başarılı koşu / koşu)', max: 10,
    rows: perTask.map((p) => ({ label: p.name, values: { off: p.judge.off.mean, plus: p.judge.plus.mean },
      texts: Object.fromEntries(MODES.map((m) => [m, `${fmt(p.judge[m].mean, 1)}${p.success[m].length ? ` · ${p.success[m].filter((x) => x === 1).length}/${p.success[m].length}` : ''}`])) })),
    foot: ['Plan ve hafıza işlerinde gizli test yok; yalnız hakem puanı.', nLine] }),
};
if (eco) {
  charts.eco = (theme) => bars({ theme, title: 'Eco: devirden sonraki iş', sub: `Bu Mac'in gerçek oturumları, son ${eco.days} gün, ${eco.handoffs} devir: aynı işin maliyeti, Eco olmasa = 100`, max: 120,
    items: [{ label: 'Eco olmasa (aynı oturum sürse)', mode: 'off', value: 100, text: '100' },
      { label: 'Eco ile (taze oturum)', mode: 'plus', value: eco.costShareWithEco * 100, lo: eco.shareLo * 100, hi: eco.shareHi * 100, text: fmt(eco.costShareWithEco * 100) }],
    foot: [`Devirde bağlam medyan ${fmt(eco.medianHandoffCtx / 1000)}k → taze oturumda ${fmt(eco.medianFreshCtx / 1000)}k token (%${fmt(eco.medianDrop * 100)} az). Karşı olgu: taze oturumun ${fmt(eco.freshCalls)} çağrısı eski bağlamla tekrar oynatıldı, 1M pencerede kesildi.`,
      'Geçişin maliyeti (taze oturumun önbelleğe yazdığı ilk bağlam) düşüldü. Ölçüm, deney değil: Eco hep açıktı.'] });
}

// ---------- SVG files for the PNG export (png.mjs renders them, through the heavy lock) ----------
if (pngDir) {
  mkdirSync(pngDir, { recursive: true });
  for (const [name, fn] of Object.entries(charts)) for (const theme of ['light', 'dark']) writeFileSync(join(pngDir, `${name}${theme === 'dark' ? '-dark' : ''}.svg`), fn(theme));
}

// ---------- HTML ----------
const inline = (name) => charts[name] ? charts[name](null) : '';
const fig = (name, cap) => `<figure class="dc-card">${inline(name)}<figcaption class="dc-figcaption">${cap} PNG: <code class="dc-code">eco-benchmark/${name}.png</code> · koyu: <code class="dc-code">${name}-dark.png</code></figcaption></figure>`;
const failRows = results.filter((r) => r.grade && r.grade.success === false).sort((a, b) => a.key.localeCompare(b.key));
const causes = existsSync(join(BENCH, 'failure-causes.json')) ? JSON.parse(readFileSync(join(BENCH, 'failure-causes.json'), 'utf-8')) : {};
const usagePct = Math.round((1 - S.usage.point) * 100);
const html = `<div class="dc-doc">
<h1 class="dc-h1">Eco ve Eco Plus: aynı işte ne kadar kullanım, ne kadar kalite</h1>
<p class="dc-lede">Aynı 8 işi kurgu bir projede (Pinewood Pantry) Tasarruf modu Kapalı (Opus) ve Eco Plus ile ${minReps === REPS ? REPS : `${minReps}-${REPS}`}'er kez koşturduk; her koşunun tokenini, liste fiyatını, süresini, gizli testlerini ve kör bir Opus hakemin puanını ölçtük. Eco'yu koşmadık: sahibin isteğiyle Eco'nun etkisini bu Mac'in son ${eco?.days ?? 30} gündeki gerçek devirlerinden ölçtük.</p>
<div class="dc-grid">
  <div class="dc-stat"><div class="dc-stat-label">Eco Plus kullanımı</div><div class="dc-value">${fmt(S.usage.point * 100)}</div><div class="dc-stat-note">Kapalı = 100 · aralık ${fmt(S.usage.lo * 100)}-${fmt(S.usage.hi * 100)}</div></div>
  <div class="dc-stat"><div class="dc-stat-label">Görev başarısı</div><div class="dc-value">%${fmt(S.success.plus.point * 100)} / %${fmt(S.success.off.point * 100)}</div><div class="dc-stat-note">Eco Plus / Kapalı · ${S.success.plus.k}/${S.success.plus.n} ve ${S.success.off.k}/${S.success.off.n}</div></div>
  <div class="dc-stat"><div class="dc-stat-label">Kalite puanı (0-10)</div><div class="dc-value">${fmt(S.judge.plus.point, 1)} / ${fmt(S.judge.off.point, 1)}</div><div class="dc-stat-note">fark ${fmt(S.judgeDiff.point, 1)} (aralık ${fmt(S.judgeDiff.lo, 1)} / ${fmt(S.judgeDiff.hi, 1)})</div></div>
  ${eco ? `<div class="dc-stat"><div class="dc-stat-label">Eco, devirden sonraki iş</div><div class="dc-value">${fmt(eco.costShareWithEco * 100)}</div><div class="dc-stat-note">Eco olmasa = 100 · ${eco.handoffs} gerçek devir · aralık ${fmt(eco.shareLo * 100)}-${fmt(eco.shareHi * 100)}</div></div>` : ''}
</div>
<h2 class="dc-h2">Kullanım, token, süre</h2>
${fig('usage', `Aynı sette Eco Plus, Kapalı'nın ${fmt(S.usage.point * 100)}'ü kadar kullanım yedi (%${usagePct} daha az; aralık %${Math.round((1 - S.usage.hi) * 100)}-%${Math.round((1 - S.usage.lo) * 100)}).`)}
${fig('tokens', 'Token toplamı.')}
${fig('time', 'Süre.')}
<h2 class="dc-h2">Başarı ve kalite</h2>
${fig('success', 'Görev başarısı: gizli testlerin hepsi geçti ve tip denetimi temiz.')}
${fig('quality', 'Kör hakem puanı.')}
<h2 class="dc-h2">İş türüne göre</h2>
${fig('byTaskUsage', 'Her iş türünde koşu başına liste fiyatı.')}
${fig('byTaskQuality', 'Her iş türünde hakem puanı ve başarı; kalitenin düştüğü yer burada görünür.')}
<div class="dc-table-wrap"><table class="dc-table"><thead><tr><th>İş</th><th>Koşu (K/E+)</th><th>$ Kapalı</th><th>$ Eco Plus</th><th>Kullanım (K=100)</th><th>Sonnet payı</th><th>Gizli test K / E+</th><th>Başarı K / E+</th><th>Hakem K / E+ (±ss)</th><th>Süre dk K / E+</th></tr></thead><tbody>
${perTask.map((p) => `<tr><td>${p.name}</td><td>${p.n.off} / ${p.n.plus}</td><td>${fmt(p.usd.off.mean, 2)} ±${fmt(p.usd.off.sd, 2)}</td><td>${fmt(p.usd.plus.mean, 2)} ±${fmt(p.usd.plus.sd, 2)}</td><td>${p.ratio ? `${fmt(p.ratio.point * 100)} (${fmt(p.ratio.lo * 100)}-${fmt(p.ratio.hi * 100)})` : '–'}</td><td>%${fmt(p.sonnetShare * 100)}</td><td>${Number.isFinite(p.hidden.off) ? `%${fmt(p.hidden.off * 100)} / %${fmt(p.hidden.plus * 100)}` : '–'}</td><td>${p.success.off.length ? `${p.success.off.filter((x) => x === 1).length}/${p.success.off.length} / ${p.success.plus.filter((x) => x === 1).length}/${p.success.plus.length}` : '–'}</td><td>${fmt(p.judge.off.mean, 1)} ±${fmt(p.judge.off.sd, 1)} / ${fmt(p.judge.plus.mean, 1)} ±${fmt(p.judge.plus.sd, 1)}</td><td>${fmt(p.wall.off, 1)} / ${fmt(p.wall.plus, 1)}</td></tr>`).join('\n')}
</tbody></table></div>
<p class="dc-p dc-muted">±ss: tekrarlar arası standart sapma. "Sonnet payı": Eco Plus koşularının dolarının Sonnet'e giden kısmı; kalanı Opus'ta kalan hakemler (reviewer, goal-plan-reviewer) ve Haiku.</p>
<h2 class="dc-h2">Başarısız koşular ve nedenleri</h2>
${failRows.length ? `<div class="dc-table-wrap"><table class="dc-table"><thead><tr><th>Koşu</th><th>Gizli test</th><th>Tip hatası</th><th>Neden (transkriptten)</th></tr></thead><tbody>
${failRows.map((r) => `<tr><td><code class="dc-code">${r.key}</code></td><td>${r.grade.hiddenPassed}/${r.grade.hiddenTotal}</td><td>${r.grade.tscErrors}</td><td>${esc(causes[r.key] ?? 'okunmadı')}</td></tr>`).join('\n')}
</tbody></table></div>` : '<p class="dc-p">Başarısız koşu yok.</p>'}
${eco ? `<h2 class="dc-h2">Eco: gerçek oturumlardan</h2>
${fig('eco', `Son ${eco.days} günde ${eco.vaults} projede ${eco.handoffs} devir.`)}
<p class="dc-p">Nasıl ölçüldü: her devirde eski oturumun bağlamı ve devam eden taze oturum kayıtlı. Taze oturumun her API çağrısını, eski oturum hiç kapanmasaydı taşıyacağı fazla bağlamla (devir bağlamı eksi taze oturumun ilk bağlamı, 1M pencereyle sınırlı) yeniden fiyatladık ve geçişin kendi maliyetini (taze oturumun ilk bağlamını önbelleğe yazması) düştük. Bu bir karşı olgu hesabı: eski oturumun aynı çağrıları yapacağını varsayar; zincirleme devirlerin birikimini saymadığı için ihtiyatlı. Medyan devir ${fmt(eco.medianHandoffCtx / 1000)}k tokende oldu, taze oturum ${fmt(eco.medianFreshCtx / 1000)}k ile başladı (çeyrekler arası düşüş %${fmt(eco.p25Drop * 100)}-%${fmt(eco.p75Drop * 100)}). Devirden sonraki işte okunan girdi tokeninin %${fmt(eco.shareOfInputAvoided * 100)}'i Eco sayesinde hiç okunmadı. Kısa işlerde (bağlam ${fmt(300)}k'ya varmadan biten) Eco hiçbir şeyi değiştirmez.</p>` : ''}
<h2 class="dc-h2">Yöntem</h2>
<ul class="dc-list">
<li><strong class="dc-strong">Proje:</strong> kurgu bir gıda bankası envanter aracı (TypeScript, vitest, 8 kaynak dosya), dreamcontext beyni ve bu dalın kancaları kurulu. Gerçek proje, kişi ya da sır yok.</li>
<li><strong class="dc-strong">Modlar:</strong> Mac'in gerçek Tasarruf modu ayarı, her mod için ayrı sahte HOME'da (sahibin ayarına dokunulmadı). Kapalı: sohbet Opus. Eco Plus: kayıtlı varsayılandan açılan sohbet Sonnet; alt ajanlar PreToolUse kancasıyla Sonnet'e indi, reviewer ve goal-plan-reviewer Opus'ta kaldı.</li>
<li><strong class="dc-strong">İşler:</strong> küçük düzeltme, küçük özellik (CSV), hata ayıklama (test bir dosyada, neden başka dosyada), çok dosyalı develop + reviewer, plan + goal-plan-reviewer, Super delegasyonu (Super kod yazmaz, goal-implementer'a devreder, sonra doğrular), hafızayla cevap (yalnız beyindeki bilgiden), uzun oturum (aynı oturumda 7 ardışık istek).</li>
<li><strong class="dc-strong">Kalite:</strong> ajanın görmediği gizli kabul testleri (referans çözümle 25/25 doğrulandı, başlangıç kodu 3/25) + tip denetimi + kör Opus hakem (mod ve model adı silinmiş fark ve son mesaj; plan ve hafıza işlerinde yazarın olgu notuyla).</li>
<li><strong class="dc-strong">Maliyet:</strong> transkriptlerden ana oturum + alt ajan tokenleri, mesaj kimliğiyle tekilleştirildi; Anthropic liste fiyatı (Opus 5.5: 4 / 20 $, önbellek okuma 0,20 $; Sonnet 5.5: 2 / 10 $, 0,10 $; önbellek yazma 5 dk 1,25x, 1 sa 2x). Kullanım limiti payı = liste fiyatı oranı (abonelik limitinin doğrudan ölçüsü yok).</li>
<li><strong class="dc-strong">Kapsam dışı:</strong> arka plan uykusu ve hafıza hakeminin (Haiku) çağrıları iki modda aynı ve ölçüme girmedi. Koşular sahibin claude.ai aboneliğiyle koştu.</li>
<li><strong class="dc-strong">Harcama:</strong> koşular ${fmt(spend.runs, 2)} $ + hakemler ${fmt(spend.judges, 2)} $ liste fiyatı (deneme koşuları dahil değil).</li>
</ul>
</div>`;
if (outHtml) writeFileSync(outHtml, html);
console.log(JSON.stringify({ usage: S.usage, success: S.success, judge: S.judge, judgeDiff: S.judgeDiff, runs: runsTotal, spend }, null, 0));
