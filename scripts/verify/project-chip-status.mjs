#!/usr/bin/env node
/**
 * Project-chip STATUS runtime proof — does the chip strip draw a session's live state?
 *
 *   node scripts/verify/project-chip-status.mjs
 *
 * WHY THIS EXISTS, separately from `project-tabs.mjs`:
 *
 * That script proves the strip's STRUCTURE (one chip per project, switching hides rather than
 * unmounts) and says outright that it cannot prove anything needing a live agent — so the
 * chip's own status marks went unproven, and a real bug lived there: a chat that had merely
 * rung its bell was counted as `asking`, so it went magenta and STAYED magenta through the
 * whole of its next turn, while the dock tile three inches below correctly read "working".
 * "The ones that aren't asking anything but are working show pink, and it doesn't update when
 * they start working" — the report this file answers.
 *
 * The gap was never that a browser can't show it. It is that reaching the real bug through the
 * app needs a Claude session, a PTY and a bell. The state that has to reach the strip is a
 * `ProjectRollup` — seven numbers — so this mounts the REAL `ProjectTabs` (real JSX, real
 * `ProjectTabs.css`, real design tokens, real Chromium) and hands it those numbers directly.
 * `rollupProject`'s own rules are unit-tested in `tests/unit/agent-status-project-rollup.test.ts`;
 * what only a browser can answer is whether the component and stylesheet then DRAW them, which
 * is the half of this bug the user actually saw.
 *
 * WHAT IT PROVES (real component, real stylesheet, real computed styles):
 *   C1  a working chat draws the GREEN working bubble — and, when it also has something unseen,
 *       still draws it green rather than turning magenta (the reported bug, inverted)
 *   C2  that bubble carries the loading RING — the "is it even running" progress mark
 *   C3  the unseen flag draws its own separate dot, so nothing is lost by not folding it in
 *   C4  a genuinely blocked chat DOES draw the magenta asking bubble — the fix did not simply
 *       delete the urgent state it was over-reporting
 *   C5  an asking chat draws NO second dot: one interruption, drawn once
 *   C6  bubbles keep their fixed asking▸working▸idle order regardless of the counts
 *   C7  a project with no live chats draws nothing at all — a quiet strip stays quiet
 *   C8  the magenta and green are genuinely different pixels (the symptom was a colour), and
 *       the accessible label says in words what the colours say
 *
 * FAILURE POLICY — collect, don't fail fast: every check reports, then the process exits
 * non-zero if any failed, so one broken assumption doesn't hide the rest.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DASHBOARD = join(ROOT, 'dashboard');
// Inside `dashboard/` on purpose: Vite resolves `react` and the component's own relative
// imports from the importer's location, so a harness in the OS temp dir would not resolve.
const HARNESS = join(DASHBOARD, '.verify-harness');
const SHOT = join(ROOT, 'tmp', 'verify', 'project-chip-status.png');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/*
 * The scenarios, as SESSIONS rather than as chip numbers — the harness runs the real
 * `deriveSessionStatus` + `rollupProject` over them and renders whatever those produce. Going
 * in one step further back matters: handing the strip seven hand-written numbers would prove
 * the component draws what it is told and nothing about whether the rollup tells it the truth,
 * and the rollup is exactly where the bug lived. This way the browser exercises the whole
 * chain a real session travels — status → bucket → chip — end to end.
 *
 * `bug` is the reported case: one chat mid-turn that ALSO rang its bell earlier (`attention`
 * is sticky until you look at the session). Before the fix this chip drew a single magenta "1"
 * and held it there through the whole turn.
 */
const SCENARIOS = [
  { vault: 'bug', active: true, sessions: [{ status: 'open', busy: true, attention: true }] },
  { vault: 'blocked', active: false, sessions: [{ status: 'open', asking: true }] },
  {
    vault: 'mixed',
    active: false,
    sessions: [
      { status: 'open', asking: true },
      { status: 'open', busy: true },
      { status: 'connecting' },          // `starting` folds into working
      { status: 'open', attention: true }, // idle, but unseen
      { status: 'open', busy: true, kind: 'shell' }, // a dev server — no bubble, but alive
      { dormant: true },                 // a restored roster entry — not a chat you have
    ],
  },
  { vault: 'quiet', active: false, sessions: [{ status: 'closed' }, { dormant: true }] },
];

mkdirSync(HARNESS, { recursive: true });
mkdirSync(dirname(SHOT), { recursive: true });

writeFileSync(join(HARNESS, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>chip status harness</title></head>
<body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>
`);

// The tokens import is what makes the colour assertions meaningful: without it every
// `var(--mood-waiting)` resolves to nothing and the bubbles come back transparent — which
// would pass a "not magenta" check for entirely the wrong reason.
writeFileSync(join(HARNESS, 'main.tsx'), `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/tokens.css';
import { ProjectTabs } from '../src/components/layout/ProjectTabs';
import { deriveSessionStatus, rollupProject } from '../src/components/sleepy/agentStatus';

// Exactly what AgentSurface does per session (see its \`dockRows\`), then the same rollup it
// publishes — so what the strip below renders came through the real code path, not a fixture.
function toChips(scenarios: any[]) {
  return scenarios.map((s) => {
    const rows = s.sessions.map((sess: any, j: number) => ({
      id: s.vault + '-' + j,
      title: s.vault + '-' + j,
      kind: sess.kind ?? 'chat',
      info: deriveSessionStatus(sess),
      attention: !sess.dormant && !!sess.attention,
    }));
    return { vault: s.vault, active: s.active, preview: false, cold: false, ...rollupProject(rows) };
  });
}

function Harness() {
  const [scenarios, setScenarios] = useState<any[]>(${JSON.stringify(SCENARIOS)});
  // Lets a check DRIVE a transition (a bell rings, then a question lands) instead of only
  // photographing end states — the bounce→nudge handover only exists across a change.
  (window as any).__setScenarios = setScenarios;
  const chips = toChips(scenarios);
  // Hand the assertions the numbers the rollup actually produced, so a check can name what the
  // chip was TOLD as well as what it drew.
  (window as any).__chips = chips;
  return (
    <div style={{ padding: 24, background: 'var(--color-bg)' }}>
      <ProjectTabs chips={chips} onActivate={() => {}} onClose={() => {}} onAdd={() => {}} onDetach={() => {}} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
`);

const { createServer } = await import(join(DASHBOARD, 'node_modules', 'vite', 'dist', 'node', 'index.js'));
const server = await createServer({
  root: DASHBOARD,
  configFile: join(DASHBOARD, 'vite.config.ts'),
  // Bind the loopback ADDRESS, not the `localhost` name: on a machine that resolves it to
  // ::1 first, a server bound only to the v6 loopback refuses the v4 connection below.
  server: { host: '127.0.0.1', port: 4793, strictPort: true },
  // Scan THIS harness for pre-bundlable deps, not the whole app. The default entry is the
  // app's own `index.html`, from which the scanner crawls every page in the dashboard — far
  // more than a strip of chips needs, and it fails on unrelated modules that have nothing to
  // do with what is being verified here.
  optimizeDeps: { entries: ['.verify-harness/index.html'] },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 200 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

try {
  await page.goto('http://127.0.0.1:4793/.verify-harness/index.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('.project-tab[data-vault="bug"]', { timeout: 15_000 });

  check('harness mounted the real ProjectTabs with no page errors', pageErrors.length === 0, pageErrors[0]);

  /* ── C0 — the rollup half, before anything is drawn ────────────────────────────────
     The bug was a MISCOUNT that the strip then faithfully rendered, so the numbers the real
     `rollupProject` handed the component are worth naming on their own: if this check fails,
     every DOM check below is drawing the wrong thing correctly. */
  const rolled = await page.evaluate(() => window.__chips);
  const bugRollup = rolled.find((c) => c.vault === 'bug');
  check(
    'C0 the real rollupProject counts a working-and-unseen chat as working, flagged separately',
    bugRollup.working === 1 && bugRollup.asking === 0 && bugRollup.flagged === 1 && bugRollup.live === 1,
    JSON.stringify(bugRollup),
  );
  const mixedRollup = rolled.find((c) => c.vault === 'mixed');
  check(
    'C0b a six-session project rolls up to 1 asking / 2 working / 1 idle / 1 unseen, 4 live, 5 alive',
    mixedRollup.asking === 1 && mixedRollup.working === 2 && mixedRollup.idle === 1
      && mixedRollup.flagged === 1 && mixedRollup.live === 4 && mixedRollup.alive === 5,
    JSON.stringify(mixedRollup),
  );

  /** Every bubble on one chip, in DOM order, with its state and computed background. */
  const readChip = (vault) => page.evaluate((v) => {
    const chip = document.querySelector(`.project-tab[data-vault="${v}"]`);
    if (!chip) return null;
    const bubbles = [...chip.querySelectorAll('.project-tab-bubble')].map((b) => ({
      state: b.getAttribute('data-state'),
      n: b.querySelector('.project-tab-bubble-n')?.textContent,
      ring: !!b.querySelector('.project-tab-bubble-ring'),
      bg: getComputedStyle(b).backgroundColor,
    }));
    const flag = chip.querySelector('.project-tab-flag');
    return {
      kind: chip.getAttribute('data-kind'),
      bubbles,
      flags: chip.querySelectorAll('.project-tab-flag').length,
      flagBg: flag ? getComputedStyle(flag).backgroundColor : null,
      label: chip.querySelector('.project-tab-main')?.getAttribute('aria-label'),
    };
  }, vault);

  const bug = await readChip('bug');
  const blocked = await readChip('blocked');
  const mixed = await readChip('mixed');
  const quiet = await readChip('quiet');

  // ── C1/C2/C3 — the reported bug, inverted ────────────────────────────────────────
  const bugStates = bug.bubbles.map((b) => b.state);
  check(
    'C1 a working-and-unseen chat draws the WORKING bubble, not the asking one',
    bugStates.length === 1 && bugStates[0] === 'working' && bug.bubbles[0].n === '1',
    `bubbles: ${JSON.stringify(bugStates)}`,
  );
  check(
    'C2 that working bubble carries the loading ring (the progress mark)',
    bug.bubbles[0]?.ring === true,
  );
  check(
    'C3 the unseen flag draws its own separate dot beside it',
    bug.flags === 1,
    `flag dots: ${bug.flags}`,
  );

  // ── C4/C5 — the urgent state still exists, and is drawn once ─────────────────────
  check(
    'C4 a genuinely blocked chat still draws the magenta asking bubble',
    blocked.bubbles.length === 1 && blocked.bubbles[0].state === 'asking',
    `bubbles: ${JSON.stringify(blocked.bubbles.map((b) => b.state))}`,
  );
  check('C5 an asking chat draws no second dot', blocked.flags === 0);

  // ── C6 — fixed order, whatever the counts ────────────────────────────────────────
  check(
    'C6 bubbles are drawn asking▸working▸idle with their counts',
    JSON.stringify(mixed.bubbles.map((b) => `${b.state}:${b.n}`)) === JSON.stringify(['asking:1', 'working:2', 'idle:1']),
    JSON.stringify(mixed.bubbles.map((b) => `${b.state}:${b.n}`)),
  );
  check('C6b only the working bubble rings', mixed.bubbles.filter((b) => b.ring).length === 1);
  check('C6c the mixed chip also carries its unseen dot', mixed.flags === 1);

  // ── C7 — a quiet project stays a bare name ───────────────────────────────────────
  check(
    'C7 a project with no live chats draws no bubbles and no dot',
    quiet.bubbles.length === 0 && quiet.flags === 0,
  );

  // ── C8 — the symptom was a colour, so assert the pixels ──────────────────────────
  const askingBg = blocked.bubbles[0]?.bg;
  const workingBg = bug.bubbles[0]?.bg;
  check(
    'C8 the working bubble is NOT painted the asking magenta',
    !!askingBg && !!workingBg && askingBg !== workingBg,
    `asking ${askingBg} vs working ${workingBg}`,
  );
  check(
    'C8b the asking bubble really is the magenta token (#ff5fc4), not an empty var',
    askingBg === 'rgb(255, 95, 196)',
    askingBg,
  );
  check(
    'C8c the unseen dot uses that same magenta — one signal, one colour',
    bug.flagBg === 'rgb(255, 95, 196)',
    bug.flagBg,
  );
  check(
    'C8d the label says the state in words, not by colour alone',
    bug.label === 'bug — 1 working — 1 unseen',
    bug.label,
  );

  await page.screenshot({ path: SHOT });

  /* ── N — "a project with a pending question shakes" ───────────────────────────────
     The motion is the whole feature here, so it is read off `getComputedStyle`'s live
     `animation-name` rather than off the attribute that triggers it: an attribute proves the
     component's intent, and only the computed style proves the stylesheet agreed. */
  const motionOf = (vault) => page.evaluate((v) => {
    const chip = document.querySelector(`.project-tab[data-vault="${v}"]`);
    const cs = getComputedStyle(chip);
    return {
      asking: chip.getAttribute('data-asking'),
      bouncing: chip.getAttribute('data-bouncing'),
      animation: cs.animationName,
      iterations: cs.animationIterationCount,
      duration: cs.animationDuration,
    };
  }, vault);

  const blockedMotion = await motionOf('blocked');
  check(
    'N1 a chip with a pending question runs the repeating Dock bounce',
    blockedMotion.animation === 'projectTabDockBounce' && blockedMotion.iterations === 'infinite',
    JSON.stringify(blockedMotion),
  );
  check(
    'N1b on a 1.6s beat — near the Dock\'s own, not a constant vibration',
    blockedMotion.duration === '1.6s',
    blockedMotion.duration,
  );
  const mixedMotion = await motionOf('mixed');
  check(
    'N2 a project whose question is one chat among six still bounces',
    mixedMotion.animation === 'projectTabDockBounce',
    JSON.stringify(mixedMotion),
  );
  // The reported case must NOT shake: working is not blocked, and a strip that shook for a
  // busy agent would be back to crying wolf — the exact failure the bubbles were fixed for.
  const bugMotion = await motionOf('bug');
  check(
    'N3 a working (not blocked) chat does NOT bounce',
    bugMotion.animation === 'none' && bugMotion.asking === null,
    JSON.stringify(bugMotion),
  );
  check('N3b a quiet project does not bounce', (await motionOf('quiet')).animation === 'none');

  /* ── N3c — THE APEX IS NOT CLIPPED ────────────────────────────────────────────────
     The one check that had to exist for a VERTICAL motion here. `.project-tabs` scrolls
     horizontally, and a scrollable axis forces the other one out of `visible`, so the strip is
     a clip box on exactly the axis the chip now travels along. Measured at the apex rather
     than reasoned about: the animation is paused and seeked there with a negative delay, then
     the chip's own rect is compared against the strip's. A regression here is silent — the
     chip would simply have its top shaved off mid-jump. */
  const apex = await page.evaluate(() => {
    const chip = document.querySelector('.project-tab[data-vault="blocked"]');
    const strip = document.querySelector('.project-tabs');
    // Seeked through the Web Animations API, not by mutating `animation-delay`: the running
    // animation must be sampled at two KNOWN phases, and a paused clock with an explicit
    // `currentTime` is the only way to read both deterministically.
    const anim = chip.getAnimations().find((a) => a.animationName === 'projectTabDockBounce');
    if (!anim) return { missing: true };
    anim.pause();
    anim.currentTime = 1200;                 // 75% — inside the rest, chip on the floor
    const rest = chip.getBoundingClientRect();
    anim.currentTime = 320;                  // 20% — inside the 18–22% hang, chip at the apex
    const top = chip.getBoundingClientRect();
    const s = strip.getBoundingClientRect();
    anim.play();
    return { chipTop: top.top, stripTop: s.top, rise: rest.top - top.top };
  });
  check(
    'N3c the chip actually rises at the apex (the keyframes are running, not just declared)',
    apex.rise > 5.5 && apex.rise < 6.5,
    `rose ${apex.rise.toFixed(2)}px`,
  );
  check(
    'N3c2 and the apex clears the strip\'s clip box — no shaved-off chip mid-jump',
    apex.chipTop >= apex.stripTop,
    `chip top ${apex.chipTop.toFixed(2)} vs strip clip top ${apex.stripTop.toFixed(2)}`,
  );

  // ── N4 — the ACTIVE chip shakes too ──────────────────────────────────────────────
  // Deliberate, and the one place this parts from the bounce: a project holds many chats, so
  // "you are looking at this project" does not mean you are looking at the blocked chat.
  await page.evaluate(() => window.__setScenarios([
    { vault: 'bug', active: true, sessions: [{ status: 'open', asking: true }] },
  ]));
  await page.waitForTimeout(50);
  check(
    'N4 the ACTIVE project bounces when one of its chats is blocked',
    (await motionOf('bug')).animation === "projectTabDockBounce",
  );

  // ── N5 — hover stops it ──────────────────────────────────────────────────────────
  await page.hover('.project-tab[data-vault="bug"]');
  check('N5 hovering the chip stops the bounce', (await motionOf('bug')).animation === 'none');
  await page.mouse.move(0, 0);

  /* ── N6 — the bounce hands over to the nudge, and never stacks ────────────────────
     Driven as a real transition: a background project's SHELL rings its bell (one-shot
     bounce), and then one of its chats asks a question. If the bounce flag survived that, two
     animations would be competing for `transform` and which one won would depend on
     stylesheet order rather than on intent. */
  await page.evaluate(() => window.__setScenarios([
    { vault: 'other', active: true, sessions: [] },
    { vault: 'bg', active: false, sessions: [{ status: 'open', kind: 'shell' }] },
  ]));
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__setScenarios([
    { vault: 'other', active: true, sessions: [] },
    { vault: 'bg', active: false, sessions: [{ status: 'open', kind: 'shell', attention: true }] },
  ]));
  await page.waitForTimeout(50);
  const bounced = await motionOf('bg');
  check(
    'N6 a background bell (no question) still fires the one-shot bounce',
    bounced.bouncing === 'true' && bounced.animation === 'projectTabBounce',
    JSON.stringify(bounced),
  );
  await page.evaluate(() => window.__setScenarios([
    { vault: 'other', active: true, sessions: [] },
    { vault: 'bg', active: false, sessions: [{ status: 'open', kind: 'shell', attention: true }, { status: 'open', asking: true }] },
  ]));
  await page.waitForTimeout(50);
  const handed = await motionOf('bg');
  check(
    'N6b when a question then lands, the bounce is dropped and the Dock bounce takes over',
    handed.bouncing === 'false' && handed.asking === 'true' && handed.animation === "projectTabDockBounce",
    JSON.stringify(handed),
  );

  // ── N7 — reduced motion ──────────────────────────────────────────────────────────
  // The shake was only ever an amplifier: the filled magenta bubble is the actual signal and
  // must survive its removal, or the alarm would live in the animation alone.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(50);
  const reduced = await motionOf('bg');
  const reducedBubbles = await page.evaluate(() =>
    [...document.querySelectorAll('.project-tab[data-vault="bg"] .project-tab-bubble')].map((b) => b.getAttribute('data-state')));
  check(
    'N7 prefers-reduced-motion silences the bounce but keeps the asking state drawn',
    reduced.animation === 'none' && reduced.asking === 'true' && reducedBubbles.includes('asking'),
    `${JSON.stringify(reduced)} bubbles=${JSON.stringify(reducedBubbles)}`,
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  console.log(`\nscreenshot: ${SHOT}`);
} finally {
  await browser.close();
  await server.close();
  rmSync(HARNESS, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
