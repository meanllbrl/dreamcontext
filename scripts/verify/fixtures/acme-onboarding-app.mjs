/**
 * Synthetic app/v1 insight for the funnel explorer verify run (lab-boards.mjs
 * sections 27-28): the fictional "Acme Storefront" onboarding app, three pages.
 * Everything here is invented (synthetic-fixtures-for-published-artifacts).
 *
 * Each page prints a marker (`#page` = its id) the verify run reads inside the
 * sandboxed frame; `overview` has a button that calls `lab.navigate('pricing')`
 * and `pricing` one that calls `lab.navigate('activation')`, so an in-frame
 * navigation can be driven like a user would.
 *
 * Self-contained (no imports): the verify run copies it as a lab script.
 */

const page = (id, body, next) => [
  `<div class="lk-title" id="page" data-page="${id}">${id}</div>`,
  `<p class="lk-muted">${body}</p>`,
  next ? `<button class="lk-btn" id="next" type="button">Go to ${next}</button>` : '',
  '<script>',
  'lab.data().then(function (ds) { document.getElementById("page").dataset.rows = String(ds && ds.rows ? ds.rows.length : 0); });',
  next ? `document.getElementById("next").addEventListener("click", function () { lab.navigate(${JSON.stringify(next)}); });` : '',
  '</script>',
].join('\n');

export default async function () {
  const rows = ['Signup', 'Profile complete', 'First order'].map((step, i) => ({ d: { step }, v: 9800 - i * 2900 }));
  return {
    data: {
      kind: 'dataset/v1',
      primary: 'onboarding',
      datasets: [{ key: 'onboarding', label: 'Onboarding', dims: [{ key: 'step', label: 'Step' }], rows, total: { v: rows[0].v } }],
    },
    app: {
      kind: 'app/v1',
      entry: 'overview',
      card: 'overview',
      pages: [
        { id: 'overview', title: 'Overview', html: page('overview', 'Acme Storefront onboarding at a glance.', 'pricing') },
        { id: 'pricing', title: 'Pricing', html: page('pricing', 'Which plan new Acme shoppers pick.', 'activation') },
        { id: 'activation', title: 'Activation', html: page('activation', 'How many reach a first order.', null) },
      ],
    },
  };
}
