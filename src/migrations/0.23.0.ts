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
/** H2 heading positions, ignoring headings inside fenced code blocks. */
function findH2Heads(lines: string[]): Array<{ at: number; title: string }> {
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
  return heads;
}

function parseUserSections(text: string): { preamble: string; sections: UserSection[] } {
  const lines = stripFrontmatter(text.replace(/\r\n/g, '\n').split('\n'));
  const heads = findH2Heads(lines);
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

/** Every body filed under `## <title>` in `text` (a document may repeat a heading). */
function sectionBodies(text: string, title: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const heads = findH2Heads(lines);
  const want = title.trim().toLowerCase();
  return heads
    .map((head, k) => ({ head, end: k + 1 < heads.length ? heads[k + 1].at : lines.length }))
    .filter(({ head }) => head.title.trim().toLowerCase() === want)
    .map(({ head, end }) => lines.slice(head.at + 1, end).join('\n'));
}

/** True when `text` already carries `## <title>` (case-insensitive) — the heading-idempotency gate. */
function hasHeading(text: string, title: string): boolean {
  const want = title.trim().toLowerCase();
  return text.split('\n').some((line) => {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    return match !== null && match[1].trim().toLowerCase() === want;
  });
}

function normalizeBody(body: string): string {
  return body.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/**
 * The person template's own section bodies, DERIVED from
 * `renderPersonConstitution` rather than restated — a copy here would drift the
 * moment the template is reworded, and a stale copy silently stops recognising
 * scaffolds (which is data loss, not a cosmetic miss).
 *
 * Exact matching is also complete, not just safe: `people/` was introduced by
 * 0.23.0 and the template has existed in exactly one form, so every scaffold in
 * the wild carries this text verbatim.
 */
const TEMPLATE_SECTION_BODIES = new Map(
  parseUserSections(renderPersonConstitution({ name: 'Placeholder', slug: 'placeholder', date: '1970-01-01' }))
    .sections.map((s) => [s.title.trim().toLowerCase(), normalizeBody(s.body)] as const),
);

/**
 * A slot, not content: this section's body is EXACTLY the template's guidance
 * for that heading, or empty.
 *
 * Deliberately not "every line is parenthesised" — that was the first version of
 * this check and it would have eaten `## Preferences\n\n- (see the team
 * handbook)`, a real sentence a real person wrote. Recognising a shape that
 * placeholders happen to have is the same mistake as judging a roster row by
 * its slug length; recognise the placeholder itself.
 */
function isTemplateSlot(title: string, body: string[]): boolean {
  const normalized = normalizeBody(body.join('\n'));
  if (normalized === '') return true;
  return normalized === TEMPLATE_SECTION_BODIES.get(title.trim().toLowerCase());
}

/**
 * Remove `## <title>` sections that are still template slots, for the titles we
 * are about to write. Every other byte — frontmatter, other sections, spacing —
 * is preserved.
 *
 * This is what keeps the heading-idempotency gate from turning into silent data
 * loss. The gate skips any heading already present in the target, and
 * `addPerson`'s scaffold carries all three constitution headings; so a
 * constitution scaffolded BEFORE the split (which happens whenever the seed step
 * could not name the owner, and on any re-run after a mid-split crash) would
 * make the split skip every section and drop the user's real prose on the floor
 * — with `core/1.user.md` deleted at the end of the same step.
 *
 * The ordering comment on the constitution write states the invariant; this
 * makes it hold even when the two steps disagree about who the owner is.
 * A section that already holds REAL prose is still never touched, so the
 * crash-resume contract (a re-run appends nothing) is unchanged.
 */
function stripPlaceholderSections(text: string, titles: Set<string>): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const heads = findH2Heads(lines);
  const drop = new Set<number>();
  heads.forEach((head, k) => {
    if (!titles.has(head.title.trim().toLowerCase())) return;
    const end = k + 1 < heads.length ? heads[k + 1].at : lines.length;
    if (!isTemplateSlot(head.title, lines.slice(head.at + 1, end))) return;
    for (let i = head.at; i < end; i++) drop.add(i);
  });
  if (drop.size === 0) return text;
  return lines.filter((_, i) => !drop.has(i)).join('\n');
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
 * A bullet only counts as a roster row when it has the SHAPE of one: a short
 * phrase with no sentence punctuation, that then slugifies legally. A
 * hand-maintained `## People` block drifts into description —
 *
 *   - **mehmet** — Mehmet Nuraydın, Technical Product Manager / App Owner. Owns …
 *
 * — and which fragment of that is the person's NAME ("mehmet"? "Mehmet
 * Nuraydın"?) is a judgment call. D5 is explicit that a code step must not fake
 * one: cutting at the em dash happens to be right here and silently mangles the
 * next vault. So the bullet is reported as unparsed, its section goes to the
 * residue whole, and `distribute-user-md-residue` places the people with
 * `dreamcontext people add`.
 *
 * SLUG LEGALITY ALONE IS NOT THE TEST, and treating it as one is a bug this
 * migration already shipped: `PERSON_SLUG_RE` caps at 64 chars, so the SAME
 * class of prose passes or fails on how verbose the sentence happens to be.
 * `- **bektas** — Bektaş Çimen, in-house developer. Owns the deploy pipeline.`
 * slugifies to 63 characters, sailed through, and put a person named
 * "**bektas** — Bektaş Çimen, in-house developer…" on the roster — with their
 * own constitution file and a duplicate of the real Bektaş sitting next to it.
 * A gate whose verdict depends on sentence length is a coin flip wearing a
 * regex.
 *
 * So there are two verdicts, and the STRONGER evidence is used when present:
 *   - The row still carries the rendered `(\`person:<slug>\`)` marker. Then the
 *     row is a roster row iff the name slugifies back to exactly that slug —
 *     an identity the renderer always satisfies and prose never does. This is
 *     exact, so a punctuated real name ("Dr. Jane Smith") is kept rather than
 *     failed by a heuristic that has no business judging it.
 *   - The marker is gone (a drifted roster). Only then does shape decide: a
 *     short phrase with no sentence punctuation, that slugifies legally.
 *
 * This is also the interlock that keeps the step from FAILING on prose: an
 * illegal slug reaching `addPerson` throws, and a thrown step reports
 * `failedCount` — which pins `setupVersion` permanently, because the runner
 * re-runs every step on every `update` and this input is deterministic. Two real
 * vaults sat on 0.21.0 that way while their assets were already 0.23.0.
 */

/** The rendered marker, capturing the slug it asserts. */
const PERSON_MARKER = /\(\s*`?person:([^)`]*)`?\s*\)\s*$/;

/**
 * One token of a human name: opens with a letter, then letters, combining marks,
 * apostrophes and INNER hyphens. `Jean-Luc`, `O'Brien`, `Nuraydın`, `Çimen` pass.
 *
 * A whitelist, not a punctuation blacklist. The blacklist this replaces listed
 * the em dash and en dash and missed the plain `-`, so the single most common
 * drift separator sailed through: `- Ada Lovelace - Engineer` became a person
 * named "Ada Lovelace - Engineer". Enumerating what prose might contain is the
 * same losing game as judging a bullet by its slug length — describe what a NAME
 * is instead, and everything else falls out.
 *
 * Known limit, deliberately not chased: `- Ada Lovelace and Grace` is
 * indistinguishable from a four-word name without judgment, so it is accepted.
 * Chasing it means a conjunction list per language, which is judgment wearing a
 * lookup table. The agentTask is told to check the roster for duplicates.
 */
const NAME_TOKEN = /^\p{L}[\p{L}\p{M}'’-]*$/u;

/** A rendered roster row holds ONE person's name, not a sentence about them. */
const MAX_NAME_WORDS = 5;

function looksLikeAName(name: string): boolean {
  if (!name) return false;
  const words = name.split(/\s+/);
  if (words.length > MAX_NAME_WORDS) return false;
  if (!words.every((word) => NAME_TOKEN.test(word))) return false;
  return isSafePersonSlug(slugify(name));
}

function parsePeopleBullets(body: string): { names: string[]; unparsed: string[] } {
  const names: string[] = [];
  const unparsed: string[] = [];
  let fenced = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    // A bullet inside a code fence is an EXAMPLE of a roster row, not one.
    // `findH2Heads` has always known this; this loop did not, so a documented
    // format sample — `- Jane Doe (`person:jane-doe`)` inside ``` — became a
    // real person with a real constitution file. Fenced lines are prose: they
    // are not names, and the section carrying them belongs to the agent.
    if (/^(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      unparsed.push(raw);
      continue;
    }
    if (fenced) {
      if (line) unparsed.push(raw);
      continue;
    }
    if (!line) continue;
    const bullet = /^[-*]\s+(.+?)\s*$/.exec(line);
    if (!bullet) {
      unparsed.push(raw);
      continue;
    }
    const marker = PERSON_MARKER.exec(bullet[1]);
    const name = bullet[1]
      .replace(PERSON_MARKER, '')
      .replace(/^[*_`]+|[*_`]+$/g, '') // `- **Ada Lovelace**` is still a roster row
      .trim();
    // With the marker: the row is a roster row iff the name slugifies back to
    // the slug it claims — exact, and the only test that needs no judgment.
    // Without it: shape is all that is left.
    const accepted = marker
      ? name !== '' && isSafePersonSlug(slugify(name)) && slugify(name) === marker[1].trim()
      : looksLikeAName(name);
    if (accepted) names.push(name);
    else unparsed.push(raw);
  }
  return { names, unparsed };
}

/**
 * WHO owns the prose in a legacy `1.user.md` — and, when nobody can be named,
 * the honest admission that nobody can.
 *
 * The active person (env → pin → git-email → solo) is the ONLY answer this step
 * is allowed to give. Step 2 has just folded this machine's git identity into
 * the roster, so a solo vault and any machine whose git email is on the roster
 * both resolve here; those are the overwhelming majority of real vaults.
 *
 * There is deliberately NO fallback, and its absence is the whole point. This
 * function used to end with `Object.keys(readPeople(root)).sort()[0]` — the
 * alphabetically first person — which is exactly how a two-person vault wrote
 * one person's Identity, Preferences and Communication Style into the OTHER
 * person's constitution: `bektas` sorts before `mehmet`, and nothing on that
 * machine said otherwise. The victim's own file stayed an empty scaffold.
 *
 * `resolveActivePerson` refuses that guess by design — "an unresolvable machine
 * gets `slug: null`, NOT somebody else's constitution" (people-resolve.ts) — and
 * the owner spec pinned the same rule: a session with no resolvable person loads
 * none rather than defaulting to the owner. Sorting the roster overrode both.
 * WHOSE prose this is is judgment, precisely like which fragment of a bullet is
 * a name (D5), and judgment belongs to the agentTask, never to a code step.
 *
 * `ambiguous` is therefore NOT a failure: the split still completes, the prose
 * goes to the residue verbatim, and `distribute-user-md-residue` places it.
 * `no-roster` IS a (retryable) failure — `doctor` repairs the roster and the
 * next `update` splits cleanly.
 */
type OwnerResolution =
  | { kind: 'resolved'; slug: string }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'no-roster'; reason: string };

function resolveOwner(contextRoot: string): OwnerResolution {
  let people: PeopleMap;
  try {
    people = readPeople(contextRoot);
  } catch (err) {
    return { kind: 'no-roster', reason: `people/people.json is unreadable — ${errorText(err)}` };
  }
  if (Object.keys(people).length === 0) {
    return { kind: 'no-roster', reason: 'people/people.json is missing or lists no people' };
  }
  const active = resolveActivePerson(contextRoot);
  if (active.slug) return { kind: 'resolved', slug: active.slug };
  return { kind: 'ambiguous', reason: active.reason };
}

function residueHeader(): string {
  return `---
name: user-md-residue
type: migration-residue
updated: "${isoDate()}"
---

# Residue from ${USER_FILE_REL} (migration 0.23.0)

0.23.0 replaced \`${USER_FILE_REL}\` with one constitution per person
(\`people/<slug>.md\`). Identity / Preferences / Communication Style moved there
WHEN this machine could name their owner. Every OTHER section is reproduced
verbatim below, because a migration must not guess where prose belongs.

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
- **Identity / Preferences / Communication Style** → \`people/<slug>.md\`. These
  are here ONLY when the roster holds more than one person and nothing on this
  machine said which of them is at the keyboard — no env var, no pin, no git
  user.email on the roster. They are somebody's constitution, and writing them
  into the alphabetically-first person is how one teammate's rules end up
  governing another. Settle WHO first (\`dreamcontext people whoami --set
  <slug>\`), then move them.

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

    // Which constitution `split-user-file` is about to author from real prose —
    // that one must NOT be pre-scaffolded, or its heading-idempotent append
    // would skip every section. An unresolvable owner means it authors nobody's,
    // so everybody gets the scaffold and the prose reaches the residue instead.
    const owner = existsSync(join(root, 'core', '1.user.md')) ? resolveOwner(root) : null;
    const legacyOwner = owner?.kind === 'resolved' ? owner.slug : null;
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

  const owner = resolveOwner(root);
  if (owner.kind === 'no-roster') {
    // Retryable by construction: `doctor` repairs the roster and the next run
    // splits. This is the ONE failure shape `failedCount` is for (see types.ts).
    return {
      step,
      filesTouched: [],
      summary:
        `Refusing to split ${USER_FILE_REL}: no person to own it (${owner.reason}). `
        + 'The file was left exactly as it is — run `dreamcontext doctor`',
      detected: false,
      failedCount: 1,
    };
  }
  // null ⇒ nobody on this machine can be named as the owner. Not a failure:
  // the constitution-bound sections go to the residue instead of into a guess.
  const ownerSlug = owner.kind === 'resolved' ? owner.slug : null;

  const filesTouched: string[] = [];
  try {
    const { preamble, sections } = parseUserSections(readFileSync(userPath, 'utf-8'));

    // `source` is the section exactly as `1.user.md` held it. Kept because a
    // constitution-bound section that the idempotency gate declines still has to
    // land SOMEWHERE, and what lands must be the original, not the renamed copy.
    const toConstitution: Array<UserSection & { source: UserSection }> = [];
    const toResidue: UserSection[] = [];
    const rosterNames: string[] = [];
    for (const section of sections) {
      const key = section.title.trim().toLowerCase();
      const constitutionTitle = CONSTITUTION_HEADINGS.get(key);
      if (constitutionTitle) {
        // With no resolvable owner there is no constitution to move this into,
        // and the alphabetically-first roster entry is NOT an answer — it is the
        // defect this step exists to avoid. Route it VERBATIM (original heading,
        // original body) so the agentTask can ask whose it is. Writing a
        // person's Preferences into someone else's file is the one outcome this
        // migration cannot walk back: the source is deleted at step 4.
        if (ownerSlug) toConstitution.push({ title: constitutionTitle, body: section.body, source: section });
        else toResidue.push(section);
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
    //    Skipped entirely when nobody resolves: `toConstitution` is empty then,
    //    and there is no path to write to that would not be a guess.
    let constitutionAdds: UserSection[] = [];
    if (ownerSlug) {
      const constitutionPath = personFilePath(root, ownerSlug);
      // A placeholder slot is not "already present" — see stripPlaceholderSections.
      const existingConstitution = existsSync(constitutionPath)
        ? stripPlaceholderSections(
          readFileSync(constitutionPath, 'utf-8'),
          new Set(toConstitution.map((s) => s.title.trim().toLowerCase())),
        )
        : null;
      constitutionAdds = toConstitution.filter(
        (s) => existingConstitution === null || !hasHeading(existingConstitution, s.title),
      );
      // A declined section is only safe to DROP when the target already holds
      // that exact body — i.e. a previous run of this step wrote it and crashed
      // before the unlink, which is the entire reason the gate exists. Anything
      // else the gate declines is DIFFERENT prose that this step is about to
      // delete the only other copy of, so it goes to the residue instead.
      //
      // Reachable without a crash: someone runs `people add`, hand-writes their
      // `## Identity`, and only then upgrades. The gate saw the heading, dropped
      // the richer `1.user.md` version, and unlinked the source. Silently — the
      // count in the summary just read one lower.
      for (const declined of toConstitution) {
        if (constitutionAdds.includes(declined)) continue;
        if (existingConstitution !== null
          && sectionBodies(existingConstitution, declined.title)
            .some((body) => normalizeBody(body) === normalizeBody(declined.body))) {
          continue; // byte-for-byte already there: a resumed run, nothing owed
        }
        toResidue.push(declined.source);
      }
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
      // Same rule as the constitution, and for the same reason: a heading that
      // is already here suppresses a re-add ONLY when the body is identical.
      // Matching on the heading alone made the residue lose prose exactly the
      // way the constitution did — crash before the unlink, user edits
      // `1.user.md`, re-run, and the edited section is silently declined while
      // step 4 deletes the source. A duplicate heading here is harmless (the
      // agent reads both); a dropped section is not.
      const residueAdds = toResidue.filter(
        (s) => existingResidue === null
          || !sectionBodies(existingResidue, s.title).some((b) => normalizeBody(b) === normalizeBody(s.body)),
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
      ownerSlug
        ? `${constitutionAdds.length} → people/${ownerSlug}.md`
        : 'NO constitution written — nobody on this machine could be named as the owner '
          + `of this prose (${owner.kind === 'ambiguous' ? owner.reason : 'unresolved'}), so `
          + 'Identity / Preferences / Communication Style went to the residue verbatim rather '
          + 'than into a guessed person. Run `dreamcontext people whoami --set <slug>` (or add '
          + 'your git user.email to the roster), then let the agent place them',
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
Identity / Preferences / Communication Style into the owner's constitution WHEN
that machine could name the owner, and every '## People' bullet that
unambiguously NAMED a person into people/people.json. Everything else was copied
VERBATIM into _dream_context/${RESIDUE_REL}, because deciding where prose belongs
is judgment, not a string transform.

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

- '## Identity', '## Preferences' / '## User Preferences' and
  '## Communication Style' are here ONLY when the roster holds more than one
  person and NOTHING on that machine could say which of them was at the
  keyboard. This is a person's constitution, so do not place it by vibe:
  1. Read the prose and work out whose it is — the '## People' block, the git
     history, and the surrounding sections usually name them outright. If it is
     still genuinely unclear, ASK the user rather than choosing.
  2. Make the identity real so no later run has to guess again:
     \`dreamcontext people whoami --set <slug>\`, and put that person's git
     user.email on the roster (\`dreamcontext people add "<Name>" --email <...>\`)
     so their other clones resolve too.
  3. Move the sections into people/<slug>.md, REPLACING the template
     placeholders that the seed step wrote there — appending after them leaves a
     constitution that reads half-scaffold, half-real.
  4. A rule that is not about that person but about the PROJECT (secrets, stack
     conventions, house style) does not belong in a constitution at all: soul
     one-liner if unconditional, knowledge/patterns/ if conditional. It must load
     whether or not that person is the active one.
  Never split the difference by copying the same prose into two people.
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
