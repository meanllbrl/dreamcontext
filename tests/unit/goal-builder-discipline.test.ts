import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAN_OUT_RECIPE, GOAL_LIVE_RECIPES } from '../../src/lib/develop-recipe.js';
import { BUILDER_BRIEF, NO_CHECK_BUILDER_RULES } from '../../src/lib/builder-brief.js';
import { BUILDER_NO_BACKGROUND_ENV } from '../../src/lib/builder-tools.js';
import { modeBriefing } from '../../src/server/chat-modes.js';
import { PLANNER_BRIEF, USER_FACING_PLAN_RULES } from '../../src/lib/planner-brief.js';

/**
 * How a `claude -p` builder runs its checks, how it ends, and who runs the heavy steps.
 *
 * Paid for on 2026-10-04 (/tmp/goal-wb-agent): two builders hit the Bash tool's 600 s timeout
 * under load, the tool MOVED the check to the background, and each ended its turn on "Waiting
 * for the full unit suite…" / "Type-checks are still running". In `claude -p` the process exits
 * with the turn, so the notification never came: each looked hung for ~39 min, then closed
 * `success` with no report, leaving its type-checker running. Meanwhile three builders each ran
 * the full suite and both type-checks at once: load 50-107 on 8 cores, and an integration
 * suite that is 42/42 on a quiet machine went red on 29 timeouts.
 *
 * The fix lives in several carriers that must agree: the printed builder brief (all a `-p`
 * builder ever reads), the implementer agent file, the goal-skill orchestrator (spawn env,
 * sentinel check, gate policy, load check) and Develop mode's recipe + briefing. The tools
 * themselves (`dreamcontext builder load|heavy|report`) are tested in builder-tools.test.ts.
 */

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf-8');
const SKILL = read('skill-packs', 'goal-skill', 'SKILL.md');
const IMPL = read('skill-packs', 'agents', 'goal-implementer.md');
const PLANNER = read('skill-packs', 'agents', 'goal-planner.md');
const PLAN_REVIEWER = read('skill-packs', 'agents', 'goal-plan-reviewer.md');

/**
 * A section of a markdown file, from its heading to the next heading of the same level. A
 * missing heading yields '' instead of throwing, so each test reports its own failure instead
 * of the whole file failing to collect.
 */
function section(doc: string, heading: string): string {
  const at = doc.indexOf(heading);
  if (at === -1) return '';
  const level = heading.match(/^#+/)![0];
  const next = doc.indexOf(`\n${level} `, at + heading.length);
  return doc.slice(at, next === -1 ? undefined : next);
}

/** Every `claude -p` command in a text, joined across `\` continuations. */
function claudeCommands(text: string): string[] {
  return text.replace(/\\\n\s*/g, ' ').split('\n').filter((l) => /\bclaude -p\b/.test(l) && !/^\s*[|>-]/.test(l));
}

const SENTINEL = '## <TaskId> report';
const NO_BACKGROUND = [/run_in_background/, /no (trailing )?`?&`?[,)]/, /nohup/, /Monitor/];
const NOT_YOURS = [/full\s+(unit\s+)?suite/, /build/, /compiled/, /generator|gen:\*/];
const WRITE_FLAGS = '--permission-mode acceptEdits --allowedTools "Write" "Edit" "Bash"';

describe('the builder brief: printed from the CLI, the only thing a -p builder reads', () => {
  it('is a goal-live recipe', () => {
    expect(GOAL_LIVE_RECIPES['builder-brief']).toBe(BUILDER_BRIEF);
  });

  // 2026-10-11 evening: every builder, goal-skill's too, writes its tests and runs none; the
  // orchestrator runs one `builder test` per wave. The hand-run heavy-locked checks are retired.
  it('the no-check rules: write the tests, run none of them, never background, report what is outside', () => {
    expect(NO_CHECK_BUILDER_RULES).toMatch(/Write the tests for the code you write/);
    expect(NO_CHECK_BUILDER_RULES).toMatch(/run\s+none of them: no test runner, no type-check, no build/);
    expect(NO_CHECK_BUILDER_RULES).toMatch(/The lead or orchestrator\s+that started you runs one type-check and test pass for the whole wave/);
    for (const re of NO_BACKGROUND.slice(0, 3)) expect(NO_CHECK_BUILDER_RULES).toMatch(re);
    expect(NO_CHECK_BUILDER_RULES).toMatch(/never end your turn "waiting"/);
    expect(NO_CHECK_BUILDER_RULES).toMatch(/outside your files is reported,\s+never fixed/);
  });

  it('the goal-skill brief carries the no-check rules and ends on the sentinel', () => {
    expect(BUILDER_BRIEF).toContain(NO_CHECK_BUILDER_RULES);
    expect(BUILDER_BRIEF).toContain(`Your final message starts with the exact heading \`${SENTINEL}\``);
    expect(BUILDER_BRIEF).toMatch(/You are NO LONGER the planner/);
    expect(BUILDER_BRIEF).toMatch(/never call dreamcontext goal-live/);
    expect(BUILDER_BRIEF).toMatch(/In an EXECUTION: lead run you build every wave in turn/);
    // The retired hand-run checks do not creep back.
    expect(BUILDER_BRIEF).not.toMatch(/builder heavy --/);
    expect(BUILDER_BRIEF).not.toMatch(/Your checks:/);
  });

  it('it names no repo-specific command: a skill pack ships to every project', () => {
    for (const word of ['dashboard', 'build:cli', 'gen:cli-manifest', 'npx tsc']) expect(BUILDER_BRIEF).not.toContain(word);
  });
});

describe('goal-skill: every builder runs without background tasks, with its write flags', () => {
  const builderLines = claudeCommands(SKILL).filter((l) => /--fork-session|--resume <implId>/.test(l));

  it('the extractor finds the fork, the live-snippet forks and the sentinel resume', () => {
    expect(builderLines.length).toBeGreaterThanOrEqual(3);
  });

  it('each one is spawned with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 and the write flags', () => {
    for (const l of builderLines) {
      const runs = l.split(/ & (?=CLAUDE_CODE|claude)/);
      for (const r of runs) {
        expect(r, r).toContain(BUILDER_NO_BACKGROUND_ENV);
        expect(r, r).toContain(WRITE_FLAGS);
        expect(r, r).toMatch(/> "\$RUN\/[^"]+\.json"/);
      }
    }
  });

  it('one identity for the whole lineage: planner, forks and resumes all run opus at effort high', () => {
    expect(SKILL).not.toMatch(/--model sonnet/);
    expect(SKILL).not.toMatch(/<tier-model>/);
    for (const l of builderLines) for (const r of l.split(/ & (?=CLAUDE_CODE|claude)/)) expect(r, r).toContain('--model opus --effort high');
    const plannerLines = claudeCommands(SKILL).filter((l) => /--session-id <plannerId>|--resume <plannerId> "/.test(l));
    for (const l of plannerLines) {
      expect(l, l).toContain('--model opus --effort high');
      expect(l, l).toContain(BUILDER_NO_BACKGROUND_ENV);
    }
    expect(SKILL).toMatch(/\*\*One identity for the whole lineage, always\.\*\*/);
    // A fork does not "keep the planner's settings" by itself: effort comes from the flag.
    for (const doc of [SKILL, IMPL, PLANNER]) expect(doc).not.toMatch(/keeps? the planner's settings/);
    expect(IMPL).toMatch(/`--model opus --effort high`, passed on every fork and resume/);
    expect(PLANNER).toMatch(/ONE identity, `--model opus --effort high`/);
  });

  it('rule 3b: an implementer resume (next wave, every FAIL route) carries the write flags and a message file', () => {
    const mechanics = section(SKILL, '### Builder session mechanics');
    const r3b = mechanics.slice(mechanics.indexOf('3b. **Resume an implementer**'), mechanics.indexOf('4. **Re-fork'));
    expect(r3b).toContain('claude -p --resume <implId> "$(cat "$RUN/<TaskId>-r<N>.md")"');
    expect(r3b).toContain(WRITE_FLAGS);
    expect(r3b).toMatch(/the next wave of an `EXECUTION: lead` run, and every FAIL\s+route/);
    const phase4 = section(SKILL, '### Phase 4');
    expect(phase4).toMatch(/next wave \("Build wave N: <criteria, files>", mechanics rule 3b\)/);
    expect(phase4).toMatch(/`--resume` \(mechanics rule 3b\) on the \*\*specific owning implementer\*\*/);
    expect(section(SKILL, '### Phase 5')).toMatch(/\(mechanics rule 3b\)/);
    expect(section(SKILL, '### Phase 6')).toMatch(/\(mechanics\s+rule 3b\)/);
  });

  it('the planner never gets write flags', () => {
    const plannerLines = claudeCommands(SKILL).filter((l) => /--session-id <plannerId>|--resume <plannerId> "/.test(l));
    expect(plannerLines.length).toBeGreaterThanOrEqual(2);
    for (const l of plannerLines) expect(l, l).not.toContain('--permission-mode');
  });

  it('the fork prompt is the printed brief read from a file, never retyped', () => {
    expect(SKILL).toContain('"$(cat "$RUN/brief-<TaskId>.md")"');
    expect(SKILL).toMatch(/`dreamcontext goal-live recipe builder-brief`/);
    expect(SKILL).toMatch(/Never retype it/);
  });
});

describe('goal-skill: the orchestrator asks every exiting builder whether it reported', () => {
  const mechanics = section(SKILL, '### Builder session mechanics');
  const rule6 = mechanics.slice(mechanics.indexOf('6. **Check the report sentinel'));

  it('rule 6 runs dreamcontext builder report on the run\'s own output', () => {
    expect(rule6).toContain('dreamcontext builder report "$RUN/<TaskId>-r<N>.json" <TaskId>');
    for (const v of ['reported', 'unfinished', 'stopped', 'missing']) expect(rule6).toContain(`**\`${v}\`**`);
  });

  it('unfinished → ONE resume with the fork\'s flags; a usage limit is a pause', () => {
    expect(rule6).toMatch(/Resume it ONCE, with the same flags it was forked\s+with/);
    expect(rule6).toContain('"Finish what you were building and write your final report now."');
    expect(rule6).toMatch(/usage limit is a pause/);
  });

  it('a second miss is bounded: one builder test on its files, re-fork once, then escalate', () => {
    expect(rule6).toMatch(/\*\*Second miss, then escalate\.\*\*/);
    expect(rule6).toMatch(/ONE `dreamcontext builder test <slug> --wave N --related\s+<its owned files>`/);
    expect(rule6).not.toMatch(/builder\s+heavy/);
    expect(rule6).toMatch(/re-fork it once from the planner with the exact FAIL lines/);
    expect(rule6).toMatch(/in a lead run\s+the re-fork's brief is the current wave, and it replaces `impl` in the registry/);
    expect(rule6).toMatch(/ESCALATE to the user/);
  });

  it('the on-disk check still follows the sentinel', () => {
    expect(rule6).toMatch(/rule 5 \(`git status --porcelain`/);
  });
});

describe('goal-skill: light wave gates, one heavy final gate, nothing run twice', () => {
  const phase4 = section(SKILL, '### Phase 4');
  const FINAL_GATE = [/full unit suite/, /`build` \/ `build:cli`/, /integration suite/, /`gen:\*`/, /gen:cli-manifest/, /browser verification/];

  it('no line anywhere still promises a build+test gate between waves', () => {
    expect(SKILL).not.toMatch(/build\s*\+\s*test gate/i);
  });

  it('the wave gate is type-checks + the wave\'s tests, run once by the orchestrator through the lock', () => {
    expect(phase4).toMatch(/\*\*Wave gate = the type-checks \+ this wave's tests, run once by you\.\*\*/);
    expect(phase4).toContain('dreamcontext builder test <slug> --wave N --related <every path the wave changed>');
    expect(phase4).toMatch(/with exactly its FAIL lines/);
    expect(phase4).toContain('builder test <slug> --wave N --failed --related <files the fix changed>');
  });

  it('the final gate lists every heavy step, after the last wave and before Phase 5', () => {
    const heavy = phase4.slice(phase4.indexOf('**Heavy steps run once, at the final gate**'));
    expect(heavy).toMatch(/after the last wave and before Phase 5/);
    for (const re of FINAL_GATE) expect(heavy).toMatch(re);
  });

  it('never twice: the final gate builds before what needs the build, Phase 6 cites it instead of re-running', () => {
    expect(phase4).toMatch(/\*\*Never twice\.\*\* The final gate runs every heavy step the change needs, in dependency\s+order/);
    expect(phase4).toMatch(/the build first whenever integration tests or a browser check need compiled\s+output/);
    expect(phase4).toMatch(/cited from the final gate's logged\s+command and output/);
    expect(phase4).not.toMatch(/left to Phase 6/);
    expect(section(SKILL, '## Hard rules')).toMatch(/the build before anything that needs compiled output/);
    expect(section(SKILL, '### Phase 6')).toMatch(/cite that logged run instead of running it again/);
  });

  it('only a planner-marked compiled artifact pulls a build forward', () => {
    expect(SKILL).toMatch(/\*\*Compiled artifacts marked\.\*\*/);
    expect(phase4).toMatch(/marked with a compiled artifact/);
  });

  it('the flow diagram draws both gates', () => {
    const flow = SKILL.slice(SKILL.indexOf('```mermaid'), SKILL.indexOf('```', SKILL.indexOf('```mermaid') + 3));
    expect(flow).toMatch(/GATE\{wave gate, orchestrator once: type-checks \+ the wave's tests\}/);
    expect(flow).toMatch(/FG\{final gate, once, load below cores: full suite, build, integration, generators, browser\}/);
    expect(flow).toMatch(/FG -->\|PASS\| P5/);
  });

  it('the hard rules agree', () => {
    const hard = section(SKILL, '## Hard rules');
    expect(hard).toMatch(/per-wave gates are the\s+type-checks \+ the wave's tests/);
    expect(hard).toMatch(/\*\*Heavy steps run once, at the final gate\*\*/);
    expect(hard).toContain(BUILDER_NO_BACKGROUND_ENV);
    expect(hard).toContain(SENTINEL);
  });
});

describe('goal-skill: load-aware waves, orphans reaped, a bounded wait for quiet', () => {
  const phase4 = section(SKILL, '### Phase 4');
  const phase6 = section(SKILL, '### Phase 6');

  it('checks the load with the CLI, not a locale-sensitive uptime parse', () => {
    expect(phase4).toContain('dreamcontext builder load --reap');
    expect(SKILL).not.toMatch(/sysctl -n hw\.ncpu/);
    expect(SKILL).not.toMatch(/awk -F'load averages/);
  });

  it('quiet → every lane of a fan-out wave at once; busy → 2 builders at a time; no fixed cap of 3', () => {
    expect(phase4).toMatch(/`quiet` = start every lane of a fan-out wave at once/);
    expect(phase4).toMatch(/`busy` = \*\*2 builders at a time\*\*/);
    expect(SKILL).not.toMatch(/Max ~?3 concurrent implementers/);
  });

  it('waits for quiet at most 15 minutes, then runs throttled and records the load', () => {
    expect(phase4).toMatch(/for at most 15 minutes/);
    expect(phase4).toMatch(/run it anyway, through the heavy lock with at most 2 test workers/);
    expect(phase4).toMatch(/record the load line next to the results/);
    expect(phase4).toMatch(/timeout under load is\s+not "the code is broken"/);
  });

  it('the validator is dispatched after the same load check', () => {
    expect(phase6).toMatch(/Run `dreamcontext builder load --reap` first and dispatch on `quiet`/);
  });

  it('a command method is run once by the orchestrator; the validator drives manual and browser checks', () => {
    expect(phase6).toMatch(/\*\*A command\*\* \(a test suite, a build, a script\): run it yourself, ONCE/);
    expect(phase6).toMatch(/The command's\s+real output IS the evidence/);
    expect(phase6).toMatch(/\*\*Manual, or Browser \(jev-verify\)\*\*: dispatch \*\*one\*\* `goal-validator` \(opus, clean\s+context\)/);
    expect(phase6).toMatch(/screenshots and a video of the\s+flow/);
  });
});

describe('goal-implementer: the agent file says what the brief says', () => {
  const cli = section(IMPL, '## Running as a CLI builder session');
  const output = section(IMPL, '## Output');

  it('forbids every way of backgrounding anything', () => {
    for (const re of NO_BACKGROUND) expect(cli).toMatch(re);
    expect(cli).toContain(BUILDER_NO_BACKGROUND_ENV);
  });

  it('never ends its turn "waiting"', () => {
    expect(cli).toMatch(/Your turn never ends "waiting"/);
    expect(cli).toMatch(/FAILED run/);
  });

  it('runs no checks: it writes its tests, the orchestrator\'s builder test runs them', () => {
    expect(cli).toMatch(/\*\*Checks are not yours\.\*\*/);
    expect(cli).toMatch(/run none of them: no test runner, no type-check, no build/);
    expect(cli).toContain('`dreamcontext builder test`');
    expect(cli).not.toMatch(/builder heavy --/);
    const notYours = cli.slice(cli.indexOf('**Not yours'));
    for (const re of NOT_YOURS) expect(notYours).toMatch(re);
  });

  it('in a lead run it is the one implementer, resumed wave by wave, on opus', () => {
    expect(cli).toMatch(/In an `EXECUTION: lead` run you are the only implementer/);
    expect(cli).toMatch(/each later wave arrives as a resume/);
    expect(IMPL).toMatch(/^model: opus$/m);
  });

  it('starts its final message with the sentinel heading', () => {
    expect(output).toContain(`**starts with the exact heading \`${SENTINEL}\`**`);
  });

  it('no longer waits on a "build+test" gate', () => {
    expect(IMPL).not.toMatch(/build\s*\+\s*test/i);
  });
});

describe('Develop fan-out (opt-in since 2026-10-11): builders run no checks, the lead checks once per wave', () => {
  it('the briefing\'s wave check is type-checks + the wave\'s tests, heavy steps once at the end', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).not.toMatch(/build\s*\+\s*test/i);
    expect(brief).toMatch(/the type-checks \+\s+that wave's tests/);
    expect(brief).toMatch(/builds and generators run once,\s+at the end/);
  });

  it('its builder brief carries the no-check rules verbatim and the sentinel', () => {
    const builder = FAN_OUT_RECIPE.slice(FAN_OUT_RECIPE.indexOf('BUILDER: "'), FAN_OUT_RECIPE.indexOf('REVIEWER: "'));
    expect(builder).toContain(NO_CHECK_BUILDER_RULES);
    expect(builder).not.toMatch(/builder heavy -- <command>/);
    expect(builder).toMatch(/starts with the exact heading '## wN-L report'/);
    expect(builder).toMatch(/files changed:/);
    expect(builder).toMatch(/outside my files:/);
  });

  it('an exited builder that did not report is resumed once; wait says so', () => {
    expect(FAN_OUT_RECIPE).toContain('dreamcontext builder wait "$S"');
    expect(FAN_OUT_RECIPE).toMatch(/`unfinished` \(no report\) = resume it ONCE/);
  });

  it('load-aware waves, one check through the lock, the final check before closing', () => {
    expect(FAN_OUT_RECIPE).not.toMatch(/Build \+ test/);
    const wave = FAN_OUT_RECIPE.slice(FAN_OUT_RECIPE.indexOf('### 2c.'), FAN_OUT_RECIPE.indexOf('Per lane L'));
    expect(wave).toContain('dreamcontext builder load --reap');
    expect(wave).toMatch(/`busy` \(1-min load above the core count\) = 2 lanes at a time this wave/);
    expect(FAN_OUT_RECIPE).toMatch(/through\s+the heavy lock/);
    const final = FAN_OUT_RECIPE.slice(FAN_OUT_RECIPE.indexOf('## 3.'), FAN_OUT_RECIPE.indexOf('## 4.'));
    expect(final.indexOf('dreamcontext builder load --reap')).toBeGreaterThan(-1);
    expect(final.indexOf('dreamcontext builder load --reap')).toBeLessThan(final.indexOf('goal-live phase done'));
    expect(final).toMatch(/for at most 15 min/);
    expect(final).toMatch(/The\s+full suite runs only when the Validation method names it/);
  });
});

// ── One doctrine (owner, 2026-10-11 evening) ────────────────────────────────────────────────
// The plan decides how the work runs; only serious findings cost a review round; every
// builder is an Opus fork of the planner; Develop's description in this pack is current.
describe('goal-skill and its agents: the plan decides, severity bounds the review', () => {
  const phase1 = section(SKILL, '### Phase 1');
  const phase2 = section(SKILL, '### Phase 2');
  const phase4 = section(SKILL, '### Phase 4');

  it('the map opens with the EXECUTION line; lanes are disjoint file groups, no fixed count', () => {
    expect(phase1).toMatch(/The map opens with `EXECUTION: lead` \(the default: ONE\s+implementer builds the waves in order\)/);
    expect(phase1).toMatch(/`EXECUTION: fan-out: <why>`/);
    expect(phase1).toMatch(/\*\*Lanes are the truly disjoint file groups\*\* of a wave, with no fixed count/);
    expect(PLANNER).toMatch(/\*\*You decide how the work runs, so the map opens with one line:\*\*/);
    expect(PLANNER).toMatch(/`EXECUTION: lead` \(the default\)/);
    expect(PLANNER).not.toMatch(/sonnet for Medium/);
  });

  it('Phase 4 follows the line: ONE implementer resumed wave by wave, or one fork per lane', () => {
    expect(phase4).toMatch(/The map's `EXECUTION:` line decides how the waves are built; you never re-decide it/);
    expect(phase4).toMatch(/\*\*`EXECUTION: lead`\*\* \(and every S tier\): fork ONE implementer from the \*\*planner\*\*/);
    expect(phase4).toMatch(/`--resume` the same session with the\s+next wave/);
    expect(phase4).toMatch(/\*\*`EXECUTION: fan-out`\*\*: fork one implementer per lane of the wave from the planner, every\s+lane at once/);
    expect(phase4).toMatch(/\*\*Write the tests, run none of them\*\*/);
  });

  it('only Critical or Major findings block, with no fixed round cap; lenses are critic + security or edge-cases', () => {
    expect(phase2).toMatch(/\*\*Only a Critical or Major\s+finding blocks\*\*/);
    expect(phase2).toMatch(/a Minor never costs a round/);
    expect(phase2).toMatch(/No fixed round cap: a serious finding is never left open because rounds ran out/);
    expect(phase2).toMatch(/- \*\*critic\*\*/);
    expect(phase2).toMatch(/- \*\*edge-cases\*\* — L tier otherwise/);
    expect(phase2).not.toMatch(/\*\*pragmatist\*\*/);
    expect(section(SKILL, '## Convergence rules')).toMatch(/Only a Critical or Major finding is blocking; a Minor never costs a round/);
  });

  it('the plan reviewer carries the severity ladder and passes a plan whose open issues are small', () => {
    expect(PLAN_REVIEWER).toMatch(/## Severity: only Critical and Major block/);
    for (const level of ['**Critical**', '**Major**', '**Minor**', '**Nit**']) expect(PLAN_REVIEWER).toContain(level);
    expect(PLAN_REVIEWER).toMatch(/`NEEDS_WORK` needs at least one Critical or Major\. With none, the verdict is `SOLID`/);
    expect(PLAN_REVIEWER).toMatch(/an\s+`EXECUTION:` line that does not fit the work/);
    expect(PLAN_REVIEWER).toMatch(/repeat a finding that is still open in the same words/);
    expect(PLAN_REVIEWER).toMatch(/Never upgrade an old Minor to keep the loop going/);
    // A clean reviewer can only repeat a finding it is shown: from round 2 it gets its own.
    expect(PLAN_REVIEWER).toMatch(/from round 2, your own previous findings word for word/);
    expect(section(SKILL, '### Phase 2')).toMatch(/from round 2 its own\s+previous findings word for word/);
    expect(modeBriefing('plan', { worktreeAllowed: false })).toMatch(/from round 2, plus its own previous findings verbatim/);
    expect(PLAN_REVIEWER).toMatch(/\*\*edge-cases\*\* — Empty\/null inputs/);
  });

  it('describes Develop as it runs now: the lead builds, one end review, validator on request', () => {
    expect(SKILL).not.toMatch(/a clean reviewer after EVERY wave/);
    expect(SKILL).toMatch(/chat's lead builds each wave itself/);
    expect(SKILL).toMatch(/ONE\s+clean reviewer judges the whole change at the end/);
    expect(SKILL).toContain('dreamcontext goal-live recipe develop|fan-out|builder-brief');
  });
});

/**
 * 2026-10-13: a goal-skill run turned a mobile app into a web app; every judge passed it and
 * the owner opened it to console errors and a PWA that was not responsive. No criterion asked
 * for either: the goal sentence did not say it, the critic checked the stated criteria for
 * testability rather than looking for what was missing, and the planner, a `claude -p`
 * session, had never loaded the goal-planner agent file at all, since the orchestrator retyped
 * its brief. The rule now lives once (USER_FACING_PLAN_RULES) and reaches the planner through a
 * printed brief, the same way the builder rules reach builders.
 */
describe('the plan writes down what the owner will see', () => {
  it('the planner brief is a goal-live recipe and carries the rule', () => {
    expect(GOAL_LIVE_RECIPES['planner-brief']).toBe(PLANNER_BRIEF);
    expect(PLANNER_BRIEF).toContain(USER_FACING_PLAN_RULES);
    expect(PLANNER_BRIEF).toMatch(/never loads the\s+goal-planner agent file: this brief is all it sees/);
  });

  it('the rule: the first 30 seconds, the goal type expectations, an observed last criterion, design for UI', () => {
    expect(USER_FACING_PLAN_RULES).toMatch(/what will the owner notice in the first 30 seconds of opening the result\?/);
    expect(USER_FACING_PLAN_RULES).toMatch(/responsive at a phone \(390 px\) and a desktop \(1440 px\)/);
    expect(USER_FACING_PLAN_RULES).toMatch(/a PWA installs and launches/);
    expect(USER_FACING_PLAN_RULES).toMatch(/ends on an OBSERVED criterion/);
    expect(USER_FACING_PLAN_RULES).toMatch(/Green unit tests on an app that does not open are not\s+evidence/);
    expect(USER_FACING_PLAN_RULES).toMatch(/A goal with UI loads the `design` skill/);
  });

  it('the goal-planner agent file holds the same rule word for word (it cannot import it)', () => {
    expect(PLANNER).toContain(USER_FACING_PLAN_RULES);
  });

  it('goal-skill spawns the planner from the printed brief, never a retyped one', () => {
    const spawns = claudeCommands(SKILL).filter((l) => /--session-id <plannerId>/.test(l));
    expect(spawns.length).toBeGreaterThanOrEqual(2);
    for (const l of spawns) expect(l).toContain('"$(cat "$RUN/planner-brief.md")"');
    expect(SKILL).not.toContain('<goal + context>');
    expect(section(SKILL, '### Phase 1')).toMatch(/dreamcontext goal-live\s+recipe planner-brief/);
  });

  it('the critic looks for what is missing; the pragmatist never cuts it as YAGNI', () => {
    expect(PLAN_REVIEWER).toMatch(/\*\*what will the owner notice in the first 30 seconds of\s+opening the result, and which criterion covers it\?\*\*/);
    expect(PLAN_REVIEWER).toMatch(/Judge what is MISSING, not only\s+whether the stated criteria are testable/);
    expect(PLAN_REVIEWER).toMatch(/is an essential, never YAGNI: do not cut it/);
    const major = PLAN_REVIEWER.slice(PLAN_REVIEWER.indexOf('- **Major**'), PLAN_REVIEWER.indexOf('- **Minor**'));
    expect(major).toMatch(/something the owner will notice on first opening the result that no\s+criterion covers/);
    expect(major).toMatch(/a goal the\s+owner opens with no observed criterion/);
    expect(section(SKILL, '### Phase 2')).toMatch(/does a goal the\s+owner opens end on an observed one\?/);
  });

  it('goal-skill opens the result once, at the final gate, and Phase 6 cites it whatever the method', () => {
    const heavy = section(SKILL, '### Phase 4').slice(section(SKILL, '### Phase 4').indexOf('**Heavy steps run once'));
    expect(heavy).toMatch(/the \*\*observed check\*\* whenever a\s+criterion is about what the owner sees/);
    expect(heavy).toMatch(/phone \(390 px\) and a desktop \(1440 px\) width/);
    expect(heavy).toMatch(/a screenshot of each that you READ/);
    const phase6 = section(SKILL, '### Phase 6');
    expect(phase6).toMatch(/Whatever the method, an OBSERVED criterion/);
    expect(phase6).toMatch(/ticked from the final gate's observed check/);
    expect(phase6).toMatch(/you never open the app a second time on the same tree/);
    expect(phase6).toMatch(/adds its screenshots to that evidence, never replaces it/);
    expect(phase6).toMatch(/Green tests never tick it/);
    expect(section(SKILL, '## Hard rules')).toMatch(/\*\*No tick without evidence\.\*\*/);
  });
});
