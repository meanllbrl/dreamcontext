/**
 * Chat MODES — the sanitizer, the briefings, and the worktree gate that decides which
 * develop briefing a project gets.
 *
 * Two properties are load-bearing enough to be pinned mechanically rather than reviewed:
 *
 *   1. An unknown mode must degrade to `basic` (plain Claude Code), never to a half-applied
 *      one. Two cases are interesting: `jarvis` is RETIRED (voice moved to the Assistant's
 *      notch), so a saved session carrying it reopens as `basic`; and `assistant` is BOUND to
 *      the hidden `__assistant__` vault in both directions.
 *
 *   2. The develop briefing's worktree paragraph must follow THIS PROJECT's layout, in all
 *      four combinations of (brain isolated?) × (linked repo present?). Getting it wrong in
 *      the permissive direction forks the brain: `_dream_context/` lives in the code checkout
 *      by default, so a second worktree is a second copy of the brain that nobody reconciles.
 *      A briefing that merely stays SILENT about worktrees is not good enough — an unmentioned
 *      capability is one the agent reaches for anyway — so the forbidden case is asserted to
 *      carry an explicit prohibition, not just the absence of permission.
 *
 * The linked-repo arm drives `worktreeIsolationAllowed`'s `home` test seam so it reads a
 * scratch registry, never the developer's real `~/.dreamcontext/linked-repos.json`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_MODES, DEFAULT_CHAT_MODE, PICKER_MODES, assistantBriefing, modeBriefing } from '../../src/server/chat-modes.js';
import { sanitizeChatMode } from '../../src/server/routes/agent-spawn-shared.js';
import { worktreeIsolationAllowed } from '../../src/lib/worktree-gate.js';
import { canonicalRemote } from '../../src/lib/git-sync/origin-setup.js';
import { linkedReposFilePath } from '../../src/lib/linked-repos.js';

describe('sanitizeChatMode', () => {
  it('passes every mode that carries behaviour', () => {
    expect(sanitizeChatMode('plan')).toBe('plan');
    expect(sanitizeChatMode('develop')).toBe('develop');
    expect(sanitizeChatMode('basic')).toBe('basic');
  });

  it('maps the retired jarvis mode to basic, so saved sessions carrying it reopen as Basic', () => {
    expect(sanitizeChatMode('jarvis')).toBe('basic');
    expect(sanitizeChatMode('jarvis', 'acme-app')).toBe('basic');
    expect(CHAT_MODES as readonly string[]).not.toContain('jarvis');
  });

  it('binds the assistant mode to the hidden vault — downgraded to basic everywhere else', () => {
    expect(sanitizeChatMode('assistant')).toBe('basic');
    expect(sanitizeChatMode('assistant', 'acme-app')).toBe('basic');
    expect(sanitizeChatMode('assistant', null)).toBe('basic');
  });

  it('forces the hidden __assistant__ vault into assistant mode, whatever the URL asked for', () => {
    for (const asked of [null, '', 'basic', 'plan', 'develop', 'jarvis', 'assistant', 'nonsense']) {
      expect(sanitizeChatMode(asked, '__assistant__'), `asked=${String(asked)}`).toBe('assistant');
    }
  });

  it('the picker never offers the assistant mode', () => {
    expect(PICKER_MODES as readonly string[]).not.toContain('assistant');
    expect([...PICKER_MODES]).toEqual(['basic', 'plan', 'develop', 'train']);
  });

  it('train is a real mode, in the picker\'s fourth position, and round-trips (a saved session reopens in it)', () => {
    expect([...CHAT_MODES]).toEqual(['basic', 'plan', 'develop', 'train', 'assistant']);
    expect(PICKER_MODES.indexOf('train')).toBe(3);
    expect(sanitizeChatMode('train')).toBe('train');
    expect(sanitizeChatMode('train', 'acme-app')).toBe('train');
    expect(sanitizeChatMode('Train')).toBe('basic');
  });

  it('coerces everything unknown, empty or hostile to basic', () => {
    const rejected = [
      null, '', ' ', 'Plan', 'PLAN', 'DEVELOP', 'basic ', 'plan;rm -rf /', 'plan develop',
      '../plan', 'develop\n', '__proto__', 'constructor', 'toString',
    ];
    for (const input of rejected) {
      expect(sanitizeChatMode(input), `input: ${JSON.stringify(input)}`).toBe('basic');
    }
  });

  it('is exhaustive over CHAT_MODES — every listed mode round-trips or coerces, none throws', () => {
    for (const mode of CHAT_MODES) {
      const out = sanitizeChatMode(mode, mode === 'assistant' ? '__assistant__' : 'acme-app');
      expect(CHAT_MODES as readonly string[]).toContain(out);
    }
  });

  it('the default IS basic (there is no user-settable mode default)', () => {
    expect(DEFAULT_CHAT_MODE).toBe('basic');
    expect(sanitizeChatMode(null)).toBe(DEFAULT_CHAT_MODE);
  });
});

describe('modeBriefing', () => {
  // REVERSAL, 2026-08-24. This test used to assert `modeBriefing('basic', …) === ''` —
  // "basic adds NOTHING — plain Claude Code plus the surface briefing". The worktree
  // paragraph was appended only in `develop`, which left the prohibition that stops a second
  // checkout forking the brain absent from `basic`: the DEFAULT mode, the one a fresh chat is
  // in, carrying exactly the same tools. The guard was on the door nobody uses. Basic now
  // carries that paragraph and nothing else, so the mode is still plain Claude Code in
  // BEHAVIOUR — the assertions below pin both halves of that sentence.
  it('basic carries the worktree paragraph — and ONLY the worktree paragraph', () => {
    expect(modeBriefing('basic', { worktreeAllowed: true })).toMatch(PERMITS);
    expect(modeBriefing('basic', { worktreeAllowed: false })).toMatch(FORBIDS);
    for (const worktreeAllowed of [true, false]) {
      const brief = modeBriefing('basic', { worktreeAllowed });
      expect(brief).not.toContain('# Mode:');
      expect(brief).not.toContain('dreamcontext tasks log');
      expect(brief).not.toContain('"type":"progress"');
      expect(brief).not.toMatch(/Work in waves/);
    }
  });

  it('develop ends with the SAME paragraph basic gets — one constant, not two copies', () => {
    for (const worktreeAllowed of [true, false]) {
      const basic = modeBriefing('basic', { worktreeAllowed });
      expect(basic.length).toBeGreaterThan(0);
      expect(modeBriefing('develop', { worktreeAllowed }).endsWith(basic),
        `worktreeAllowed=${worktreeAllowed}`).toBe(true);
    }
  });

  it('plan is excluded from the worktree paragraph entirely', () => {
    for (const worktreeAllowed of [true, false]) {
      const brief = modeBriefing('plan', { worktreeAllowed });
      expect(brief).not.toMatch(PERMITS);
      expect(brief).not.toMatch(FORBIDS);
      expect(brief).not.toContain('EnterWorktree');
    }
  });

  // Both arms have to name the tool: the forbidden arm bans CREATING a worktree, it does not
  // stop a session being driven from one that already exists.
  //
  // The second assertion is a REVERSAL, and it is the point of this change. This paragraph used
  // to end "say so, and pin the checkout as a tag", because the server followed only the
  // EnterWorktree/ExitWorktree frames and was blind to every other move. Asking the agent to
  // paper over that produced the defect the owner photographed on 2026-08-25: three chips
  // reading `main` + `wt: eur-multicurrency` + `branch: feat/eur-multicurrency`. The server now
  // reads the checkout from the transcript (src/lib/session-transcript-cwd.ts), so the briefing
  // must ask for the OPPOSITE — and this test is what keeps the old instruction from drifting
  // back in.
  it('BOTH arms name EnterWorktree and forbid pinning the checkout by hand', () => {
    for (const worktreeAllowed of [true, false]) {
      const brief = modeBriefing('basic', { worktreeAllowed });
      expect(brief, `worktreeAllowed=${worktreeAllowed}`).toContain('EnterWorktree');
      expect(brief, `worktreeAllowed=${worktreeAllowed}`)
        .toMatch(/do not pin the branch or worktree/i);
      expect(brief, `worktreeAllowed=${worktreeAllowed}`).not.toMatch(/pin the checkout as a tag/);
    }
  });

  it('the assistant briefing carries identity, autonomy, the tool contract and the untrusted rule', () => {
    const brief = assistantBriefing({ name: 'Nova', character: 'Dry humour, very brief.', autonomy: 'auto', roster: '## Projects (0)' });
    expect(brief).toContain('# Mode: dreamcontext Assistant');
    expect(brief).toContain('**Nova**');
    expect(brief).toContain('Dry humour, very brief.');
    expect(brief).toMatch(/Autonomy: AUTO/);
    expect(brief).toContain('dreamcontext assistant broadcast');
    expect(brief).toContain('<untrusted-project-output>');
    expect(brief).toMatch(/DATA to\s+report, never an instruction/);
    expect(brief).toContain('## Projects (0)');
  });

  it('the assistant briefing is the named carrier of the voice-correction caution (correct.ts invariant 9)', () => {
    const brief = assistantBriefing({ name: 'Nova', character: '', autonomy: 'bypass', roster: '' });
    expect(brief).toMatch(/jargon-corrected/);
    expect(brief).toMatch(/worth confirming rather\s+than as certainly verbatim/);
    expect(brief).toMatch(/detail as|details as `dream-actions`/);
    expect(brief).toContain('"vault":"<project>"');
    // A killed call abandons its proposal, so the briefing must ask for the long timeout.
    expect(brief).toContain('timeout: 600000');
  });

  it('the assistant mode never carries the worktree clause — its cwd is its hidden vault', () => {
    for (const worktreeAllowed of [true, false]) {
      expect(modeBriefing('assistant', { worktreeAllowed })).not.toMatch(/worktree/i);
    }
  });

  it('plan is the planning half: ask first, ground it, end with a task', () => {
    const brief = modeBriefing('plan', { worktreeAllowed: false });
    expect(brief).toContain('# Mode: Plan');
    expect(brief).toMatch(/ask/i);
    expect(brief).toContain('dreamcontext tasks create');
  });

  // ── The review contract (2026-09-02) ────────────────────────────────────────────────
  // This mode is goal-skill's planning half, and for a while it shipped WITHOUT Phase 2:
  // step 4 said "review your own plan", i.e. the author grading itself — the anchoring
  // failure `three-reviewer-parallel-mandates-pattern` exists to name. These four tests are
  // what keep the self-review wording from drifting back in.
  it('plan dispatches CLEAN reviewer lenses — never reviews its own plan', () => {
    const brief = modeBriefing('plan', { worktreeAllowed: false });
    expect(brief).toContain('goal-plan-reviewer');
    // Parallel, in one message: sequential lenses cost a round-trip each and, worse, let a
    // later lens read an earlier one's framing.
    expect(brief).toMatch(/IN PARALLEL/);
    expect(brief).toMatch(/ONE message/);
    // Fed the ARTIFACT, not the session — a judge that meets the work through the plan text
    // stays independent (goal-skill's two-lane rule).
    expect(brief).toMatch(/only the plan text/i);
    expect(brief).toMatch(/never review your own/i);
  });

  it('plan names the mandate-diverse lenses, including edge cases', () => {
    const brief = modeBriefing('plan', { worktreeAllowed: false });
    // Different mandates surface different categories; none is a substitute for another.
    for (const lens of ['critic', 'pragmatist', 'edge-cases', 'security']) {
      expect(brief, `missing lens: ${lens}`).toContain(lens);
    }
    // Security is conditional on the hot-path surfaces, not a fourth lens on every plan.
    expect(brief).toMatch(/auth, crypto, secrets or migrations/);
  });

  // The chat reads a lens off the dispatch's NAME (agentRoles.ts `resolveAgentIdentity`), so
  // a party card can show "Critic" and "Pragmatist" rather than three identical "Reviewer"s.
  it('plan names each reviewer dispatch after its lens', () => {
    const brief = modeBriefing('plan', { worktreeAllowed: false });
    expect(brief).toMatch(/Name each dispatch\s+after its lens/);
    expect(brief).toContain('`critic lens`');
  });

  it('plan ITERATES on the review, and escalates instead of proceeding when stuck', () => {
    const brief = modeBriefing('plan', { worktreeAllowed: false });
    expect(brief).toMatch(/SOLID/);
    expect(brief).toMatch(/re-review/i);
    // Convergence by signal (goal-skill Phase 2): the same finding surviving a revision means
    // the loop is stuck, and a stuck loop goes to the user — it does not get waved through.
    expect(brief).toMatch(/SAME finding twice/i);
    expect(brief).toMatch(/never quietly proceed/i);
  });

  it('plan writes the plan INTO the task — criteria, details, constraints, validation', () => {
    // "Create a task" alone produced a task with a name and nothing else: the plan body,
    // the decisions and the agreed validation method stayed in the transcript, which is
    // exactly the artifact the next session cannot find.
    const brief = modeBriefing('plan', { worktreeAllowed: false });
    for (const section of ['acceptance_criteria', 'technical_details', 'constraints']) {
      expect(brief, `missing section: ${section}`).toContain(`insert <slug> ${section}`);
    }
    expect(brief).toMatch(/Validation method:/);
  });

  it('plan ENDS by offering the develop handoff as a dream-actions button', () => {
    const brief = modeBriefing('plan', { worktreeAllowed: false });
    expect(brief).toContain('dream-actions');
    expect(brief).toContain('"action": "develop"');
    // The button carries the slug the agent just created — an id-less handoff has nothing
    // to hand off.
    expect(brief).toMatch(/"id":\s*"<the-task-slug>"/);
  });

  it('plan tells the agent to SHELVE the task it just created', () => {
    // The shelf is proactive or it is nothing: an agent that only mentions progress in prose
    // leaves the surface empty for the whole session.
    const brief = modeBriefing('plan', { worktreeAllowed: false });
    expect(brief).toContain('dream-view');
    expect(brief).toContain('"type":"progress"');
    expect(brief).toMatch(/"task":\s*"<the-slug>"/);
  });

  it('plan does not depend on the worktree gate (it never implements)', () => {
    expect(modeBriefing('plan', { worktreeAllowed: true }))
      .toBe(modeBriefing('plan', { worktreeAllowed: false }));
  });

  it('develop is the implementing half: waves, evidence, no silent redesign', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).toContain('# Mode: Develop');
    expect(brief).toMatch(/waves/i);
    expect(brief).toMatch(/evidence/i);
    expect(brief).toContain('dreamcontext tasks log');
  });

  // ── The review + validate contract (2026-09-02, per-wave since 2026-09-26) ──────────
  // The mirror of the Plan briefing's step 4. This half used to end at "don't expand scope":
  // the agent built, gated its own waves, ticked its own criteria and declared itself done —
  // every judgement in the loop belonging to the author. 2026-09-02 added ONE clean review
  // after the last wave; the owner reversed the timing on 2026-09-26: a review closes EVERY
  // wave, scoped to that wave's files, and the last one reads the whole run.
  it('develop closes EVERY wave with a CLEAN, scoped reviewer — it does not self-approve', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).toMatch(/you do not sign off on your own work/i);
    expect(brief).toContain('`reviewer`');
    expect(brief).toMatch(/Close every wave/);
    expect(brief).toMatch(/on that wave's files and criteria/);
    expect(brief).toMatch(/last wave's reads\s+the whole run/);
    // The reversed rule must not creep back: no "after the LAST wave" review timing.
    expect(brief).not.toMatch(/After the LAST wave/);
    // The judge fetches its own changes — a pasted diff is the author choosing what gets read.
    expect(brief).toMatch(/git diff[^\n]*ITSELF/);
    expect(brief).toMatch(/never paste a diff/i);
    // The verdict lands before the run moves on, or the map loses it.
    expect(brief).toMatch(/verdict before the next phase/);
  });

  it('develop: builders build, the lead writes no product code', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).toMatch(/Builders build every wave, never you/);
    expect(brief).toMatch(/You write no product code/);
    expect(brief).toMatch(/owned\s+files changed on disk/);
  });

  it('develop sends the lead to the recipe, and says what to do when the CLI is too old', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).toContain('dreamcontext goal-live recipe develop');
    expect(brief).toMatch(/Unknown\s+command\? STOP and tell the owner to run `dreamcontext update`/);
    expect(brief).toContain('dreamcontext goal-live start --goal <slug> --mode develop || true');
  });

  it('develop writes the wave map before any code: max 3 lanes, disjoint files, Plan\'s map unchanged', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).toMatch(/Write one before any code/);
    expect(brief).toMatch(/max\s+3 lanes a wave/);
    expect(brief).toMatch(/disjoint files/);
    expect(brief).toMatch(/A map from Plan mode is used unchanged/);
  });

  it('plan asks for the wave map in the file-by-file draft', () => {
    const brief = modeBriefing('plan', { worktreeAllowed: false });
    expect(brief).toMatch(/Include the wave map: waves, lanes \(max 3\), files owned/);
    // In step 3, the draft — not bolted on after the review.
    expect(brief.indexOf('Include the wave map')).toBeLessThan(brief.indexOf('4. **Then have it attacked'));
  });

  it('develop iterates on review findings, and escalates one that survives a fix', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).toMatch(/re-review/i);
    expect(brief).toMatch(/SAME finding twice/i);
    expect(brief).toMatch(/never merge past it/i);
  });

  it('develop validates through a CLEAN judge — it does not certify its own build', () => {
    // Plan mode writes "Validation method: …" into the task as a criterion; this is the half
    // that spends it. goal-skill Phase 6 calls this "the real gate" and always dispatches a
    // clean goal-validator — an earlier draft of this briefing had the BUILDER run the check
    // and close the task itself, which is the self-approval this whole change exists to end.
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).toContain('goal-validator');
    expect(brief).toMatch(/you do not certify your own build/i);
    expect(brief).toContain('Validation method:');
    expect(brief).toMatch(/Flaky, skipped or "should pass" is a\s+FAIL/);
    expect(brief).toContain('dreamcontext tasks status <slug> completed');
    expect(brief).toContain('in_review');
  });

  // ── Train Me (2026-09-27) ───────────────────────────────────────────────────────────
  // The owner's swipe verdicts are the contract: test the rule by predicting picks and show
  // only the misses; do NOT print the rule every round (once, at the end, with its hit rate).
  // The write is confirm-gated, and an automation-bound session writes its playbook instead.
  it('train opens on the scenario and recalls the existing pattern', () => {
    const brief = modeBriefing('train', { worktreeAllowed: false });
    expect(brief).toContain('# Mode: Train Me');
    expect(brief).toMatch(/what you are being trained on/i);
    expect(brief).toContain('dreamcontext patterns match "<scenario>"');
    expect(brief.indexOf('patterns match')).toBeLessThan(brief.indexOf('rounds of 3-4 cards'));
  });

  it('train deals swipe decks, A/B/C preview boards and bare media, each verdict noteable', () => {
    const brief = modeBriefing('train', { worktreeAllowed: false });
    expect(brief).toContain('AskUserQuestion');
    expect(brief).toContain('"metadata":{"source":"swipe"}');
    expect(brief).toContain('`preview`');
    expect(brief).toMatch(/<img src>.*<video src>/);
    expect(brief).toMatch(/verdict may carry a note/);
  });

  it('train tests the rule silently and shows ONLY the misses — never the rule every round', () => {
    const brief = modeBriefing('train', { worktreeAllowed: false });
    expect(brief).toMatch(/Predict the owner's pick for each card BEFORE\s+asking/);
    expect(brief).toMatch(/never on the card/);
    expect(brief).toMatch(/show only the misses/);
    expect(brief).toContain('I expected Keep, you dropped it');
    expect(brief).toMatch(/Do not print the rule between rounds/);
    // The dropped verdict must not creep back in any wording.
    expect(brief).not.toMatch(/(print|show|state) the rule (after|at the end of) (each|every) round/i);
    expect(brief).not.toMatch(/one-line rule/i);
    // Shown once, at the end, with its hit rate.
    expect(brief).toMatch(/show the rule once with its hit rate/);
  });

  it('train writes a pattern ONLY after an explicit yes, with the diff shown first', () => {
    const brief = modeBriefing('train', { worktreeAllowed: false });
    expect(brief).toMatch(/pattern diff/);
    expect(brief).toMatch(/Write ONLY after an explicit yes/);
    expect(brief.indexOf('pattern diff')).toBeLessThan(brief.indexOf('Write ONLY after an explicit yes'));
    expect(brief).toContain('dreamcontext knowledge create "patterns/<name>" -t kind:pattern -d "…" -c "…"');
    expect(brief).toMatch(/existing → edit that file/);
  });

  it('train bound to an automation writes its playbook through automations learn, never patterns', () => {
    const brief = modeBriefing('train', { worktreeAllowed: false });
    expect(brief).toContain('dreamcontext automations learn <slug> --playbook-file <file>');
    expect(brief).toMatch(/never\s+knowledge\/patterns/);
  });

  it('train learns by watching: a dropped screen recording through the video-watching skill', () => {
    const brief = modeBriefing('train', { worktreeAllowed: false });
    expect(brief).toMatch(/record the screen/);
    expect(brief).toContain('_dream_context/tmp/agent-drops');
    expect(brief).toContain('video-watching skill');
    expect(brief).toMatch(/steps \+ a pattern under the same confirm gate/);
  });

  it('train ends with the SAME worktree paragraph basic gets, and stays off the dream-html surface', () => {
    for (const worktreeAllowed of [true, false]) {
      const brief = modeBriefing('train', { worktreeAllowed });
      expect(brief.endsWith(modeBriefing('basic', { worktreeAllowed })), `worktreeAllowed=${worktreeAllowed}`).toBe(true);
      expect(brief).not.toContain('dream-html');
      expect(brief).not.toContain('dream-view');
    }
  });

  // `\s+`, not a literal space: the briefings are hand-wrapped prose, so the sentence can
  // break across a newline. The property under test is what the sentence SAYS, never where
  // the line happens to end.
  const PERMITS = /MAY\s+use\s+a\s+git\s+worktree/;
  const FORBIDS = /Do\s+NOT\s+create\s+a\s+git\s+worktree/;

  it('develop opens the run on the shelf BEFORE the first edit', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).toContain('"type":"progress"');
    expect(brief).toMatch(/"task":\s*"<the-slug>"/);
    // It must land ahead of the wave instruction — "first action", not "somewhere".
    expect(brief.indexOf('"type":"progress"')).toBeLessThan(brief.indexOf('Work in waves'));
    // And it must say WHERE the percent comes from, or the agent will try to assert one.
    expect(brief).toMatch(/criteria\s+you\s+tick/i);
  });

  it('develop tells the agent to pin a dev-server URL as a tag', () => {
    // The port is the one session fact no server-side reader can attribute to a session —
    // only the agent that ran the command knows it.
    const brief = modeBriefing('develop', { worktreeAllowed: true });
    expect(brief).toContain('"type":"pin"');
    expect(brief).toContain('"weight":"tag"');
    expect(brief).toContain('http://localhost:PORT');
  });

  it('develop PERMITS a worktree only when the brain is isolated', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: true });
    expect(brief).toMatch(PERMITS);
    expect(brief).not.toMatch(FORBIDS);
  });

  it('develop FORBIDS a worktree explicitly otherwise — silence is not enough', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).toMatch(FORBIDS);
    expect(brief).not.toMatch(PERMITS);
    // It says WHY, so the agent can tell this apart from an arbitrary rule.
    expect(brief).toContain('_dream_context/');
  });

  // Every briefing rides in the system prompt of EVERY turn of a session that selected it,
  // so each mode gets a hard ceiling. `plan` and `develop` get a bigger one than the rest, on
  // purpose: they are the only briefings that carry a CONTRACT (which judges, fed what, and
  // what to do when they disagree) rather than a list of habits, and the one-line version of
  // that contract is exactly what let both modes ship self-review. The budget bought a
  // behaviour. `basic` stays lean — it is the default mode and adds only the worktree rule.
  //
  // `develop` is allowed a little more than `plan` for a reason that is NOT its prose: it is
  // the only mode whose briefing concatenates the shared worktree paragraph (~490 chars in
  // the ALLOWED arm), so its mode-specific text is the shorter of the two.
  //
  // `plan` went 2400 → 2450 (2026-09-25) for one sentence: "Name each dispatch after its lens".
  // It is part of the contract too: the chat reads the lens off the dispatch name, and
  // without it three reviewers render as three identical "Reviewer"s.
  //
  // `assistant` is measured WITHOUT its roster (which `renderRoster` caps separately at 6 000):
  // its fixed part is the tool contract and the untrusted-content rule, both load-bearing.
  //
  // `plan` went 2450 → 2520 (2026-09-26) for one sentence in step 3: the wave map. Develop
  // inherits only the task file, so the lanes and their owned files must already be in it.
  //
  // `develop` went 2600 → 3200 (2026-09-26) for the per-wave contract: builders not the lead,
  // a scoped review closing every wave, the recipe pointer and its too-old-CLI fallback. The
  // PROCEDURE went to `goal-live recipe develop` instead; nothing procedural buys a higher
  // ceiling here.
  //
  // `train` got 2150 (2026-09-27): like develop it concatenates the worktree paragraph, and its
  // own text is a contract too, the owner's swipe verdicts: predict and show only misses, no
  // rule per round, a confirm-gated write, the automation's playbook route. The card SHAPES
  // stay in the surface briefing; nothing here re-explains them.
  const BRIEFING_CEILING: Record<string, number> = { plan: 2520, develop: 3200, train: 2150, assistant: 3200 };
  const DEFAULT_CEILING = 1600;

  it('keeps every briefing short — it rides in the system prompt of every turn', () => {
    for (const mode of CHAT_MODES) {
      for (const worktreeAllowed of [true, false]) {
        expect(modeBriefing(mode, { worktreeAllowed }).length,
          `${mode} (worktreeAllowed=${worktreeAllowed})`)
          .toBeLessThan(BRIEFING_CEILING[mode] ?? DEFAULT_CEILING);
      }
    }
  });
});

// ── worktreeIsolationAllowed — criterion 18's four combinations ────────────────────────
//
// (brain isolated?) × (linked repo present?). Only the top-left cell forbids a worktree:
//
//                        no linked repo      linked repo present
//   brain in-tree            FORBID                 ALLOW
//   brain full-repo          ALLOW                  ALLOW

const LINKED_URL = 'https://github.com/acme/product.git';
const roots: string[] = [];

/** A project root with the given brain mode, plus an optional linked-repo config entry. */
function makeProject(brainMode: 'in-tree' | 'full-repo' | null, linked: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-worktree-gate-proj-'));
  roots.push(root);
  mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
  const config: Record<string, unknown> = { platforms: [], packs: [], setupVersion: '1' };
  if (brainMode) config.brainRepo = { mode: brainMode, enabled: brainMode === 'full-repo' };
  if (linked) config.linkedRepos = [{ name: 'product', gitRemoteUrl: LINKED_URL }];
  writeFileSync(join(root, '_dream_context', 'state', '.config.json'), JSON.stringify(config));
  return root;
}

/** A scratch HOME whose linked-repo registry maps LINKED_URL to a path that does/doesn't
 *  exist. The canonical key is computed with the SAME helper the resolver uses, so the
 *  fixture can't drift from the lookup. */
function makeHome(present: boolean): string {
  const home = mkdtempSync(join(tmpdir(), 'dc-worktree-gate-home-'));
  roots.push(home);
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  const checkout = join(home, 'code', 'product');
  if (present) mkdirSync(checkout, { recursive: true });
  const key = canonicalRemote(LINKED_URL) ?? LINKED_URL;
  writeFileSync(linkedReposFilePath(home), JSON.stringify({ repos: { [key]: checkout } }));
  return home;
}

let homeWithRepo: string;
let homeWithoutRepo: string;

beforeAll(() => {
  homeWithRepo = makeHome(true);
  homeWithoutRepo = makeHome(false);
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('worktreeIsolationAllowed (criterion 18 — all four combinations)', () => {
  it('in-tree brain + no linked repo → FORBIDDEN (the default layout: a worktree forks the brain)', () => {
    expect(worktreeIsolationAllowed(makeProject('in-tree', false), homeWithoutRepo)).toBe(false);
  });

  it('full-repo brain + no linked repo → allowed (the brain is its own repo)', () => {
    expect(worktreeIsolationAllowed(makeProject('full-repo', false), homeWithoutRepo)).toBe(true);
  });

  it('in-tree brain + linked repo present → allowed (the code has no brain of its own)', () => {
    expect(worktreeIsolationAllowed(makeProject('in-tree', true), homeWithRepo)).toBe(true);
  });

  it('full-repo brain + linked repo present → allowed', () => {
    expect(worktreeIsolationAllowed(makeProject('full-repo', true), homeWithRepo)).toBe(true);
  });

  it('a CONFIGURED linked repo that is not on THIS machine does not count', () => {
    // The shared config travels with the team; the local path registry does not. A teammate's
    // linked checkout must not unlock worktrees on a machine that never cloned it.
    expect(worktreeIsolationAllowed(makeProject('in-tree', true), homeWithoutRepo)).toBe(false);
  });

  it('no config at all → FORBIDDEN (absent brainRepo means in-tree, the safe default)', () => {
    const bare = mkdtempSync(join(tmpdir(), 'dc-worktree-gate-bare-'));
    roots.push(bare);
    expect(worktreeIsolationAllowed(bare, homeWithoutRepo)).toBe(false);
  });

  it('a corrupt config degrades to FORBIDDEN rather than throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-worktree-gate-bad-'));
    roots.push(root);
    mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(root, '_dream_context', 'state', '.config.json'), '{not json');
    expect(() => worktreeIsolationAllowed(root, homeWithoutRepo)).not.toThrow();
    expect(worktreeIsolationAllowed(root, homeWithoutRepo)).toBe(false);
  });
});
