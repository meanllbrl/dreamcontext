import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVELOP_RECIPE, GOAL_LIVE_RECIPES } from '../../src/lib/develop-recipe.js';
import { BUILDER_BRIEF, BUILDER_CHECK_RULES } from '../../src/lib/builder-brief.js';
import { BUILDER_NO_BACKGROUND_ENV } from '../../src/lib/builder-tools.js';
import { modeBriefing } from '../../src/server/chat-modes.js';

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

  it('rule 1: foreground with a timeout under the Bash cap, one check per call, nothing backgrounded', () => {
    expect(BUILDER_CHECK_RULES).toMatch(/foreground with an explicit timeout under\s+600000 ms/);
    for (const re of NO_BACKGROUND) expect(BUILDER_CHECK_RULES).toMatch(re);
    expect(BUILDER_CHECK_RULES).toMatch(/One check per Bash call/);
  });

  it('rule 2: never end with a check running; a moved-to-background check is polled, not abandoned', () => {
    expect(BUILDER_CHECK_RULES).toMatch(/Never end your turn while a check is still running/);
    expect(BUILDER_CHECK_RULES).toMatch(/"waiting for X"\s+is a failed run/);
    expect(BUILDER_CHECK_RULES).toMatch(/"was moved to the background", poll its\s+output file/);
    expect(BUILDER_CHECK_RULES).toMatch(/narrower scope, never the background/);
  });

  it('rule 3: the lane\'s checks only; the heavy steps are the orchestrator\'s', () => {
    expect(BUILDER_CHECK_RULES).toMatch(/the test files you wrote or changed, the existing tests of the\s+modules you touched, and the type-check of each package you touched/);
    const notYours = BUILDER_CHECK_RULES.slice(BUILDER_CHECK_RULES.indexOf('Never the full'));
    for (const re of NOT_YOURS) expect(notYours).toMatch(re);
    expect(notYours).toMatch(/once, at the final gate/);
  });

  it('rule 4: every type-check and test run through the heavy lock, 2 workers, exit 75 = run again', () => {
    expect(BUILDER_CHECK_RULES).toMatch(/`dreamcontext builder heavy -- <command>`/);
    expect(BUILDER_CHECK_RULES).toMatch(/--maxWorkers=2/);
    expect(BUILDER_CHECK_RULES).toMatch(/Exit 75 means the lock stayed busy and NOTHING ran: run it again/);
  });

  it('the goal-skill brief carries the rules and ends on the sentinel', () => {
    expect(BUILDER_BRIEF).toContain(BUILDER_CHECK_RULES);
    expect(BUILDER_BRIEF).toContain(`Your final message starts with the exact heading \`${SENTINEL}\``);
    expect(BUILDER_BRIEF).toMatch(/You are NO LONGER the planner/);
    expect(BUILDER_BRIEF).toMatch(/never call dreamcontext goal-live/);
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
    expect(rule6).toContain('"Run your pending checks in the foreground and write your final report."');
    expect(rule6).toMatch(/usage limit is a pause/);
  });

  it('a second miss is bounded: you run the lane\'s checks, re-fork once, then escalate', () => {
    expect(rule6).toMatch(/\*\*Second miss, then escalate\.\*\*/);
    expect(rule6).toMatch(/re-fork the lane once/);
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
    expect(phase4).toMatch(/each through `dreamcontext builder heavy`/);
  });

  it('the final gate lists every heavy step, after the last wave and before Phase 5', () => {
    const heavy = phase4.slice(phase4.indexOf('**Heavy steps run once, at the final gate**'));
    expect(heavy).toMatch(/after the last wave and before Phase 5/);
    for (const re of FINAL_GATE) expect(heavy).toMatch(re);
  });

  it('a step the validation method already runs is left to the validator', () => {
    expect(phase4).toMatch(/\*\*Never twice\.\*\*/);
    expect(phase4).toMatch(/left to the Phase 6\s+validator/);
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

  it('busy → 1-2 builders instead of 3', () => {
    expect(phase4).toMatch(/`busy` = run the wave with \*\*1–2 builders instead of 3\*\*/);
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
});

describe('goal-implementer: the agent file says what the brief says', () => {
  const cli = section(IMPL, '## Running as a CLI builder session');
  const output = section(IMPL, '## Output');

  it('forbids every way of backgrounding a check, one check per call', () => {
    for (const re of NO_BACKGROUND) expect(cli).toMatch(re);
    expect(cli).toMatch(/one check per Bash call/);
    expect(cli).toContain(BUILDER_NO_BACKGROUND_ENV);
  });

  it('never ends with a check running', () => {
    expect(cli).toMatch(/Your turn never ends before every check you started has finished/);
    expect(cli).toMatch(/FAILED run/);
  });

  it('scopes its checks to its lane and runs them through the heavy lock', () => {
    expect(cli).toMatch(/test files you wrote or changed/);
    expect(cli).toMatch(/existing tests of the modules you touched/);
    expect(cli).toMatch(/`dreamcontext builder heavy -- <command>`/);
    const notYours = cli.slice(cli.indexOf('**Not yours'));
    for (const re of NOT_YOURS) expect(notYours).toMatch(re);
  });

  it('starts its final message with the sentinel heading', () => {
    expect(output).toContain(`**starts with the exact heading \`${SENTINEL}\`**`);
  });

  it('no longer waits on a "build+test" gate', () => {
    expect(IMPL).not.toMatch(/build\s*\+\s*test/i);
  });
});

describe('Develop mode follows the same discipline', () => {
  it('the briefing\'s wave gate is type-checks + the wave\'s tests, heavy steps once at the end', () => {
    const brief = modeBriefing('develop', { worktreeAllowed: false });
    expect(brief).not.toMatch(/build\s*\+\s*test/i);
    expect(brief).toMatch(/type-checks \+ that wave's tests/);
    expect(brief).toMatch(/full suite, builds and generators run once, after\s+the last wave/);
  });

  it('its builder brief carries the shared check rules verbatim and the sentinel', () => {
    const builder = DEVELOP_RECIPE.slice(DEVELOP_RECIPE.indexOf('BUILDER: "'), DEVELOP_RECIPE.indexOf('REVIEWER: "'));
    expect(builder).toContain(BUILDER_CHECK_RULES);
    expect(builder).toMatch(/starts with the exact heading '## wN-L report'/);
    expect(builder).toMatch(/files changed:/);
  });

  it('the lead asks each exited builder whether it reported, and bounds the resume', () => {
    expect(DEVELOP_RECIPE).toContain('dreamcontext builder report "$ROOT/tmp/develop/$S/wN-L.log" wN-L');
    expect(DEVELOP_RECIPE).toMatch(/resume\s+it ONCE/);
    expect(DEVELOP_RECIPE).toMatch(/a second `unfinished` = run that lane's checks yourself/);
  });

  it('load-aware waves, a light gate through the lock, the final gate before the validator', () => {
    expect(DEVELOP_RECIPE).not.toMatch(/Build \+ test/);
    const wave = DEVELOP_RECIPE.slice(DEVELOP_RECIPE.indexOf('### 2b.'), DEVELOP_RECIPE.indexOf('Per lane L'));
    expect(wave).toContain('dreamcontext builder load --reap');
    expect(wave).toMatch(/at most 1-2 lanes at a time/);
    expect(DEVELOP_RECIPE).toMatch(/each through the heavy lock/);
    const final = DEVELOP_RECIPE.slice(DEVELOP_RECIPE.indexOf('## 3.'), DEVELOP_RECIPE.indexOf('## 4.'));
    expect(final.indexOf('dreamcontext builder load --reap')).toBeGreaterThan(-1);
    expect(final.indexOf('dreamcontext builder load --reap')).toBeLessThan(final.indexOf('goal-live phase validate'));
    expect(final).toMatch(/for at most 15 min/);
    expect(final).toMatch(/does NOT already run/);
  });
});
