import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { generateSnapshot, measureSnapshot } from '../../src/cli/commands/snapshot.js';
import {
  HARNESS_PERSIST_CHAR_LIMIT,
  HARNESS_PREVIEW_CHARS,
  OVERSIZED_SNAPSHOT_DIRECTIVE,
} from '../../src/lib/snapshot-budget.js';
import {
  DEMOTION_RANKS,
  PINNED_KNOWLEDGE_CHARS,
  TASKS_ROSTER_CHARS,
} from '../../src/lib/snapshot-caps.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { createObjective } from '../../src/lib/objectives-store.js';
import { createThesis } from '../../src/lib/theses/store.js';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { writePeople, type PeopleMap } from '../../src/lib/people-store.js';
import { PERSON_ENV_VAR } from '../../src/lib/people-resolve.js';

/**
 * The acceptance battery for the snapshot demotion ladder.
 *
 * These are not unit tests of a function — they are the ACCEPTANCE CRITERIA of
 * the harness-fit work, expressed against a synthetic vault:
 *
 *   AC1/AC2  a mature vault renders under the ladder target (and so under the
 *            20,000-char harness limit that made the brain arrive as a 2KB
 *            positional preview)
 *   AC3      no silent drops — every demoted item is either NAMED or omitted
 *            behind an accurate count plus the exact recovery command, and a
 *            user-visible name is never cut mid-string
 *   AC4      when it still cannot fit, the agent is told so INSIDE the preview
 *            window, not in a footer it will never receive
 *   AC5      the Lab floor survives, along with the objectives / theses /
 *            ★★★-bookmark floors that exist for the same reason
 *
 * `_dream_context/state/…snapshot-busts-the-harness-limit….md` is the task.
 */

// ─── Determinism ────────────────────────────────────────────────────────────
// The snapshot reads the clock in several places (knowledge staleness, feature
// freshness, insight TTL, objective time-boxing, recent-done cutoffs). Pinning
// the clock, HOME and cwd is what makes the byte counts below reproducible —
// HOME leaks in through the vault registry and setup-config lookups, so time
// alone is not determinism. Same pattern as snapshot-hotpath-guard.test.ts.
const FIXED_NOW = new Date('2026-07-28T12:00:00Z');

/**
 * The active person, pinned through `DREAMCONTEXT_PERSON` in `beforeEach`.
 *
 * Active-person resolution falls through to `git config user.email` — a MACHINE
 * fact — before it reaches the solo-vault rung, so on the multi-person fixtures
 * below an unpinned run would render whichever person happened to match the
 * developer's git identity (and UNRESOLVED on CI). The env var is rung 1, so it
 * short-circuits the git exec entirely and makes every assertion here portable.
 */
const ACTIVE_PERSON = 'ada-floors';

/** The ladder's char target: DEFAULT_SNAPSHOT_BUDGET_TOKENS (4,500) x 4. */
const LADDER_TARGET_CHARS = 18_000;

/**
 * Maximum budget pressure, for the assertions about FLOORS.
 *
 * A floor is a promise about what survives when the ladder has run out of road,
 * so proving one requires the ladder to actually reach it. At the default budget
 * `applyBudget` stops at the FIRST fitting state — which on a vault that fits is
 * long before it walks down to rank 120-140 (objectives / theses / lab). This
 * budget (clamped to 2,000 tok = 8,000 chars) is below the fixture's fully
 * floored size, so every rung runs and the floors are observable.
 */
const MAX_PRESSURE_BUDGET = '2000';

function withBudget<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
  if (value === undefined) delete process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
  else process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
    else process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = previous;
  }
}

// ─── Assertion helpers ──────────────────────────────────────────────────────

/**
 * Match a slug as a WHOLE token.
 *
 * `toContain('fixture-task-01')` also passes on `fixture-task-010`, which would
 * let a truncated roster masquerade as a complete one — exactly the failure AC3
 * is about. Slug characters are `[a-z0-9-]` plus `/` for foldered knowledge, so
 * the boundary is "not one of those".
 */
function containsWholeToken(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9/_-])${escaped}($|[^A-Za-z0-9/_-])`).test(haystack);
}

function expectAllPresent(text: string, tokens: string[], label: string): void {
  const missing = tokens.filter((t) => !containsWholeToken(text, t));
  expect(missing, `${label}: ${missing.length} missing (${missing.slice(0, 5).join(', ')})`)
    .toEqual([]);
}

/**
 * The remainder-tail lines: `- (+N more …)` / `- 📌 (+N more pinned …)`.
 *
 * `…` is legitimate elsewhere — compressed prose in the user file, memory
 * titles, bookmark bodies all elide. It is ONLY forbidden in a tail, because a
 * tail carries identifiers rather than prose.
 */
function tailLines(text: string): string[] {
  return text.split('\n').filter((line) => /^- (📌 )?\(\+\d+ /.test(line));
}

function sectionBlock(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}`);
  if (start === -1) return '';
  const next = text.indexOf('\n## ', start + 2);
  return text.slice(start, next === -1 ? text.length : next);
}

// ─── Fixture construction ───────────────────────────────────────────────────

const pad = (n: number, width = 3): string => String(n).padStart(width, '0');

/** Prose that survives a first-sentence cut with something left to cut. */
function prose(chars: number, seed: string): string {
  const sentence = `${seed} rationale detail that exists purely to be compressed away. `;
  return sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars).trim() + '.';
}

/**
 * ONE long sentence — no internal full stop until the end.
 *
 * `shrinkBody` caps at the first sentence boundary, so multi-sentence prose of
 * ANY total length compresses to its short opening clause. A fixture that means
 * to bust a per-item cap has to deny it that boundary; otherwise it silently
 * tests the easy path. (This is why the pinned-block stage-2 case needs it: 600
 * chars of short sentences shrink to ~68 and stage 1 fits comfortably.)
 */
function singleSentence(chars: number, seed: string): string {
  const run = `${seed} clause `;
  return run.repeat(Math.ceil(chars / run.length)).slice(0, chars).trimEnd() + '.';
}

/**
 * A soul the ladder cannot shrink — because NO soul is shrinkable any more.
 *
 * The soul is never-evict and renders verbatim at every budget, so a big one is
 * simply big. (The heading-only shape is kept because it also predates the
 * doctrine: `^#{1,6} ` lines passed through verbatim even when the soul still
 * had compression rungs, which is what made this fixture deterministic then and
 * keeps it byte-predictable now.)
 */
function incompressibleSoul(headings: number, padChars = 40): string {
  const lines = Array.from(
    { length: headings },
    (_, i) => `## Rule ${pad(i, 4)} — ${'x'.repeat(padChars)}`,
  );
  return `---\nname: Incompressible\ntype: soul\n---\n\n${lines.join('\n')}\n`;
}

/**
 * A soul as an ORDERED list of named rules, mirroring the largest live vault
 * (whose `## Unbreakable Rules` is `1.`/`2.`… , not `- `). Each rule's
 * `**RULE_NNN …**` bold lead is its NAME, so the sentinels below can assert rule
 * by rule that the whole constitution reached the agent.
 */
function orderedRuleSoul(count: number, rationaleChars: number): string {
  const rules = Array.from({ length: count }, (_, i) =>
    `${i + 1}. **RULE_${pad(i)} — a binding rule about subsystem ${pad(i)}** - `
    + prose(rationaleChars, `Rule ${pad(i)}`));
  return [
    '---', 'name: Fixture Soul', 'type: soul', '---', '',
    '## Project Identity', '',
    'A synthetic brain built to reproduce the pre-rework never-evict tier.', '',
    '## Unbreakable Rules', '',
    rules.join('\n'), '',
  ].join('\n');
}

/**
 * Fixture #1's soul: a LEAN constitution — 40 one-line named rules, ~3.3K.
 *
 * The soul is the agent's constitution: never-evict, no rungs, VERBATIM at every
 * budget. That makes its size the one thing the ladder cannot absorb, so a
 * fixture soul has to be the size a soul is SUPPOSED to be — otherwise the
 * 18,000-char gate below stops measuring the ladder and just measures the
 * fixture. One line per rule is also the shape the doctrine asks for: a
 * conditional "when X, do Y" rule belongs in knowledge/patterns, which recall
 * fetches on demand, and only the unconditional identity stays here.
 *
 * (Fixture #2 keeps the oversized soul, where it now reads as the alarm it is.)
 */
const CONSTITUTION_RULES = 40;
function constitutionSoul(): string {
  return orderedRuleSoul(CONSTITUTION_RULES, 20);
}

/**
 * Fixture #1's user file: a LEAN constitution — 40 one-line named preferences,
 * ~2.9K, exactly the shape (and for exactly the reason) `constitutionSoul` is.
 *
 * The user file is the PERSON's constitution: never-evict, no rungs, VERBATIM at
 * every budget. So its size is the second thing the ladder cannot absorb, and a
 * fixture user has to be the size a user file is SUPPOSED to be — otherwise the
 * 18,000-char gate below stops measuring the ladder and just measures the
 * fixture. One line per preference is also the shape the doctrine asks for: what
 * is not about the person belongs outside this file.
 */
const CONSTITUTION_PREFS = 40;
function constitutionUser(): string {
  return preferenceUser(CONSTITUTION_PREFS, 20);
}

function preferenceUser(count: number, bodyChars: number): string {
  const prefs = Array.from({ length: count }, (_, i) =>
    `- **PREF_${pad(i)} — preference ${pad(i)}** - ${prose(bodyChars, `Preference ${pad(i)}`)}`);
  return [
    '---', 'name: Fixture User', 'type: user', '---', '',
    '## User Preferences', '',
    prefs.join('\n'), '',
    '## Workflow Notes', '',
    prefs.slice(0, Math.ceil(count / 4)).join('\n'), '',
  ].join('\n');
}

function memoryFile(decisions: number, issues: number): string {
  const decisionLines = Array.from({ length: decisions }, (_, i) =>
    `- **DEC_${pad(i)} (2026-01-${pad((i % 28) + 1, 2)})**: ${prose(650, `Decision ${pad(i)}`)}`);
  const issueLines = Array.from({ length: issues }, (_, i) =>
    `- **ISSUE_${pad(i)}**: ${prose(300, `Issue ${pad(i)}`)}`);
  return [
    '---', 'name: Fixture Memory', 'type: memory', '---', '',
    '## Active Memory', '',
    '- Current focus: proving the ladder fits the harness limit.', '',
    '## Technical Decisions', '',
    decisionLines.join('\n'), '',
    '## Known Issues', '',
    issueLines.join('\n'), '',
  ].join('\n');
}

interface VaultSpec {
  soul: string;
  /** The ACTIVE person's constitution (`people/<ACTIVE_PERSON>.md`). */
  user?: string;
  /** Teammates besides the active person — what the roster section renders. */
  otherPeople?: number;
  memory?: string;
  /** Non-pinned knowledge files, spread evenly across this many folders. */
  knowledgeFiles?: number;
  knowledgeFolders?: number;
  /** Pinned 📌 knowledge, with a description this long (600 busts stage 1). */
  pinnedFiles?: number;
  pinnedDescriptionChars?: number;
  features?: number;
  tasks?: number;
  /** Override the generated task slugs (used by the long-slug roster variant). */
  taskSlug?: (i: number) => string;
  bookmarks?: number;
  criticalBookmarks?: number;
  peers?: number;
  extendedCoreFiles?: number;
  objectives?: number;
  theses?: number;
  insights?: number;
  releases?: boolean;
  changelog?: boolean;
}

interface Vault {
  projectRoot: string;
  ctxRoot: string;
  taskSlugs: string[];
  featureSlugs: string[];
  knowledgeSlugs: string[];
  pinnedSlugs: string[];
  objectiveSlugs: string[];
  insightTitles: string[];
  insightValues: string[];
  criticalMessages: string[];
  thesisClaims: string[];
  peerNames: string[];
  /** Slugs of the OTHER people (never the active one). */
  peopleSlugs: string[];
  peopleNames: string[];
}

const BASE_CONFIG: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.22.0',
  disableNativeMemory: true,
};

function buildVault(dir: string, spec: VaultSpec): Vault {
  const projectRoot = dir;
  const ctxRoot = join(projectRoot, '_dream_context');
  for (const sub of ['core', 'knowledge', 'knowledge/features', 'state']) {
    mkdirSync(join(ctxRoot, sub), { recursive: true });
  }

  // Learning is opt-in; the theses section is silent without it.
  writeSetupConfig(projectRoot, { ...BASE_CONFIG, learning: { enabled: true } });

  writeFileSync(join(ctxRoot, 'core', '0.soul.md'), spec.soul, 'utf-8');
  writeFileSync(join(ctxRoot, 'core', '2.memory.md'), spec.memory ?? '---\nname: M\ntype: memory\n---\n\n## Active Memory\n\n- Nothing yet.\n', 'utf-8');

  const vault: Vault = {
    projectRoot, ctxRoot,
    taskSlugs: [], featureSlugs: [], knowledgeSlugs: [], pinnedSlugs: [],
    objectiveSlugs: [], insightTitles: [], insightValues: [], criticalMessages: [],
    thesisClaims: [], peerNames: [], peopleSlugs: [], peopleNames: [],
  };

  // The people-first layout: a roster plus one constitution per person. The
  // ACTIVE person is pinned through the env rung (see ACTIVE_PERSON) rather than
  // left to `git config user.email`, which is a machine fact and would make
  // every assertion below depend on who ran the suite.
  mkdirSync(join(ctxRoot, 'people'), { recursive: true });
  const people: PeopleMap = { [ACTIVE_PERSON]: { name: 'Ada Floors', emails: ['ada@floors.invalid'] } };
  writeFileSync(
    join(ctxRoot, 'people', `${ACTIVE_PERSON}.md`),
    spec.user ?? '---\nname: ada-floors\ntype: person\n---\n\n## Preferences\n\n- Terse.\n',
    'utf-8',
  );
  for (let i = 0; i < (spec.otherPeople ?? 0); i++) {
    const slug = `teammate-${pad(i, 2)}`;
    people[slug] = {
      name: `Teammate ${pad(i, 2)}`,
      emails: [`${slug}@floors.invalid`],
      role: `role ${pad(i, 2)}`,
    };
    // Deliberately prose-heavy `## Identity`: the roster line must be built from
    // people.json's `role` alone, so this text has to stay in the file (B3).
    writeFileSync(
      join(ctxRoot, 'people', `${slug}.md`),
      `---\nname: ${slug}\ntype: person\n---\n\n## Identity\n\n- IDENTITY_${pad(i, 2)}: ${prose(300, `Teammate ${pad(i, 2)}`)}\n`,
      'utf-8',
    );
    vault.peopleSlugs.push(slug);
    vault.peopleNames.push(people[slug].name);
  }
  writePeople(ctxRoot, people);

  // Extended core files (core/[3-9]*) — the index that was never-evict and 4.5KB
  // of summaries on the largest live vault.
  for (let i = 0; i < (spec.extendedCoreFiles ?? 0); i++) {
    const filename = `${i + 3}.extended_${pad(i, 2)}.md`;
    writeFileSync(
      join(ctxRoot, 'core', filename),
      `---\nname: Extended ${pad(i, 2)}\ntype: reference\nsummary: "${prose(180, `Extended ${pad(i, 2)}`)}"\n---\n\nBody.\n`,
      'utf-8',
    );
  }

  // Knowledge — foldered so the rung-2 grouped render has something to group.
  const folders = spec.knowledgeFolders ?? 8;
  for (let i = 0; i < (spec.knowledgeFiles ?? 0); i++) {
    const folder = `folder-${pad(i % folders, 2)}`;
    const slug = `${folder}/kb-${pad(i)}`;
    mkdirSync(join(ctxRoot, 'knowledge', folder), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'knowledge', `${slug}.md`),
      `---\nname: KB ${pad(i)}\ndescription: "Knowledge note ${pad(i)} about subsystem ${pad(i % folders, 2)}."\ntags: [architecture]\n---\n\nBody paragraph for kb ${pad(i)}.\n`,
      'utf-8',
    );
    vault.knowledgeSlugs.push(slug);
  }

  // Pinned 📌 knowledge — the user's MUST-READ signal, and (until v5) the one
  // unbounded term left in the ladder.
  for (let i = 0; i < (spec.pinnedFiles ?? 0); i++) {
    const slug = `pinned-${pad(i, 2)}`;
    writeFileSync(
      join(ctxRoot, 'knowledge', `${slug}.md`),
      `---\nname: Pinned ${pad(i, 2)}\npinned: true\ndescription: "${singleSentence(spec.pinnedDescriptionChars ?? 600, `Pinned ${pad(i, 2)}`)}"\n---\n\nBody.\n`,
      'utf-8',
    );
    vault.pinnedSlugs.push(slug);
  }

  for (let i = 0; i < (spec.features ?? 0); i++) {
    const slug = `feature-${pad(i, 2)}`;
    writeFileSync(
      join(ctxRoot, 'knowledge', 'features', `${slug}.md`),
      [
        '---', `name: Feature ${pad(i, 2)}`, 'type: feature',
        `status: ${i % 3 === 0 ? 'in_progress' : 'planned'}`,
        'tags: [product]', '---', '',
        '## Why', '', prose(200, `Feature ${pad(i, 2)}`), '',
      ].join('\n'),
      'utf-8',
    );
    vault.featureSlugs.push(slug);
  }

  const slugOf = spec.taskSlug ?? ((i: number) => `fixture-task-${pad(i, 2)}-slug`);
  for (let i = 0; i < (spec.tasks ?? 0); i++) {
    const slug = slugOf(i);
    writeFileSync(
      join(ctxRoot, 'state', `${slug}.md`),
      [
        '---', `name: Task ${pad(i, 2)}`, `status: ${i % 5 === 0 ? 'in_progress' : 'todo'}`,
        'priority: high', "updated_at: '2026-07-20'", '---', '',
        '## Why', '', prose(220, `Task ${pad(i, 2)}`), '',
      ].join('\n'),
      'utf-8',
    );
    vault.taskSlugs.push(slug);
  }

  // Bookmarks live in state/.sleep.json; readSleepState merges with defaults, so
  // the file only needs the key under test.
  const bookmarkCount = spec.bookmarks ?? 0;
  if (bookmarkCount > 0) {
    const critical = spec.criticalBookmarks ?? 0;
    const bookmarks = Array.from({ length: bookmarkCount }, (_, i) => {
      const isCritical = i < critical;
      const message = isCritical
        ? `CRITICAL_BOOKMARK_${pad(i, 2)} must survive every rung of the ladder verbatim.`
        : `QUIET_BOOKMARK_${pad(i, 2)}: ${prose(260, `Bookmark ${pad(i, 2)}`)}`;
      if (isCritical) vault.criticalMessages.push(message);
      return {
        id: `bm_${pad(i, 2)}`,
        message,
        salience: isCritical ? 3 : ((i % 2) + 1),
        created_at: FIXED_NOW.toISOString(),
        session_id: null,
        task_slug: null,
      };
    });
    writeFileSync(join(ctxRoot, 'state', '.sleep.json'), JSON.stringify({ debt: 0, bookmarks }, null, 2), 'utf-8');
  }

  if ((spec.peers ?? 0) > 0) {
    const peers = Array.from({ length: spec.peers ?? 0 }, (_, i) => {
      const name = `peer-vault-${pad(i, 2)}`;
      vault.peerNames.push(name);
      return {
        vault: name,
        whatItIs: prose(160, `Peer ${pad(i, 2)}`),
        lastActivity: [`2026-07-${pad(20 + i, 2)} shipped something`],
        activeTask: `peer task ${pad(i, 2)}`,
        topTags: ['architecture', 'product'],
        pinnedKnowledge: [`peer-doc-${pad(i, 2)}`],
      };
    });
    writeFileSync(
      join(ctxRoot, 'state', '.peer-summaries.json'),
      JSON.stringify({ generatedAt: FIXED_NOW.toISOString(), peers }, null, 2),
      'utf-8',
    );
  }

  for (let i = 0; i < (spec.objectives ?? 0); i++) {
    const slug = `objective-${pad(i, 2)}`;
    createObjective(ctxRoot, { slug, title: `Objective ${pad(i, 2)} — a measurable outcome` });
    vault.objectiveSlugs.push(slug);
  }

  for (let i = 0; i < (spec.theses ?? 0); i++) {
    const claim = `THESIS_${pad(i, 2)} hybrid recall beats plain keyword matching on this corpus`;
    createThesis(ctxRoot, {
      slug: `thesis-${pad(i, 2)}`,
      claim,
      predictions: [`Prediction ${pad(i, 2)}: recall precision improves`],
      open: true,
    });
    vault.thesisClaims.push(claim);
  }

  for (let i = 0; i < (spec.insights ?? 0); i++) {
    const slug = `metric-${pad(i, 2)}`;
    const title = `Metric ${pad(i, 2)} Weekly Value`;
    const value = String(1000 + i);
    createInsight(ctxRoot, { slug, title, unit: 'users', group: 'Engagement' });
    writeCache(ctxRoot, slug, {
      slug,
      fetchedAt: FIXED_NOW.toISOString(),
      tweaks: {},
      granularity: 'daily',
      unit: 'users',
      series: [{ name: 'default', points: [{ t: '2026-07-27', v: Number(value) }] }],
      latest: Number(value),
      error: null,
      errorAt: null,
      scriptHash: null,
    });
    vault.insightTitles.push(title);
    vault.insightValues.push(value);
  }

  if (spec.releases) {
    writeFileSync(
      join(ctxRoot, 'core', 'RELEASES.json'),
      JSON.stringify([
        { version: 'v1.3.0', status: 'planning', summary: prose(200, 'Release 1.3'), tasks: ['a', 'b'] },
        { version: 'v1.2.0', status: 'planning', summary: prose(200, 'Release 1.2'), tasks: ['c'] },
        { version: 'v1.1.0', status: 'released', date: '2026-07-01', summary: prose(200, 'Release 1.1'), tasks: ['d'], features: ['e'] },
      ], null, 2),
      'utf-8',
    );
  }

  if (spec.changelog) {
    writeFileSync(
      join(ctxRoot, 'core', 'CHANGELOG.json'),
      JSON.stringify(
        Array.from({ length: 15 }, (_, i) => ({
          date: `2026-07-${pad(28 - (i % 28), 2)}`,
          type: 'feat',
          scope: `scope-${pad(i, 2)}`,
          summary: `Changelog headline ${pad(i, 2)}`,
          description: prose(400, `Changelog ${pad(i, 2)}`),
        })),
        null, 2,
      ),
      'utf-8',
    );
  }

  return vault;
}

/** The full mature-vault fixture: every section populated, every tier oversized. */
function matureVaultSpec(): VaultSpec {
  return {
    soul: constitutionSoul(),
    user: constitutionUser(),
    memory: memoryFile(130, 25),
    knowledgeFiles: 80,
    knowledgeFolders: 8,
    pinnedFiles: 8,
    pinnedDescriptionChars: 600,
    features: 40,
    tasks: 60,
    bookmarks: 20,
    criticalBookmarks: 3,
    peers: 5,
    otherPeople: 12,
    extendedCoreFiles: 6,
    objectives: 4,
    theses: 3,
    insights: 3,
    releases: true,
    changelog: true,
  };
}

// ─── Suite ──────────────────────────────────────────────────────────────────

let home: string;
let base: string;
let originalHome: string | undefined;
let originalCwd: string;
let originalPerson: string | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
  home = join(tmpdir(), `dc-floors-home-${Math.random().toString(36).slice(2)}`);
  base = join(tmpdir(), `dc-floors-base-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(base, { recursive: true });
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  originalPerson = process.env[PERSON_ENV_VAR];
  process.env.HOME = home;
  process.env[PERSON_ENV_VAR] = ACTIVE_PERSON;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPerson === undefined) delete process.env[PERSON_ENV_VAR];
  else process.env[PERSON_ENV_VAR] = originalPerson;
  rmSync(home, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('fixture #1 — the pre-change never-evict tier now fits', () => {
  let vault: Vault;

  beforeEach(() => {
    vault = buildVault(join(base, 'mature'), matureVaultSpec());
  });

  it('renders under the ladder target on a mature vault (AC1/AC2)', () => {
    const { text, budget } = withBudget(undefined, () => measureSnapshot(vault.ctxRoot));

    // The ladder met its target: `overBudget` is the verdict, taken on the
    // PRE-footer text (deliberately — letting the footer's own bytes decide
    // which footer to append would be circular).
    expect(budget.overBudget).toBe(false);

    // …and the CONTENT really is inside the 18,000-char target, not merely
    // declared to be. Everything past it is the Budget-note footer, which is
    // appended after the verdict and therefore sits on top of the target.
    const footerStart = text.indexOf('\n\n---\n_Budget note:');
    const content = footerStart === -1 ? text : text.slice(0, footerStart);
    expect(content.length).toBeLessThanOrEqual(LADDER_TARGET_CHARS);

    // The acceptance criterion itself: it lands inline, in full, with room to
    // spare — this is the promise that was broken at 74KB/100KB.
    expect(text.length).toBeLessThan(HARNESS_PERSIST_CHAR_LIMIT);
    expect(HARNESS_PERSIST_CHAR_LIMIT - text.length).toBeGreaterThan(1_000);
  });

  it('renders the soul VERBATIM, however deep the ladder goes (constitution)', () => {
    const soul = constitutionSoul().trim();
    const sentinels = Array.from({ length: CONSTITUTION_RULES }, (_, i) => `RULE_${pad(i)}`);

    // Both bands: the ordinary render AND the one where every demotable section
    // has been taken to its floor. The soul is identical in both — that is the
    // whole doctrine. Rule NAMES are asserted separately from the verbatim body
    // so a failure says which rule went missing, not just "the block differs".
    for (const budget of [undefined, MAX_PRESSURE_BUDGET]) {
      const text = withBudget(budget, () => generateSnapshot(vault.ctxRoot));
      expectAllPresent(text, sentinels, `soul rules @ budget=${budget ?? 'default'}`);
      expect(text, `soul not verbatim @ budget=${budget ?? 'default'}`).toContain(soul);
      // Never the compressed-core provenance footer, which only a demoted core
      // file emits — its presence would mean the soul got a rung back.
      expect(text).not.toContain('Full text: `_dream_context/core/0.soul.md`');
    }
  });

  it('never demotes the soul, at any pressure (constitution)', () => {
    const { budget } = withBudget(MAX_PRESSURE_BUDGET, () => measureSnapshot(vault.ctxRoot));
    expect(budget.demoted.map((d) => d.id)).not.toContain('soul');
    // It is in the tier that cannot be demoted, and it costs real bytes there.
    expect(budget.neverEvictChars).toBeGreaterThan(constitutionSoul().trim().length);
  });

  it('renders the ACTIVE PERSON\'s constitution VERBATIM, however deep the ladder goes', () => {
    const user = constitutionUser().trim();
    const sentinels = Array.from({ length: CONSTITUTION_PREFS }, (_, i) => `PREF_${pad(i)}`);

    // Same doctrine as the soul, applied to the person. A preference reduced to
    // its title is worse than an absent one: the agent sees that a rule about
    // the user exists, reads that as knowing it, and never opens the file.
    for (const budget of [undefined, MAX_PRESSURE_BUDGET]) {
      const text = withBudget(budget, () => generateSnapshot(vault.ctxRoot));
      expect(text).toContain(`## Person (Active — Ada Floors, \`person:${ACTIVE_PERSON}\`)`);
      expectAllPresent(text, sentinels, `person preferences @ budget=${budget ?? 'default'}`);
      expect(text, `person not verbatim @ budget=${budget ?? 'default'}`).toContain(user);
      // The compressed-core provenance footer only a demoted core file emits.
      expect(text).not.toContain(`Full text: \`_dream_context/people/${ACTIVE_PERSON}.md\``);
    }
  });

  it('never demotes the person block, at any pressure (constitution)', () => {
    const { budget } = withBudget(MAX_PRESSURE_BUDGET, () => measureSnapshot(vault.ctxRoot));
    expect(budget.demoted.map((d) => d.id)).not.toContain('person');
    // Soul + person together are the never-evict floor the ladder works around.
    expect(budget.neverEvictChars)
      .toBeGreaterThan(constitutionSoul().trim().length + constitutionUser().trim().length);
  });

  it('demotes the OTHER-people roster to a NAMED list, never to a count', () => {
    // The roster is inventory, not constitution: it has a rank (110) and it does
    // give way under pressure. What it may never give up is a name — a person
    // the agent cannot see is a person it cannot address with `person:<slug>`.
    const { text, budget } = withBudget(MAX_PRESSURE_BUDGET, () => measureSnapshot(vault.ctxRoot));

    expect(budget.demoted.map((d) => d.id)).toContain('people-roster');
    expect(text).toContain('## Other People (this vault)');
    expectAllPresent(text, vault.peopleNames, 'other people at max pressure');

    // …and the ACTIVE person is never in the "other" list, at any rung.
    const block = sectionBlock(text, '## Other People (this vault)');
    expect(block).not.toContain(ACTIVE_PERSON);
  });

  it('builds the roster line from people.json ROLE only — never from anyone\'s markdown (B3)', () => {
    // Parsing each person's `## Identity` would read every constitution on the
    // SessionStart hot path AND lift prose into a structural line. `role` is
    // already structural, already loaded, and free.
    // The role suffix only exists in the FULL render (rung 1 drops it), so the
    // budget is switched off here — this assertion is about the line's source,
    // not about the ladder.
    const full = withBudget('off', () => generateSnapshot(vault.ctxRoot));
    expect(sectionBlock(full, '## Other People (this vault)'))
      .toContain(`- **${vault.peopleNames[0]}** (\`person:${vault.peopleSlugs[0]}\`) — role 00`);

    // Nobody else's constitution reaches the render at ANY budget.
    for (const budget of ['off', undefined, MAX_PRESSURE_BUDGET]) {
      const text = withBudget(budget, () => generateSnapshot(vault.ctxRoot));
      for (let i = 0; i < vault.peopleSlugs.length; i++) {
        expect(text, `identity prose from ${vault.peopleSlugs[i]} leaked @ budget=${budget ?? 'default'}`)
          .not.toContain(`IDENTITY_${pad(i, 2)}`);
      }
      expect(text).not.toContain('rationale detail that exists purely to be compressed away. Teammate');
    }
  });

  it('names every knowledge slug, feature slug and task slug (AC3)', () => {
    const text = withBudget(MAX_PRESSURE_BUDGET, () => generateSnapshot(vault.ctxRoot));

    // The deepest knowledge rung groups by folder — `- **…/folder-00/** (10):
    // kb-000, kb-008, …` — so a slug is named as folder-header + basename, not
    // as one contiguous string. Assert the shape the render actually uses, or
    // the check silently demands a format the design deliberately dropped.
    const knowledgeBlock = sectionBlock(text, '## Knowledge Index');
    for (const slug of vault.knowledgeSlugs) {
      const [folder, basename] = slug.split('/');
      const groupLine = knowledgeBlock.split('\n')
        .find((l) => l.includes(`**_dream_context/knowledge/${folder}/**`));
      expect(groupLine, `no group line for ${folder}/`).toBeDefined();
      expect(containsWholeToken(groupLine as string, basename), `${slug} not named`).toBe(true);
    }

    expectAllPresent(text, vault.featureSlugs, 'feature slugs');
    // 60 slugs x 22 chars = 1,320 <= TASKS_ROSTER_CHARS, so the whole roster fits.
    expect(vault.taskSlugs.reduce((n, s) => n + s.length + 2, 0))
      .toBeLessThanOrEqual(TASKS_ROSTER_CHARS);
    expectAllPresent(text, vault.taskSlugs, 'task slugs');
  });

  it('never cuts a name mid-string in any remainder tail (AC3)', () => {
    const text = withBudget(MAX_PRESSURE_BUDGET, () => generateSnapshot(vault.ctxRoot));
    const tails = tailLines(text);
    for (const tail of tails) {
      expect(tail, `tail contains an elision: ${tail}`).not.toContain('…');
      expect(tail, `tail contains an ASCII elision: ${tail}`).not.toContain('...');
    }
  });

  it('never demotes objectives to a bare count, and names every objective (AC3)', () => {
    const text = withBudget(MAX_PRESSURE_BUDGET, () => generateSnapshot(vault.ctxRoot));

    // The rung this replaced was literally `- N objective(s) — …`.
    expect(text).not.toMatch(/- \d+ objective\(s\)/);
    expectAllPresent(text, vault.objectiveSlugs, 'objective slugs');
  });

  it('keeps the theses claims, not just the counts (AC3)', () => {
    const text = withBudget(MAX_PRESSURE_BUDGET, () => generateSnapshot(vault.ctxRoot));

    expect(text).toContain('## Learning (Hypotheses)');
    // The rung this replaced was `⚗ Learning: N open · N flipped · N blocked`.
    expect(text).not.toMatch(/⚗ Learning: \d+ open/);
    expect(text).toContain('THESIS_00');
  });

  it('keeps every Lab metric name AND its latest value (AC5)', () => {
    const text = withBudget(MAX_PRESSURE_BUDGET, () => generateSnapshot(vault.ctxRoot));

    expectAllPresent(text, vault.insightTitles, 'insight titles');
    for (const value of vault.insightValues) expect(text).toContain(value);
    // The blinding rung that started all of this.
    expect(text).not.toMatch(/- \d+ insight\(s\)/);
  });

  it('keeps every ★★★ bookmark verbatim', () => {
    const text = withBudget(MAX_PRESSURE_BUDGET, () => generateSnapshot(vault.ctxRoot));
    expect(vault.criticalMessages).toHaveLength(3);
    for (const message of vault.criticalMessages) expect(text).toContain(message);
  });

  it('keeps every compressed core file recoverable by path', () => {
    const text = withBudget(MAX_PRESSURE_BUDGET, () => generateSnapshot(vault.ctxRoot));

    // BOTH constitutions are deliberately absent from this list: neither the
    // soul nor the user file is ever compressed, so there is nothing to recover
    // — their full text is already in the snapshot (asserted verbatim above).
    // Memory is the first core file that still carries rungs, so it is the one
    // that must print its path.
    expect(text).toContain('_dream_context/core/2.memory.md');
  });

  it('shows no banner, and a footer that matches the ladder verdict', () => {
    const { text, budget } = withBudget(undefined, () => measureSnapshot(vault.ctxRoot));

    expect(text).not.toContain(OVERSIZED_SNAPSHOT_DIRECTIVE);
    expect(text).not.toContain('CONTEXT IS INCOMPLETE');

    if (budget.overBudget) {
      expect(text).toContain('the demotion ladder is EXHAUSTED');
    } else if (budget.demoted.length > 0) {
      expect(text).toContain('_Budget note: sections demoted to fit the snapshot budget');
      expect(text).not.toContain('EXHAUSTED');
    }
  });

  it('honours every floor under maximum pressure (AC5)', () => {
    const { budget } = withBudget(MAX_PRESSURE_BUDGET, () => measureSnapshot(vault.ctxRoot));
    const levelOf = (id: string): number | undefined =>
      budget.demoted.find((d) => d.id === id)?.level;

    // Floored sections: the level IS the guarantee, so it is asserted exactly.
    expect(levelOf('lab')).toBe(1);
    expect(levelOf('theses')).toBe(1);
    expect(levelOf('objectives')).toBe(2);

    // Unfloored sections: `applyBudget` breaks the wave loop the instant the
    // snapshot fits, so WHICH rung each stops at is fixture tuning, not a
    // behavioural promise. Only "it demoted at all" is.
    for (const id of ['memory', 'knowledge-index', 'features', 'tasks']) {
      expect(levelOf(id), `${id} was never demoted`).toBeGreaterThanOrEqual(1);
    }
  });

  it('bounds the pinned block while still naming every pin (v5 A1)', () => {
    const text = withBudget(MAX_PRESSURE_BUDGET, () => generateSnapshot(vault.ctxRoot));
    const block = sectionBlock(text, '## Knowledge Index');

    const pinLines = block.split('\n').filter((l) => l.startsWith('- 📌'));
    const bannerLine = block.split('\n').find((l) => l.startsWith('> !!!'));
    const pinnedBlockChars = (bannerLine ?? '').length + 1
      + pinLines.reduce((n, l) => n + l.length + 1, 0);

    expect(bannerLine, 'the MUST-READ banner is never dropped').toBeDefined();
    expect(pinnedBlockChars).toBeLessThanOrEqual(PINNED_KNOWLEDGE_CHARS);

    for (const slug of vault.pinnedSlugs) {
      expect(block).toContain(`**${slug}**`);
      expect(block).toContain(`_dream_context/knowledge/${slug}.md`);
    }
    // 8 pins x a 600-char single sentence bust stage 1 (8 x ~260 > 1,300), so
    // the block degrades to the bare render — no description survives at all.
    for (const line of pinLines) {
      expect(line).toMatch(/^- 📌 \*\*pinned-\d+\*\* \(_dream_context\/knowledge\/pinned-\d+\.md\)$/);
    }
    expect(block).not.toContain(singleSentence(600, 'Pinned 00'));
  });
});

describe('fixture #1 variant — a task roster larger than its bound', () => {
  it('omits whole slugs behind an accurate count, never a cut name (AC3)', () => {
    const longSlug = (i: number) => `fixture-task-${pad(i, 3)}-with-a-deliberately-long-name`;
    const vault = buildVault(join(base, 'long-slugs'), {
      soul: constitutionSoul(),
      user: constitutionUser(),
      memory: memoryFile(130, 25),
      tasks: 200,
      taskSlug: longSlug,
    });

    const text = withBudget(MAX_PRESSURE_BUDGET, () => generateSnapshot(vault.ctxRoot));
    const block = sectionBlock(text, '## Active Tasks');
    const tail = block.split('\n').find((l) => /^- \(\+\d+ more active task\(s\)/.test(l));

    expect(tail, 'the roster tail is missing').toBeDefined();
    const parsed = /^- \(\+(\d+) more active task\(s\) — (\d+) named, (\d+) omitted: (.*) — `dreamcontext tasks list`\)$/
      .exec(tail as string);
    expect(parsed, `tail did not match the named-roster shape: ${tail}`).not.toBeNull();

    const [, restCount, named, omitted, list] = parsed as RegExpExecArray;
    expect(Number(named) + Number(omitted)).toBe(Number(restCount));

    const listed = list.split(', ');
    expect(listed).toHaveLength(Number(named));
    // Every listed name is a WHOLE slug — the bound omits items, it never cuts one.
    for (const name of listed) expect(vault.taskSlugs).toContain(name);
    expect(tail).not.toContain('…');
    expect(tail).toContain('dreamcontext tasks list');
  });
});

describe('fixture #2 — the unfittable vault warns inside the preview window (AC4)', () => {
  it('prepends the banner after the H1, naming the oversized core file', () => {
    const vault = buildVault(join(base, 'unfittable'), { soul: incompressibleSoul(500) });
    const soulChars = incompressibleSoul(500).length;

    const text = withBudget(undefined, () => generateSnapshot(vault.ctxRoot));

    expect(text.length).toBeGreaterThan(HARNESS_PERSIST_CHAR_LIMIT);

    const preview = text.slice(0, HARNESS_PREVIEW_CHARS);
    // Byte-identical to the shipped constant — this is the one instruction the
    // agent is guaranteed to read when the hook output is persisted to a file.
    expect(preview).toContain(OVERSIZED_SNAPSHOT_DIRECTIVE);
    expect(preview).toContain('CONTEXT IS INCOMPLETE');
    expect(preview).toContain('_dream_context/core/0.soul.md');
    expect(preview).toContain(soulChars.toLocaleString('en-US'));
    expect(preview).toContain('dreamcontext doctor');

    // Immediately after the H1, not buried.
    expect(text.split('\n')[0]).toBe('# Agent Context — Auto-loaded');
    expect(text.indexOf(OVERSIZED_SNAPSHOT_DIRECTIVE)).toBeLessThan(200);
  });

  it('names an oversized PERSON constitution the same way — it is never-evict too', () => {
    // A person's constitution renders verbatim, so it reaches the SAME alarm the
    // soul does and the banner must name `people/<slug>.md` rather than blame the
    // renderer. This is what puts `people/*.md` in `auditCoreFileSizes`: the
    // audited path set is the banner's only source of file names.
    const bigUser = preferenceUser(500, 250);
    const vault = buildVault(join(base, 'unfittable-user'), {
      soul: constitutionSoul(),
      user: bigUser,
    });

    const text = withBudget(undefined, () => generateSnapshot(vault.ctxRoot));
    expect(text.length).toBeGreaterThan(HARNESS_PERSIST_CHAR_LIMIT);

    const preview = text.slice(0, HARNESS_PREVIEW_CHARS);
    expect(preview).toContain(OVERSIZED_SNAPSHOT_DIRECTIVE);
    expect(preview).toContain('CONTEXT IS INCOMPLETE');
    expect(preview).toContain(`_dream_context/people/${ACTIVE_PERSON}.md`);
    expect(preview).toContain(bigUser.length.toLocaleString('en-US'));

    // And it got there by staying whole, not by demoting.
    const { budget } = withBudget(undefined, () => measureSnapshot(vault.ctxRoot));
    expect(budget.demoted.map((d) => d.id)).not.toContain('person');
    expect(text).toContain(bigUser.trim());
  });
});

describe('fixture #3 — over the ladder target but still inline (B7 band)', () => {
  /**
   * Total size is monotonic in the heading count: heading lines are verbatim at
   * every rung and the soul is the LAST thing the ladder touches, so the render
   * is `constant + soul`. Bisect rather than hard-code a magic number — the
   * constant moves whenever any cap in snapshot-caps.ts is tuned.
   */
  function bisectHeadingsForBand(root: string, ctxRoot: string): { headings: number; length: number } {
    const measure = (headings: number): number => {
      writeFileSync(join(ctxRoot, 'core', '0.soul.md'), incompressibleSoul(headings), 'utf-8');
      return withBudget(undefined, () => generateSnapshot(ctxRoot)).length;
    };
    let lo = 0;
    let hi = 600;
    let best = { headings: hi, length: measure(hi) };
    for (let step = 0; step < 14 && lo <= hi; step++) {
      const mid = Math.floor((lo + hi) / 2);
      const length = measure(mid);
      if (length > LADDER_TARGET_CHARS && length <= HARNESS_PERSIST_CHAR_LIMIT) {
        return { headings: mid, length };
      }
      if (length <= LADDER_TARGET_CHARS) lo = mid + 1;
      else { hi = mid - 1; best = { headings: mid, length }; }
    }
    return best;
  }

  it('emits the loud footer and NO truncation claim', () => {
    const vault = buildVault(join(base, 'middle-band'), { soul: incompressibleSoul(1) });
    const { headings, length } = bisectHeadingsForBand(vault.projectRoot, vault.ctxRoot);

    expect(
      length,
      `could not land in the 18,001-20,000 band (got ${length} chars at ${headings} headings)`,
    ).toBeGreaterThan(LADDER_TARGET_CHARS);
    expect(length).toBeLessThanOrEqual(HARNESS_PERSIST_CHAR_LIMIT);

    const { text, budget } = withBudget(undefined, () => measureSnapshot(vault.ctxRoot));
    expect(budget.overBudget).toBe(true);

    // The snapshot is thinner than the brain, but it ARRIVES. Claiming a
    // truncated preview here would be false.
    expect(text).not.toContain(OVERSIZED_SNAPSHOT_DIRECTIVE);
    expect(text).not.toContain('CONTEXT IS INCOMPLETE');
    expect(text).not.toMatch(/truncat/i);
    expect(text).not.toMatch(/2KB preview/i);

    expect(text).toContain('_Budget note: the demotion ladder is EXHAUSTED');
    expect(text).toContain('At their floor, unable to shrink further:');
  });
});

describe('pinned knowledge — all three fallback stages (v5 A4)', () => {
  it('stage 1: short descriptions survive, capped per item', () => {
    const vault = buildVault(join(base, 'pins-stage-1'), {
      soul: constitutionSoul(),
      memory: memoryFile(130, 25),
      pinnedFiles: 3,
      pinnedDescriptionChars: 120,
    });

    const text = withBudget(MAX_PRESSURE_BUDGET, () => generateSnapshot(vault.ctxRoot));
    const block = sectionBlock(text, '## Knowledge Index');
    const pinLines = block.split('\n').filter((l) => l.startsWith('- 📌'));

    expect(pinLines).toHaveLength(3);
    for (const line of pinLines) expect(line).toMatch(/^- 📌 \*\*pinned-\d+\*\* \(_dream_context\/knowledge\/pinned-\d+\.md\): .+/);
    expect(pinLines.reduce((n, l) => n + l.length + 1, 0)).toBeLessThanOrEqual(PINNED_KNOWLEDGE_CHARS);
  });

  it('stage 2: descriptions that bust the budget fall back to bare, every pin still named', () => {
    const vault = buildVault(join(base, 'pins-stage-2'), {
      soul: constitutionSoul(),
      memory: memoryFile(130, 25),
      pinnedFiles: 10,
      pinnedDescriptionChars: 600,
    });

    const text = withBudget(MAX_PRESSURE_BUDGET, () => generateSnapshot(vault.ctxRoot));
    const block = sectionBlock(text, '## Knowledge Index');
    const pinLines = block.split('\n').filter((l) => l.startsWith('- 📌'));

    // Bare, not counted: all ten are still named.
    expect(pinLines).toHaveLength(10);
    for (const line of pinLines) expect(line).toMatch(/^- 📌 \*\*pinned-\d+\*\* \(_dream_context\/knowledge\/pinned-\d+\.md\)$/);
    expectAllPresent(block, vault.pinnedSlugs, 'pinned slugs');
    expect(block).not.toContain('more pinned');
  });

  it('stage 3: a pathological pin count packs whole lines behind an accurate count', () => {
    const vault = buildVault(join(base, 'pins-stage-3'), {
      soul: constitutionSoul(),
      memory: memoryFile(130, 25),
      pinnedFiles: 40,
      pinnedDescriptionChars: 600,
    });

    const text = withBudget(MAX_PRESSURE_BUDGET, () => generateSnapshot(vault.ctxRoot));
    const block = sectionBlock(text, '## Knowledge Index');
    const pinLines = block.split('\n').filter((l) => /^- 📌 \*\*/.test(l));
    const tail = block.split('\n').find((l) => /^- 📌 \(\+\d+ more pinned/.test(l));

    expect(tail, 'stage 3 did not fire').toBeDefined();
    const omitted = Number(/\(\+(\d+) more pinned/.exec(tail as string)?.[1]);
    expect(pinLines.length + omitted).toBe(40);

    // Whole lines only — a slug or a path is never cut.
    for (const line of pinLines) expect(line).toMatch(/^- 📌 \*\*pinned-\d+\*\* \(_dream_context\/knowledge\/pinned-\d+\.md\)$/);
    expect(tail).not.toContain('…');
    expect(tail).toContain('dreamcontext knowledge index');
    expect(block.split('\n').find((l) => l.startsWith('> !!!')), 'banner dropped').toBeDefined();
  });
});

describe('demotion ranks', () => {
  // No 'soul' and no 'person': both constitutions are never-evict, so neither
  // has a rank at all. `people-roster` DOES have one (110) — who else exists is
  // inventory, not constitution.
  const EXPECTED_DEMOTABLE_IDS = [
    'bookmarks', 'changelog', 'connected-projects', 'extended-core', 'features',
    'knowledge-index', 'lab', 'memory', 'objectives', 'people-roster', 'releases',
    'tasks', 'theses', 'warm-knowledge',
  ];

  it('covers exactly the demotable sections, with unique ranks above any array index', () => {
    // The union type enforces this at compile time; nothing type-checks at test
    // time, so the same invariant is re-asserted at runtime.
    expect(Object.keys(DEMOTION_RANKS).sort()).toEqual([...EXPECTED_DEMOTABLE_IDS].sort());

    const values = Object.values(DEMOTION_RANKS);
    expect(new Set(values).size).toBe(values.length);
    // Above the largest plausible array index, so a section that escaped the
    // typed constructors sorts FIRST (demoted first) instead of interleaving.
    for (const value of values) expect(value).toBeGreaterThanOrEqual(10);
  });
});
