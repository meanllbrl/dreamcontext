import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readGitIdentity } from '../lib/git-sync/git.js';
import { slugify } from '../lib/id.js';
import { readJsonObject, writeJsonObject } from '../lib/json-file.js';
import { resolveActivePerson } from '../lib/people-resolve.js';
import {
  addPerson,
  hasPeopleLayout,
  isSafePersonSlug,
  normalizeEmails,
  peopleJsonPath,
  personFilePath,
  readPeople,
  renderPersonConstitution,
  writePeople,
} from '../lib/people-store.js';
import type { PeopleMap } from '../lib/people-store.js';
import { deleteSetupConfigKeys, readSetupConfig } from '../lib/setup-config.js';
import {
  rescaleLegacySessionRecords,
  recomputeDebt,
  sleepinessLevel,
  DEBT_MUST_SLEEP,
} from '../lib/sleep-consolidation.js';
import type { SessionRecord } from '../lib/sleep-consolidation.js';
import type { Migration, MigrationStepResult } from './types.js';

// ─── People-first (T6): 1.user.md → people/ ──────────────────────────────────

/**
 * ROOT CONVENTION (a bug factory if you get it wrong): a `MigrationStep`'s
 * `root` is the CONTEXT root (`…/_dream_context`) — `runMigrations(contextRoot)`.
 * So `writePeople(root)` / `readPeople(root)` take it directly, while the
 * project-rooted readers take `dirname(root)`: `readSetupConfig(dirname(root))`,
 * `deleteSetupConfigKeys(dirname(root))`, `readGitIdentity(dirname(root))`.
 */

const USER_FILE_REL = 'core/1.user.md';
const RESIDUE_REL = 'inbox/1.user-residue.md';

/**
 * The only headings that may land in a person's constitution. Everything else
 * goes to the residue — drift must NEVER silently become a person's preferences.
 * Keyed lowercase; the value is the heading written to the constitution.
 * `Preferences` is accepted as both source and target so a vault that already
 * renamed the section is not sent round-trip through the residue.
 */
const CONSTITUTION_HEADINGS = new Map<string, string>([
  ['user preferences', 'Preferences'],
  ['preferences', 'Preferences'],
  ['identity', 'Identity'],
  ['communication style', 'Communication Style'],
]);

/** The `## People` block written by the pre-0.23 `ensurePeopleSection`. */
const PEOPLE_HEADING_KEY = 'people';

/** Residue section title for prose that sat before the first H2 (or a file with no H2 at all). */
const PREAMBLE_TITLE = 'Preamble';

interface UserSection {
  /** Heading text without the `## ` marker. */
  title: string;
  /** Everything between this heading and the next H2 (or EOF), verbatim, trailing blanks trimmed. */
  body: string;
}

function isoDate(): string {
  return new Date().toISOString().split('T')[0];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Drop a leading YAML frontmatter block. Machine metadata — both targets carry their own. */
function stripFrontmatter(lines: string[]): string[] {
  if (lines.length === 0 || lines[0].trim() !== '---') return lines;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return lines.slice(i + 1);
  }
  return lines; // unterminated ⇒ not frontmatter, keep every byte
}

/**
 * Split a legacy `1.user.md` into its H2 sections plus whatever preceded the
 * first one.
 *
 * Two deliberate refinements over the section-range logic this replaces
 * (the deleted `people.ts:findPeopleSection`), both in service of the hard rule
 * that NOTHING is discarded:
 *   - a section runs to the next **H2**, not the next `^#{1,2}`, so a stray
 *     mid-file H1 stays inside its section instead of falling into a gap that
 *     no target owns. `preamble + every section body` reproduces the whole file.
 *   - headings inside fenced code blocks are not headings.
 */
function parseUserSections(text: string): { preamble: string; sections: UserSection[] } {
  const lines = stripFrontmatter(text.replace(/\r\n/g, '\n').split('\n'));
  const heads: Array<{ at: number; title: string }> = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:```|~~~)/.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (match) heads.push({ at: i, title: match[1] });
  }
  const firstHead = heads.length > 0 ? heads[0].at : lines.length;
  const preamble = lines.slice(0, firstHead).join('\n').trim();
  const sections = heads.map((head, k) => ({
    title: head.title,
    body: lines
      .slice(head.at + 1, k + 1 < heads.length ? heads[k + 1].at : lines.length)
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\s+$/, ''),
  }));
  return { preamble, sections };
}

/** True when `text` already carries `## <title>` (case-insensitive) — the heading-idempotency gate. */
function hasHeading(text: string, title: string): boolean {
  const want = title.trim().toLowerCase();
  return text.split('\n').some((line) => {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    return match !== null && match[1].trim().toLowerCase() === want;
  });
}

/** Append sections to a document, one blank line between blocks, exactly one trailing newline. */
function appendSections(base: string, sections: UserSection[]): string {
  const blocks = sections.map((s) => (s.body ? `## ${s.title}\n\n${s.body}` : `## ${s.title}`));
  const head = base.replace(/\s+$/, '');
  if (blocks.length === 0) return `${head}\n`;
  return `${head}\n\n${blocks.join('\n\n')}\n`;
}

function writeDoc(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

/**
 * Roster bullets from a `## People` block: `- <Name> (\`person:<slug>\`)`, with
 * the marker optional (drifted rosters lost it). The NAME is authoritative —
 * `addPerson` re-derives the slug, which is how the block was rendered in the
 * first place and the only way to guarantee a roster key that is a legal path
 * segment. Anything that is not a bullet is reported so the caller can route the
 * whole section to the residue instead of dropping prose.
 *
 * A bullet only counts as a roster row when its text slugifies to a LEGAL person
 * slug. A hand-maintained `## People` block drifts into description —
 *
 *   - **mehmet** — Mehmet Nuraydın, Technical Product Manager / App Owner. Owns …
 *
 * — and that line slugifies to a 250-char string `PERSON_SLUG_RE` rejects. Which
 * fragment of it is the person's NAME ("mehmet"? "Mehmet Nuraydın"?) is a
 * judgment call, and D5 is explicit that a code step must not fake one: cutting
 * at the em dash happens to be right here and silently mangles the next vault.
 * So the bullet is reported as unparsed, its section goes to the residue whole,
 * and `distribute-user-md-residue` places the people with `dreamcontext people
 * add`. Guessing here is what the residue exists to avoid.
 *
 * This is also the interlock that keeps the step from FAILING on prose: an
 * illegal slug reaching `addPerson` throws, and a thrown step reports
 * `failedCount` — which pins `setupVersion` permanently, because the runner
 * re-runs every step on every `update` and this input is deterministic. Two real
 * vaults sat on 0.21.0 that way while their assets were already 0.23.0.
 */
function parsePeopleBullets(body: string): { names: string[]; unparsed: string[] } {
  const names: string[] = [];
  const unparsed: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^[-*]\s+(.+?)\s*$/.exec(line);
    if (!bullet) {
      unparsed.push(raw);
      continue;
    }
    const name = bullet[1].replace(/\(\s*`?person:[^)]*`?\s*\)\s*$/, '').trim();
    if (name && isSafePersonSlug(slugify(name))) names.push(name);
    else unparsed.push(raw);
  }
  return { names, unparsed };
}

/**
 * WHO owns the prose in a legacy `1.user.md`. The active person (env → pin →
 * git-email → solo) is the honest answer, since step 1 has just folded this
 * machine's git identity into the roster. An unresolvable multi-person vault
 * falls back to the first roster slug so the split still completes — and says so.
 */
function resolveOwnerSlug(contextRoot: string): string | null {
  const active = resolveActivePerson(contextRoot);
  if (active.slug) return active.slug;
  try {
    return Object.keys(readPeople(contextRoot)).sort()[0] ?? null;
  } catch {
    return null; // corrupt roster — split-user-file refuses rather than guesses
  }
}

function residueHeader(): string {
  return `---
name: user-md-residue
type: migration-residue
updated: "${isoDate()}"
---

# Residue from ${USER_FILE_REL} (migration 0.23.0)

0.23.0 replaced \`${USER_FILE_REL}\` with one constitution per person
(\`people/<slug>.md\`). Identity / Preferences / Communication Style moved there.
Every OTHER section is reproduced verbatim below, because a migration must not
guess where prose belongs.

An agent finishes the job (\`dreamcontext migrations pending\` prints the full
instruction, id \`distribute-user-md-residue\`). The routing:

- **Project Details**, **Skills & Capabilities** → \`core/4.tech_stack.md\`
- **Project Rules** → \`core/0.soul.md\` as unconditional one-liners; a
  conditional "when X do Y" rule belongs in \`knowledge/patterns/\` instead
- **Workflow Notes** → \`knowledge/patterns/<slug>.md\`, moved as-is with honest
  frontmatter and an explicit "un-distilled" note
- brand / palette / voice → \`core/3.style_guide_and_branding.md\`
- **People** → \`dreamcontext people add\`. This section is here because its
  bullets describe people rather than name them, so no code could tell the NAME
  apart from the description without guessing. You can: read each bullet, decide
  the person's name, and register them.

NOTHING IS DISCARDED. A section with no home stays in this file and is reported.
Delete this file only once every section below has been placed.
`;
}

// ─── Steps ───────────────────────────────────────────────────────────────────

/**
 * Migration 0.23.0, step 1 of 4: rescale accumulated sleep debt onto the 0–10
 * session scale.
 *
 * 0.23.0 replaced the per-session scorer. The old one composed three saturating
 * 0–3 buckets with `max()`, and measured over 395 real transcripts **77% of all
 * sessions scored exactly 3** — the ceiling was reached by the MEDIAN session,
 * so a 42-change/155-tool session weighed the same as a 13-change/103-tool one
 * and total debt was really just a session counter. The replacement is a
 * log-compressed weighted sum over novel tokens, file changes, tool calls and
 * substance, scored 0–10, and the level thresholds moved up with it
 * (Must Sleep 20 → 30).
 *
 * Those two halves must land TOGETHER. Raising the thresholds while leaving
 * already-accumulated scores on the old scale is a silent regression in the
 * dangerous direction: a project sitting at debt 19 — "Sleepy, consolidate
 * soon" the day before the upgrade — would read as "Drowsy" afterwards and
 * defer a consolidation that is already overdue. Nothing would report an error;
 * the brain would just quietly stop asking to sleep.
 *
 * So this multiplies each legacy session score by `LEGACY_SCORE_RESCALE` (3,
 * mapping the old ceiling 3 → 9) and recomputes `state.debt` from the result.
 *
 * Idempotent by construction: `rescaleLegacySessions` only touches records with
 * no `scoring_version`, and stamps every one it converts, so a second run finds
 * nothing to do. PENDING sessions (`score === null`) are deliberately left
 * alone — the SessionStart catch-up scores them from their transcripts with the
 * NEW scorer, which is strictly better than rescaling a guess.
 *
 * Deterministic (no agentTask): no judgment is involved, and leaving it opt-in
 * would leave exactly the mis-read debt the migration exists to prevent.
 */
function rescaleLegacySleepDebt(root: string): MigrationStepResult {
  const step = 'rescale-legacy-sleep-debt';
  const sleepPath = join(root, 'state', '.sleep.json');

  // No state file = never slept, or a fresh brain. Nothing to rescale, and
  // we must not conjure the file into existence.
  if (!existsSync(sleepPath)) {
    return {
      step,
      filesTouched: [],
      summary: 'No .sleep.json (fresh brain or never slept) — nothing to rescale',
      detected: true,
    };
  }

  // Read the RAW object, not via readSleepState: this rewrites only
  // `sessions` and `debt` and leaves every other field byte-identical,
  // rather than round-tripping the whole state through its normalizer.
  let raw: { sessions?: SessionRecord[]; debt?: number } & Record<string, unknown>;
  try {
    raw = readJsonObject(sleepPath);
  } catch {
    // A torn/unreadable .sleep.json is the state reader's "fresh default"
    // case — there is no ledger to rescale, and a migration must never be
    // the thing that throws on it.
    return {
      step,
      filesTouched: [],
      summary: 'Unreadable .sleep.json — nothing to rescale',
      detected: true,
    };
  }

  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  const debtBefore = typeof raw.debt === 'number' ? raw.debt : 0;
  const result = rescaleLegacySessionRecords(sessions);

  if (result.rescaled === 0) {
    return {
      step,
      filesTouched: [],
      summary: 'No legacy-scored sessions found — debt is already on the 0-10 scale',
      detected: true,
    };
  }

  const debtAfter = recomputeDebt(result.sessions);
  writeJsonObject(sleepPath, { ...raw, sessions: result.sessions, debt: debtAfter });

  const level = sleepinessLevel(debtAfter);
  const crossed = debtBefore < DEBT_MUST_SLEEP && debtAfter >= DEBT_MUST_SLEEP;
  return {
    step,
    filesTouched: [sleepPath],
    summary:
      `Rescaled ${result.rescaled} legacy session score(s) onto the 0-10 scale; `
      + `debt ${debtBefore} → ${debtAfter} (${level})`
      + (crossed
        ? '. This crosses the Must Sleep threshold: the debt was ALREADY this large in '
          + 'real terms — the old scale simply could not express it. Consolidate soon.'
        : ''),
    detected: false,
  };
}

/**
 * Step 2 of 4 — `seed-people-from-config`: build `people/people.json` from the
 * retiring `.config.json.people[]` roster, folded together with this machine's
 * git identity.
 *
 * A roster already on disk is left ALONE (`detected:true`): the vault is
 * people-first already, and re-deriving it from a stale config key could only
 * lose entries.
 *
 * The step NEVER produces an empty roster — `doctor` errors on one (an empty
 * roster is unrepresentable state, not a valid solo vault). A vault with no
 * config names and no git identity gets a single `owner` entry, and the summary
 * says so out loud so the user renames it rather than discovering it later.
 *
 * It also scaffolds a constitution for every seeded person that lacks one
 * (`doctor` errors on a roster slug with no `people/<slug>.md`) — with ONE
 * exception: the owner of a still-present `core/1.user.md`. That person's
 * constitution is authored by `split-user-file` from real prose, and a
 * placeholder scaffold would make the heading-idempotent append skip the very
 * sections it is supposed to carry over.
 */
function seedPeopleFromConfig(root: string): MigrationStepResult {
  const step = 'seed-people-from-config';
  const projectRoot = dirname(root);

  if (hasPeopleLayout(root)) {
    return {
      step,
      filesTouched: [],
      summary: 'people/people.json already exists — roster left untouched',
      detected: true,
    };
  }

  try {
    const legacyNames = readSetupConfig(projectRoot)?.people ?? [];
    const people: PeopleMap = {};
    const rejected: string[] = [];
    for (const raw of legacyNames) {
      const name = raw.trim();
      if (!name) continue;
      const slug = slugify(name);
      if (!isSafePersonSlug(slug)) {
        rejected.push(name);
        continue;
      }
      if (!people[slug]) people[slug] = { name, emails: [] };
    }

    // Fold in the git identity: an email on the roster is what makes
    // `resolveActivePerson`'s git-email rung work on every teammate's machine.
    const git = readGitIdentity(projectRoot);
    const gitName = (git.name ?? '').trim();
    const gitEmail = (git.email ?? '').trim().toLowerCase();
    const gitSlug = gitName ? slugify(gitName) : '';
    const notes: string[] = [];
    if (gitSlug && isSafePersonSlug(gitSlug)) {
      const existing = people[gitSlug];
      if (existing) {
        if (gitEmail) existing.emails = normalizeEmails([...existing.emails, gitEmail]);
        notes.push(`git identity matched ${gitSlug}${gitEmail ? ` (${gitEmail})` : ''}`);
      } else {
        people[gitSlug] = { name: gitName, emails: gitEmail ? [gitEmail] : [] };
        notes.push(`added ${gitSlug} from git identity${gitEmail ? ` (${gitEmail})` : ''}`);
      }
    }

    // Never an empty roster. A bare git email with no git name cannot name a
    // person, but it can still identify one — fold it into `owner` so the
    // machine resolves instead of reporting UNRESOLVED forever.
    let placeholder = false;
    if (Object.keys(people).length === 0) {
      people.owner = { name: 'Owner', emails: gitEmail ? [gitEmail] : [] };
      placeholder = true;
    }

    writePeople(root, people);
    const filesTouched = [peopleJsonPath(root)];

    const legacyOwner = existsSync(join(root, 'core', '1.user.md')) ? resolveOwnerSlug(root) : null;
    for (const [slug, person] of Object.entries(people)) {
      if (slug === legacyOwner) continue;
      const path = personFilePath(root, slug);
      if (existsSync(path)) continue;
      writeDoc(path, renderPersonConstitution({ name: person.name, slug, date: isoDate() }));
      filesTouched.push(path);
    }

    const slugs = Object.keys(people).sort();
    const parts = [`Seeded people/people.json with ${slugs.length} person(s): ${slugs.join(', ')}`];
    if (notes.length > 0) parts.push(notes.join('; '));
    if (rejected.length > 0) {
      parts.push(`dropped ${rejected.length} config name(s) with no usable slug: ${rejected.join(', ')}`);
    }
    if (placeholder) {
      parts.push(
        'NO roster in .config.json and no git user.name on this machine, so the vault was seeded '
        + "with a single placeholder person 'owner' (an empty roster is an error). Rename them with "
        + '`dreamcontext people add "<Your Name>" --email <email>` and `dreamcontext people rm owner`',
      );
    }
    return { step, filesTouched, summary: parts.join('. '), detected: false };
  } catch (err) {
    return {
      step,
      filesTouched: [],
      summary: `Could not seed people/people.json: ${errorText(err)}. Nothing was written`,
      detected: false,
      failedCount: 1,
    };
  }
}

/**
 * Step 3 of 4 — `split-user-file`: retire `core/1.user.md` into the owner's
 * constitution, the roster, and a residue file for everything else.
 *
 * Routing (the whole judgment call of this migration, made deterministic):
 *   - `## User Preferences` → `## Preferences`, `## Identity` and
 *     `## Communication Style` as-is → `people/<owner>.md`
 *   - `## People` bullets → upserted into `people/people.json`
 *   - EVERY other H2, verbatim → `inbox/1.user-residue.md` for the agentTask
 *
 * Unknown headings go to the residue, NEVER to the constitution — drift must not
 * silently become a person's preferences. Nothing is discarded: the residue plus
 * the constitution reproduce every byte of prose the source file held.
 *
 * HEADING-IDEMPOTENT on BOTH targets: an H2 already present in a target (as of
 * the snapshot read at the start of this step) is skipped, so a crash anywhere
 * between the first append and the `1.user.md` unlink is safely resumable — a
 * re-run appends nothing and simply finishes the delete. Two identically-titled
 * sections in ONE source file both survive; only pre-existing headings suppress.
 *
 * `core/1.user.md` is unlinked LAST, only after every write succeeded.
 */
function splitUserFile(root: string): MigrationStepResult {
  const step = 'split-user-file';
  const userPath = join(root, 'core', '1.user.md');

  if (!existsSync(userPath)) {
    return {
      step,
      filesTouched: [],
      summary: `No ${USER_FILE_REL} — already people-first, nothing to split`,
      detected: true,
    };
  }

  const ownerSlug = resolveOwnerSlug(root);
  if (!ownerSlug) {
    return {
      step,
      filesTouched: [],
      summary:
        `Refusing to split ${USER_FILE_REL}: no person to own it (people/people.json is missing, `
        + 'empty or unreadable). The file was left exactly as it is — run `dreamcontext doctor`',
      detected: false,
      failedCount: 1,
    };
  }

  const filesTouched: string[] = [];
  try {
    const { preamble, sections } = parseUserSections(readFileSync(userPath, 'utf-8'));

    const toConstitution: UserSection[] = [];
    const toResidue: UserSection[] = [];
    const rosterNames: string[] = [];
    for (const section of sections) {
      const key = section.title.trim().toLowerCase();
      const constitutionTitle = CONSTITUTION_HEADINGS.get(key);
      if (constitutionTitle) {
        toConstitution.push({ title: constitutionTitle, body: section.body });
        continue;
      }
      if (key === PEOPLE_HEADING_KEY) {
        const { names, unparsed } = parsePeopleBullets(section.body);
        rosterNames.push(...names);
        // Prose inside a `## People` block is not convertible to roster rows —
        // keep the section verbatim in the residue rather than discard it.
        if (unparsed.length > 0) toResidue.push(section);
        continue;
      }
      toResidue.push(section);
    }
    // Prose before the first H2 (or a file with no H2 at all) is still prose.
    if (preamble) toResidue.unshift({ title: PREAMBLE_TITLE, body: preamble });

    // 1. Constitution FIRST. Snapshot-based skip = the heading-idempotency gate.
    //    Order is load-bearing: `addPerson` (step 2) scaffolds an absent
    //    constitution, and a scaffold already carries all three headings — so
    //    upserting the roster first would make this append skip every section
    //    and silently drop the user's real prose.
    const constitutionPath = personFilePath(root, ownerSlug);
    const existingConstitution = existsSync(constitutionPath)
      ? readFileSync(constitutionPath, 'utf-8')
      : null;
    const constitutionAdds = toConstitution.filter(
      (s) => existingConstitution === null || !hasHeading(existingConstitution, s.title),
    );
    if (existingConstitution === null || constitutionAdds.length > 0) {
      const base = existingConstitution
        ?? `---\nname: ${ownerSlug}\ntype: person\nupdated: "${isoDate()}"\n---\n`;
      // A source file with nothing constitution-shaped still owes this person a
      // usable document — fall back to the standard scaffold.
      const content = existingConstitution === null && constitutionAdds.length === 0
        ? renderPersonConstitution({
          name: readPeople(root)[ownerSlug]?.name ?? ownerSlug,
          slug: ownerSlug,
          date: isoDate(),
        })
        : appendSections(base, constitutionAdds);
      writeDoc(constitutionPath, content);
      filesTouched.push(constitutionPath);
    }

    // 2. Roster upserts. `addPerson` is the locked path and also scaffolds an
    //    absent constitution, so a name lifted out of `## People` lands complete.
    const rosterBefore = Object.keys(readPeople(root)).length;
    for (const name of rosterNames) {
      const { slug, created } = addPerson(root, { name });
      if (created) filesTouched.push(personFilePath(root, slug));
    }
    if (Object.keys(readPeople(root)).length !== rosterBefore) filesTouched.push(peopleJsonPath(root));

    // 3. Residue — created only when something is actually homeless, so a clean
    //    split does not leave a pending agentTask with nothing to do.
    const residuePath = join(root, 'inbox', '1.user-residue.md');
    let residueAdded = 0;
    if (toResidue.length > 0) {
      const existingResidue = existsSync(residuePath) ? readFileSync(residuePath, 'utf-8') : null;
      const residueAdds = toResidue.filter(
        (s) => existingResidue === null || !hasHeading(existingResidue, s.title),
      );
      residueAdded = residueAdds.length;
      if (existingResidue === null || residueAdds.length > 0) {
        writeDoc(residuePath, appendSections(existingResidue ?? residueHeader(), residueAdds));
        filesTouched.push(residuePath);
      }
    }

    // 4. Only now is the source expendable.
    unlinkSync(userPath);
    filesTouched.push(userPath);

    const parts = [
      `Split ${USER_FILE_REL} (${sections.length} section(s))`,
      `${constitutionAdds.length} → people/${ownerSlug}.md`,
      `${residueAdded} → ${RESIDUE_REL}`,
    ];
    if (rosterNames.length > 0) parts.push(`${rosterNames.length} '## People' bullet(s) upserted into the roster`);
    if (toConstitution.length > constitutionAdds.length || (toResidue.length > residueAdded)) {
      parts.push('headings already present in a target were skipped (resumed a partial run)');
    }
    if (toResidue.length > 0) {
      parts.push(`run \`dreamcontext migrations pending\` — an agent must distribute ${RESIDUE_REL}`);
    }
    parts.push(`deleted ${USER_FILE_REL}`);
    return { step, filesTouched, summary: parts.join('; '), detected: false };
  } catch (err) {
    return {
      step,
      filesTouched,
      summary:
        `Could not finish splitting ${USER_FILE_REL}: ${errorText(err)}. The file was NOT deleted — `
        + 're-run the migration; the split is heading-idempotent and resumes safely',
      detected: false,
      failedCount: 1,
    };
  }
}

/**
 * Step 4 of 4 — `retire-config-roster`: delete the `people` key from
 * `.config.json`. `peopleIdentity` is a side-table of external system ids keyed
 * by slug, NOT a roster — it is untouched.
 *
 * `detected:true` when the key is already gone, so the file stays byte-identical
 * on a re-run. A present-but-unparseable config is left alone rather than
 * rewritten (`deleteSetupConfigKeys` throws there by design).
 */
function retireConfigRoster(root: string): MigrationStepResult {
  const step = 'retire-config-roster';
  const configPath = join(root, 'state', '.config.json');

  if (!existsSync(configPath)) {
    return { step, filesTouched: [], summary: 'No .config.json — no roster key to retire', detected: true };
  }

  // Presence is checked on the RAW object: `readSetupConfig` normalizes an
  // absent key and a `people: []` key to different values, but only the raw
  // `hasOwnProperty` tells us whether a write is actually needed.
  let hasKey: boolean;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
    hasKey = parsed !== null
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && Object.prototype.hasOwnProperty.call(parsed, 'people');
  } catch (err) {
    return {
      step,
      filesTouched: [],
      summary: `.config.json is not valid JSON (${errorText(err)}) — left untouched; run \`dreamcontext doctor\``,
      detected: false,
      failedCount: 1,
    };
  }

  if (!hasKey) {
    return {
      step,
      filesTouched: [],
      summary: '.config.json has no "people" key — roster already retired',
      detected: true,
    };
  }

  try {
    deleteSetupConfigKeys(dirname(root), ['people']);
  } catch (err) {
    return {
      step,
      filesTouched: [],
      summary: `Could not rewrite .config.json: ${errorText(err)}`,
      detected: false,
      failedCount: 1,
    };
  }
  return {
    step,
    filesTouched: [configPath],
    summary: 'Deleted the retired "people" roster key from .config.json (peopleIdentity untouched)',
    detected: false,
  };
}

/**
 * Migration 0.23.0 — sleep-debt rescale + the people-first user model.
 *
 * Step order is load-bearing for the people-first trio: `seed-people-from-config`
 * must run before `split-user-file` (which needs a roster to own the prose) and
 * before `retire-config-roster` (which deletes the key the seed reads).
 *
 * `agentTask` distributes the residue: prose judgment about where a paragraph
 * belongs is not deterministic and must not be faked by code (D5).
 */
export const migration0230: Migration = {
  version: '0.23.0',
  steps: [rescaleLegacySleepDebt, seedPeopleFromConfig, splitUserFile, retireConfigRoster],
  agentTask: {
    id: 'distribute-user-md-residue',
    instruction: `Start by checking the filesystem: if _dream_context/${RESIDUE_REL} does not
exist, there is nothing to distribute — record this step and stop.

0.23.0 replaced _dream_context/${USER_FILE_REL} with one constitution per person
(_dream_context/people/<slug>.md). The deterministic steps already moved
Identity / Preferences / Communication Style into the owner's constitution, and
every '## People' bullet that unambiguously NAMED a person into people/people.json.
Everything else was copied VERBATIM into _dream_context/${RESIDUE_REL}, because
deciding where prose belongs is judgment, not a string transform.

Read the residue file and place each '## <Heading>' section:

- '## Project Details', '## Skills & Capabilities' → core/4.tech_stack.md.
  Merge into the existing sections; do not duplicate a fact already recorded.
- '## Project Rules' → core/0.soul.md, as UNCONDITIONAL one-liners (the soul
  holds rules that always apply). A conditional rule — "when X, do Y" — is a
  pattern, not a law: move it to knowledge/patterns/<slug>.md instead.
- '## Workflow Notes' → knowledge/patterns/<slug>.md, MOVED AS-IS with honest
  frontmatter (name, type: pattern, updated) and an explicit note that the
  content is un-distilled and migrated from ${USER_FILE_REL}. Do not paraphrase
  it into something you did not verify.
- brand / palette / tone / voice sections → core/3.style_guide_and_branding.md.
- '## People' is here ONLY when its bullets describe people instead of naming
  them ("- **mehmet** — Mehmet Nuraydin, Technical Product Manager. Owns ..."),
  so no code could separate the NAME from the description without guessing.
  Decide each person's name yourself and register them:
  \`dreamcontext people add "<Name>" [--email <email>] [--role <role>]\`.
  Then move any per-person prose into that person's people/<slug>.md, and check
  people/people.json for a duplicate the seed step already created under a
  different slug before you add a second one.

- '## Preamble' holds prose that sat before the first heading. Place it by
  meaning, exactly like any other section.

NOTHING IS DISCARDED. A section with no sensible home STAYS in the residue file
and is reported in your summary — never delete prose you could not place.

Delete _dream_context/${RESIDUE_REL} only when every section has been placed. If
anything remains, leave the file and say what is left and why.

Then record completion:

  dreamcontext migrations record --version 0.23.0 --step distribute-user-md-residue --executor agent --summary "<what you did>"`,
  },
};
