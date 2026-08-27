/**
 * App adapter for the "demo-acquisition-app" insight — a DEMO FIXTURE.
 *
 * Every number below is invented. This insight exists so `render: app` has a
 * surface that can be photographed for the What's New story and driven by the
 * verify scripts without touching anybody's real analytics. Same rule as the
 * other `demo-*` fixtures in this vault: synthetic data, example.com URLs,
 * nothing that belongs to a real company.
 *
 * It returns { data, app } — the two independent halves `render: app` is built
 * around. `data` is the queryable dataset/v1 bundle (`lab query`, `lab show`,
 * KR bindings all read THIS); `app` is the ordered list of sandboxed pages the
 * dashboard draws and wires over the postMessage bridge. Numbers live in `data`
 * once and are pulled into a page with `lab.data()` — never typed twice.
 */

/** One month of invented acquisition history, by channel. */
const CHANNELS = [
  { key: 'organic', label: 'Organic search', signups: 4820, spend: 0, cac: 0 },
  { key: 'paid-social', label: 'Paid social', signups: 3140, spend: 27900, cac: 8.89 },
  { key: 'referral', label: 'Referral', signups: 1980, spend: 4200, cac: 2.12 },
  { key: 'partners', label: 'Partners', signups: 1260, spend: 11800, cac: 9.37 },
  { key: 'newsletter', label: 'Newsletter', signups: 640, spend: 900, cac: 1.41 },
  { key: 'events', label: 'Events', signups: 84, spend: 9600, cac: 114.29 },
];

/** Week-1 retention by signup cohort — the second page's grid. */
const COHORTS = [
  { cohort: '2026-07-06', size: 2410, w1: 0.61, w2: 0.44, w3: 0.38, w4: 0.35 },
  { cohort: '2026-07-13', size: 2680, w1: 0.64, w2: 0.47, w3: 0.41, w4: 0.37 },
  { cohort: '2026-07-20', size: 2905, w1: 0.66, w2: 0.5, w3: 0.43, w4: null },
  { cohort: '2026-07-27', size: 3120, w1: 0.63, w2: 0.46, w3: null, w4: null },
  { cohort: '2026-08-03', size: 2840, w1: 0.68, w2: null, w3: null, w4: null },
];

export default async function fetchApp(ctx) {
  const { fromISO, toISO } = ctx.resolvedTweaks.range;
  void fromISO;
  void toISO; // a real adapter would scope its query with these

  const totalSignups = CHANNELS.reduce((a, c) => a + c.signups, 0);
  const totalSpend = CHANNELS.reduce((a, c) => a + c.spend, 0);

  return {
    data: {
      kind: 'dataset/v1',
      primary: 'channels',
      datasets: [
        // TWO DIMENSIONS, not one dimension plus a bag of side-values. dataset/v1
        // keeps `{ d, v, n }` per row and drops anything else, so a second metric
        // is a second DIM VALUE — never an `extra` field. (Learned the hard way:
        // rows carrying `extra` sync clean, `lab query` looks right, and every
        // page then renders em-dashes because the field is gone by the time the
        // sandbox reads it.)
        {
          key: 'channels',
          dims: [
            { key: 'channel', label: 'Channel' },
            { key: 'metric', label: 'Metric' },
          ],
          rows: CHANNELS.flatMap((c) => [
            { d: { channel: c.label, metric: 'signups' }, v: c.signups, n: c.signups },
            { d: { channel: c.label, metric: 'spend' }, v: c.spend, n: c.signups },
          ]),
          total: { v: totalSignups, n: totalSignups },
        },
        // A week that has not happened yet is an ABSENT ROW, not a zero — which is
        // what lets the retention page draw "·" instead of quietly averaging a 0 in.
        {
          key: 'cohorts',
          dims: [
            { key: 'cohort', label: 'Cohort' },
            { key: 'week', label: 'Week' },
          ],
          rows: COHORTS.flatMap((c) =>
            [
              ['w1', c.w1],
              ['w2', c.w2],
              ['w3', c.w3],
              ['w4', c.w4],
            ]
              .filter(([, v]) => v !== null)
              .map(([week, v]) => ({ d: { cohort: c.cohort, week }, v, n: c.size })),
          ),
        },
      ],
    },

    app: {
      kind: 'app/v1',
      entry: 'overview',

      pages: [
        {
          id: 'overview',
          title: 'Overview',
          dataset: 'channels',
          html: `
            <div class="lk-grid">
              <div class="lk-stat">
                <span class="lk-label">Signups</span>
                <span class="lk-value lk-value--lg" id="signups">—</span>
                <span class="lk-delta lk-delta--up">▲ 12.4%</span>
              </div>
              <div class="lk-stat">
                <span class="lk-label">Spend</span>
                <span class="lk-value" id="spend">—</span>
                <span class="lk-delta lk-delta--up">▲ 6.1%</span>
              </div>
              <div class="lk-stat">
                <span class="lk-label">Blended CAC</span>
                <span class="lk-value" id="cac">—</span>
                <span class="lk-delta lk-delta--down">▼ 5.6%</span>
              </div>
            </div>

            <div class="lk-spacer"></div>
            <div class="lk-title">Signups by channel</div>
            <div id="bars"></div>

            <div class="lk-spacer"></div>
            <button class="lk-chip lk-chip--accent" id="to-cohorts" type="button"
                    style="cursor:pointer;border:none;">
              Retention by cohort →
            </button>
            <script>
              // NAME THE DATASET EXPLICITLY. The page's own "dataset" field is
              // documented as lab.data()'s default, but the runtime does not wire it
              // through: an argument-less call posts dataset:null and the host
              // resolves that to bundle.primary (appModel.ts findDataset), so a page
              // whose dataset is not the primary one silently gets the wrong numbers.
              lab.data('channels').then(function (ds) {
                var fmt = function (n) { return n.toLocaleString('en-US'); };
                var pick = function (metric) {
                  return ds.rows.filter(function (r) { return r.d.metric === metric; });
                };
                var signupRows = pick('signups');
                var spend = pick('spend').reduce(function (a, r) { return a + r.v; }, 0);
                var signups = signupRows.reduce(function (a, r) { return a + r.v; }, 0);

                document.getElementById('signups').textContent = fmt(signups);
                document.getElementById('spend').textContent = '$' + fmt(spend);
                document.getElementById('cac').textContent = '$' + (spend / signups).toFixed(2);

                var max = Math.max.apply(null, signupRows.map(function (r) { return r.v; }));
                document.getElementById('bars').innerHTML = signupRows.map(function (r, i) {
                  var pct = Math.round((r.v / max) * 100);
                  var weak = r.v < 300 ? ' lk-low-sample' : '';
                  // The kit's row wrapper is lk-bar — the flex row that gives the
                  // label, the track and the value their shares. Without it the three
                  // spans just stack as text and the chart reads as a list.
                  // (No backticks in here: this whole page body IS a template literal.)
                  return '<div class="lk-bar' + weak + '">' +
                    '<span class="lk-bar-label">' + r.d.channel + '</span>' +
                    '<span class="lk-bar-track"><span class="lk-bar-fill lk-bar-fill--' +
                      ((i % 8) + 1) + '" style="width:' + pct + '%"></span></span>' +
                    '<span class="lk-bar-value">' + fmt(r.v) + '</span>' +
                  '</div>';
                }).join('');
              });
              document.getElementById('to-cohorts').addEventListener('click', function () {
                lab.navigate('cohorts');
              });
            </script>
          `,
        },
        {
          id: 'cohorts',
          title: 'Retention',
          dataset: 'cohorts',
          html: `
            <div class="lk-title">Week-on-week retention by signup cohort</div>
            <table class="lk-table" id="grid"></table>
            <p class="lk-muted" style="margin-top:10px;">
              A blank cell is a week that has not happened yet, not a zero.
            </p>
            <div class="lk-spacer"></div>
            <button class="lk-chip" id="back" type="button" style="cursor:pointer;border:none;">
              ← Overview
            </button>
            <script>
              // Explicit key — see the note on the overview page. This is the page
              // that PROVED the bug: with an argument-less call it rendered a single
              // "undefined" row carrying the channels total.
              lab.data('cohorts').then(function (ds) {
                // Pivot the long rows back into a grid. An absent (cohort, week)
                // pair stays absent — that is the "·" the caption promises.
                var byCohort = {};
                ds.rows.forEach(function (r) {
                  var c = byCohort[r.d.cohort] || (byCohort[r.d.cohort] = { n: r.n });
                  c[r.d.week] = r.v;
                });
                var pc = function (x) {
                  return x === undefined
                    ? '<td class="lk-muted">·</td>'
                    : '<td class="lk-num">' + Math.round(x * 100) + '%</td>';
                };
                var body = Object.keys(byCohort).sort().map(function (k) {
                  var c = byCohort[k];
                  return '<tr><td>' + k + '</td>' +
                    '<td class="lk-num">' + c.n.toLocaleString('en-US') + '</td>' +
                    pc(c.w1) + pc(c.w2) + pc(c.w3) + pc(c.w4) + '</tr>';
                }).join('');
                document.getElementById('grid').innerHTML =
                  '<tr><th>Cohort</th><th class="lk-num">Size</th><th class="lk-num">W1</th>' +
                  '<th class="lk-num">W2</th><th class="lk-num">W3</th><th class="lk-num">W4</th></tr>' +
                  body;
              });
              document.getElementById('back').addEventListener('click', function () {
                lab.navigate('overview');
              });
            </script>
          `,
        },
        {
          id: 'about',
          title: 'About',
          html: `
            <div class="lk-callout">
              A demo fixture. Every figure on these pages is invented — it exists so the
              <code>render: app</code> surface can be driven and photographed without
              anyone's real analytics. The pages are written by
              <code>lab/scripts/demo-acquisition-app.mjs</code> and drawn in a sandbox
              with no network access; the numbers arrive over the host bridge via
              <code>lab.data()</code>.
            </div>
          `,
        },
      ],
    },
  };
}
