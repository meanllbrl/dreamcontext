import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureGitignoreEntries, removeGitignoreEntries } from '../gitignore.js';
import {
  AUTOMATIONS_GITIGNORE_ENTRIES,
  AUTOMATIONS_GITIGNORE_ENTRIES_ROOT,
  AutomationError,
  negationIsEffective,
  sharedSlugNegations,
  sharedSlugNegationsRoot,
  shareOrderingProblems,
} from './types.js';

/**
 * The sharing engine — every `.gitignore` mutation for the private-by-default
 * automations feature lives here, in one lane, so no other module needs to
 * reason about ordering or dual-file (brain-relative + project-root-relative)
 * writes.
 *
 * Deliberately does NOT import store.ts (same wave, a sibling task's file):
 * every pure ordering predicate this module needs already lives in the frozen
 * types.ts contract (`negationIsEffective`, `shareOrderingProblems`,
 * `sharedSlugNegations[Root]`), and everything else this module needs to know
 * (which slugs are currently private) arrives as a parameter from the caller.
 */

const SHARE_COMMENT = 'dreamcontext automations — shared (published) automations';
const LOCK_STATE_COMMENT = 'dreamcontext automations — machine-local run state (never commit)';

/** Every negation line this subsystem writes starts with one of these — used
 *  only to LOCATE existing automations negations during a repair or a
 *  `listSharedSlugs` scan, never to validate a slug's shape (that's the
 *  store's job, out of scope here by the hard prohibition above). */
const BRAIN_NEGATION_PREFIX = '!automations/';
const ROOT_NEGATION_PREFIX = '!_dream_context/automations/';
const BRAIN_NEGATION_MANIFEST_RE = /^!automations\/([a-z0-9][a-z0-9-]*)\.md$/;
const ROOT_NEGATION_MANIFEST_RE = /^!_dream_context\/automations\/([a-z0-9][a-z0-9-]*)\.md$/;

export interface ShareResult {
  slug: string;
  shared: boolean;
  added: string[];
  removed: string[];
  /** True iff a broken (missing or misordered) base block was rewritten
   *  before this call's own negations were appended — see F2. */
  repairedOrdering: boolean;
}

export interface ShareOrderingCheck {
  ok: boolean;
  problems: string[];
}

function readGitignoreText(root: string): string {
  const path = join(root, '.gitignore');
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

/** Non-blank, non-comment lines, trimmed — a local duplicate of the same
 *  small filter kept private in types.ts. Not worth an import for four lines,
 *  and it keeps this module's only cross-import the frozen pure predicates it
 *  actually needs (the whole point of hoisting them there). */
function meaningfulLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

function slugsFromNegations(text: string, re: RegExp): string[] {
  const slugs: string[] = [];
  for (const line of meaningfulLines(text)) {
    const m = re.exec(line);
    if (m) slugs.push(m[1]);
  }
  return slugs;
}

function assertNonEmptySlug(slug: string): void {
  if (!slug || slug.trim().length === 0) {
    throw new AutomationError('sharing.ts: slug must be a non-empty string.');
  }
}

/**
 * Every ordering fault across BOTH governing `.gitignore` files (brain-relative
 * at `contextRoot`, project-root-relative at `dirname(contextRoot)` — the two
 * topologies the store's manifest-creation path writes so either can govern
 * depending on whether `_dream_context` is itself a git root or a subdirectory
 * of one). `ok: false` means at least one existing negation is silently
 * dropped by git right now (F2) — a share believed to be live is not.
 */
export function assertShareOrdering(contextRoot: string): ShareOrderingCheck {
  const projectRoot = dirname(contextRoot);
  const problems = [
    ...shareOrderingProblems(readGitignoreText(contextRoot), AUTOMATIONS_GITIGNORE_ENTRIES),
    ...shareOrderingProblems(readGitignoreText(projectRoot), AUTOMATIONS_GITIGNORE_ENTRIES_ROOT),
  ];
  return { ok: problems.length === 0, problems };
}

/**
 * Rebuild one `.gitignore`'s automations block into correct order: pulls every
 * base wildcard AND every existing automations negation out of wherever they
 * currently sit (however broken), then re-appends the wildcards first and the
 * SAME negations after — so every previously-shared slug survives the repair,
 * now guaranteed effective. Never invents or drops a negation; only relocates
 * what was already there.
 */
function repairAutomationsBlock(
  root: string,
  baseEntries: readonly string[],
  negationPrefix: string,
): { removed: string[]; added: string[] } {
  const text = readGitignoreText(root);
  const existingNegations = meaningfulLines(text).filter((l) => l.startsWith(negationPrefix));

  const removed = removeGitignoreEntries(root, [...baseEntries, ...existingNegations]);

  const addedBase = ensureGitignoreEntries(root, [...baseEntries], { comment: LOCK_STATE_COMMENT });
  const addedNegations =
    existingNegations.length > 0
      ? ensureGitignoreEntries(root, existingNegations, { comment: SHARE_COMMENT })
      : [];

  return { removed, added: [...addedBase, ...addedNegations] };
}

/**
 * Publish ONE automation: append its three negation lines (manifest, cache
 * record, output directory) to both governing `.gitignore` files, AFTER
 * verifying (and if necessary repairing) that the base wildcard block fully
 * precedes every existing negation.
 *
 * Skipping the repair-first step is exactly how F2 happens: a negation
 * appended below a currently-fine wildcard block can still end up silently
 * ignored later if a prior edit already left the file misordered, or if
 * another slug's stray negation sits above the wildcards. So this always
 * leaves the file in a verified-effective order before adding anything new —
 * never appends into a block already known to be broken.
 */
export function shareAutomation(contextRoot: string, slug: string): ShareResult {
  assertNonEmptySlug(slug);
  const projectRoot = dirname(contextRoot);

  const check = assertShareOrdering(contextRoot); // MUST run first — F2.
  const removed: string[] = [];
  const repairAdded: string[] = [];
  let repairedOrdering = false;

  if (!check.ok) {
    // Repair only the file(s) that are actually broken — an already-healthy
    // gitignore is never rewritten just because its sibling is broken.
    if (shareOrderingProblems(readGitignoreText(contextRoot), AUTOMATIONS_GITIGNORE_ENTRIES).length > 0) {
      const r = repairAutomationsBlock(contextRoot, AUTOMATIONS_GITIGNORE_ENTRIES, BRAIN_NEGATION_PREFIX);
      removed.push(...r.removed);
      repairAdded.push(...r.added);
      repairedOrdering = true;
    }
    if (shareOrderingProblems(readGitignoreText(projectRoot), AUTOMATIONS_GITIGNORE_ENTRIES_ROOT).length > 0) {
      const r = repairAutomationsBlock(projectRoot, AUTOMATIONS_GITIGNORE_ENTRIES_ROOT, ROOT_NEGATION_PREFIX);
      removed.push(...r.removed);
      repairAdded.push(...r.added);
      repairedOrdering = true;
    }
  }

  const addedBrain = ensureGitignoreEntries(contextRoot, sharedSlugNegations(slug), { comment: SHARE_COMMENT });
  const addedRoot = ensureGitignoreEntries(projectRoot, sharedSlugNegationsRoot(slug), { comment: SHARE_COMMENT });

  return {
    slug,
    shared: true,
    added: [...repairAdded, ...addedBrain, ...addedRoot],
    removed,
    repairedOrdering,
  };
}

/**
 * Un-publish ONE automation: remove its three negation lines from both
 * governing `.gitignore` files. Does NOT rewrite git history — anything
 * already committed and pushed under the old negation remains on every
 * machine that pulled it. The caller (the CLI's `unshare` verb) is
 * responsible for warning the user of that in plain language; this function
 * only performs the mechanical removal.
 */
export function unshareAutomation(contextRoot: string, slug: string): ShareResult {
  assertNonEmptySlug(slug);
  const projectRoot = dirname(contextRoot);

  const removedBrain = removeGitignoreEntries(contextRoot, sharedSlugNegations(slug));
  const removedRoot = removeGitignoreEntries(projectRoot, sharedSlugNegationsRoot(slug));

  return {
    slug,
    shared: false,
    added: [],
    removed: [...removedBrain, ...removedRoot],
    repairedOrdering: false,
  };
}

/**
 * Slugs currently negated in EITHER governing `.gitignore`, AND whose
 * negation is actually EFFECTIVE there (`negationIsEffective` — presence
 * alone is not enough, see F2). This is the ground truth of what actually
 * publishes, not what the frontmatter or the mere existence of a negation
 * line claims.
 *
 * Union across the two files, not intersection: only one topology is ever
 * "live" for a given git root, and this module cannot detect which — so the
 * safe direction on ambiguity is to report a slug as shared rather than
 * under-report it as private.
 */
export function listSharedSlugs(contextRoot: string): string[] {
  const projectRoot = dirname(contextRoot);
  const brainText = readGitignoreText(contextRoot);
  const rootText = readGitignoreText(projectRoot);

  const candidates = new Set<string>([
    ...slugsFromNegations(brainText, BRAIN_NEGATION_MANIFEST_RE),
    ...slugsFromNegations(rootText, ROOT_NEGATION_MANIFEST_RE),
  ]);

  const shared: string[] = [];
  for (const slug of candidates) {
    const brainEffective = negationIsEffective(brainText, sharedSlugNegations(slug)[0], AUTOMATIONS_GITIGNORE_ENTRIES);
    const rootEffective = negationIsEffective(
      rootText,
      sharedSlugNegationsRoot(slug)[0],
      AUTOMATIONS_GITIGNORE_ENTRIES_ROOT,
    );
    if (brainEffective || rootEffective) shared.push(slug);
  }
  return shared.sort();
}

/**
 * Auto-repair the UNSAFE drift direction (S3): remove any negation still on
 * disk for a slug whose manifest flag is `false`. Content leaving the machine
 * while the user believes it is private does not fail safe, so this needs no
 * confirmation — unlike the opposite drift (flag true, negation missing),
 * which only warns. Returns every line actually removed so the caller can
 * print it — repair is announced, never silent.
 */
export function pruneStrayNegations(contextRoot: string, privateSlugs: string[]): string[] {
  const projectRoot = dirname(contextRoot);
  const removed: string[] = [];
  for (const slug of privateSlugs) {
    removed.push(...removeGitignoreEntries(contextRoot, sharedSlugNegations(slug)));
    removed.push(...removeGitignoreEntries(projectRoot, sharedSlugNegationsRoot(slug)));
  }
  return removed;
}
