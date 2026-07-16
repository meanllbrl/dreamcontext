// atomic_check.js — the regression guard for the kit's core promise:
// every chart type is a plug-in adaptor, drivable from ONE spec element with DATA only.
//
// Run:  node examples/atomic_check.js
// Each type below gets a single spec element and nothing else — no coordinates, no layout, no JS
// helpers. If it draws elements with a clean audit, it is genuinely atomic. If someone adds a chart
// to charts.js but forgets to register it in COMPOSITES, or breaks it on minimal input, this fails.
const path = require('path');
const os = require('os');
const { buildExcalidraw } = require(path.resolve(__dirname, '../scripts/build_excalidraw.js'));

// Minimal-but-real input per type. Deliberately sparse: a chart must degrade sanely, not assume
// the author passed every option.
const CASES = {
  lineChart:  { type: 'lineChart', w: 400, h: 240, xLabels: ['1', '2', '3'], series: [{ label: 'DAU', points: [10, 30, 20] }] },
  barChart:   { type: 'barChart', w: 400, h: 240, bars: [{ label: 'US', value: 266 }, { label: 'TR', value: 22 }] },
  barCompare: { type: 'barCompare', w: 400, h: 240, seriesLabels: ['W1', 'W2'], groups: [{ label: 'CPM', values: [139, 169] }] },
  stackedBar: { type: 'stackedBar', w: 400, h: 240, seriesLabels: ['a', 'b'], groups: [{ label: 'X', values: [3, 7] }] },
  gantt:      { type: 'gantt', w: 600, tasks: [{ label: 'iş', start: '2026-07-16', end: '2026-07-20', done: 0.4 }] },
  quadrant:   { type: 'quadrant', w: 400, h: 400, items: [{ label: 'A', x: 0.8, y: 0.8 }, { label: 'B', x: 0.2, y: 0.3 }] },
  donut:      { type: 'donut', r: 80, slices: [{ label: 'a', value: 70 }, { label: 'b', value: 30 }] },
  pie:        { type: 'pie', r: 80, slices: [{ label: 'a', value: 60 }, { label: 'b', value: 40 }] },
  sparkline:  { type: 'sparkline', w: 160, h: 40, points: [5, 9, 4, 8] },
  heatmap:    { type: 'heatmap', rows: ['r1', 'r2'], cols: ['D0', 'D1'], values: [[100, 11], [100, 9]] },
  table:      { type: 'table', headers: ['Plan', 'Churn'], rows: [['Pro', '3.4%']] },
  timeline:   { type: 'timeline', w: 800, events: [{ label: 'başladı', at: '2026-07-03' }, { label: 'review', at: '2026-07-16' }] },
  kpi:        { type: 'kpi', w: 260, label: 'DAU', value: '32', delta: '−%57' },
  callout:    { type: 'callout', w: 600, title: 'not', text: 'metin hep ölçüde kalır.' },
  funnel:     { type: 'funnel', w: 300, stages: [{ label: 'Landing' }, { label: 'Sub' }] },
  // device + product-UI kit
  'device(iphone)': { type: 'device', kind: 'iphone', x: 0, y: 0 },
  'device(ipad)':   { type: 'device', kind: 'ipad', x: 0, y: 0 },
  'device(mac)':    { type: 'device', kind: 'mac', x: 0, y: 0 },
  appBar:     { type: 'appBar', w: 340, title: 'Ayarlar', back: true, actions: ['more-v'] },
  tabBar:     { type: 'tabBar', w: 340, items: [{ icon: 'home', label: 'Akış' }, { icon: 'user', label: 'Profil' }], active: 0 },
  icon:       { type: 'icon', name: 'search', size: 24 },
  iconButton: { type: 'iconButton', icon: 'plus', shape: 'circle', variant: 'solid', color: 'blue' },
  listRow:    { type: 'listRow', w: 340, title: 'Bildirimler', trailing: 'toggle' },
  toggle:     { type: 'toggle', on: true },
  segmented:  { type: 'segmented', w: 300, items: ['Hepsi', 'Yeni'], active: 0 },
  slider:     { type: 'slider', w: 260, value: 0.4 },
  searchField:{ type: 'searchField', w: 300, placeholder: 'Ara' },
  windowFrame:{ type: 'windowFrame', w: 400, h: 260, kind: 'browser', url: 'acme.app' },
  button:     { type: 'button', w: 140, text: 'Kaydet' },
  input:      { type: 'input', w: 240, label: 'Slug', placeholder: 'chart-kit' },
  imagePlaceholder: { type: 'imagePlaceholder', w: 200, h: 140 },
};

// Degenerate input must not throw or divide by zero — empty series, single point, all-equal values.
const EDGE = {
  'lineChart (boş seri)':   { type: 'lineChart', w: 300, h: 200, series: [] },
  'lineChart (tek nokta)':  { type: 'lineChart', w: 300, h: 200, xLabels: ['1'], series: [{ label: 'a', points: [5] }] },
  'barChart (hepsi eşit)':  { type: 'barChart', w: 300, h: 200, bars: [{ label: 'a', value: 7 }, { label: 'b', value: 7 }] },
  'donut (tek dilim)':      { type: 'donut', r: 60, slices: [{ label: 'a', value: 1 }] },
  'sparkline (boş)':        { type: 'sparkline', w: 100, h: 30, points: [] },
  'table (satır yok)':      { type: 'table', headers: ['a', 'b'], rows: [] },
  'tabBar (boş)':           { type: 'tabBar', w: 300, items: [] },
  'segmented (tek)':        { type: 'segmented', w: 200, items: ['A'], active: 0 },
  'icon (bilinmeyen ad)':   { type: 'icon', name: 'yok-boyle-bir-sey', size: 20 },
  'listRow (başlıksız)':    { type: 'listRow', w: 300, title: '' },
};

const tmp = path.join(os.tmpdir(), 'excalidraw-atomic-check');
let pass = 0, fail = 0;

function check(label, el, requireElements = true) {
  try {
    const r = buildExcalidraw({ out: path.join(tmp, `${label.replace(/\W+/g, '-')}.excalidraw.md`), elements: [el] });
    const bad = r.overlaps + r.buriedText + r.longLines;
    const ok = bad === 0 && (!requireElements || r.elements > 0);
    if (ok) { pass++; console.log(`  ✓ ${label.padEnd(22)} ${String(r.elements).padStart(3)} element`); }
    else { fail++; console.log(`  ✗ ${label.padEnd(22)} elements=${r.elements} audit=${bad}`); }
  } catch (e) {
    fail++; console.log(`  ✗ ${label.padEnd(22)} THREW: ${e.message.slice(0, 60)}`);
  }
}

console.log('\nEvery type from ONE spec element (data only, no JS):');
for (const [name, el] of Object.entries(CASES)) check(name, el);

console.log('\nDegenerate input must not throw:');
for (const [name, el] of Object.entries(EDGE)) check(name, el, false);

console.log(`\n  ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
