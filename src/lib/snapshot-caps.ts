/**
 * Every byte budget and demotion rank the snapshot demotion ladder uses.
 *
 * WHY THIS FILE EXISTS: tuning the ladder against live vaults is its own pass
 * (the plan's wave 4), and it must be a ONE-FILE diff. If these numbers lived in
 * `src/cli/commands/snapshot.ts` the tuning lane and the section-rework lane
 * would collide on a 1,750-line file. Nothing here imports anything; nothing
 * here has logic. Values were derived by measuring the two acceptance vaults
 * (this repo and the largest live brain) at the pre-change build — see the
 * task's per-section floor table before changing any of them.
 *
 * Some caps are AC-locked: the objectives rung, the theses rung, the Lab floor
 * and the ★★★ bookmark floor exist so the snapshot can never demote a section
 * down to a bare count. Shrinking those to buy bytes re-breaks the acceptance
 * criteria they were added for.
 *
 * The SOUL and the USER file have no caps here at all, deliberately. They are
 * the agent's constitution and the person's constitution, and both render
 * VERBATIM in every snapshot — never-evict, no rungs, no limit. A core file that
 * pushes the snapshot past the harness limit is a CONTENT problem (conditionals
 * belong in knowledge/patterns, and the user file's non-person material belongs
 * in the people-first layout the redesign introduces — not in a constitution)
 * and the loud banner + doctor error exist to say so. Compressing either at
 * render time would hide the bloat instead of forcing the extraction.
 *
 * The FEATURES_* pair was then re-tuned against live vaults, measuring the
 * rendered snapshot with JS `.length` (NOT `wc -c` — the snapshot is full of
 * multi-byte box drawing, arrows and emoji, and the two disagree by ~160 chars
 * on this repo alone). Anything measured below was measured that way.
 */

// ─── Core-file compression rungs ────────────────────────────────────────────
// Passed straight to `compressMarkdownBlock` / `compressedCoreFile` as
// CompressOptions. Structural typing keeps this module import-free.
//
// CURRENTLY UNUSED BY THE SNAPSHOT RENDERER, and deliberately retained.
//
// These drove `core/0.soul.md`, then `core/1.user.md` alone, and now neither:
// both files are never-evict and render verbatim (see the file header). They
// are kept — rather than deleted — because the people-first redesign that moves
// the user file's non-person content out will re-introduce compressible core
// surfaces, and re-deriving these three rungs from git history is pure waste.
// `snapshot-compress.ts` and its tests still exercise them, so they are covered,
// not merely parked.

/** Rung 1: keep each item's title + its first sentence. */
export const CORE_L1 = { itemChars: 170, paraChars: 220 } as const;
/** Rung 2: same shape, tighter — title plus whatever of the sentence still fits. */
export const CORE_L2 = { itemChars: 80, paraChars: 120 } as const;
/** Rung 3: titles only. Every rule stays NAMED; the rationale goes to the file. */
export const CORE_L3 = { itemChars: 70, paraChars: 110, titleOnly: true } as const;

// ─── Memory (core/2.memory.md) ──────────────────────────────────────────────
//
// These rungs engage ONLY when the file is OVER the core ceiling
// (CORE_FILE_CHAR_CEILING): a compliant memory file is sleep's already-distilled
// working set and renders in full, no rungs at all. See the memory block in
// snapshot.ts for the doctrine.

/**
 * PER INNER H2 of `2.memory.md`, not per file. Both acceptance vaults have 3
 * inner H2s (Active Memory / Technical Decisions / Known Issues), so the section
 * floors near 3x this value in the worst case; measured actual is lower because
 * Active Memory and Known Issues compress below the cap on both vaults.
 *
 * 350 is the floor worth taking, not the smallest number that fits. Measured
 * against the shipped compressor: 1,065 -> 920 (dreamcontext) and 1,582 -> 1,225
 * (a large peer vault) going 500 -> 350, but 300 is *worse* on dreamcontext (947) because a
 * tighter per-H2 budget trips more `(+N more)` tails than it saves in prose.
 */
export const MEMORY_DEEP_PER_SECTION_CHARS = 350;
/** Per-item cap inside that rung (titles only). */
export const MEMORY_DEEP_ITEM_CHARS = 70;

// ─── Active tasks ───────────────────────────────────────────────────────────
// Demoted design (Fable judge verdict, owner-approved 2026-07-30): detailed
// in_progress entries + a named "needs attention" exceptions line + a
// per-status count + the filter-teaching footer. The routine queue (todo/
// planned names) is NOT listed — the contract is "every active task ACCOUNTED
// FOR": detailed, named with a status marker, or inside a count whose sum
// equals the true total.

/** Rung 1: char budget for whole detailed entry blocks (max 3 entries). */
export const TASKS_DETAIL_CHARS = 1_100;
/** Max detailed entries at rung 1. */
export const TASKS_DETAIL_MAX = 3;
/** Floor: one detailed entry's budget. */
export const TASKS_DETAIL_FLOOR_CHARS = 400;
/** Exceptions line name-packing budget at rung 1 / at the floor. */
export const TASKS_EXCEPTIONS_CHARS = 450;
export const TASKS_EXCEPTIONS_FLOOR_CHARS = 250;
// TASKS_ROSTER_CHARS was retired 2026-07-30: the routine-name roster is no
// longer rendered (Fable judge verdict) — exceptions are named, the rest is a
// per-status count, and the footer teaches the filter surface.

// ─── Features ───────────────────────────────────────────────────────────────

/** Rung 1: chars of full feature detail blocks retained. */
export const FEATURES_L1_CHARS = 2_600;
/**
 * Rung 2: chars of `name (status) -> path` lines retained.
 *
 * 900 -> 550 is where live-vault tuning found the last 249 chars, and it is the
 * cheapest 249 in the whole ladder because a rung-2 feature line carries almost
 * no information its own slug does not: the path is always
 * `_dream_context/knowledge/features/<slug>.md`, so dropping a line costs the
 * status flag and nothing else — the slug itself falls straight through to the
 * roster tail below, which still NAMES it.
 *
 * Measured on dreamcontext, paired with FEATURES_ROSTER_CHARS 450:
 *   before  8 lines + 17 named in the tail = 25 features named, 18,131 chars
 *   after   5 lines + 20 named in the tail = 25 features named, 17,882 chars
 * Same names, same accurate count, 249 chars cheaper. Nothing was traded away
 * except three formulaic paths and three status words.
 *
 * 550 sits mid-class, not on a boundary: dreamcontext keeps 5 lines anywhere in
 * ~506-596, so a small drift in a feature slug's length cannot silently flip the
 * render. Do not raise it back without re-measuring — 650 puts dreamcontext at
 * 17,917 (83 chars of margin) and 700 puts it back OVER at 18,024.
 */
export const FEATURES_L2_CHARS = 550;
/**
 * The features remainder tail, same whole-slug + accurate-count shape as
 * TASKS_ROSTER_CHARS. Measured full tails on the two acceptance vaults are 611
 * and 388 chars, so this trims dreamcontext's roster to a counted tail and keeps
 * the smaller vault's whole.
 *
 * This cap has a FLOOR, and the floor MOVES with FEATURES_L2_CHARS. "Every
 * feature slug is named" (AC3) is asserted in `tests/unit/snapshot-floors.test.ts`
 * against a 40-feature fixture, and every feature the L2 block above stops
 * listing arrives here instead — so tightening L2 RAISES the minimum this cap
 * may hold. At L2 = 550 the fixture needs >= 408 here; at L2 = 900 it needed
 * only >= 360. That is why this value went UP (400 -> 450) in the same pass that
 * took L2 down: the pair is one lever, not two.
 *
 * It is also why the plan's 400 -> 250 cut was NOT taken — measured, it lands
 * dreamcontext at 17,995 (5 chars of margin) and drops 11 feature slugs from the
 * fixture roster, i.e. it buys less than the L2 cut while actually failing AC3.
 *
 * 450 is the LOOSEST value that still leaves dreamcontext >= 100 chars under
 * budget: 450 -> 17,882 (118 spare), 470 -> 17,908 (92), 500 -> 17,935 (65).
 * Loosest wins here because every extra char is another feature NAMED.
 */
export const FEATURES_ROSTER_CHARS = 450;

// ─── Knowledge index ────────────────────────────────────────────────────────

// KNOWLEDGE_L2_CHARS was retired 2026-07-30: non-pinned knowledge is no
// longer listed in the snapshot at all (count + search commands instead), so
// the grouped-by-folder rung and its cap are gone with it.

/**
 * Pinned 📌 knowledge is a user MUST-READ signal, so it is the LAST thing the
 * knowledge index gives up: verbatim at level 0 and at rung 1, bounded only at
 * rung 2. The bound exists because the block is unbounded in pin count and was
 * measured at 3,530 chars (6 pins, dreamcontext) — ~82% of it description prose
 * the file itself holds one Read away. Every pin keeps its slug + path at every
 * rung; only a pathological pin count reaches the counted tail.
 *
 * AC-locked in one direction: PINNED_KNOWLEDGE_CHARS may tighten to the stage-2
 * bare-render size (measured 731 / 523) but never below it, because under that
 * the block stops naming pins at all.
 */
export const PINNED_ITEM_CHARS = 200;
export const PINNED_KNOWLEDGE_CHARS = 1_300;

// ─── Bookmarks ──────────────────────────────────────────────────────────────

/** Rung 1: ★★★ verbatim, the rest first-sentence, packed into this budget. */
export const BOOKMARKS_L1_CHARS = 1_200;
/** Per-bookmark cap for salience 1-2 at rung 1. ★★★ is never capped. */
export const BOOKMARK_ITEM_CHARS = 120;

// ─── Small inventory sections ───────────────────────────────────────────────

/** Extended core index at rung 1 = name + path + a SHORT summary. */
export const EXTENDED_CORE_L1_CHARS = 1_200;
/**
 * Per-file summary cap at that rung (first sentence, word-safe). The file NAME
 * says what a core file is; this one clause says what is IN it — without it the
 * demoted index on a mature vault read as bare "tech-stack, style-guide" lines
 * and the agent had no reason to ever open them (owner call 2026-07-29).
 */
export const EXTENDED_CORE_SUMMARY_CHARS = 90;
/** Upcoming versions + latest release at rung 1, summaries dropped. */
export const RELEASES_L1_CHARS = 400;
/**
 * The LATEST release's summary at the demoted rung, word-safe. Level 0 keeps
 * it whole — but a release narrative can run 1.5K+ chars (0.21.0 did), and an
 * unbounded line at the FLOOR made the one section that cannot demote further
 * scale with prose nobody budgeted.
 */
export const RELEASES_LATEST_SUMMARY_CHARS = 300;
/** Connected peers at rung 1: one line per peer, no activity/tags/pinned docs. */
export const CONNECTED_L1_CHARS = 800;
/** Connected peers at rung 2: name + a SHORT identity per peer, packed. */
export const CONNECTED_L2_CHARS = 300;
/**
 * Per-peer identity cap at rung 2 (first sentence, word-safe). A peer named
 * without its "what it is" reproduced the original soul-review complaint —
 * the agent sees "acme-payments" and has no idea what it is.
 */
export const CONNECTED_PEER_ID_CHARS = 90;
/**
 * Per-pattern brief in the Knowledge Index (first sentence, word-safe). Owner
 * decision 2026-07-30: every pattern title is ALWAYS visible with one short
 * clause — enough to know the pattern exists and when it applies; the deep
 * keyword-ranked pattern surface is the patterns run's scope.
 */
export const PATTERN_BRIEF_CHARS = 80;
/**
 * The patterns block at the knowledge index FLOOR: slugs only, packed whole
 * with a named tail. Rules must never fold into anonymous folder inventory
 * (the soul-split migration moves rule-bearing conditionals here), so unlike
 * every other knowledge folder the patterns list keeps its own warned block
 * at the deepest rung. ~19 live patterns on the largest vault fit under this.
 */
export const PATTERNS_FLOOR_CHARS = 1_000;
/**
 * The other-people roster at rung 1: one `- **Name** (`person:slug`) — role`
 * line per teammate. Sized like the peer roster above because it is the same
 * shape of list — a handful of short, named lines. The ACTIVE person's
 * constitution is never in here (it is never-evict); this section is purely
 * "who else exists in this vault", so its floor is a named list, never a count.
 */
export const PEOPLE_ROSTER_L1_CHARS = 600;

// ─── AC-locked rungs ────────────────────────────────────────────────────────

/**
 * AC-locked. Rung 2 is one compact line per ACTIVE objective — it replaced a
 * bare `- N objective(s)` rung that blinded the agent to what the project is
 * driving toward. Shrinking this below "one line per objective" restores the
 * blinding; it is a deliberate byte INCREASE over the old rung, not a regression.
 */
export const OBJECTIVES_L2_CHARS = 700;
/** Per-objective cap inside that rung. */
export const OBJECTIVE_ITEM_CHARS = 110;
/**
 * AC-locked. Per-claim cap for the theses rung, which keeps the top open claims
 * instead of bottoming out at `⚗ Learning: N open · N flipped · N blocked`.
 */
export const THESES_CLAIM_CHARS = 110;

// ─── Over-budget banner ─────────────────────────────────────────────────────

/**
 * The banner lists at most this many oversized core files, then `(+N more)`.
 * It is injected inside the harness's ~2KB blind-preview window, so a vault with
 * a dozen extended core files must not push the actionable fix out of view.
 */
export const BANNER_MAX_CORE_FILES = 4;

// ─── Section identity + demotion order ──────────────────────────────────────

/**
 * Sections the ladder may demote. This union is the enforcement mechanism: the
 * snapshot builder's demotable-section constructors take this type, so adding a
 * demotable section without giving it a rank below is a COMPILE error rather
 * than a silent fallback to its array index.
 */
export type DemotableSectionId =
  | 'warm-knowledge'
  | 'changelog'
  | 'releases'
  | 'extended-core'
  | 'connected-projects'
  | 'knowledge-index'
  | 'features'
  | 'memory'
  | 'bookmarks'
  | 'tasks'
  | 'people-roster'
  | 'objectives'
  | 'theses'
  | 'lab';

/**
 * Sections that are never demoted. Small, behaviour-binding, or positional
 * (linked-repos is deliberately first so resolved machine paths survive even a
 * blind-preview cut). `header` is here because the `# Agent Context` H1 is
 * sealed into its own section — otherwise it rides along in whichever section
 * flushes first, and would become demotable with it.
 *
 * `soul` and `person` are here on a different rationale from the rest: they are
 * not small, and they are not positional. They are the agent's CONSTITUTION and
 * the ACTIVE PERSON's CONSTITUTION, so they render verbatim or the agent is
 * operating under rules — and about a person — it was only shown the titles of.
 * A named preference with its body compressed away is the worst of both: it
 * costs bytes AND it reads as if the agent knows the preference, so the agent
 * never goes and reads the file. Size is managed by extracting content
 * (conditionals into knowledge/patterns; anything that is not about the person
 * out of `people/<slug>.md`), never by compressing either file at render time.
 *
 * `person` covers all three shapes the block can take — the resolved
 * constitution, the UNRESOLVED notice, and the retired `core/1.user.md` legacy
 * render (D15) — because each of them is the same load-bearing slot. The ROSTER
 * of other people is a different thing entirely and is demotable (rank 110): who
 * else exists is inventory, not constitution.
 *
 * `peer-mail` is here for a reason none of the others share: it is the only
 * section someone is WAITING on. A peer addressed this project and is holding an
 * open thread; if the message is demoted away the agent never learns it exists
 * and the sender gets silence that is indistinguishable from a refusal. It is
 * also self-limiting — pending mail is a handful of short messages, and it stops
 * rendering entirely the moment they are answered and closed.
 */
export type NeverEvictSectionId =
  | 'header'
  | 'linked-repos'
  | 'soul'
  | 'person'
  | 'task-override'
  | 'product-and-nudge'
  | 'awareness'
  | 'marketing'
  | 'peer-mail'
  | 'federation';

/**
 * Demotion order — LOWER demotes FIRST, cheapest loss first. Deliberately
 * decoupled from render order: `memory` renders near the top but is given up
 * well after the inventory sections below it, and the ladder's wave loop walks
 * this order, not the render order.
 *
 * The soul and the active person's constitution are absent by design, not by
 * omission: both are never-evict, so neither has a rank at all. `lab` at 140 is
 * therefore the end of the road — when it reaches its floor the ladder is
 * exhausted, and anything still over the limit is a CONSTITUTION (soul or
 * person) that needs slimming by extraction, which the banner and
 * `dreamcontext doctor` say out loud.
 *
 * The scale is sparse (10-140, with 150 and 160 free) so a future section
 * can be slotted between two existing ones without renumbering. Every value
 * stays above the largest plausible array index, so a section that somehow
 * escapes the typed constructors and falls back to `?? arrayIndex` can never
 * interleave into the middle of this scale — it sorts first and gets demoted
 * first, which is the safe failure direction.
 */
export const DEMOTION_RANKS: Record<DemotableSectionId, number> = {
  'warm-knowledge': 10,
  changelog: 20,
  releases: 30,
  'extended-core': 40,
  'connected-projects': 50,
  'knowledge-index': 60,
  features: 70,
  // Only reachable when core/2.memory.md is OVER the core ceiling — a compliant
  // file gets no rungs at all (sleep already compressed it), so this rank never
  // fires on a well-slept vault.
  memory: 80,
  bookmarks: 90,
  tasks: 100,
  // 110 was the slot reserved for exactly this: the people roster, added by the
  // people-first layout. Everyone in it stays NAMED at its floor, so demoting it
  // costs a role label, never an identity.
  'people-roster': 110,
  objectives: 120,
  theses: 130,
  lab: 140,
  // 150 and 160 intentionally free — they were the user file's and the soul's
  // ranks before both became never-evict. Nothing should reclaim them without a
  // reason to demote AFTER Lab.
};
