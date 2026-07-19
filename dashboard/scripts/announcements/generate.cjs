#!/usr/bin/env node
/**
 * Generates the announcement boards shipped with the dashboard.
 *
 * Announcements are landing-page-style Excalidraw boards (git-tracked, rendered
 * by the dashboard's ExcalidrawPreview) rather than markdown — one board per
 * entry in dashboard/public/announcements.json (matched by `id`).
 *
 * Every board tells the same three-act story so a reader FEELS what shipped:
 *   ① The problem  (red)   → ② The solution (blue) → ③ The proof (green)
 * with big momentum arrows between the acts and KPI tiles for the numbers.
 *
 * Source of truth: the SPECS array below. Deliverables: the generated
 * `<id>.excalidraw.md` boards under dashboard/public/announcements/. Only the
 * boards ship (this generator lives outside public/). Re-run after editing a
 * spec:  node dashboard/scripts/announcements/generate.cjs
 *
 * Boards are byte-stable for a given spec (seeds derive from the output path),
 * so they diff cleanly in git.
 */
const path = require('path');

const SKILL = path.resolve(__dirname, '../../../.claude/skills/excalidraw');
const { buildExcalidraw } = require(path.resolve(SKILL, 'scripts/build_excalidraw.js'));
const { sectionTitle, prose, chip, stack, row, PALETTE } = require(path.resolve(SKILL, 'scripts/lib/style.js'));
const { callout, kpi } = require(path.resolve(SKILL, 'scripts/lib/charts.js'));

const OUT_DIR = path.resolve(__dirname, '../../public/announcements');

// Landing-page geometry: three "act" columns side by side make a wide landscape
// board that reads as a journey (problem → solution → proof) and renders well in
// the dashboard's horizontal strip.
const MARGIN = 80;
const COL_W = 430;
const COL_GAP = 96; // wide enough to fit a momentum arrow in the gutter
const CARD_H = 148;
const SUBHEAD_W = 660; // body copy respects the reading measure; the headline doesn't

/** Hero block: version/date chip, big headline, one-line hook. */
function hero({ x, y, chipText, headline, hook }) {
  return stack({
    x, y, gap: 16, items: [
      (cx, cy) => chip({ x: cx, y: cy, text: chipText, color: 'purple' }),
      (cx, cy) => sectionTitle({ x: cx, y: cy, text: headline, fontSize: 48, maxWidth: COL_W * 3 }),
      (cx, cy) => prose({ x: cx, y: cy, text: hook, fontSize: 20, width: SUBHEAD_W }),
    ],
  });
}

/** One item inside an act column → a factory (x,y)=>els for stack(). */
function renderItem(it, w, actColor) {
  if (it.kind === 'kpis') {
    const n = it.tiles.length;
    const tileW = Math.round((w - 16 * (n - 1)) / n);
    return (x, y) => row({
      x, y, gap: 16, valign: 'top', items: it.tiles.map((t) => (cx, cy) => kpi({
        x: cx, y: cy, w: tileW, h: 112, label: t.label, value: t.value, delta: t.delta ?? null,
        color: t.color ?? actColor, valueSize: 30, labelSize: 12, deltaSize: 12,
      })),
    });
  }
  const color = it.color ?? actColor;
  return (x, y) => callout({
    x, y, w, title: it.title, text: it.text, color, fit: false,
    minH: it.minH ?? CARD_H, titleSize: 17, fontSize: 14,
  });
}

/** A vertical "act": a big colored kicker header, then its items. */
function actColumn({ x, y, w, kicker, color, items }) {
  const header = (cx, cy) => [{
    type: 'text', x: cx, y: cy, text: kicker, fontSize: 24, color: PALETTE[color].stroke, width: w,
  }];
  return stack({ x, y, gap: 18, items: [header, ...items.map((it) => renderItem(it, w, color))] });
}

/** A fat momentum arrow drawn in the gutter between two acts. */
function momentumArrow(fromX, toX, y) {
  return { type: 'arrow', points: [[fromX, y], [toX, y]], strokeColor: '#343a40', strokeWidth: 4, endArrow: true };
}

/** The three-act story: hero on top, problem → solution → proof across the width. */
function storyBoard({ chipText, headline, hook, problem, solution, proof }) {
  const h = hero({ x: MARGIN, y: 70, chipText, headline, hook });
  const actsY = h.nextY + 52;
  const xs = [MARGIN, MARGIN + COL_W + COL_GAP, MARGIN + 2 * (COL_W + COL_GAP)];

  const acts = [
    actColumn({ x: xs[0], y: actsY, w: COL_W, kicker: '①  The problem', color: 'red', items: problem }),
    actColumn({ x: xs[1], y: actsY, w: COL_W, kicker: '②  The solution', color: 'blue', items: solution }),
    actColumn({ x: xs[2], y: actsY, w: COL_W, kicker: '③  The proof', color: 'green', items: proof }),
  ];

  const arrowY = actsY + 132;
  const arrows = [
    momentumArrow(xs[0] + COL_W + 14, xs[1] - 14, arrowY),
    momentumArrow(xs[1] + COL_W + 14, xs[2] - 14, arrowY),
  ];

  return [...h, ...acts.flat(), ...arrows];
}

const SPECS = [
  {
    id: 'visual-announcements',
    name: 'Announcement — Announcements, redrawn',
    description: "What's New became a wall of git-tracked Excalidraw landing pages that tell a problem → solution → proof story.",
    build: () => storyBoard({
      chipText: 'v0.19.0  ·  2026-07-19',
      headline: 'Announcements, redrawn',
      hook: 'Release notes should make you feel what shipped — not make you read a changelog.',
      problem: [
        { title: 'A wall of markdown', text: 'Every update was text you skim and forget — no flow, no before/after, no picture.' },
        { title: 'You miss what shipped', text: 'The best features hid inside paragraphs nobody finished reading.' },
      ],
      solution: [
        { title: 'Every update is a board', text: 'Hand-built Excalidraw landing pages — hero, story, diagram — rendered live in the dashboard.', color: 'purple' },
        { title: 'Git-tracked & reproducible', text: 'Each board regenerates from one spec, so it diffs cleanly and never drifts.' },
        { title: 'Pinned where it belongs', text: 'Announcements sit at the foot of the sidebar — news about dreamcontext itself.' },
      ],
      proof: [
        { kind: 'kpis', tiles: [
          { label: 'Boards shipped', value: '4' },
          { label: 'Audit defects', value: '0', delta: 'overlaps · long lines' },
        ] },
        { title: '✓ One command to publish', text: 'Run the generator and every board rebuilds, byte-stable. Add an entry, ship a picture.', color: 'mint', minH: 130 },
      ],
    }),
  },
  {
    id: 'task-manager',
    name: 'Announcement — The Task Manager',
    description: 'Every task gets its own live Claude session that keeps the document honest — problem → solution → proof.',
    build: () => storyBoard({
      chipText: 'v0.18.0  ·  2026-07-17',
      headline: 'The Task Manager',
      hook: 'Every task gets its own live Claude session that keeps the document honest — it maintains, it never writes your product code.',
      problem: [
        { title: 'Tasks drift from reality', text: 'The doc said one thing; the repo did another. Status quietly lied.' },
        { title: 'You maintained it by hand', text: 'Rewriting, summarizing and splitting tasks was slow, manual work.' },
      ],
      solution: [
        { title: 'A session inside the task', text: 'A Claude Code session is pinned in the task view, driven by the task-manager skill.', color: 'purple' },
        { title: 'It maintains, never implements', text: 'Rewrites sections, summarizes history, splits oversized tasks, reconciles status.' },
        { title: 'Comment on the document', text: 'Select any span and attach an anchored comment the manager sees exactly.' },
      ],
      proof: [
        { title: '✓ Survives navigation', text: 'The terminal is re-parented, not recreated — leave, come back, still mid-thought.' },
        { title: '✓ Safe by design', text: 'Opt-in, bypass perms, edits only the task doc — with a live diff before you accept.', color: 'mint' },
      ],
    }),
  },
  {
    id: 'dashboard-highlights-0-17-0-18',
    name: 'Announcement — The rough edges, smoothed',
    description: 'The 0.17 → 0.18 quality-of-life pass, told as problem → solution → proof.',
    build: () => storyBoard({
      chipText: 'v0.18.0  ·  2026-07-16',
      headline: 'The rough edges, smoothed',
      hook: "0.17 → 0.18 wasn't one headline — it was a dozen small frictions, gone.",
      problem: [
        { title: 'Sessions vanished', text: 'Minimize an agent and it disappeared — you lost your place.' },
        { title: 'Sleep duplicated knowledge', text: '"The same thing, said differently" spawned a new file every time.' },
        { title: 'The numbers lied', text: 'Session cost was inflated ~7.6× by double-counting.' },
      ],
      solution: [
        { title: 'The living dock', text: 'Minimized sessions dock into corner chips — still running, live state, one click back.', color: 'purple' },
        { title: 'Sleep merges, not forks', text: 'A semantic near-duplicate gate folds new insight into the existing file.' },
        { title: 'Delegate from the board', text: 'Task cards hand work to Claude in one click; onboarding can clone from GitHub.' },
      ],
      proof: [
        { kind: 'kpis', tiles: [
          { label: 'Cost reporting', value: '7.6×→1×', delta: 'inflation gone' },
          { label: 'Knowledge', value: 'by meaning', delta: 'not by count', color: 'mint' },
        ] },
        { title: '✓ Native clipboard', text: 'Turkish copied from the in-app terminal no longer arrives as mojibake.', color: 'mint', minH: 130 },
      ],
    }),
  },
  {
    id: 'goal-skill-v2',
    name: 'Announcement — Goal-Skill v2',
    description: 'Fork the builders, keep the judges clean — the goal orchestrator rewrite as problem → solution → proof.',
    build: () => storyBoard({
      chipText: 'v0.18.0  ·  2026-07-18',
      headline: 'Goal-Skill v2',
      hook: 'Fork the builders. Keep the judges clean. Ship big goals without the token burn.',
      problem: [
        { title: "One pass isn't enough", text: 'Big or risky goals fail on a single straight-line attempt.' },
        { title: 'Builders re-explore', text: 'Every round re-read the codebase from scratch — tokens up in smoke.' },
        { title: 'Judges rubber-stamp', text: "A reviewer that inherits the builder's framing tends to agree with it." },
      ],
      solution: [
        { title: 'Fork the builders', text: 'Planner + implementers are resumable; each fork inherits context at cache-read price.', color: 'purple' },
        { title: 'Keep the judges fresh', text: 'Reviewers and the validator arrive cold every round — never forked, never resumed.' },
        { title: 'Ceremony scales S / M / L', text: 'Small goals skip review; auth, crypto, secrets and migrations always escalate.' },
      ],
      proof: [
        { kind: 'kpis', tiles: [
          { label: 'End to end', value: '~45 min', delta: 'vs ~1.5 h' },
          { label: 'Plan converged', value: '3 rounds' },
        ] },
        { title: '✓ Dogfooded on itself', text: '7 implementers forked from the planner and ran in parallel — every criterion validated before ship.', color: 'mint', minH: 130 },
      ],
    }),
  },
];

for (const spec of SPECS) {
  buildExcalidraw({
    out: path.resolve(OUT_DIR, `${spec.id}.excalidraw.md`),
    name: spec.name,
    description: spec.description,
    tags: ['announcement', 'excalidraw'],
    background: '#ffffff',
    elements: spec.build(),
  });
  console.log('wrote', `${spec.id}.excalidraw.md`);
}
