import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkCoreFileSizes, checkPeople, checkSnapshotSize } from '../../src/cli/commands/doctor.js';
import {
  HARNESS_PERSIST_CHAR_LIMIT, DEFAULT_SNAPSHOT_BUDGET_TOKENS,
} from '../../src/lib/snapshot-budget.js';
import { CORE_FILE_CHAR_CEILING, CORE_FILE_LINE_CEILING } from '../../src/lib/core-index.js';
import { measureSnapshot } from '../../src/cli/commands/snapshot.js';
import { writePeople } from '../../src/lib/people-store.js';
import { PERSON_ENV_VAR } from '../../src/lib/people-resolve.js';

let projectRoot: string;
let root: string;
let home: string;
let originalHome: string | undefined;
let originalBudget: string | undefined;
let originalPerson: string | undefined;

/**
 * The active person, pinned via `DREAMCONTEXT_PERSON` (rung 1) in `beforeEach`.
 *
 * Two reasons, both load-bearing here: it makes the render independent of the
 * machine's `git config user.email`, and it means the resolution ladder never
 * shells out to git — this suite renders the snapshot ~70 times in the
 * middle-band bisect alone.
 */
const ACTIVE_PERSON = 'ada-doctor';

/**
 * A core file the demotion ladder CANNOT shrink.
 *
 * Heading lines pass through the compressor verbatim at every rung (see
 * `snapshot-compress.ts`), so a file built from them holds its size through
 * every rung it has. That is what lets these fixtures drive the ladder to
 * exhaustion without any opt-in "pin this" product surface. It is also why the
 * bulk lives in HEADINGS rather than in `- **Decision N**` bullets: memory's
 * deepest rung packs each H2's items into a 350-char budget, so a bullet-shaped
 * fixture collapses to nothing and never reaches the band under test.
 *
 * Which FILE it is written to decides which doctor band fires, so the three are
 * not interchangeable:
 *   - `0.soul.md` and `people/<active>.md` are NEVER-EVICT — the agent's
 *     constitution and the active person's constitution both render verbatim —
 *     so bloat in either lands in the never-evict tier and doctor ERRORS.
 *   - `2.memory.md` is demotable, so bloat there exercises "the render busts the
 *     limit but the pinned tier is small" — the band that WARNS.
 */
function incompressibleCore(headings: number, name = 'Big'): string {
  return `---\nname: ${name}\n---\n\n`
    + Array.from({ length: headings }, (_, i) => `## Rule ${i} — ${'x'.repeat(60)}`).join('\n')
    + '\n';
}

function incompressibleSoul(headings: number): string {
  return incompressibleCore(headings).replace('name: Big\n', 'name: Big\ntype: soul\n');
}

function writeSoul(content: string): void {
  writeFileSync(join(root, 'core', '0.soul.md'), content, 'utf-8');
}

/** The ACTIVE person's constitution — `people/<slug>.md`, never-evict. */
function writePerson(content: string): void {
  writeFileSync(join(root, 'people', `${ACTIVE_PERSON}.md`), content, 'utf-8');
}

function writeMemory(content: string): void {
  writeFileSync(join(root, 'core', '2.memory.md'), content, 'utf-8');
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-doctor-snapshot-'));
  home = mkdtempSync(join(tmpdir(), 'dc-doctor-home-'));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'people'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeSoul('---\nname: Small\ntype: soul\n---\n\nA tiny project.\n');
  writePeople(root, { [ACTIVE_PERSON]: { name: 'Ada Doctor', emails: ['ada@doctor.invalid'] } });
  writePerson('---\nname: ada-doctor\ntype: person\n---\n\nPrefers brevity.\n');
  writeFileSync(join(root, 'core', '2.memory.md'), '---\nname: memory\n---\n\n## Active Memory\n\n- nothing yet\n', 'utf-8');

  // HOME leaks into the vault registry and linked-repo resolution, so pin it or
  // the real machine's vaults bleed into the measured snapshot.
  originalHome = process.env.HOME;
  process.env.HOME = home;
  originalBudget = process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
  delete process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
  originalPerson = process.env[PERSON_ENV_VAR];
  process.env[PERSON_ENV_VAR] = ACTIVE_PERSON;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalBudget === undefined) delete process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
  else process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = originalBudget;
  if (originalPerson === undefined) delete process.env[PERSON_ENV_VAR];
  else process.env[PERSON_ENV_VAR] = originalPerson;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('checkSnapshotSize — under the limit', () => {
  it('reports ok with the size and its percentage of the harness limit', () => {
    const results = checkSnapshotSize(root);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('ok');
    expect(results[0].message).toContain('Snapshot size');
    expect(results[0].message).toMatch(/\d+% of the 20,000-char harness limit/);
  });
});

describe('checkSnapshotSize — over the harness limit', () => {
  it('WARNS (not errors) when the render busts the limit but the never-evict tier is small', () => {
    // ~29K of headings in the MEMORY file: demotable, so the ladder runs every
    // rung and still cannot fit — while the pinned tier stays small. (It has to
    // be memory, not a constitution: both the soul and the user file are
    // never-evict, so the same bulk in either is the ERROR band below.)
    writeMemory(incompressibleCore(400, 'memory'));
    const { text, budget } = measureSnapshot(root, { fireTriggers: false });
    expect(text.length).toBeGreaterThan(HARNESS_PERSIST_CHAR_LIMIT);
    expect(budget.neverEvictChars).toBeLessThan(HARNESS_PERSIST_CHAR_LIMIT);

    const results = checkSnapshotSize(root);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('warn');
    expect(results[0].status).not.toBe('error');
    expect(results[0].message).toContain('20,000-char harness limit');
    expect(results[0].message).toContain('2,000-char blind preview');
    expect(results[0].message).toContain('Trim the core files flagged above');
  });

  it('ERRORS on an oversized SOUL — the constitution renders verbatim, so no rung can help', () => {
    // The designed alarm for a soul that has not had its conditional rules
    // extracted yet: it is never-evict, so the ladder has nothing to give and
    // doctor must say so on the FILE rather than blame the renderer.
    writeSoul(incompressibleSoul(400));

    const { budget } = measureSnapshot(root, { fireTriggers: false });
    expect(budget.neverEvictChars).toBeGreaterThan(HARNESS_PERSIST_CHAR_LIMIT);
    expect(budget.demoted.map((d) => d.id)).not.toContain('soul');

    const results = checkSnapshotSize(root);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].message).toContain('Never-evict tier');
    expect(results[0].message).toContain('soul');
    expect(results[0].message).toContain('core/0.soul.md');
  });

  it('ERRORS on an oversized PERSON constitution too — same terms as the soul', () => {
    // Same alarm, same reason: the active person's constitution renders
    // verbatim, so a junk-drawer one is a CONTENT problem the ladder must not
    // paper over. Extraction is the fix, not a compression rung.
    writePerson(incompressibleCore(400, 'person'));

    const { budget } = measureSnapshot(root, { fireTriggers: false });
    expect(budget.neverEvictChars).toBeGreaterThan(HARNESS_PERSIST_CHAR_LIMIT);
    expect(budget.demoted.map((d) => d.id)).not.toContain('person');

    const results = checkSnapshotSize(root);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].message).toContain('Never-evict tier');
    expect(results[0].message).toContain('person');
    expect(results[0].message).toContain('people/<active>.md');
  });

  it('ERRORS the same way on a LEGACY core/1.user.md — the D15 branch is never-evict too', () => {
    // The migration window (CLI upgraded, project not yet updated) renders the
    // old file under the same pinned section id, so it reaches the same alarm.
    rmSync(join(root, 'people'), { recursive: true, force: true });
    writeFileSync(join(root, 'core', '1.user.md'), incompressibleCore(400, 'user'), 'utf-8');

    const { text, budget } = measureSnapshot(root, { fireTriggers: false });
    expect(text).toContain('Retired layout');
    expect(budget.neverEvictChars).toBeGreaterThan(HARNESS_PERSIST_CHAR_LIMIT);
    expect(budget.demoted.map((d) => d.id)).not.toContain('person');
    expect(checkSnapshotSize(root)[0].status).toBe('error');
  });

  it('ERRORS when the never-evict tier ALONE busts the limit — the ladder cannot fix that', () => {
    // A matched contextual reminder renders into `awareness`, which is never
    // evicted. A huge one puts the pinned tier over the limit on its own.
    writeFileSync(
      join(root, 'state', 'build-the-thing.md'),
      '---\nstatus: todo\npriority: high\n---\n\n## Why\n\nBecause.\n',
      'utf-8',
    );
    writeFileSync(
      join(root, 'state', '.sleep.json'),
      JSON.stringify({
        debt: 0,
        sessions: [],
        bookmarks: [],
        triggers: [{
          when: 'build-the-thing',
          remind: 'R'.repeat(25_000),
          fired_count: 0,
          max_fires: 3,
        }],
        knowledge_access: {},
      }),
      'utf-8',
    );

    const { budget } = measureSnapshot(root, { fireTriggers: false });
    expect(budget.neverEvictChars).toBeGreaterThan(HARNESS_PERSIST_CHAR_LIMIT);

    const results = checkSnapshotSize(root);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].message).toContain('Never-evict tier');
    expect(results[0].message).toContain('demotion ladder cannot fix this');
    // The tier is named so the user knows where to look.
    expect(results[0].message).toContain('awareness');
    expect(results[0].message).toContain('task-override');
  });
});

describe('checkSnapshotSize — the middle band (over the ladder target, still inline)', () => {
  it('names the 18,000-char ladder target, not the harness limit', () => {
    // Grow the incompressible soul until the render lands strictly between the
    // ladder's 18,000-char target and the 20,000-char harness limit. Bounded and
    // deterministic — it re-calibrates if the surrounding format ever shifts.
    const budgetChars = DEFAULT_SNAPSHOT_BUDGET_TOKENS * 4;
    let landed = 0;
    for (let headings = 230; headings <= 300; headings++) {
      writeSoul(incompressibleSoul(headings));
      const len = measureSnapshot(root, { fireTriggers: false }).text.length;
      if (len > budgetChars && len <= HARNESS_PERSIST_CHAR_LIMIT) {
        landed = len;
        break;
      }
    }
    expect(landed).toBeGreaterThan(budgetChars);
    expect(landed).toBeLessThanOrEqual(HARNESS_PERSIST_CHAR_LIMIT);

    const results = checkSnapshotSize(root);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('warn');
    expect(results[0].message).toContain("past the ladder's 18,000-char target");
    expect(results[0].message).toContain('still lands inline');
    // NOT the harness-limit message.
    expect(results[0].message).not.toContain('blind preview');
    expect(results[0].message).not.toContain('Trim the core files');
  });
});

describe('checkSnapshotSize — DREAMCONTEXT_SNAPSHOT_BUDGET=off', () => {
  it('blames the disabled ladder, not the core files', () => {
    process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = 'off';
    // Bulk in a DEMOTABLE core file: with the ladder off it renders in full, so
    // the disabled ladder is the honest diagnosis. The same bulk in either
    // constitution is the never-evict error instead, which is a different (and
    // also true) claim.
    writeMemory(`---\nname: Big\n---\n\n## Active Memory\n\n${'padding line\n'.repeat(16_000)}`);

    const { text } = measureSnapshot(root, { fireTriggers: false });
    expect(text.length).toBeGreaterThan(200_000);

    const results = checkSnapshotSize(root);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('warn');
    expect(results[0].message).toContain('DREAMCONTEXT_SNAPSHOT_BUDGET is set to off');
    expect(results[0].message).toContain('demotion ladder is disabled');
    // Must not send the user off trimming files that are not the cause.
    expect(results[0].message).not.toContain('Trim the core files');
    expect(results[0].message).not.toContain('blind preview');
  });

  it('still reports ok on a small vault when the ladder is off', () => {
    process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = 'off';
    const results = checkSnapshotSize(root);
    expect(results[0].status).toBe('ok');
  });
});

describe('checkSnapshotSize — never spends a contextual reminder firing', () => {
  it('leaves state/.sleep.json byte-identical with a matching trigger present', () => {
    writeFileSync(
      join(root, 'state', 'ship-the-fix.md'),
      '---\nstatus: in_progress\npriority: high\n---\n\n## Why\n\nBecause.\n',
      'utf-8',
    );
    const sleepPath = join(root, 'state', '.sleep.json');
    writeFileSync(
      sleepPath,
      JSON.stringify({
        debt: 0,
        sessions: [],
        bookmarks: [],
        triggers: [{ when: 'ship-the-fix', remind: 'Remember the migration', fired_count: 0, max_fires: 3 }],
        knowledge_access: {},
      }),
      'utf-8',
    );
    const before = readFileSync(sleepPath, 'utf-8');

    // Guard the guard: the trigger really does match and render, so a missing
    // `fireTriggers: false` would genuinely have written here.
    expect(measureSnapshot(root, { fireTriggers: false }).text).toContain('Remember the migration');

    checkSnapshotSize(root);

    expect(readFileSync(sleepPath, 'utf-8')).toBe(before);
  });
});

describe('checkSnapshotSize — degrades instead of breaking doctor', () => {
  it('warns when the snapshot cannot be rendered at all', () => {
    // A directory where core/0.soul.md should be: existsSync passes, the read
    // throws EISDIR. doctor must survive a corrupted vault.
    rmSync(join(root, 'core', '0.soul.md'), { force: true });
    mkdirSync(join(root, 'core', '0.soul.md'), { recursive: true });

    expect(() => measureSnapshot(root, { fireTriggers: false })).toThrow();

    const results = checkSnapshotSize(root);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('warn');
    expect(results[0].message).toContain('Could not render the snapshot');
  });
});

describe('checkCoreFileSizes', () => {
  it('reports ok when every core file is within both ceilings', () => {
    const results = checkCoreFileSizes(root);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('ok');
    expect(results[0].message).toContain('4,000-char / 150-line ceilings');
  });

  it('warns per oversized file, naming CHARS before LINES', () => {
    // 69 lines / ~13.6K chars is the real shape of this repo's soul: a
    // line-only ceiling calls it fine, which is why chars lead.
    const fat = `---\nname: Fat\n---\n\n${Array.from({ length: 60 }, (_, i) => `- rule ${i}: ${'y'.repeat(200)}`).join('\n')}\n`;
    writeSoul(fat);
    expect(fat.length).toBeGreaterThan(CORE_FILE_CHAR_CEILING);
    expect(fat.split('\n').length).toBeLessThan(CORE_FILE_LINE_CEILING);

    const results = checkCoreFileSizes(root);
    const soulWarn = results.find((r) => r.message.includes('0.soul.md'));
    expect(soulWarn?.status).toBe('warn');
    expect(soulWarn?.message).toContain('over the 4,000-char ceiling');
    expect(soulWarn?.message).toContain('extract detail to knowledge/');
    // Chars are named before lines.
    const msg = soulWarn!.message;
    expect(msg.indexOf('chars')).toBeLessThan(msg.indexOf('lines'));
    // Only the char ceiling was breached, so the line ceiling is not claimed.
    expect(msg).not.toContain('150-line ceiling');
  });

  it('names BOTH ceilings when a file breaches both', () => {
    writeSoul(`---\nname: Fat\n---\n\n${Array.from({ length: 300 }, (_, i) => `- rule ${i}: ${'y'.repeat(60)}`).join('\n')}\n`);
    const results = checkCoreFileSizes(root);
    const soulWarn = results.find((r) => r.message.includes('0.soul.md'));
    expect(soulWarn?.message).toContain('over the 4,000-char and 150-line ceiling');
  });

  it('returns [] when there is nothing to audit', () => {
    // Both audited roots have to go: the audit covers `core/[0-9]*.md` AND
    // `people/*.md` now, so removing only one still yields rows.
    rmSync(join(root, 'core'), { recursive: true, force: true });
    rmSync(join(root, 'people'), { recursive: true, force: true });
    expect(checkCoreFileSizes(root)).toEqual([]);
  });

  it('warns on an oversized PERSON constitution, naming people/<slug>.md', () => {
    writePerson(`---\nname: Fat\n---\n\n${Array.from({ length: 60 }, (_, i) => `- pref ${i}: ${'y'.repeat(200)}`).join('\n')}\n`);
    const warn = checkCoreFileSizes(root).find((r) => r.message.includes('people/'));
    expect(warn?.status).toBe('warn');
    expect(warn?.message).toContain(`_dream_context/people/${ACTIVE_PERSON}.md`);
    expect(warn?.message).toContain('over the 4,000-char ceiling');
  });
});

/**
 * `doctor`'s people matrix (v3). Lives here because this file owns the doctor
 * unit tests; it is about correctness of the CHECK, not about snapshot size.
 *
 * The through-line of every case: `doctor` is the tool people run BECAUSE
 * something is wrong, so every broken state it can find must come back as a
 * described result — never as an exception, and never as a hard failure on a
 * vault that is merely mid-migration.
 */
describe('checkPeople — the doctor matrix', () => {
  const statuses = (root_: string): string[] => checkPeople(root_).map((r) => r.status);
  const messages = (root_: string): string => checkPeople(root_).map((r) => r.message).join('\n');

  it('is OK on a healthy solo vault', () => {
    expect(statuses(root)).toEqual(['ok']);
    expect(messages(root)).toContain('people/ (1 person)');
  });

  it('ERRORS when NEITHER people/people.json NOR core/1.user.md exists', () => {
    rmSync(join(root, 'people'), { recursive: true, force: true });
    expect(statuses(root)).toEqual(['error']);
    expect(messages(root)).toContain('people/people.json');
    expect(messages(root)).toContain('core/1.user.md');
  });

  it('ERRORS when the roster parses to ZERO people (unrepresentable, not solo)', () => {
    writeFileSync(join(root, 'people', 'people.json'), '{"version":1,"people":{}}', 'utf-8');
    const results = checkPeople(root);
    expect(results.map((r) => r.status)).toEqual(['error']);
    expect(results[0].message).toContain('lists no people');
  });

  it('ERRORS on a corrupt roster with a MESSAGE, never a stack trace (D17)', () => {
    writeFileSync(join(root, 'people', 'people.json'), '{"version":1,"people":{', 'utf-8');

    let results: ReturnType<typeof checkPeople> = [];
    expect(() => { results = checkPeople(root); }).not.toThrow();
    expect(results.map((r) => r.status)).toEqual(['error']);
    expect(results[0].message).toContain('people/people.json could not be read');
    expect(results[0].message).not.toContain('at Object.');
  });

  it('ERRORS naming EVERY roster slug that has no constitution file', () => {
    writePeople(root, {
      [ACTIVE_PERSON]: { name: 'Ada Doctor', emails: [] },
      'bob-doctor': { name: 'Bob Doctor', emails: [] },
      'cleo-doctor': { name: 'Cleo Doctor', emails: [] },
    });
    const errors = checkPeople(root).filter((r) => r.status === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('people/bob-doctor.md');
    expect(errors[0].message).toContain('people/cleo-doctor.md');
    // The one that DOES have its file is not accused.
    expect(errors[0].message).not.toContain(`people/${ACTIVE_PERSON}.md`);
  });

  it('WARNS (never errors) on the retired layout, with or without people/', () => {
    // WITH people/: migrated but the old file is still lying around.
    writeFileSync(join(root, 'core', '1.user.md'), '---\nname: user\n---\n\nOld.\n', 'utf-8');
    const withPeople = checkPeople(root);
    expect(withPeople.some((r) => r.status === 'error')).toBe(false);
    expect(withPeople.find((r) => r.status === 'warn')?.message).toContain('retired layout');
    expect(withPeople.find((r) => r.status === 'warn')?.message).toContain('dreamcontext update');

    // WITHOUT people/: the pre-migration window. A vault here is WORKING, so a
    // hard failure would break `doctor` in CI on a healthy project.
    rmSync(join(root, 'people'), { recursive: true, force: true });
    const legacyOnly = checkPeople(root);
    expect(legacyOnly.map((r) => r.status)).toEqual(['warn']);
    expect(legacyOnly[0].message).toContain('retired layout');
  });

  it('WARNS with the resolution SOURCE when a multi-person vault cannot resolve this machine', () => {
    writePeople(root, {
      [ACTIVE_PERSON]: { name: 'Ada Doctor', emails: ['ada@doctor.invalid'] },
      'bob-doctor': { name: 'Bob Doctor', emails: ['bob@doctor.invalid'] },
    });
    writeFileSync(join(root, 'people', 'bob-doctor.md'), '---\nname: bob-doctor\n---\n\nB.\n', 'utf-8');

    // No env pin, no machine pin, and neither fixture email is anyone's git
    // identity — so this machine is genuinely ambiguous.
    delete process.env[PERSON_ENV_VAR];
    const warn = checkPeople(root).find((r) => r.status === 'warn');
    expect(warn?.message).toContain('Active person unresolved');
    expect(warn?.message).toContain('source: none');
    expect(warn?.message).toContain('people whoami --set');
    expect(checkPeople(root).some((r) => r.status === 'error')).toBe(false);

    // …and resolving it flips the same check to ok, printing the source.
    process.env[PERSON_ENV_VAR] = ACTIVE_PERSON;
    const ok = checkPeople(root).filter((r) => r.status === 'ok');
    expect(ok.some((r) => r.message.includes(`Active person: Ada Doctor (\`person:${ACTIVE_PERSON}\`, source: env)`))).toBe(true);
  });

  it('says nothing about resolution on a SOLO vault — it is trivially implied', () => {
    delete process.env[PERSON_ENV_VAR];
    expect(messages(root)).not.toContain('Active person');
  });
});
