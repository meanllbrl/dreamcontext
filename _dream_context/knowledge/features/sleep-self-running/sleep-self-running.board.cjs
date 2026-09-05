const path = require('path');
const SKILL = path.resolve(__dirname, '../../../../.claude/skills/excalidraw/scripts');
const { buildExcalidraw } = require(path.join(SKILL, 'build_excalidraw.js'));
const S = require(path.join(SKILL, 'lib/style.js'));
const C = require(path.join(SKILL, 'lib/charts.js'));

const { stack, row, sectionTitle, takeaway, prose, card, node, column } = S;
const { callout, kpi, table, barCompare } = C;

const P = [];
const push = (els) => { P.push(...els); return els; };

// ─── HEADER ──────────────────────────────────────────────────────────────────
const head = stack({ x: 80, y: 60, gap: 26, items: [
  (x, y) => sectionTitle({ x, y, text: 'Sleep, four ways', fontSize: 46 }),
  (x, y) => takeaway({ x, y, width: 820, label: 'IN A NUTSHELL',
    text: 'The brain now **consolidates itself in the background** — on thresholds you set, with a bar against junk tasks, and locks so it can never overwrite what you are working on.' }),
  (x, y) => row({ x, y, gap: 20, items: [
    (px, py) => kpi({ x: px, y: py, w: 210, label: 'Debt, real cycle', value: '61 → 14', delta: 'down', color: 'green' }),
    (px, py) => kpi({ x: px, y: py, w: 210, label: 'Tests', value: '8 882', delta: 'up', color: 'blue' }),
    (px, py) => kpi({ x: px, y: py, w: 210, label: 'Criteria met', value: '18/18', color: 'mint' }),
    (px, py) => kpi({ x: px, y: py, w: 210, label: 'Bugs found', value: '7', color: 'red' }),
  ] }),
] });
push(head);

let Y = head.nextY + 90;

// ─── 1 · TUNABLE SETTINGS ────────────────────────────────────────────────────
const t1 = stack({ x: 80, y: Y, gap: 24, items: [
  (x, y) => sectionTitle({ x, y, text: '1 · Sleep settings you can tune', fontSize: 32 }),
  (x, y) => prose({ x, y, width: 620, text: 'The debt ladder and the model each specialist runs on used to be **constants in the source**. They are now per-brain settings, read from one place by the hook, the CLI, the API and the dashboard.' }),
] });
push(t1);

const ladder = row({ x: 80, y: t1.nextY + 20, gap: 46, valign: 'top', items: [
  (x, y) => stack({ x, y, gap: 12, items: [
    (px, py) => prose({ x: px, y: py, width: 320, fontSize: 15, text: 'THE LADDER — defaults, not constants' }),
    (px, py) => card({ x: px, y: py, w: 320, h: 56, text: 'Alert 0–23 · say nothing', color: 'gray', fontSize: 16 }),
    (px, py) => card({ x: px, y: py, w: 320, h: 56, text: 'Drowsy 24 · offer after the task', color: 'mint', fontSize: 16 }),
    (px, py) => card({ x: px, y: py, w: 320, h: 56, text: 'Sleepy 40 · recommend it', color: 'yellow', fontSize: 16 }),
    (px, py) => card({ x: px, y: py, w: 320, h: 56, text: 'Must Sleep 60 · required', color: 'red', fontSize: 16 }),
    (px, py) => prose({ x: px, y: py, width: 320, fontSize: 14,
      text: 'Derived from Must Sleep: deep-op authority ×1.5, cooldown override ×2. A ladder that does not increase is refused at write time.' }),
  ] }),
  (x, y) => stack({ x, y, gap: 14, items: [
    (px, py) => prose({ x: px, y: py, width: 460, fontSize: 15, text: 'WHO RUNS ON WHAT — injected into the agent file' }),
    (px, py) => table({ x: px, y: py, headers: ['specialist', 'model', 'effort'], align: ['left', 'left', 'left'], rows: [
      ['sleep-tasks', { text: 'opus-5', color: 'purple' }, 'medium'],
      ['sleep-product', { text: 'opus-5', color: 'purple' }, 'medium'],
      ['sleep-state', { text: 'sonnet-5', color: 'blue' }, 'low'],
      ['sleep-migration', { text: 'sonnet-5', color: 'blue' }, 'low'],
      ['sleep-federation', { text: 'sonnet-5', color: 'blue' }, 'low'],
      ['sleep-learn', { text: 'sonnet-5', color: 'blue' }, 'low'],
    ] }),
    (px, py) => callout({ x: px, y: py, w: 460, color: 'green', title: 'Survives install',
      lead: 'The choice is written into the agent frontmatter at **every** install site.',
      items: ['Proven: an override survived a real ==update --core-only== (21 files).',
        'The ones that judge get Opus; the ones that reconcile get Sonnet.'] }),
  ] }),
] });
push(ladder);

Y = ladder.nextY + 90;

// ─── 2 · THE FILING BAR ──────────────────────────────────────────────────────
const t2 = stack({ x: 80, y: Y, gap: 24, items: [
  (x, y) => sectionTitle({ x, y, text: '2 · A bar against junk tasks', fontSize: 32 }),
  (x, y) => prose({ x, y, width: 620, text: 'You said sleep opened tasks nobody asked for. An audit of **all 116 tasks** filed since August found something more precise: 115 were well justified, and ==exactly one== had none at all — the same chore, resurrected every cycle.' }),
] });
push(t2);

const audit = row({ x: 80, y: t2.nextY + 20, gap: 46, valign: 'top', items: [
  (x, y) => barCompare({ x, y, w: 470, h: 300, seriesLabels: ['chars of justification'],
    groups: [
      { label: 'median', values: [2532] },
      { label: 'thinnest real', values: [146] },
      { label: 'the bar', values: [40] },
      { label: 'the junk one', values: [0] },
    ] }),
  (x, y) => stack({ x, y, gap: 16, items: [
    (px, py) => callout({ x: px, y: py, w: 430, color: 'yellow', title: 'What that means',
      lead: 'The number is a **floor against the empty template**, not a quality judge.',
      items: ['Real tasks sit 3–60× above it — the bar never touches them.',
        'Quality stays the prompt\'s job.'] }),
    (px, py) => callout({ x: px, y: py, w: 430, color: 'blue', title: 'The real fix',
      lead: 'It was a **repetition** problem, not a volume one.',
      items: ['A merged-away task now leaves a ==tombstone==.',
        'Re-filing it is refused, and points at what absorbed it.'] }),
  ] }),
] });
push(audit);

const gates = row({ x: 80, y: audit.nextY + 40, gap: 30, valign: 'middle', items: [
  (x, y) => card({ x, y, w: 150, h: 78, text: 'candidate', color: 'gray', fontSize: 16 }),
  (x, y) => node({ x, y, w: 168, h: 78, text: 'names a user,\nfriction, cost', color: 'blue', fontSize: 14 }),
  (x, y) => node({ x, y, w: 168, h: 78, text: 'has a next\nstep', color: 'blue', fontSize: 14 }),
  (x, y) => node({ x, y, w: 168, h: 78, text: 'no prior home\n(recall + tombstones)', color: 'blue', fontSize: 13 }),
  (x, y) => node({ x, y, w: 168, h: 78, text: 'under the\nper-cycle cap', color: 'blue', fontSize: 14 }),
  (x, y) => card({ x, y, w: 150, h: 78, text: 'filed', color: 'green', fontSize: 16 }),
] });
push(gates);
push(prose({ x: 80, y: gates.nextY + 40, width: 560, fontSize: 15,
  text: 'Any gate that fails refuses with the rule it broke. A person is never blocked — `--by human` always passes, and the refusal says so.' }));

Y = gates.nextY + 140;

// ─── 3 · TWO-WRITER SAFETY ───────────────────────────────────────────────────
const t3 = stack({ x: 80, y: Y, gap: 24, items: [
  (x, y) => sectionTitle({ x, y, text: '3 · Two writers, one brain', fontSize: 32 }),
  (x, y) => prose({ x, y, width: 620, text: 'A background cycle, and you editing at the same time. Every task write is a read-modify-write: interleave two and one side vanishes — **silently**, because a lost write throws nothing.' }),
] });
push(t3);

const locks = row({ x: 80, y: t3.nextY + 24, gap: 40, valign: 'top', items: [
  (x, y) => stack({ x, y, gap: 18, items: [
    (px, py) => row({ x: px, y: py, gap: 26, valign: 'middle', items: [
      (ax, ay) => card({ x: ax, y: ay, w: 190, h: 74, text: 'you, in the app', color: 'purple', fontSize: 16 }),
      (ax, ay) => card({ x: ax, y: ay, w: 150, h: 74, text: 'per-file lock', color: 'yellow', fontSize: 15 }),
      (ax, ay) => card({ x: ax, y: ay, w: 190, h: 74, text: 'one task file', color: 'mint', fontSize: 16 }),
    ] }),
    (px, py) => row({ x: px, y: py, gap: 26, valign: 'middle', items: [
      (ax, ay) => card({ x: ax, y: ay, w: 190, h: 74, text: 'background cycle', color: 'blue', fontSize: 16 }),
      (ax, ay) => card({ x: ax, y: ay, w: 150, h: 74, text: 'waits, then writes', color: 'gray', fontSize: 14 }),
      (ax, ay) => card({ x: ax, y: ay, w: 190, h: 74, text: 'nothing lost', color: 'green', fontSize: 16 }),
    ] }),
  ] }),
  (x, y) => callout({ x, y, w: 430, color: 'green', title: 'Proved, not argued',
    lead: 'Two real processes wrote ==50 log entries each== to the same task.',
    items: ['All **100** survived, frontmatter intact.',
      'The cycle is also told which tasks you have open, and defers them.'] }),
] });
push(locks);

Y = locks.nextY + 90;

// ─── 4 · BACKGROUND AUTO-SLEEP ───────────────────────────────────────────────
const t4 = stack({ x: 80, y: Y, gap: 24, items: [
  (x, y) => sectionTitle({ x, y, text: '4 · It sleeps by itself', fontSize: 32 }),
  (x, y) => prose({ x, y, width: 620, text: 'Turn it on for **this machine** and the nagging stops entirely. At the end of a turn, if debt is over your trigger, a headless session runs the whole cycle in the background while you keep working.' }),
] });
push(t4);

const autoRow = row({ x: 80, y: t4.nextY + 24, gap: 44, valign: 'top', items: [
  (x, y) => stack({ x, y, gap: 16, items: [
    (px, py) => prose({ x: px, y: py, width: 400, fontSize: 15, text: 'SEVEN REASONS IT WILL NOT START' }),
    (px, py) => column({ x: px, y: py, items: [
      { text: 'off for this machine', color: 'gray' },
      { text: 'debt below your trigger', color: 'gray' },
      { text: 'still cooling down', color: 'gray' },
      { text: 'a sleep already holds the epoch', color: 'gray' },
      { text: 'a background job is alive', color: 'gray' },
      { text: 'settings changed since you approved', color: 'red' },
      { text: 'we are already inside one', color: 'red' },
    ] }),
  ] }),
  (x, y) => stack({ x, y, gap: 16, items: [
    (px, py) => callout({ x: px, y: py, w: 440, color: 'purple', title: 'Consent is a fingerprint',
      lead: 'Approving is not a **boolean** — it covers what you actually approved.',
      items: ['Models, the cap, the trigger, and the six agent files.',
        'Change any of them and it ==pauses== and says so.',
        'A routine `dreamcontext update` does not pause it.'] }),
    (px, py) => callout({ x: px, y: py, w: 440, color: 'green', title: 'What a real cycle did',
      lead: 'Dispatched by the Stop hook, ran **13 minutes**, closed clean.',
      items: ['Specialists ran on the configured models — read from their transcripts.',
        'It deferred the task I had open, and said so in its report.',
        'My foreground edit was still there afterwards.'] }),
  ] }),
] });
push(autoRow);

Y = autoRow.nextY + 90;

// ─── CLOSING ─────────────────────────────────────────────────────────────────
const close = stack({ x: 80, y: Y, gap: 22, items: [
  (x, y) => sectionTitle({ x, y, text: 'Turning it on', fontSize: 30 }),
  (x, y) => row({ x, y, gap: 22, valign: 'top', items: [
    (px, py) => callout({ x: px, y: py, w: 430, color: 'blue', title: 'Tune it',
      items: ['`dreamcontext sleep config` — everything in force.',
        '`sleep config set thresholds.must-sleep 45`',
        '`sleep config set specialists.sleep-tasks.model opus`',
        'Or the new **Settings › Sleep** tab.'] }),
    (px, py) => callout({ x: px, y: py, w: 430, color: 'purple', title: 'Hand it the keys',
      items: ['`dreamcontext sleep auto on` — off by default, machine-local.',
        '`sleep auto status` — armed? paused? running?',
        '`sleep auto cancel` — stop one; it asks first.'] }),
  ] }),
  (x, y) => takeaway({ x, y, width: 820, accent: 'green', label: 'THE POINT',
    text: 'You stop being asked to remember. The brain keeps itself, on your terms, and stays out of the way of whatever you are holding.' }),
] });
push(close);

buildExcalidraw({
  out: path.resolve(__dirname, 'sleep-self-running.excalidraw.md'),
  name: 'sleep-self-running',
  tags: ['topic:sleep', 'kind:architecture', 'excalidraw'],
  description: 'The four capabilities shipped in the sleep umbrella (v0.26.3): per-brain tunable sleep settings (debt ladder plus per-specialist model/effort injected into agent frontmatter and surviving install), a deterministic filing bar and a tombstone ledger that stop sleep re-filing junk or merged-away tasks, per-file locks and a hands-off set so a background cycle and the foreground user cannot lose each other writes, and machine-local background auto-sleep dispatched by the Stop hook under a consent fingerprint. Includes the 116-task audit that reframed the junk-task complaint as a repetition problem, and evidence from a real validated background cycle.',
  elements: P,
});
