import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { generateSnapshot } from '../../src/cli/commands/snapshot.js';
import {
  applyBudget, estimateTokens, DEFAULT_SNAPSHOT_BUDGET_TOKENS, type BudgetSection,
} from '../../src/lib/snapshot-budget.js';

/**
 * Byte-identity harness for the SessionStart snapshot.
 *
 * The snapshot's demotion ladder is being reworked so mature vaults fit the
 * harness persist limit. The binding constraint on that work is that an
 * UNDER-BUDGET vault's output must not move by a single byte: small vaults see
 * zero change. Four independent legs prove it, and each is deliberately a
 * different KIND of proof so no single mistake can invalidate all of them:
 *
 *   (a) Golden file. `expected.txt` was generated from a detached worktree at
 *       the SHA recorded in `BASE_SHA`, i.e. from a build that predates every
 *       source edit under test. It cannot be circular with the change.
 *   (b) Ladder-inert. With the budget disabled the ladder cannot run at all;
 *       with it enabled on an under-budget vault the ladder must be a no-op.
 *       The two renders must agree byte for byte. Self-proving: no golden.
 *   (c) The join lemma, executable. Every section split in the rework relies on
 *       `[...X, ...Y].join('\n') === X.join('\n') + '\n' + Y.join('\n')`, and on
 *       its one caveat (a whitespace-only group is dropped by the render filter).
 *   (d) Date-determinism. The fixture must contain nothing that reads the clock,
 *       or the golden rots on its own. Proven by rendering 400 days apart.
 *
 * TWO FIXTURES, one per user-model layout (0.23.0, people-first):
 *   - `snapshot-golden`        — LEGACY: `core/1.user.md`, no `people/`. Pins the
 *     D15 migration window, which renders the old header plus exactly one
 *     deprecation line and is deleted in 0.24.0 along with the branch itself.
 *   - `snapshot-golden-people` — TARGET: `people/people.json` + one constitution
 *     per person, no `core/1.user.md`. Pins the shape everything migrates to.
 * The two vaults are otherwise byte-identical, so `diff` between their goldens
 * is exactly the user-block substitution — which is what makes the new golden
 * reviewable rather than 190 lines of fresh prose to eyeball.
 *
 * DETERMINISM PINS. Four ambient inputs leak into a snapshot render and all four
 * are pinned in `beforeEach`; each one is a bug that actually bites:
 *   - HOME     — the vault registry and the linked-repo registry live under it.
 *   - CWD      — `buildMarketingSnapshot()` resolves the context root from CWD,
 *                NOT from the rootOverride, so an un-pinned CWD splices THIS
 *                repo's Marketing block into the fixture render.
 *   - the clock — `vi.setSystemTime`, only `Date` faked (nothing here uses timers).
 *   - DREAMCONTEXT_PERSON (people fixture only) — active-person resolution falls
 *                through to `git config user.email`, a MACHINE fact, so without
 *                the explicit rung the golden would render whichever fixture
 *                person happened to match the developer's git identity (and
 *                UNRESOLVED on CI). The env var is the documented override and
 *                is rung 1, so it also short-circuits the git exec entirely.
 * Plus `DREAMCONTEXT_DRIFT_CHECK=0`: the drift directive compares the running
 * CLI version against the fixture's `setupVersion`, so without the kill-switch
 * the golden would break on the next version bump.
 *
 * REGENERATING (only when the format legitimately changes, and only from a
 * base-SHA worktree — never from the working tree):
 *   git worktree add ../.dc-base-<sha> <sha>
 *   cd ../.dc-base-<sha> && npm ci
 *   cp -R <main>/tests/fixtures/snapshot-golden* tests/fixtures/
 *   cp <main>/tests/unit/snapshot-byte-identity.test.ts tests/unit/
 *   DC_GOLDEN_WRITE=1 npx vitest run tests/unit/snapshot-byte-identity.test.ts
 * then copy each `expected.txt` back and update `BASE_SHA`.
 *
 * The ONE exception, and the rule that governs it: a DELIBERATE format change
 * cannot be regenerated from a worktree that predates it, so it is regenerated
 * from the working tree and the review gate moves to the DIFF. 0.23.0's
 * people-first change was gated on the legacy golden's diff being *exactly one
 * added line* (the deprecation notice); any other delta would have been an
 * unintended render change, to be fixed in the renderer rather than absorbed
 * into the golden. The memory full-render pointer (also 0.23.0: a
 * ceiling-compliant `2.memory.md` renders verbatim plus one recall-pointer
 * line) re-ran the same gate — *exactly two added lines* (the pointer + a
 * blank) in BOTH goldens. The automations zero state (0.24.2: the
 * `## Automations` section now always renders, so a session can discover the
 * subsystem on a vault that has none) ran it a third time — *exactly four
 * added lines* (heading, blank, the one-line zero state, blank) in BOTH
 * goldens. `BASE_SHA` still records the last SHA at which leg (a) was
 * non-circular.
 *
 * `expected.txt` intentionally has NO trailing newline: `generateSnapshot`
 * returns trimmed text and the golden is that text verbatim. An editor or
 * formatter that appends one will fail leg (a) loudly, which is the correct
 * outcome — do not "fix" it by trimming in the assertion.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'fixtures');

interface GoldenFixture {
  /** Test-name label. */
  label: string;
  /** Directory under tests/fixtures/. */
  dir: string;
  /**
   * `DREAMCONTEXT_PERSON` for this fixture, or null to leave it unset. Only the
   * people-first fixture needs it (see the determinism pins above).
   */
  person: string | null;
}

const FIXTURES: GoldenFixture[] = [
  { label: 'legacy — core/1.user.md, no people/', dir: 'snapshot-golden', person: null },
  { label: 'people-first — people/, no core/1.user.md', dir: 'snapshot-golden-people', person: 'ada-fixture' },
];

/** Project root of a fixture (the parent of its `_dream_context/`). */
const vaultRoot = (f: GoldenFixture): string => join(FIXTURES_DIR, f.dir, 'vault');
/** What `generateSnapshot(rootOverride)` takes: the context root itself. */
const contextRoot = (f: GoldenFixture): string => join(vaultRoot(f), '_dream_context');
const expectedPath = (f: GoldenFixture): string => join(FIXTURES_DIR, f.dir, 'expected.txt');

const PINNED_NOW = new Date('2026-07-28T12:00:00.000Z');
const FAR_LATER = new Date(PINNED_NOW.getTime() + 400 * 86_400_000);

/** The fixture must stay comfortably under budget or leg (b) goes vacuous. */
const FIXTURE_MAX_CHARS = 12_000;

let originalHome: string | undefined;
let originalCwd: string;
let originalDrift: string | undefined;
let originalBudget: string | undefined;
let originalPerson: string | undefined;
let home: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  originalDrift = process.env.DREAMCONTEXT_DRIFT_CHECK;
  originalBudget = process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
  originalPerson = process.env.DREAMCONTEXT_PERSON;

  // An empty HOME: no vault registry, no linked-repo registry, no machine state.
  // The fixture's linked repo therefore resolves as MISSING, which renders the
  // `(missing; ...)` branch and emits no absolute path — that is what keeps the
  // golden portable across machines and CI.
  home = mkdtempSync(join(tmpdir(), 'dc-golden-home-'));
  process.env.HOME = home;
  process.env.DREAMCONTEXT_DRIFT_CHECK = '0';
  delete process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
  delete process.env.DREAMCONTEXT_PERSON;

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDrift === undefined) delete process.env.DREAMCONTEXT_DRIFT_CHECK;
  else process.env.DREAMCONTEXT_DRIFT_CHECK = originalDrift;
  if (originalBudget === undefined) delete process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
  else process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = originalBudget;
  if (originalPerson === undefined) delete process.env.DREAMCONTEXT_PERSON;
  else process.env.DREAMCONTEXT_PERSON = originalPerson;
  rmSync(home, { recursive: true, force: true });
});

describe.each(FIXTURES)('snapshot byte-identity — golden fixture (leg a) [$label]', (fixture) => {
  const VAULT_ROOT = vaultRoot(fixture);
  const CONTEXT_ROOT = contextRoot(fixture);
  const EXPECTED_PATH = expectedPath(fixture);
  const SLEEP_STATE_PATH = join(CONTEXT_ROOT, 'state', '.sleep.json');

  beforeEach(() => {
    process.chdir(VAULT_ROOT);
    if (fixture.person) process.env.DREAMCONTEXT_PERSON = fixture.person;
  });

  it('renders byte-identically to the golden captured at BASE_SHA', () => {
    const text = generateSnapshot(CONTEXT_ROOT);

    // Generation mode, used ONLY inside a base-SHA worktree (or for a
    // deliberate, diff-reviewed format change). See the header.
    if (process.env.DC_GOLDEN_WRITE === '1') {
      writeFileSync(EXPECTED_PATH, text, 'utf-8');
    }

    expect(existsSync(EXPECTED_PATH)).toBe(true);
    expect(text).toBe(readFileSync(EXPECTED_PATH, 'utf-8'));
  });

  it('records the base SHA the golden was generated from', () => {
    const sha = readFileSync(join(FIXTURES_DIR, fixture.dir, 'BASE_SHA'), 'utf-8').trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the fixture stays under budget, so the ladder is genuinely a no-op', () => {
    const text = generateSnapshot(CONTEXT_ROOT);
    expect(text.length).toBeLessThan(FIXTURE_MAX_CHARS);
    expect(estimateTokens(text)).toBeLessThanOrEqual(DEFAULT_SNAPSHOT_BUDGET_TOKENS);
    // A no-op ladder never appends its footer.
    expect(text).not.toContain('Budget note');
  });

  it('emits no machine-specific absolute path (the golden must be portable)', () => {
    const text = generateSnapshot(CONTEXT_ROOT);
    expect(text).not.toContain(VAULT_ROOT);
    expect(text).not.toContain(home);
    expect(text).not.toContain(tmpdir());
  });

  it('rendering the fixture does not mutate it', () => {
    // A contextual-reminder trigger would increment `fired_count` and rewrite
    // `.sleep.json`, making run two differ from run one. The fixture ships with
    // `triggers: []` for exactly this reason; this pins that invariant.
    const before = readFileSync(SLEEP_STATE_PATH, 'utf-8');
    generateSnapshot(CONTEXT_ROOT);
    expect(readFileSync(SLEEP_STATE_PATH, 'utf-8')).toBe(before);
  });
});

describe('snapshot byte-identity — the two layouts render their own block, and only their own', () => {
  const legacy = FIXTURES[0];
  const people = FIXTURES[1];

  const DEPRECATION_LINE = '> ⚠️ Retired layout — run `dreamcontext update` to migrate to `people/`.';

  function render(fixture: GoldenFixture): string {
    process.chdir(vaultRoot(fixture));
    if (fixture.person) process.env.DREAMCONTEXT_PERSON = fixture.person;
    return generateSnapshot(contextRoot(fixture));
  }

  it('the LEGACY vault keeps the old header and gains exactly one deprecation line (D15)', () => {
    const text = render(legacy);

    expect(text).toContain('## User (Preferences, Project Details, Rules)');
    expect(text.split('\n').filter((l) => l === DEPRECATION_LINE)).toHaveLength(1);
    // The notice sits directly UNDER the header, not somewhere in the body.
    const lines = text.split('\n');
    const headerAt = lines.indexOf('## User (Preferences, Project Details, Rules)');
    expect(lines[headerAt + 2]).toBe(DEPRECATION_LINE);

    // No people layout, so no person block and no roster, ever.
    expect(text).not.toContain('## Person (Active');
    expect(text).not.toContain('## Other People');
  });

  it('the PEOPLE vault renders the active constitution verbatim under its own header', () => {
    const text = render(people);
    const constitution = readFileSync(
      join(contextRoot(people), 'people', 'ada-fixture.md'), 'utf-8',
    ).trim();

    expect(text).toContain('## Person (Active — Ada Fixture, `person:ada-fixture`)');
    expect(text).toContain(constitution);

    // The retired layout is GONE, not merely superseded.
    expect(text).not.toContain('## User (Preferences, Project Details, Rules)');
    expect(text).not.toContain(DEPRECATION_LINE);
    expect(text).not.toContain('## Person (Active — UNRESOLVED)');
  });

  it('the roster names everyone ELSE, carries role from people.json, and parses no markdown', () => {
    const text = render(people);

    expect(text).toContain('## Other People (this vault)');
    expect(text).toContain('- **Bob Fixture** (`person:bob-fixture`) — reviewer');
    // No role in people.json ⇒ no suffix at all, not an empty one.
    expect(text).toContain('- **Cleo Fixture** (`person:cleo-fixture`)');
    expect(text).not.toContain('- **Cleo Fixture** (`person:cleo-fixture`) —');
    // The ACTIVE person is not "other".
    expect(text).not.toContain('(`person:ada-fixture`)\n');
    expect(text).not.toContain('- **Ada Fixture** (`person:ada-fixture`)');

    // B3 REGRESSION LOCK: the roster line is built from people.json's `role`
    // ONLY. Bob's `## Identity` prose exists, and must never reach the render —
    // parsing it would read every person's markdown on the SessionStart hot path
    // AND lift prose into a structural line.
    expect(text).not.toContain('IDENTITY_PROSE_STAYS_IN_THIS_FILE');
    expect(text).not.toContain('reviews the budget ladder');
  });

  it('multi-person attribution is derived from people.json, not from .config.json', () => {
    // The fixture's `.config.json` has NO `people` key at all — the roster is the
    // only source of "is this vault multi-person", which is what makes the
    // changelog's `— by …` suffix render here and not in the legacy vault.
    const config = JSON.parse(
      readFileSync(join(contextRoot(people), 'state', '.config.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(config.people).toBeUndefined();

    expect(render(people)).toContain('— by ada-fixture');
    expect(render(legacy)).not.toContain('— by ');
  });

  it('the two goldens differ ONLY in the user block (and its attribution)', () => {
    // The vaults are byte-identical copies apart from the user model, so this is
    // the review aid that makes the NEW golden checkable rather than eyeballed:
    // delete the user-model sections and the person attribution, and the two
    // renders must be the same document. Anything else drifting between them is
    // a fixture bug, not a format decision.
    // The cut runs from the first user-model header to the section that follows
    // it in BOTH layouts. It cannot stop at "the next `## `": a constitution's
    // own body is made of H2s (`## Preferences`, `## Workflow Notes`), which is
    // precisely why the block is rendered verbatim in the first place.
    const NEXT_SECTION = '## Task Format Override';
    const stripUserModel = (text: string): string => {
      const start = text.search(/^## (User \(Preferences|Person \(Active|Other People)/m);
      const end = text.indexOf(NEXT_SECTION);
      expect(start, 'no user-model block found').toBeGreaterThan(-1);
      expect(end, `no ${NEXT_SECTION} section to cut to`).toBeGreaterThan(start);
      return (text.slice(0, start) + text.slice(end)).replace(/ — by .*$/gm, '');
    };

    expect(stripUserModel(readFileSync(expectedPath(people), 'utf-8')))
      .toBe(stripUserModel(readFileSync(expectedPath(legacy), 'utf-8')));
  });
});

describe.each(FIXTURES)('snapshot byte-identity — ladder inert under budget (leg b) [$label]', (fixture) => {
  const CONTEXT_ROOT = contextRoot(fixture);

  beforeEach(() => {
    process.chdir(vaultRoot(fixture));
    if (fixture.person) process.env.DREAMCONTEXT_PERSON = fixture.person;
  });

  it('a disabled budget and the default budget render identically', () => {
    process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = 'off';
    const disabled = generateSnapshot(CONTEXT_ROOT);

    delete process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
    const budgeted = generateSnapshot(CONTEXT_ROOT);

    expect(budgeted).toBe(disabled);
  });

  it('holds for an explicit generous budget too', () => {
    process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = '100000';
    const generous = generateSnapshot(CONTEXT_ROOT);

    process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = 'off';
    const disabled = generateSnapshot(CONTEXT_ROOT);

    expect(generous).toBe(disabled);
  });
});

describe('snapshot byte-identity — the join lemma (leg c)', () => {
  // Every section split in the rework (the `# Agent Context` header out of
  // soul, soul out of user, bookmarks out of awareness) rests on this property.
  const X = ['## Alpha\n', 'alpha body', ''];
  const Y = ['## Beta\n', 'beta body', ''];

  const render = (sections: BudgetSection[]): string => applyBudget(sections, null).text;

  it('splitting one section into two at an element boundary is byte-neutral', () => {
    const merged = render([{ id: 'merged', text: [...X, ...Y].join('\n') }]);
    const split = render([
      { id: 'x', text: X.join('\n') },
      { id: 'y', text: Y.join('\n') },
    ]);
    expect(split).toBe(merged);
  });

  it('holds at every element boundary, not just the one we happen to use', () => {
    const all = [...X, ...Y];
    const merged = render([{ id: 'merged', text: all.join('\n') }]);
    for (let cut = 1; cut < all.length; cut++) {
      const head = all.slice(0, cut);
      const tail = all.slice(cut);
      // The caveat below governs whitespace-only groups; skip those here.
      if (head.join('\n').trim() === '' || tail.join('\n').trim() === '') continue;
      expect(render([
        { id: 'head', text: head.join('\n') },
        { id: 'tail', text: tail.join('\n') },
      ])).toBe(merged);
    }
  });

  it('CAVEAT: a whitespace-only group is dropped by the render filter', () => {
    // This is the one case where splitting is NOT byte-neutral, and it is why
    // every split in the rework lands where both halves carry real content.
    const merged = render([{ id: 'merged', text: ['', '## Alpha\n', 'body'].join('\n') }]);
    const split = render([
      { id: 'blank', text: '' },
      { id: 'rest', text: ['## Alpha\n', 'body'].join('\n') },
    ]);
    expect(split).not.toBe(merged);
    expect(merged.startsWith('\n')).toBe(true);
    expect(split.startsWith('\n')).toBe(false);
  });
});

describe.each(FIXTURES)('snapshot byte-identity — date-determinism (leg d) [$label]', (fixture) => {
  const CONTEXT_ROOT = contextRoot(fixture);

  beforeEach(() => {
    process.chdir(vaultRoot(fixture));
    if (fixture.person) process.env.DREAMCONTEXT_PERSON = fixture.person;
  });

  it('renders identically 400 days apart', () => {
    const atPinned = generateSnapshot(CONTEXT_ROOT);
    vi.setSystemTime(FAR_LATER);
    const atFarLater = generateSnapshot(CONTEXT_ROOT);

    expect(atFarLater).toBe(atPinned);
  });

  it('renders identically 400 days EARLIER too', () => {
    // Guards the other direction: a `daysSince` that goes negative must not
    // flip a threshold either.
    const atPinned = generateSnapshot(CONTEXT_ROOT);
    vi.setSystemTime(new Date(PINNED_NOW.getTime() - 400 * 86_400_000));
    const atEarlier = generateSnapshot(CONTEXT_ROOT);

    expect(atEarlier).toBe(atPinned);
  });
});
