/**
 * Runtime verification for the Space launcher. Drives the REAL dashboard and
 * asserts what the geometry is supposed to mean — radius is recency, angle is
 * kinship — plus the interactions the retired Network view used to own.
 *
 * Point it at a dashboard running on an isolated scratch HOME (see the `verify`
 * skill); it discovers the registered projects from the API rather than
 * hardcoding fixture names, so it works against whatever vaults that HOME holds.
 * It needs at least 2 projects, and exercises wiring only when it can find an
 * unconnected pair.
 *
 *   BASE=http://127.0.0.1:45741 node e2e/verify-space.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45741';
const OUT = process.env.OUT ?? '/tmp/dc-verify-space/shots';
mkdirSync(OUT, { recursive: true });

const api = async (p) => (await fetch(`${BASE}/api${p}`)).json();
const post = (p, body) =>
  fetch(`${BASE}/api${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`${pass ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const graph = await api('/launcher/federation-graph');
if (graph.nodes.length < 2) {
  console.error('needs at least 2 registered projects in this HOME');
  process.exit(2);
}
const edgeKey = (e) => `${e.source}→${e.target}`;
// A pair with no edge either way, so the drag below must CREATE one.
const linked = new Set(graph.edges.flatMap((e) => [`${e.source}|${e.target}`, `${e.target}|${e.source}`]));
let pair = null;
for (const a of graph.nodes) {
  for (const b of graph.nodes) {
    if (a.name === b.name || linked.has(`${a.name}|${b.name}`)) continue;
    if (!a.exists || !b.exists) continue;
    pair = [a.name, b.name];
    break;
  }
  if (pair) break;
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 840 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  // The sky drifts forever, so Playwright's "element is stable" gate never opens
  // and every click times out. Emulating reduced motion is the honest fix: it
  // exercises the real accessibility branch (drift disabled) rather than reaching
  // in to freeze the animation, and it is how an assistive user meets this UI.
  reducedMotion: 'reduce',
});
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [console error]', m.text().slice(0, 200));
});

// ─── The view choice ────────────────────────────────────────────────────────
// List leads for a first-time launcher; Space has to be chosen. The choice then
// sticks, which is the whole contract — verify both halves before anything else,
// because every check below depends on landing in Space.
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
check('a first-time launcher opens on List',
      (await page.locator('.launcher-grid').count()) === 1 && (await page.locator('.space').count()) === 0);
await page.locator('.launcher-btn', { hasText: 'Space' }).click();
await page.waitForSelector('.space-chip', { timeout: 20000 });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
check('the Space choice survives a relaunch', (await page.locator('.space').count()) === 1);
await page.waitForSelector('.space-chip', { timeout: 20000 });
await page.waitForTimeout(1200);

// ─── The sky ────────────────────────────────────────────────────────────────
const bodies = await page.locator('.space-body').count();
check('every registered project is a body in the sky', bodies === graph.nodes.length,
      `${bodies} bodies vs ${graph.nodes.length} projects`);

// The sky (rings, clouds, wires, stars) is one SVG anchored to a 0×0 rotor. If a
// global reset collapses its box, all of it still EXISTS in the DOM — counts pass,
// screenshots come back wrong. So assert where it actually PAINTS.
const aligned = await page.evaluate(() => {
  const svg = document.querySelector('.space-sky')?.getBoundingClientRect();
  const rotor = document.querySelector('.space-rotor')?.getBoundingClientRect();
  if (!svg || !rotor) return null;
  return {
    width: Math.round(svg.width),
    dx: Math.round(svg.left + svg.width / 2 - rotor.left),
    dy: Math.round(svg.top + svg.height / 2 - rotor.top),
  };
});
check('the sky paints on the same origin the projects orbit',
      Boolean(aligned && aligned.width > 0 && Math.abs(aligned.dx) <= 1 && Math.abs(aligned.dy) <= 1),
      JSON.stringify(aligned));

// Radius is recency: the freshest project must not sit outside the coldest one.
const radii = await page.evaluate(() =>
  Object.fromEntries([...document.querySelectorAll('.space-body')].map((el) => [
    el.querySelector('[data-vault]')?.getAttribute('data-vault'),
    parseFloat(getComputedStyle(el).getPropertyValue('--r')),
  ])),
);
const opened = graph.nodes.filter((n) => n.lastOpenedAt).sort((a, b) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt));
const never = graph.nodes.filter((n) => !n.lastOpenedAt);
if (opened.length && never.length) {
  check('radius is recency — the freshest project is nearer the centre than a never-opened one',
        radii[opened[0].name] <= radii[never[0].name],
        `${opened[0].name} ${radii[opened[0].name]} vs ${never[0].name} ${radii[never[0].name]}`);
}

check('every stored read edge is drawn as a wire',
      (await page.locator('.space-wire').count()) === graph.edges.length,
      `${await page.locator('.space-wire').count()} wires vs ${graph.edges.length} edges`);

const statuses = await page.evaluate(() =>
  Object.fromEntries([...document.querySelectorAll('.space-chip')].map((el) => [
    el.getAttribute('data-vault'),
    [...el.classList].find((c) => c.startsWith('status-')),
  ])),
);
const expectStatus = (n) => (!n.exists ? 'status-gone' : n.needsUpdate ? 'status-stale' : 'status-ok');
check('every project wears the status its registry says it has',
      graph.nodes.every((n) => statuses[n.name] === expectStatus(n)),
      JSON.stringify(statuses));

await page.screenshot({ path: `${OUT}/space-01-overview.png` });

// ─── Focus: the pill grows into a card, in place ────────────────────────────
const target = graph.nodes.find((n) => n.exists).name;
const pillBox = await page.locator(`[data-vault="${target}"]`).boundingBox();
await page.click(`[data-vault="${target}"]`);
await page.waitForTimeout(700);

check('clicking a project expands it into a card', (await page.locator('.space-card').count()) === 1);
const cardBox = await page.locator('.space-card').boundingBox();
check('the card is materially bigger than the pill it replaced',
      cardBox.width > pillBox.width * 1.5 && cardBox.height > pillBox.height * 2,
      `${Math.round(pillBox.width)}x${Math.round(pillBox.height)} → ${Math.round(cardBox.width)}x${Math.round(cardBox.height)}`);

// It has to open ON the thing that was clicked — that is the entire point of the
// card over a docked panel — and it has to stay fully on canvas at the edges.
const spaceBox = await page.locator('.space').boundingBox();
const clipped = Math.max(
  spaceBox.x - cardBox.x,
  cardBox.x + cardBox.width - (spaceBox.x + spaceBox.width),
  spaceBox.y - cardBox.y,
  cardBox.y + cardBox.height - (spaceBox.y + spaceBox.height),
);
check('the card stays fully on canvas', clipped <= 0, `worst overhang ${Math.round(clipped)}px`);

const cardText = await page.locator('.space-card').innerText();
check('the card names the project it describes', cardText.includes(target));
check('the card states version, sync and recency as facts',
      /Up to date|Skills on v|Folder is missing/.test(cardText)
      && /team sync|Team sync/.test(cardText)
      && /Opened |Never opened/.test(cardText),
      cardText.replace(/\n/g, ' | '));
check('facts are a list, not buttons', (await page.locator('.space-card-facts li').count()) >= 2);

// The retired `shareable` gate must leave no trace: connecting IS the read grant.
check('nothing offers a "readable" toggle any more', !/readable/i.test(await page.locator('body').innerText()));
check('no edge carries an `active` flag', graph.edges.every((e) => e.active === undefined));

await page.screenshot({ path: `${OUT}/space-02-card.png` });

// Opening a project stamps recency, which is what radius is made of.
await page.locator('.space-card-actions .space-btn', { hasText: 'Open project' }).click();
await page.waitForTimeout(900);
const stamped = (await api('/launcher/status')).vaults.find((v) => v.name === target)?.lastOpenedAt;
check('opening a project stamps its recency', Boolean(stamped), String(stamped));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Esc collapses the card back into its pill',
      (await page.locator('.space-card').count()) === 0
      && (await page.locator(`[data-vault="${target}"].space-chip`).count()) === 1);

// ─── Search dims instead of re-laying out ───────────────────────────────────
await page.keyboard.press('Escape');
const anglesBefore = await page.evaluate(() =>
  [...document.querySelectorAll('.space-body')].map((el) => getComputedStyle(el).getPropertyValue('--a')));
await page.fill('.launcher-search', target);
await page.waitForTimeout(600);
const anglesAfter = await page.evaluate(() =>
  [...document.querySelectorAll('.space-body')].map((el) => getComputedStyle(el).getPropertyValue('--a')));
check('a search dims the projects it does not match',
      (await page.locator('.space-body.is-dim').count()) > 0,
      `${await page.locator('.space-body.is-dim').count()} dimmed`);
check('a search never moves a body — the sky stays put',
      JSON.stringify(anglesBefore) === JSON.stringify(anglesAfter));
await page.screenshot({ path: `${OUT}/space-03-search.png` });
await page.fill('.launcher-search', '');
await page.waitForTimeout(400);

// ─── Keyboard traversal ─────────────────────────────────────────────────────
// Blur the search box first: arrows inside a text field move the caret, and the
// sky deliberately keeps its hands off them there.
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
// A SELECTED body is a card, not a pill — read the name off whichever it is.
const selectedName = () =>
  page.locator('.space-body.is-selected .space-card-name').innerText().catch(() => '');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(300);
const firstSel = await selectedName();
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(300);
const secondSel = await selectedName();
check('arrow keys walk the ring without a mouse', Boolean(firstSel) && firstSel !== secondSel,
      `${firstSel} → ${secondSel}`);
await page.keyboard.press('Escape');

// ─── A wire is easy to hit ──────────────────────────────────────────────────
if (graph.edges.length > 0) {
  // `pointer-events: stroke` means the drawn 2px line is the only target unless
  // a fat invisible band is drawn with it. Aim deliberately OFF the centreline —
  // the miss a real cursor makes.
  const off = await page.locator('.space-wire-hit').first().evaluate((el) => {
    const mid = el.getPointAtLength(el.getTotalLength() / 2);
    const back = el.getPointAtLength(Math.max(0, el.getTotalLength() / 2 - 6));
    const dx = mid.x - back.x;
    const dy = mid.y - back.y;
    const len = Math.hypot(dx, dy) || 1;
    const pt = new DOMPoint(mid.x + (-dy / len) * 14, mid.y + (dx / len) * 14);
    return pt.matrixTransform(el.getScreenCTM());
  });
  await page.mouse.move(off.x, off.y);
  await page.waitForTimeout(250);
  check('hovering 14px off a wire still lights it up',
        (await page.locator('.space-wire-group.is-hovered').count()) === 1);
  await page.mouse.click(off.x, off.y);
  await page.waitForTimeout(400);
  check('clicking 14px off a wire opens its editor', (await page.locator('.space-cockpit').count()) === 1);
  await page.keyboard.press('Escape');
}

// ─── Drag one project onto another wires them (the retired Network view's job) ─
if (pair) {
  const [from, to] = pair;
  const a = await page.locator(`[data-vault="${from}"]`).boundingBox();
  const b = await page.locator(`[data-vault="${to}"]`).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 40, { steps: 6 });
  check('dragging off a project shows a rubber band', (await page.locator('.space-rubber').count()) > 0);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const after = (await api('/launcher/federation-graph')).edges.map(edgeKey);
  check('dropping it on another project wires a read edge',
        after.includes(`${from}→${to}`), `${from}→${to}`);

  // The sky has to SAY something changed, or a mutation made elsewhere lands silently.
  const rippled = await page.locator('.space-body.pulse-wire').evaluateAll((els) =>
    els.map((e) => e.querySelector('[data-vault]')?.getAttribute('data-vault')));
  check('both ends ripple when a wire is drawn',
        rippled.includes(from) && rippled.includes(to), JSON.stringify(rippled));
  check('the new wire itself flashes', (await page.locator('.space-wire.is-fresh').count()) > 0);

  // Leave the fixture as we found it.
  await post('/launcher/connection/remove', { from, to });
} else {
  console.log('  · every project pair is already wired — skipping the drag-to-wire check');
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`shots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
