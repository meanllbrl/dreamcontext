/**
 * The Develop run recipe (src/lib/develop-recipe.ts), printed by
 * `dreamcontext goal-live recipe develop`. The Develop briefing carries only the contract and
 * sends the lead here, so these lines ARE the procedure. Each assertion pins a rule a plan
 * review paid for (task develop-mode-runs-like-goal-skill-…, R4-R11); a wording change that
 * keeps the rule passes, a change that drops it fails.
 */
import { describe, it, expect } from 'vitest';
import { DEVELOP_RECIPE as R } from '../../src/lib/develop-recipe.js';

const lines = R.split('\n');
const goalLiveLines = lines.filter((l) => /dreamcontext goal-live\b|(?:^|\s|`)goal-live (?:actor|state|phase|start|clear)\b/.test(l));

describe('the builder spawn (R6)', () => {
  const UNSETS = '-u DREAMCONTEXT_TAB_SESSION -u DREAMCONTEXT_SERVER_PID -u DREAMCONTEXT_DEVELOP_LEAD -u CLAUDE_CODE_SESSION_ID -u DREAMCONTEXT_DEFERRED_PROMPT';
  const SPAWNED = 'DREAMCONTEXT_SPAWNED=develop';
  // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 (2026-10-04): without it a check that hits the Bash
  // timeout is moved to the background of a session about to exit, and the builder ends
  // "waiting" with no report. Asserted on every spawn AND resume line.
  const NO_BG = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1';
  const STRIP = `env ${UNSETS} ${SPAWNED} ${NO_BG} nohup claude -p`;

  it('every claude -p a builder runs under carries the full env strip', () => {
    const spawns = lines.filter((l) => /claude -p/.test(l) && !/^\s*BUILDER:|"You are/.test(l));
    expect(spawns.length).toBeGreaterThanOrEqual(2); // spawn + resume
    // The account words ("$@", resume only) come right after the -u flags and BEFORE the
    // DREAMCONTEXT_SPAWNED assignment: "$@" may be `-u CLAUDE_CONFIG_DIR`, and env runs
    // everything after a NAME=value as the command, so a -u after an assignment would exec "-u".
    // DREAMCONTEXT_SPAWNED=develop is what keeps the builder out of sleep debt and directives
    // from its first SessionStart, before its goal-live registration exists.
    for (const l of spawns) expect(l, l).toMatch(new RegExp(`\\benv ${UNSETS} (?:"\\$@" )?${SPAWNED} ${NO_BG} nohup claude -p`));
  });

  it('the spawn template: session id, opus, acceptEdits, Write/Edit/Bash allowed, json, log + $! pid', () => {
    const spawn = lines.find((l) => l.includes(STRIP) && l.includes('--session-id'))!;
    expect(spawn).toBeTruthy();
    expect(spawn).toContain('--session-id "$SID"');
    expect(spawn).toContain('--model opus');
    expect(spawn).toContain('--permission-mode acceptEdits');
    const allowed = /--allowedTools "([^"]+)"/.exec(spawn)![1].split(/[ ,]+/);
    for (const t of ['Write', 'Edit', 'Bash']) expect(allowed).toContain(t);
    expect(spawn).toContain('--output-format json');
    expect(spawn).toMatch(/> "[^"]+\.log" 2>&1 &$/);
    expect(R).toMatch(/PID=\$!/);
    // The RAW config dir is recorded: '-' when unset. Recording $HOME/.claude and setting it on
    // a resume would relocate ~/.claude.json and lose the primary account's login
    // (accountEnvFor, src/lib/claude-accounts.ts).
    expect(R).toContain('CFG="${CLAUDE_CONFIG_DIR:--}"');
    expect(R).not.toContain('CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"');
  });

  it('never starts a builder with run_in_background', () => {
    const mentions = lines.filter((l) => l.includes('run_in_background'));
    expect(mentions.length).toBeGreaterThan(0);
    for (const l of mentions) expect(l).toMatch(/Never|never/);
  });

  it('builders are told never to call goal-live', () => {
    expect(R).toMatch(/Builders never call goal-live/);
    expect(R).toMatch(/BUILDER:[\s\S]*Never call dreamcontext goal-live/);
    expect(R).toMatch(/files changed:/);
  });
});

describe('the registry and liveness (R7)', () => {
  it('every lifecycle line carries sid, pid and cfg', () => {
    for (const kind of ['spawned', 'resumed', 'respawned']) {
      expect(R, kind).toMatch(new RegExp(`wN-L ${kind} sid \\S+ pid \\S+ cfg \\S+`));
    }
    const logged = lines.filter((l) => /tasks log "\$S" "wN-L (?:spawned|resumed)/.test(l));
    expect(logged.length).toBe(2);
    for (const l of logged) expect(l).toMatch(/sid \$SID pid \$(?:PID|!) cfg \$(?:CFG|cfg)/);
  });

  it('liveness: kill -0 plus the sid in ps; a live builder is waited on, never resumed', () => {
    expect(R).toContain('kill -0 $PID');
    expect(R).toContain('ps -p $PID -o command=');
    expect(R).toMatch(/WAITED on, never resumed/);
  });

  it('progress is the transcript found by find under the lane\'s RECORDED cfg, with etime before it exists', () => {
    expect(R).toContain('CFGDIR="$cfg"; [ "$CFGDIR" = "-" ] && CFGDIR="$HOME/.claude"');
    expect(R).toContain('find "$CFGDIR/projects" -maxdepth 2 -name "$SID.jsonl"');
    expect(R).toMatch(/RECORDED cfg/);
    expect(R).toContain('ps -p $PID -o etime=');
    expect(R).toMatch(/Never judge by the \.log/);
    expect(R).toMatch(/20 min/);
    // A resume runs under the lane's own config dir, and UNSETS it for the primary account.
    // `set --`, never a string variable: zsh does not word-split it, and `env "-u X"` unsets nothing.
    expect(R).toContain('if [ "$cfg" = "-" ]; then set -- -u CLAUDE_CONFIG_DIR; else set -- CLAUDE_CONFIG_DIR="$cfg"; fi');
    expect(R).not.toMatch(/env \$ACCT/);
    expect(R).not.toMatch(/CLAUDE_CONFIG_DIR="\$cfg" env/);
  });
});

describe('the per-wave snapshot and scope (R4)', () => {
  it('seeds a task-keyed index in the git dir from the real index, then writes a tree', () => {
    expect(R).toContain('IDX="$(git rev-parse --absolute-git-dir)/dc-$S-wN.idx"');
    expect(R).toContain('REAL="$(git rev-parse --git-path index)"');
    expect(R).toContain('[ -f "$REAL" ] && cp "$REAL" "$IDX"');
    expect(R).toContain('GIT_INDEX_FILE="$IDX" git add -A && GIT_INDEX_FILE="$IDX" git write-tree');
  });

  it('logs the base for a reopened lead, and diffs trees NUL-separated with quotePath off', () => {
    expect(R).toContain('dreamcontext tasks log "$S" "wN base $BASE"');
    expect(R).toContain('git -c core.quotePath=false diff-tree -r -z --name-status "$BASE" "$NOW"');
  });

  it('classifies collisions and unclaimed paths; the last reviewer gets the union by name', () => {
    expect(R).toMatch(/COLLISION/);
    expect(R).toMatch(/unclaimed/);
    expect(R).toMatch(/tell the owner once/);
    expect(R).toMatch(/union of\s+every wave's scope, enumerated by name/);
    expect(R).toMatch(/never a bare `git diff`/);
    expect(R).toMatch(/status A are new: read them whole/);
    expect(R).toMatch(/fetches its own changes; never paste a diff/);
  });

  it('the earlier wave\'s builders must be gone before a base is taken', () => {
    expect(R).toMatch(/no builder of an earlier wave is alive/);
  });
});

describe('goal-live call discipline (R11, R1, R10)', () => {
  it('every goal-live command ends in || true and nothing is chained after it with &&', () => {
    const commands = lines.filter((l) => /^\s+dreamcontext goal-live /.test(l));
    expect(commands.length).toBeGreaterThanOrEqual(8);
    for (const l of commands) {
      expect(l, l).toMatch(/\|\| true\s*$/);
      expect(l.slice(l.indexOf('goal-live')), l).not.toContain('&&');
    }
    for (const l of goalLiveLines) expect(l.slice(l.indexOf('goal-live')), l).not.toContain('&&');
  });

  it('every wave-qualified actor names both --role and --wave', () => {
    const actors = goalLiveLines.filter((l) => /goal-live actor w[NM0-9]+-/.test(l));
    expect(actors.length).toBeGreaterThanOrEqual(4);
    for (const l of actors) {
      expect(l, l).toMatch(/--role (?:implementer|reviewer)/);
      expect(l, l).toMatch(/--wave [NM0-9]/);
    }
  });

  it('never enters impl or codereview after validate', () => {
    const at = R.indexOf('goal-live phase validate');
    expect(at).toBeGreaterThan(0);
    expect(R.slice(at)).not.toMatch(/goal-live phase (?:impl|codereview)/);
    expect(R).toMatch(/the phase STAYS validate/);
    expect(R).toContain('final-fix-reviewer');
  });

  it('a review FAIL re-enters impl and codereview for that wave, so the retry is a round on the map', () => {
    const fail = R.slice(R.indexOf('FAIL: re-enter the build'));
    expect(fail).toBeTruthy();
    const impl = fail.indexOf('dreamcontext goal-live phase impl --wave N || true');
    const review = fail.indexOf('dreamcontext goal-live phase codereview --wave N || true');
    const reviewer = fail.indexOf('goal-live actor wN-reviewer --kind fresh --role reviewer --wave N --round 2');
    expect(impl).toBeGreaterThan(0);
    expect(review).toBeGreaterThan(impl);
    expect(reviewer).toBeGreaterThan(review);
  });

  it('says each Bash call is a fresh shell, and how values cross calls', () => {
    expect(R).toMatch(/EACH BASH CALL IS A FRESH SHELL/);
    expect(R).toMatch(/pasting the literal value printed earlier|reading it back from the task log/);
  });

  it('a verdict is recorded before the next phase', () => {
    expect(R).toMatch(/Record the verdict BEFORE the next phase/);
    expect(R).toContain('dreamcontext goal-live state wN-reviewer=PASS --wave N || true');
  });
});

describe('reopen, the wave map and the validator (R8, R10)', () => {
  it('start --mode develop adopts; a wave-map mismatch starts fresh', () => {
    expect(R).toContain('dreamcontext goal-live start --goal "$S" --mode develop || true');
    expect(R).toMatch(/ADOPTS/);
    expect(R).toMatch(/impl\.waves differs from the task's wave map, start fresh/);
  });

  it('the mid-fix reopen rule: never re-validate an unreviewed fix', () => {
    expect(R).toMatch(/validator FAIL newer than any\s+final-fix-reviewer PASS/);
    expect(R).toMatch(/never re-validate an unreviewed fix/);
  });

  it('the wave map: max 3 lanes, disjoint files, a Plan-mode map used unchanged', () => {
    expect(R).toMatch(/at most 3 lanes a wave/);
    expect(R).toMatch(/DISJOINT files/);
    expect(R).toMatch(/used\s+unchanged/);
  });

  it('every validator verdict is also a task-log line', () => {
    expect(R).toContain('"validator PASS"');
    expect(R).toContain('"validator FAIL -> wM-L"');
  });
});
