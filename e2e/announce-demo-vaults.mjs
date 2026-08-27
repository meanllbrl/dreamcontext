/**
 * Stand up the DEMO VAULT SET every announcement screenshot is captured against.
 *
 * Why this exists: a What's New page ships inside the npm tarball and the desktop
 * bundle, so a screenshot taken on the author's real machine publishes whatever was
 * on that screen — client project names, a private task board, a peer product's
 * business description, the author's own name. That already happened five times
 * (v0.23.1, v0.24.0, v0.26.1). The fix is structural: the capture never sees the
 * real machine at all.
 *
 * How the isolation works: `listVaults()` resolves its registry under `homedir()`,
 * and Node's `os.homedir()` honours `$HOME` on POSIX. So a dashboard launched with
 * HOME pointed at the fake home below reads a registry that contains ONLY these
 * synthetic vaults. The real `~/.dreamcontext/vaults.json` is never opened, never
 * backed up and never restored — nothing to get wrong.
 *
 *   node e2e/announce-demo-vaults.mjs                # build the set (idempotent)
 *   node e2e/announce-demo-vaults.mjs --print-home   # just echo the fake HOME
 *
 * Then serve it and shoot:
 *   HOME=$(node e2e/announce-demo-vaults.mjs --print-home) \
 *     DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45778
 *
 * The names are deliberately fictional-but-plausible. A screenshot has to look like
 * somebody's real working set or it reads as a mock-up, and it must be impossible
 * to mistake for anyone's actual project.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.DEMO_BASE ?? '/tmp/dc-announce-demo';
const HOME = join(BASE, 'home');
const VAULTS = join(BASE, 'vaults');
const CLI = resolve('dist/index.js');

if (process.argv.includes('--print-home')) {
  console.log(HOME);
  process.exit(0);
}

/** The synthetic working set. `logo` is an SVG mark drawn inline — no binary fixtures
 *  to commit, and every vault wearing one is what the 0.26.1 story actually claims. */
const DEMO = [
  {
    name: 'acme-storefront',
    description: 'Customer-facing shop for the Acme demo company — catalogue, cart, checkout.',
    stack: 'TypeScript, React, Vite',
    priority: 'Rebuilding checkout on the new payments API',
    logo: ['#7c5cff', 'M12 3 21 8v8l-9 5-9-5V8z'],
    connect: ['acme-payments', 'acme-design'],
  },
  {
    name: 'acme-payments',
    description: 'Payments and payout service for the Acme demo company.',
    stack: 'TypeScript, Node, Postgres',
    priority: 'Idempotent refunds',
    logo: ['#38bdf8', 'M4 7h16v10H4z M4 11h16'],
    connect: ['acme-storefront'],
  },
  {
    name: 'acme-design',
    description: 'The shared design system behind every Acme surface.',
    stack: 'TypeScript, Storybook',
    priority: 'Token pass on dark mode',
    logo: ['#f472b6', 'M12 4a8 8 0 1 0 0 16 4 4 0 0 0 0-8 4 4 0 0 1 0-8z'],
    connect: ['acme-storefront'],
  },
  {
    name: 'atlas-mobile',
    description: 'The Atlas demo iOS/Android client.',
    stack: 'TypeScript, React Native',
    priority: 'Offline-first sync',
    logo: ['#34d399', 'M7 3h10v18H7z M9 19h6'],
    connect: ['acme-payments'],
  },
  {
    name: 'field-notes',
    description: 'A demo research vault — interviews, notes, and what they add up to.',
    stack: 'Markdown',
    priority: 'Second round of interviews',
    logo: ['#fbbf24', 'M5 4h11l3 3v13H5z M8 9h8 M8 13h8 M8 17h5'],
    connect: [],
  },
];

function logoSvg([colour, path]) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="64" height="64">
  <rect width="24" height="24" rx="6" fill="${colour}" fill-opacity="0.18"/>
  <path d="${path}" fill="none" stroke="${colour}" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

function run(cwd, args) {
  execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    stdio: 'pipe',
    // Every CLI call runs under the fake home too, so `connect` writes its edges
    // into the demo registry rather than reading the author's.
    env: { ...process.env, HOME },
  });
}

// ─── Build ────────────────────────────────────────────────────────────────────

rmSync(BASE, { recursive: true, force: true });
mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });

for (const v of DEMO) {
  const dir = join(VAULTS, v.name);
  mkdirSync(dir, { recursive: true });
  run(dir, [
    'init', '-y',
    '--name', v.name,
    '--description', v.description,
    '--stack', v.stack,
    '--priority', v.priority,
    '--platforms', 'claude',
  ]);
  const assets = join(dir, '_dream_context', 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'logo.svg'), logoSvg(v.logo));
  console.log('  ✓', v.name);
}

// The registry the dashboard will read. `lastOpenedAt` staggers the orbit: the Space
// view places recent projects near the centre, so without it every chip lands on the
// same ring and the layout reads as a mock.
const base = Date.parse('2026-08-27T09:00:00.000Z');
writeFileSync(
  join(HOME, '.dreamcontext', 'vaults.json'),
  JSON.stringify(
    {
      vaults: DEMO.map((v, i) => ({
        name: v.name,
        path: join(VAULTS, v.name),
        lastOpenedAt: new Date(base - i * 36e5).toISOString(),
      })),
    },
    null,
    2,
  ) + '\n',
);

// Wire the orbit — `connect` is what draws the dashed lines between chips.
for (const v of DEMO) {
  for (const peer of v.connect) {
    try {
      run(join(VAULTS, v.name), ['connect', peer]);
      console.log('  ✓', v.name, '→', peer);
    } catch (err) {
      console.log('  ! connect failed', v.name, '→', peer, '-', String(err.message).split('\n')[0]);
    }
  }
}

// ─── Seed a board ─────────────────────────────────────────────────────────────
// A screenshot of the task board is one of the recurring announcement scenes, and an
// empty board photographs as "No tasks match these filters" — a picture of nothing.
// These are the only tasks any announcement will ever show.
const TASKS = [
  ['Checkout: split payment into its own step', 'in_progress', 'high', 'topic:checkout,layer:frontend', 'One-page checkout buries card errors below the fold; splitting payment out is what lets an error sit next to the field that caused it.'],
  ['Guest checkout without an account', 'in_progress', 'high', 'topic:checkout,type:ux', 'Forced sign-up is the single largest drop in the funnel — a guest lane removes the wall without removing the account.'],
  ['Retire the legacy cart cookie', 'todo', 'medium', 'layer:backend,type:chore', 'Two carts can disagree after a session expires, and the cookie is the copy nobody reads.'],
  ['Product page: gallery keyboard traps', 'todo', 'high', 'topic:a11y,layer:frontend', 'The lightbox takes focus and never gives it back, so a keyboard user cannot leave the gallery.'],
  ['Search ranks out-of-stock items first', 'in_review', 'critical', 'topic:search,layer:backend', 'Relevance ignores stock, so the best-matching result is routinely one nobody can buy.'],
  ['Order confirmation email renders blank in Outlook', 'completed', 'high', 'topic:email,type:bug', 'The template relies on flexbox, which Outlook drops — the customer gets a blank receipt.'],
  ['Cache the catalogue facet counts', 'completed', 'medium', 'layer:backend,type:perf', 'Facet counts are recomputed per request and dominate the category page p95.'],
];

const boardVault = join(VAULTS, 'acme-storefront');

// `init` scaffolds the soul with "(Add your project's guiding principles here)"
// placeholders. That is correct for a real new vault and wrong for a photograph: the
// Core page is one of the recurring scenes, and a screenshot full of template prompts
// reads as an unfinished product rather than a filled brain. Give the one vault we
// shoot a soul with something in it.
writeFileSync(
  join(boardVault, '_dream_context', 'core', '0.soul.md'),
  `---
name: "acme-storefront"
type: soul
updated: "2026-08-27"
---

## Project Identity

The customer-facing shop for the Acme demo company — catalogue, cart and checkout.
A Vite/React storefront in front of the payments service, sharing its type and
components with the Acme design system.

## Core Principles

- **The cart is server truth**: the client renders it, it never owns it.
- **Every price crosses one boundary**: formatting lives in one module, never inline.
- **A checkout step may never lose what was typed** — back is always safe.
- **Stock is part of relevance**: nothing unbuyable ranks above something buyable.

## Constraints

- Node >= 20; the storefront and the payments service share no database.
- Catalogue reads go through the CDN cache; writes never do.
- No card data touches this app — the payments service owns every PAN.

## Agent Behaviors & Rules

- Change a price path and the rounding tests run before anything else.
- A new checkout step needs an abandonment event before it ships.
`,
);
for (const [name, status, priority, tags, why] of TASKS) {
  try {
    run(boardVault, ['tasks', 'create', name, '-s', status, '-p', priority, '-t', tags, '-w', why]);
  } catch (err) {
    console.log('  ! task failed', name, '-', String(err.message).split('\n')[0]);
  }
}
console.log('  ✓ seeded', TASKS.length, 'tasks on acme-storefront');

console.log('\ndemo home:', HOME);
console.log('serve it:  HOME=' + HOME + ' DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45778');
if (!existsSync(join(HOME, '.dreamcontext', 'vaults.json'))) process.exit(1);
