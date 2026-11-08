// chart_board.js — every chart in the kit, on one board.
// Data is FICTIONAL (a made-up product, "Acme"): this file ships to npm, so it demos the kit and
// must never carry real customer metrics.
// Run:  node examples/chart_board.js     → examples/Chart Kit.excalidraw.md   (expects a clean audit)
//
// This doubles as the kit's smoke test: it drives every builder, and the build must report
// overlaps=0 buriedText=0 longLines=0. If a chart's geometry drifts, this board says so.
const path = require('path');
const { buildExcalidraw } = require(path.resolve(__dirname, '../scripts/build_excalidraw.js'));
const { sectionTitle, prose, stack, row, funnel, READ_W } = require(path.resolve(__dirname, '../scripts/lib/style.js'));
const {
  lineChart, barChart, barCompare, stackedBar, gantt, quadrant,
  donut, sparkline, heatmap, table, timeline, kpi, callout,
} = require(path.resolve(__dirname, '../scripts/lib/charts.js'));

const DAYS = ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'];
const DAU = [58, 74, 69, 64, 55, 47, 44, 41, 38, 36, 35, 33, 32];
const NEW = [44, 56, 51, 47, 40, 33, 30, 28, 26, 24, 23, 21, 20];
const PREM = [30, 35, 36, 38, 33, 27, 24, 21, 18, 15, 14, 12, 11];

const board = stack({
  x: 60, y: 60, gap: 64, items: [
    (x, y) => stack({
      x, y, gap: 12, items: [
        (x, y) => sectionTitle({ x, y, text: 'Excalidraw chart kit — every builder, one board', fontSize: 42 }),
        (x, y) => prose({ x, y, width: READ_W, fontSize: 15, text: 'Each chart below is one call with DATA only — no coordinates, no hand-placed labels. Geometry, axes, wrapping and collision-avoidance belong to the builder.' }),
      ],
    }),

    // KPI tiles (with sparklines) + a callout
    (x, y) => row({
      x, y, gap: 24, items: [
        (x, y) => kpi({ x, y, w: 300, label: 'DAU', value: '32', delta: 'peak 74 → -57%', color: 'red', spark: DAU }),
        (x, y) => kpi({ x, y, w: 300, label: 'NEW USERS / DAY', value: '20', delta: '425 over 13 days', color: 'red', spark: NEW }),
        (x, y) => kpi({ x, y, w: 300, label: 'D0 ROAS', value: '0.34', delta: 'W1: 0.31 — +10%', color: 'yellow' }),
        (x, y) => callout({ x, y, w: 700, color: 'gray', title: 'callout()', text: 'Body copy is always bounded to the reading measure. A wide band puts its heading beside the text instead of stretching one line edge-to-edge.' }),
      ],
    }),

    // lineChart + barCompare
    (x, y) => row({
      x, y, gap: 60, items: [
        (x, y) => lineChart({
          x, y, w: 760, h: 340, title: 'lineChart() — app health, days 1–13',
          xLabels: DAYS, area: true,
          series: [
            { label: 'DAU', color: 'blue', points: DAU },
            { label: 'new users', color: 'green', points: NEW },
            { label: 'paid actives', color: 'red', points: PREM },
          ],
        }),
        (x, y) => barCompare({
          x, y, w: 700, h: 340, title: 'barCompare() — week 1 vs week 2',
          seriesLabels: ['Week 1', 'Week 2'], colors: ['gray', 'red'],
          groups: [
            { label: 'ROAS x100', values: [31, 34] },
            { label: 'CPM $', values: [120, 145] },
            { label: 'Checkout %', values: [72.0, 58.4] },
            { label: 'Refund x10', values: [18.0, 26.5] },
          ],
        }),
      ],
    }),

    // funnel + barChart(horizontal) + donut
    (x, y) => row({
      x, y, gap: 60, valign: 'top', items: [
        (x, y) => funnel({
          x, y, w: 420, topW: 420, botW: 120, stageH: 74, fontSize: 15, notes: false,
          stages: [
            { label: 'Landing 4,000', color: 'blue' }, { label: 'Signup 1,900', color: 'red' },
            { label: 'Onboard 1,700', color: 'green' }, { label: 'Trial 1,200', color: 'red' },
            { label: 'Checkout 1,150', color: 'yellow' }, { label: 'Paid 140', color: 'red' },
          ],
        }),
        (x, y) => barChart({
          x, y, w: 620, h: 320, horizontal: true, title: 'barChart({horizontal}) — signups by country',
          bars: [
            { label: 'US', value: 310, color: 'blue' }, { label: 'DE', value: 64, color: 'yellow' },
            { label: 'UK', value: 52, color: 'gray' }, { label: 'CA', value: 41, color: 'gray' },
            { label: 'AU', value: 23, color: 'gray' },
          ],
        }),
        (x, y) => donut({
          x, y, r: 120, title: 'donut() — error breakdown',
          slices: [
            { label: 'timeout', value: 240, color: 'red' },
            { label: 'other', value: 60, color: 'gray' },
            { label: 'rate limited', value: 30, color: 'yellow' },
          ],
        }),
      ],
    }),

    // stackedBar + quadrant
    (x, y) => row({
      x, y, gap: 60, valign: 'top', items: [
        (x, y) => stackedBar({
          x, y, w: 680, h: 340, title: 'stackedBar() — D1 cohort split',
          seriesLabels: ['paid returned', 'free returned', 'churned'], colors: ['green', 'blue', 'gray'],
          groups: [
            { label: 'week 1', values: [22, 14, 90] }, { label: 'week 2', values: [19, 12, 84] },
            { label: 'week 3', values: [17, 11, 96] },
          ],
        }),
        (x, y) => quadrant({
          x, y, w: 620, h: 460, title: 'quadrant() — roadmap: impact x effort',
          xAxis: { left: 'high effort', right: 'low effort' }, yAxis: { bottom: 'low impact', top: 'high impact' },
          quadrantLabels: { tr: 'DO FIRST', tl: 'plan', br: 'quick win', bl: 'later' },
          items: [
            { label: 'signup provisioning', x: 0.42, y: 0.95, color: 'red' },
            { label: 'checkout rate', x: 0.55, y: 0.88, color: 'red' },
            { label: 'landing A/B', x: 0.78, y: 0.66, color: 'yellow' },
            { label: 'churn-save', x: 0.35, y: 0.5, color: 'blue' },
            { label: 'refund monitor', x: 0.85, y: 0.28, color: 'gray' },
          ],
        }),
      ],
    }),

    // gantt + timeline
    (x, y) => gantt({
      x, y, w: 1400, title: 'gantt() — fix plan', today: '2026-03-02',
      tasks: [
        { label: 'backend cross-check', start: '2026-03-02', end: '2026-03-05', color: 'red', done: 0.3 },
        { label: 'payment triage', start: '2026-03-03', end: '2026-03-09', color: 'red' },
        { label: 'landing A/B', start: '2026-03-06', end: '2026-03-16', color: 'yellow' },
        { label: 'churn-save flow', start: '2026-03-10', end: '2026-03-22', color: 'blue' },
        { label: 'review', start: '2026-03-09', milestone: true, color: 'purple' },
      ],
    }),
    (x, y) => timeline({
      x, y, w: 1400, title: 'timeline() — campaign events',
      events: [
        { label: 'Campaign start', at: '2026-02-17', color: 'blue' },
        { label: 'Pricing change', at: '2026-02-22', color: 'yellow' },
        { label: 'Budget cut 67%', at: '2026-02-23', color: 'red' },
        { label: 'Checkout dropped', at: '2026-02-26', color: 'red' },
        { label: 'Review', at: '2026-03-02', color: 'purple' },
      ],
    }),

    // heatmap + table
    (x, y) => row({
      x, y, gap: 60, valign: 'top', items: [
        (x, y) => heatmap({
          x, y, title: 'heatmap() — retention, cohort x day', cell: 40,
          rows: ['week 1', 'week 2', 'week 3', 'week 4', 'week 5'],
          cols: ['D0', 'D1', 'D2', 'D3', 'D4'],
          values: [
            [100, 11, 7, 5, 4], [100, 9, 6, 4, 3], [100, 13, 8, 6, 4],
            [100, 8, 5, 4, null], [100, 27, 12, null, null],
          ],
          fmt: (v) => (v == null ? '' : v + '%'),
        }),
        (x, y) => table({
          x, y, title: 'table() — plan comparison',
          headers: ['Plan', 'Churn', 'MRR', 'Seats'],
          align: ['left', 'right', 'right', 'right'],
          rows: [
            ['Free', { text: '9.1%', color: 'red' }, '$0', '1,240'],
            ['Pro', { text: '3.4%', color: 'yellow' }, '$18,400', '460'],
            ['Team', { text: '1.8%', color: 'green' }, '$42,900', '210'],
            ['Enterprise', { text: '0.9%', color: 'green' }, '$96,000', '48'],
          ],
        }),
      ],
    }),
  ],
});

const res = buildExcalidraw({ out: path.resolve(__dirname, 'Chart Kit.excalidraw.md'), elements: board });
console.log(`elements=${res.elements} texts=${res.texts} overlaps=${res.overlaps} buriedText=${res.buriedText} longLines=${res.longLines}`);
