const path = require('path');

const { buildExcalidraw } = require(path.resolve(__dirname, '../../.claude/skills/excalidraw/scripts/build_excalidraw.js'));
const {
  card,
  sectionTitle,
  connector,
  bullets,
  rightOf,
  leftOf,
  bottomOf,
  topOf,
} = require(path.resolve(__dirname, '../../.claude/skills/excalidraw/scripts/lib/style.js'));

const ROOT = path.resolve(__dirname, '..');
const out = path.resolve(ROOT, 'PrePublish-Test-Case-Map.excalidraw.md');

const elements = [];

elements.push(
  ...sectionTitle({
    x: 40,
    y: 30,
    text: 'v0.8.3 Pre-Publish Test Case Map',
    fontSize: 44,
  }),
  ...bullets({
    x: 46,
    y: 92,
    width: 1020,
    fontSize: 20,
    items: [
      'Reviewed window: 2026-06-05 -> 2026-06-14',
      'Diff source: b924fa5..HEAD, 601 files, 69k insertions, 79k deletions',
      'Goal: test what changed fast, find blockers before npm publish',
    ],
  })
);

const gates = { x: 80, y: 190, w: 260, h: 96, text: '1. Blocker Gates\nbuild, tests, pack, CLI smoke', color: 'red' };
const core = { x: 450, y: 190, w: 260, h: 96, text: '2. Core Vault\nsetup, init, snapshot, doctor', color: 'blue' };
const tasks = { x: 820, y: 190, w: 260, h: 96, text: '3. Tasks\nlocal + ClickUp backend', color: 'yellow' };
const knowledge = { x: 1190, y: 190, w: 260, h: 96, text: '4. Knowledge\nSQL, diagrams, fullscreen', color: 'mint' };
const federation = { x: 80, y: 390, w: 260, h: 96, text: '5. Federation\nvaults, recall, digest inbox', color: 'purple' };
const dashboard = { x: 450, y: 390, w: 260, h: 96, text: '6. Dashboard UI\ntasks, taxonomy, settings', color: 'blue' };
const desktop = { x: 820, y: 390, w: 260, h: 96, text: '7. Desktop App\nlauncher, onboarding, app update', color: 'green' };
const sleepy = { x: 1190, y: 390, w: 260, h: 96, text: '8. Sleepy Notch\nAsk, Learn, Sleep, mascot', color: 'yellow' };
const graph = { x: 80, y: 590, w: 260, h: 96, text: '9. Launcher Graph\nstatus dots, drag-connect', color: 'purple' };
const sleep = { x: 450, y: 590, w: 260, h: 96, text: '10. Sleep Quality\ndedup, eval, migration signals', color: 'mint' };
const release = { x: 820, y: 590, w: 260, h: 96, text: '11. Release\ninstall, upgrade, publish', color: 'red' };
const decision = { x: 1190, y: 590, w: 260, h: 96, text: 'Publish Decision\nGo / No-go / Go with risks', color: 'green' };

const nodes = [gates, core, tasks, knowledge, federation, dashboard, desktop, sleepy, graph, sleep, release, decision];
for (const n of nodes) elements.push(...card(n));

const links = [
  [gates, core, 'green gates'],
  [core, tasks, 'vault ready'],
  [tasks, knowledge, 'data paths'],
  [knowledge, federation, 'knowledge moves'],
  [federation, dashboard, 'control plane'],
  [dashboard, desktop, 'same surfaces'],
  [desktop, sleepy, 'desktop shell'],
  [sleepy, graph, 'launcher state'],
  [graph, sleep, 'signals'],
  [sleep, release, 'quality bar'],
  [release, decision, 'ship call'],
];

for (const [from, to, label] of links) {
  const fromPoint = from.y === to.y ? rightOf(from.x, from.y, from.w, from.h) : bottomOf(from.x, from.y, from.w, from.h);
  const toPoint = from.y === to.y ? leftOf(to.x, to.y, to.w, to.h) : topOf(to.x, to.y, to.w, to.h);
  elements.push(...connector({ from: fromPoint, to: toPoint, label }));
}

elements.push(
  ...sectionTitle({ x: 80, y: 780, text: 'Commit Groups -> Manual Coverage', fontSize: 34 }),
  ...card({
    x: 80,
    y: 850,
    w: 300,
    h: 160,
    color: 'paleBlue',
    fontSize: 18,
    text: 'Tasks + ClickUp\n2e6a48a, 649a999,\n829d6c2 -> 2e9cc0c\n\nRun sections 3 + 10',
  }),
  ...card({
    x: 420,
    y: 850,
    w: 300,
    h: 160,
    color: 'palePurple',
    fontSize: 18,
    text: 'Federation\n971ef7f, ba20011,\nf1e3b16, f46ff98\n\nRun section 7',
  }),
  ...card({
    x: 760,
    y: 850,
    w: 300,
    h: 160,
    color: 'paleGreen',
    fontSize: 18,
    text: 'Desktop + Onboarding\n79b9546, 737ad63,\nc7a6c8c, e3dda6d\n\nRun section 11',
  }),
  ...card({
    x: 1100,
    y: 850,
    w: 300,
    h: 160,
    color: 'yellow',
    fontSize: 18,
    text: 'Sleepy\n64a0899 -> 3bc0490\nAsk, Learn, Sleep\n\nRun section 12',
  }),
  ...card({
    x: 80,
    y: 1060,
    w: 300,
    h: 160,
    color: 'mint',
    fontSize: 18,
    text: 'Knowledge + Migrations\ne7bd1c5, 55a74e8,\n8b52232, cb96b44\n\nRun sections 6 + 8',
  }),
  ...card({
    x: 420,
    y: 1060,
    w: 300,
    h: 160,
    color: 'paleBlue',
    fontSize: 18,
    text: 'Recall + Snapshot\n5d05a63, 8dfb72b\nbudget, people, feedback\n\nRun section 9',
  }),
  ...card({
    x: 760,
    y: 1060,
    w: 300,
    h: 160,
    color: 'palePurple',
    fontSize: 18,
    text: 'Launcher Graph + Sleep QA\na41dc7b, e7dca76\nstatus dots, eval\n\nRun sections 13 + 14',
  }),
  ...card({
    x: 1100,
    y: 1060,
    w: 300,
    h: 160,
    color: 'red',
    fontSize: 18,
    text: 'Release\nApache license, install.sh,\nupgrade, npm pack\n\nRun sections 1 + 15',
  })
);

elements.push(
  ...sectionTitle({ x: 80, y: 1310, text: 'How to Use This Board', fontSize: 34 }),
  ...bullets({
    x: 90,
    y: 1380,
    width: 1320,
    fontSize: 22,
    items: [
      'Start at Blocker Gates. Do not continue if build, tests, or pack dry-run fail.',
      'Then follow the flow left-to-right. Each node points to the numbered section in docs/PRE-PUBLISH-TEST-PLAN.md.',
      'Use the commit cards to understand why each test exists and what recent code it protects.',
      'End with Release only after the Sleepy, Desktop, Federation, Tasks, and Sleep Quality lanes are manually checked.',
    ],
  })
);

buildExcalidraw({
  out,
  background: '#ffffff',
  elements,
});

console.log(`wrote ${out}`);
