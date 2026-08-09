import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, realpathSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { APPROVAL_DIFF_FIELDS } from '../../src/lib/automations/types.js';
import { unshareWarningLines } from '../../src/cli/commands/automations.js';

/**
 * `dreamcontext automations` CLI (integration). Spawns the real built CLI as
 * a subprocess — unlike the frozen unit suites (schedule/store/registry/
 * launchd/runner/tick), there is no way to inject a fake `spawnImpl`/`home`
 * across a real process boundary, so isolation has to happen at the
 * environment level instead. Every single invocation in this file goes
 * through `run()` below, which is the ONLY place that sets `HOME`.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

/**
 * A minimal, universally-present PATH that cannot resolve a real `claude`.
 * Verified during planning: on this machine `claude` resolves ONLY via
 * `~/.local/bin` (neither /opt/homebrew/bin, /usr/local/bin, nor node's own
 * bin dir have it) — so isolating $HOME already blinds `findClaudeBin()`'s
 * two HOME-relative candidate directories, and this additionally blinds the
 * runner's shell-fallback `exec claude "$@"` PATH lookup. Either way, a
 * `run --force` in this suite fails FAST and DETERMINISTICALLY (a shell
 * "command not found", or — if $SHELL itself doesn't resolve — a synchronous
 * ENOENT) with NO network call, no API cost, and no dependence on a live
 * authenticated `claude` being present wherever this suite happens to run.
 */
const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function makeTmpDir(prefix: string): string {
  const raw = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function makeProjectDir(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  return realpathSync(dir);
}

interface RunResult { stdout: string; exitCode: number }

/**
 * Spawn the real built CLI with an ISOLATED $HOME/$USERPROFILE and a
 * claude-blind $PATH. MANDATORY: a wave-4 gate failure was caused by exactly
 * a test omitting this and silently writing to the developer's real
 * ~/.dreamcontext/ — every CLI invocation in this file MUST go through this
 * one function, never a bare `exec*`.
 *
 * Uses `execFileSync(process.execPath, [CLI, ...args], ...)` — the exact
 * absolute node binary already running this test, invoked directly with an
 * argv array. Deliberately NOT `execSync`/a shell command string: a shell
 * would need to resolve `node` via `$PATH` too, which SAFE_PATH intentionally
 * strips (that's what keeps `claude` unreachable), and an argv array also
 * sidesteps shell-quoting entirely for arguments like `--title "EOD Digest"`.
 */
function run(args: string[], cwd: string, home: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 20_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: SAFE_PATH },
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    const stdout = (e.stdout ?? '') + (e.stderr ?? '');
    const exitCode = typeof e.status === 'number' ? e.status : 1;
    return { stdout, exitCode };
  }
}

describe('automations CLI (integration)', () => {
  // ── MANDATORY real-home non-interference proof ──────────────────────────
  // Snapshot the real machine's automations registry/heartbeat files BEFORE
  // any test in this file runs, and assert they are BYTE-FOR-BYTE untouched
  // after every test has run. This is the actual thing the task requires
  // proven — not merely assumed — because this suite spawns real CLI
  // subprocesses that would use the real $HOME by default.
  const realAutomationsJson = join(homedir(), '.dreamcontext', 'automations.json');
  const realHeartbeatJson = join(homedir(), '.dreamcontext', 'automations-tick.json');
  /** null ⇒ absent before this suite ran. Content, not just existence: the
   *  guarantee this block claims is BYTE-FOR-BYTE, so it has to compare bytes. */
  let realAutomationsJsonBefore: string | null;
  let realHeartbeatJsonBefore: string | null;

  const snapshot = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf-8') : null);

  beforeAll(() => {
    realAutomationsJsonBefore = snapshot(realAutomationsJson);
    realHeartbeatJsonBefore = snapshot(realHeartbeatJson);
  });

  afterAll(() => {
    // Prove non-interference by CONTENT, which is what actually matters and what
    // the comment above has always claimed: a suite that leaks into the real
    // machine either creates these files or edits them, and both show up here.
    //
    // An earlier version asserted `automations.json` must not exist AT ALL on
    // this machine, reading that as the "ships fully disabled" property. It is
    // not: `automations create` auto-approves on the local machine BY DESIGN, so
    // the registry legitimately exists for anyone who has ever created a single
    // automation — the moment the feature is actually used, that assertion fails
    // forever, for a reason that has nothing to do with this suite's isolation.
    // The comment already reasoned exactly this way about the heartbeat file
    // without applying it to the registry. Byte comparison is strictly stronger
    // than the existence check it replaces AND it is independent of ambient state.
    expect(snapshot(realAutomationsJson)).toBe(realAutomationsJsonBefore);
    expect(snapshot(realHeartbeatJson)).toBe(realHeartbeatJsonBefore);
  });

  let home: string;
  let base: string;
  let projectDir: string;

  beforeEach(() => {
    home = makeTmpDir('dc-automations-cli-home');
    base = makeTmpDir('dc-automations-cli-base');
    projectDir = makeProjectDir(base, 'proj');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('lists every verb in --help, including share/unshare', () => {
    const out = run(['automations', '--help'], projectDir, home);
    expect(out.exitCode).toBe(0);
    for (const verb of [
      'create', 'list', 'show', 'run', 'tick', 'enable', 'disable', 'share', 'unshare',
      'approve', 'kill', 'remove', 'install', 'uninstall', 'logs',
    ]) {
      expect(out.stdout).toContain(verb);
    }
  });

  it('create → list → show → run --force → approve', () => {
    // create
    const createOut = run(
      ['automations', 'create', 'eod-digest', '--title', 'EOD Digest', '--days', 'daily', '--at', '18:00', '--timeout', '1'],
      projectDir, home,
    );
    expect(createOut.exitCode).toBe(0);
    expect(createOut.stdout).toMatch(/created/i);
    const manifestPath = join(projectDir, '_dream_context', 'automations', 'eod-digest.md');
    expect(existsSync(manifestPath)).toBe(true);

    // list
    const listOut = run(['automations', 'list'], projectDir, home);
    expect(listOut.exitCode).toBe(0);
    expect(listOut.stdout).toContain('eod-digest');
    expect(listOut.stdout).toContain('EOD Digest');

    // show — create auto-approves locally, so approval must already read approved
    const showOut = run(['automations', 'show', 'eod-digest'], projectDir, home);
    expect(showOut.exitCode).toBe(0);
    expect(showOut.stdout).toContain('EOD Digest');
    expect(showOut.stdout).toMatch(/approval:\s*approved/i);
    expect(showOut.stdout).toMatch(/never run/i);

    // run --force — must reach a real spawn attempt (bypassing dueness; the
    // schedule is "daily at 18:00" and the actual time of day is arbitrary)
    // and must NOT be blocked by approval (auto-approved above) or the
    // orphan guard (no prior sidecar exists). `claude` is unreachable by
    // construction (SAFE_PATH + isolated HOME — see the module doc), so the
    // deterministic disposition is 'failed' via the unparseable-CLI-output
    // path (runner.ts: a spawned shell that can't exec `claude` produces no
    // parseable JSON on stdout). This proves the CLI correctly plumbed
    // force/fireAt/host through to `runAutomation` and rendered a real
    // RunOutcome, with zero real, costly, non-deterministic Claude API calls
    // anywhere in this test suite.
    const runOut = run(['automations', 'run', 'eod-digest', '--force'], projectDir, home);
    expect(runOut.exitCode).toBe(1);
    expect(runOut.stdout).toMatch(/eod-digest:\s*failed/i);

    const cachePath = join(projectDir, '_dream_context', 'automations', 'cache', 'eod-digest.json');
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(cache.status).toBe('failed');
    expect(cache.lastFireAt).not.toBeNull(); // watermark DID advance — a child started

    // approve — already approved (create auto-approved it; the run above
    // touched no hashed field), so this must be an idempotent success, never
    // a re-review prompt.
    const approveOut = run(['automations', 'approve', 'eod-digest', '--yes'], projectDir, home);
    expect(approveOut.exitCode).toBe(0);
    expect(approveOut.stdout).toMatch(/already approved/i);
  });

  it('approve shows every hashed field after a manifest edit, and refuses non-interactively without --yes', () => {
    run(
      ['automations', 'create', 'weekly-report', '--title', 'Weekly Report', '--days', 'fri', '--at', '17:00'],
      projectDir, home,
    );
    const manifestPath = join(projectDir, '_dream_context', 'automations', 'weekly-report.md');

    // Edit ONE hashed field (the prompt) by hand — mirrors a teammate's synced
    // edit — so checkApproval now reports 'manifest-changed'.
    const original = readFileSync(manifestPath, 'utf-8');
    const edited = original.replace(
      '(What should this automation do? Write the prompt the scheduled run will send.)',
      "Summarize this week's CI logs.",
    );
    expect(edited).not.toBe(original); // the replace actually matched something
    writeFileSync(manifestPath, edited, 'utf-8');

    // Refuses non-interactively without --yes. execSync's child stdin is
    // never a TTY, so this exercises the REAL `!process.stdin.isTTY` guard —
    // not a simulated one.
    const noYesOut = run(['automations', 'approve', 'weekly-report'], projectDir, home);
    expect(noYesOut.exitCode).toBe(1);
    expect(noYesOut.stdout).toMatch(/refus/i);

    // With --yes: the review must name EVERY hashed field, every time —
    // reviewing only the prompt is exactly the reflexive-approval failure
    // this command exists to prevent. Iterating APPROVAL_DIFF_FIELDS itself
    // (rather than a hand-copied list) is the actual fix here: a hardcoded
    // 5-element array stayed GREEN when `effort` became the sixth hashed
    // field, silently covering 5 of 6 — this can never again miss a field the
    // approve loop was supposed to diff, because it reads the same constant
    // the CLI's loop reads.
    const yesOut = run(['automations', 'approve', 'weekly-report', '--yes'], projectDir, home);
    expect(yesOut.exitCode).toBe(0);
    // The count is a deliberate canary on top of the iteration: adding a hashed
    // field must make a human look at this file rather than sail through green.
    // 6 → 7 when `learning` joined; 7 → 8 when `review` (HITL mode) joined.
    expect(APPROVAL_DIFF_FIELDS.length).toBe(8);
    for (const field of APPROVAL_DIFF_FIELDS) {
      expect(yesOut.stdout).toContain(field);
    }
    expect(yesOut.stdout).toMatch(/approved/i);
  });

  it('create --effort ultra exits non-zero naming the valid effort levels, and never scaffolds the manifest', () => {
    const out = run(
      [
        'automations', 'create', 'bad-effort', '--title', 'Bad Effort',
        '--days', 'daily', '--at', '09:00', '--effort', 'ultra',
      ],
      projectDir, home,
    );
    expect(out.exitCode).toBe(1);
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(out.stdout).toContain(level);
    }
    // Validation must throw BEFORE any write — an invalid --effort must never
    // leave a half-created manifest behind.
    expect(existsSync(join(projectDir, '_dream_context', 'automations', 'bad-effort.md'))).toBe(false);
  });

  it('create --effort low is persisted and rendered in show', () => {
    run(
      ['automations', 'create', 'effort-test', '--title', 'Effort Test', '--days', 'daily', '--at', '09:00', '--effort', 'low'],
      projectDir, home,
    );
    const out = run(['automations', 'show', 'effort-test'], projectDir, home);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('effort: low');
  });

  it('create --shared publishes the manifest/cache/output negations; a plain create stays private', () => {
    // Slugs deliberately avoid the literal substrings "private"/"shared" so a
    // later regex match against the rendered badge word can't be satisfied by
    // the slug's own name instead of the actual state being asserted.
    run(['automations', 'create', 'digest-a', '--title', 'Digest A', '--days', 'daily', '--at', '09:00'], projectDir, home);
    const sharedOut = run(
      ['automations', 'create', 'digest-b', '--title', 'Digest B', '--days', 'daily', '--at', '09:00', '--shared'],
      projectDir, home,
    );
    expect(sharedOut.exitCode).toBe(0);
    expect(sharedOut.stdout).toMatch(/will publish to the synced brain/i);

    const gitignore = readFileSync(join(projectDir, '_dream_context', '.gitignore'), 'utf-8');
    expect(gitignore).toContain('!automations/digest-b.md');
    expect(gitignore).toContain('!automations/cache/digest-b.json');
    expect(gitignore).toContain('!automations/output/digest-b/*');
    expect(gitignore).not.toContain('!automations/digest-a.md');

    const listOut = run(['automations', 'list'], projectDir, home);
    expect(listOut.exitCode).toBe(0);
    const lines = listOut.stdout.split('\n');
    const lineA = lines.find((l) => l.includes('digest-a'));
    const lineB = lines.find((l) => l.includes('digest-b'));
    expect(lineA).toBeDefined();
    expect(lineB).toBeDefined();
    expect(lineA).toMatch(/\bprivate\b/);
    expect(lineA).not.toMatch(/\bshared\b/);
    expect(lineB).toMatch(/\bshared\b/);

    // The JSON contract carries the same verdict, plus `effort` for free
    // (it's just a spread manifest field — Q-A keeps effort out of the plain
    // table but --json always has it).
    const jsonRows = JSON.parse(run(['automations', 'list', '--json'], projectDir, home).stdout);
    const rowB = jsonRows.find((r: { slug: string }) => r.slug === 'digest-b');
    expect(rowB.shareState).toBe('shared');
    expect(rowB.effort).toBeNull();

    const showJson = JSON.parse(run(['automations', 'show', 'digest-b', '--json'], projectDir, home).stdout);
    expect(showJson.shareState).toBe('shared');
  });

  it('unshare without -y refuses non-interactively and prints the non-retroactive warning verbatim; --yes removes the negations', () => {
    run(
      ['automations', 'create', 'unshare-test', '--title', 'Unshare Test', '--days', 'daily', '--at', '09:00', '--shared'],
      projectDir, home,
    );
    const gitignorePath = join(projectDir, '_dream_context', '.gitignore');
    expect(readFileSync(gitignorePath, 'utf-8')).toContain('!automations/unshare-test.md');

    const noYesOut = run(['automations', 'unshare', 'unshare-test'], projectDir, home);
    expect(noYesOut.exitCode).toBe(1);
    expect(noYesOut.stdout).toMatch(/refus/i);
    // Every line must appear VERBATIM — imported from the CLI source itself
    // (unshareWarningLines) so the printed text and this assertion can never
    // silently drift apart. This warning IS the entire justification for the
    // verb: it is the only place a user learns that unsharing is not
    // retroactive before they act on that belief.
    for (const line of unshareWarningLines('unshare-test')) {
      expect(noYesOut.stdout).toContain(line);
    }
    // A REFUSED unshare must leave the negations completely intact.
    expect(readFileSync(gitignorePath, 'utf-8')).toContain('!automations/unshare-test.md');

    const yesOut = run(['automations', 'unshare', 'unshare-test', '--yes'], projectDir, home);
    expect(yesOut.exitCode).toBe(0);
    expect(yesOut.stdout).toMatch(/no longer publish/i);
    const gitignoreAfter = readFileSync(gitignorePath, 'utf-8');
    expect(gitignoreAfter).not.toContain('!automations/unshare-test.md');
    expect(gitignoreAfter).not.toContain('!automations/cache/unshare-test.json');
    expect(gitignoreAfter).not.toContain('!automations/output/unshare-test/*');
  });

  it('a shared flag with no effective negation renders drifted-flag-only and is NEVER auto-repaired (fails safe)', () => {
    run(
      ['automations', 'create', 'drift-flag-test', '--title', 'Drift Flag Test', '--days', 'daily', '--at', '09:00'],
      projectDir, home,
    );
    // Hand-flip the frontmatter flag to shared WITHOUT ever running `share` —
    // the exact F2 shape: the user believes this publishes; it never left.
    const manifestPath = join(projectDir, '_dream_context', 'automations', 'drift-flag-test.md');
    const original = readFileSync(manifestPath, 'utf-8');
    const edited = original.replace('shared: false', 'shared: true');
    expect(edited).not.toBe(original); // the replace actually matched something
    writeFileSync(manifestPath, edited, 'utf-8');

    const out = run(['automations', 'show', 'drift-flag-test'], projectDir, home);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/NOT actually published/i);
    expect(out.stdout).toContain('dreamcontext automations share drift-flag-test');

    // list is one of the auto-repair touchpoints too — running it must NOT
    // silently flip the flag back or fabricate a negation. This direction
    // fails safe (content stays local), so it only ever warns.
    run(['automations', 'list'], projectDir, home);
    const manifestAfter = readFileSync(manifestPath, 'utf-8');
    expect(manifestAfter).toContain('shared: true');
    const gitignoreAfter = readFileSync(join(projectDir, '_dream_context', '.gitignore'), 'utf-8');
    expect(gitignoreAfter).not.toContain('!automations/drift-flag-test.md');
  });

  it('a stray negation surviving for a private automation is auto-repaired with a printed removal line', () => {
    run(
      ['automations', 'create', 'drift-ignore-test', '--title', 'Drift Ignore Test', '--days', 'daily', '--at', '09:00'],
      projectDir, home,
    );
    // Hand-append the slug's three negation lines directly, AFTER the base
    // wildcard block that `create` already wrote — the exact "does NOT fail
    // safe" drift direction: the frontmatter flag stays `false` throughout
    // (the user believes this is private) while the negation actively
    // publishes it.
    const gitignorePath = join(projectDir, '_dream_context', '.gitignore');
    appendFileSync(
      gitignorePath,
      '\n!automations/drift-ignore-test.md\n!automations/cache/drift-ignore-test.json\n!automations/output/drift-ignore-test/*\n',
    );
    expect(readFileSync(gitignorePath, 'utf-8')).toContain('!automations/drift-ignore-test.md');

    const out = run(['automations', 'list'], projectDir, home);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/auto-repaired/i);
    expect(out.stdout).toContain('!automations/drift-ignore-test.md');

    const gitignoreAfter = readFileSync(gitignorePath, 'utf-8');
    expect(gitignoreAfter).not.toContain('!automations/drift-ignore-test.md');
    expect(gitignoreAfter).not.toContain('!automations/cache/drift-ignore-test.json');
    expect(gitignoreAfter).not.toContain('!automations/output/drift-ignore-test/*');
  });

  it('a manifest already tracked by git despite shared:false renders tracked-despite-private and is NEVER auto-repaired', () => {
    run(
      ['automations', 'create', 'tracked-test', '--title', 'Tracked Test', '--days', 'daily', '--at', '09:00'],
      projectDir, home,
    );

    // Simulate the residual `git add -f` / merge-from-a-branch-where-it-was-
    // tracked case: a real git repo where the manifest is already indexed
    // despite `shared: false`. .gitignore can never untrack a path git
    // already has, so this is checked ahead of (and independent from) the
    // ignore-effectiveness check. `-f` is required and is itself part of the
    // realism here: the manifest IS covered by the base wildcard `create`
    // already wrote, so a plain `git add` refuses it outright — `-f` is
    // exactly the escape hatch this residual path is named for.
    execFileSync('git', ['init', '-q'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync(
      'git', ['add', '-f', join('_dream_context', 'automations', 'tracked-test.md')],
      { cwd: projectDir, stdio: 'ignore' },
    );

    const out = run(['automations', 'show', 'tracked-test'], projectDir, home);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/TRACKED despite private/i);
    expect(out.stdout).toContain('git rm --cached automations/tracked-test.md');

    // Never auto-repaired: `list` is a repair touchpoint too, and running it
    // must not attempt anything destructive to git's index (impossible via
    // .gitignore anyway, but this proves nothing in the CLI even tries).
    const listOut = run(['automations', 'list'], projectDir, home);
    expect(listOut.exitCode).toBe(0);
    expect(listOut.stdout).toMatch(/TRACKED despite private/i);

    const tracked = execFileSync(
      'git', ['ls-files', join('_dream_context', 'automations', 'tracked-test.md')],
      { cwd: projectDir, encoding: 'utf-8' },
    );
    expect(tracked.trim()).toContain('tracked-test.md');
  });

  it('remove leaves no stray sharing negations behind, even for a shared automation', () => {
    run(
      [
        'automations', 'create', 'remove-shared-test', '--title', 'Remove Shared Test',
        '--days', 'daily', '--at', '09:00', '--shared',
      ],
      projectDir, home,
    );
    const gitignorePath = join(projectDir, '_dream_context', '.gitignore');
    expect(readFileSync(gitignorePath, 'utf-8')).toContain('!automations/remove-shared-test.md');

    const out = run(['automations', 'remove', 'remove-shared-test', '--yes'], projectDir, home);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/removed/i);

    const gitignoreAfter = readFileSync(gitignorePath, 'utf-8');
    expect(gitignoreAfter).not.toContain('!automations/remove-shared-test.md');
    expect(gitignoreAfter).not.toContain('!automations/cache/remove-shared-test.json');
    expect(gitignoreAfter).not.toContain('!automations/output/remove-shared-test/*');
  });

  it('tick <disabled-slug> reports disabled and never attempts a run', () => {
    // --catchup 168 (the max, 7 days) makes this automation DUE unconditionally
    // at any wall-clock time the suite happens to run: a daily schedule's most
    // recent fire is always < 24h in the past, comfortably inside a 168h
    // catch-up window. This matters — without it, the test could pass even
    // against the OLD buggy code simply because the automation wasn't due at
    // that moment, proving nothing about the enabled-check. Forcing dueness
    // makes `enabled: false` the ONLY thing that can stop a spawn attempt here.
    run(
      [
        'automations', 'create', 'disabled-tick-test', '--title', 'Disabled Tick Test',
        '--days', 'daily', '--at', '09:00', '--catchup', '168', '--disabled',
      ],
      projectDir, home,
    );

    const cachePath = join(projectDir, '_dream_context', 'automations', 'cache', 'disabled-tick-test.json');
    expect(existsSync(cachePath)).toBe(false); // sanity check on the fixture: never run yet

    const tickOut = run(['automations', 'tick', 'disabled-tick-test'], projectDir, home);
    expect(tickOut.exitCode).toBe(0);
    expect(tickOut.stdout).toMatch(/disabled/i);

    // The actual proof, not merely a wording check: `recordRun` — the ONLY
    // writer of automations/cache/<slug>.json — is called exclusively from
    // inside `runAutomation`. If the enabled-check didn't short-circuit
    // BEFORE `runAutomation`, this file would exist regardless of outcome
    // (even a failed/unreachable-claude spawn attempt still records a cache
    // event, as the main create→run--force test above demonstrates). Its
    // continued absence is direct proof the run was never attempted.
    expect(existsSync(cachePath)).toBe(false);

    // Same proof again via --json, pinning the exact verdict shape too.
    const jsonOut = run(['automations', 'tick', 'disabled-tick-test', '--json'], projectDir, home);
    expect(jsonOut.exitCode).toBe(0);
    expect(JSON.parse(jsonOut.stdout)).toEqual({ slug: 'disabled-tick-test', verdict: 'disabled' });
    expect(existsSync(cachePath)).toBe(false);
  });

  it('kill on a slug with no sidecar exits cleanly with a clear message', () => {
    run(
      ['automations', 'create', 'no-sidecar', '--title', 'No Sidecar', '--days', 'daily', '--at', '09:00'],
      projectDir, home,
    );
    const killOut = run(['automations', 'kill', 'no-sidecar', '--yes'], projectDir, home);
    expect(killOut.exitCode).toBe(0);
    expect(killOut.stdout).toMatch(/nothing to kill/i);
  });

  it('kill on an unknown slug fails clearly rather than guessing a target', () => {
    const killOut = run(['automations', 'kill', 'does-not-exist', '--yes'], projectDir, home);
    expect(killOut.exitCode).toBe(1);
    expect(killOut.stdout).toMatch(/no such automation/i);
  });

  it('show renders the orphan-liveness line only when a sidecar exists', () => {
    run(
      ['automations', 'create', 'sidecar-test', '--title', 'Sidecar Test', '--days', 'daily', '--at', '09:00'],
      projectDir, home,
    );

    const noSidecarOut = run(['automations', 'show', 'sidecar-test'], projectDir, home);
    expect(noSidecarOut.exitCode).toBe(0);
    expect(noSidecarOut.stdout).not.toMatch(/is still alive|stale run record|currently running/i);

    // Hand-write a sidecar recording a definitively DEAD process group — a
    // PID/PGID this far outside any real OS's PID space is guaranteed not to
    // resolve to a live process, so `show`'s signal-0 probe deterministically
    // reports "stale". There is no injection point for this across a real CLI
    // subprocess boundary, so a genuinely-dead PID is the only reliable way
    // to exercise this branch here (the frozen unit suite covers the
    // live-orphan branch via an injected killImpl).
    const contextRoot = join(projectDir, '_dream_context');
    const cacheDir = join(contextRoot, 'automations', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const sidecar = {
      slug: 'sidecar-test',
      runnerPid: 999999999,
      childPid: 999999999,
      childPgid: 999999999,
      fireAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    };
    writeFileSync(join(cacheDir, '.sidecar-test.run.json'), JSON.stringify(sidecar, null, 2) + '\n', 'utf-8');

    const withSidecarOut = run(['automations', 'show', 'sidecar-test'], projectDir, home);
    expect(withSidecarOut.exitCode).toBe(0);
    expect(withSidecarOut.stdout).toMatch(/stale run record/i);
  });

  it('install --check prints raw heartbeat timestamps with no staleness verdict, and writes nothing', () => {
    run(
      ['automations', 'create', 'check-test', '--title', 'Check Test', '--days', 'daily', '--at', '09:00'],
      projectDir, home,
    );

    const checkOut = run(['automations', 'install', '--check'], projectDir, home);
    // Must not throw even off macOS — inspectDispatcher only gates
    // `bootstrapped` on darwin, never refuses outright.
    expect(checkOut.exitCode).toBe(0);
    // Raw timestamps, nothing appended to the line — "(never)" is the whole
    // value. A staleness verdict would have appended a judgment here; it
    // was deliberately cut (see runner/tick task notes) in favor of the exact
    // timestamp, which carries most of the value without false-alarming
    // during a long-but-healthy multi-automation tick.
    expect(checkOut.stdout).toContain('last tick started: (never)');
    expect(checkOut.stdout).toContain('last tick completed: (never)');

    // Writes nothing at the ISOLATED home: no plist, no wrapper, no heartbeat
    // file (the heartbeat is only ever created by a real `tick`, never by
    // `--check`, which only reads).
    expect(existsSync(join(home, 'Library', 'LaunchAgents', 'com.dreamcontext.automations.plist'))).toBe(false);
    expect(existsSync(join(home, '.dreamcontext', 'bin', 'automations-dispatch.sh'))).toBe(false);
    expect(existsSync(join(home, '.dreamcontext', 'automations-tick.json'))).toBe(false);
  });

  // ── Machine-scoped verbs must work from a directory with NO _dream_context/ ──
  // A real launchd install found this the hard way: the dispatcher runs with
  // no project directory whatsoever, so any verb that iterates machine-level
  // state (the registry, the dispatcher install, the log file) must never
  // call `ensureContextRoot()` — that throws "_dream_context/ not found" and
  // kills the tick forever, every 5 minutes, on every machine. `tickProject`/
  // `run`/`show`/etc. are correctly project-scoped and are NOT tested here —
  // this section is specifically the verbs that must NOT require a project.
  describe('machine-scoped verbs run from a brainless working directory', () => {
    it('tick --all is a silent no-op with an empty registry, from a directory with no brain', () => {
      const brainlessCwd = makeTmpDir('dc-automations-cli-brainless');
      try {
        const out = run(['automations', 'tick', '--all'], brainlessCwd, home);
        expect(out.exitCode).toBe(0);
        expect(out.stdout).not.toMatch(/_dream_context/i);
        expect(out.stdout).toMatch(/no projects registered/i);

        const jsonOut = run(['automations', 'tick', '--all', '--json'], brainlessCwd, home);
        expect(jsonOut.exitCode).toBe(0);
        expect(JSON.parse(jsonOut.stdout)).toEqual({
          projects: [],
          missing: [],
          startedAt: expect.any(String),
          durationMs: expect.any(Number),
        });
      } finally {
        rmSync(brainlessCwd, { recursive: true, force: true });
      }
    });

    it('tick --all resolves work from the machine registry, not cwd, with a populated registry', () => {
      // `create` (run from the real project dir) auto-registers that project
      // in the shared isolated $HOME's registry. Then tick --all is invoked
      // from a COMPLETELY DIFFERENT, brainless directory — proving the work
      // comes from ~/.dreamcontext/automations.json, never from cwd.
      run(
        [
          'automations', 'create', 'registry-tick-test', '--title', 'Registry Tick Test',
          '--days', 'daily', '--at', '09:00', '--catchup', '168',
        ],
        projectDir, home,
      );

      const brainlessCwd = makeTmpDir('dc-automations-cli-brainless');
      try {
        const out = run(['automations', 'tick', '--all'], brainlessCwd, home);
        expect(out.exitCode).toBe(0);
        expect(out.stdout).toContain(projectDir);
        expect(out.stdout).toContain('registry-tick-test');
      } finally {
        rmSync(brainlessCwd, { recursive: true, force: true });
      }

      // The automation really did run (claude unreachable ⇒ deterministic
      // 'failed', same reasoning as the main chain test above) — proving this
      // was a genuine tick, not a vacuous pass.
      const cachePath = join(projectDir, '_dream_context', 'automations', 'cache', 'registry-tick-test.json');
      expect(existsSync(cachePath)).toBe(true);
      const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
      expect(cache.status).toBe('failed');
    });

    it('install --check runs from a directory with no brain', () => {
      const brainlessCwd = makeTmpDir('dc-automations-cli-brainless');
      try {
        const out = run(['automations', 'install', '--check'], brainlessCwd, home);
        expect(out.exitCode).toBe(0);
        expect(out.stdout).not.toMatch(/_dream_context/i);
        expect(out.stdout).toContain('last tick started');
      } finally {
        rmSync(brainlessCwd, { recursive: true, force: true });
      }
    });

    it('logs runs from a directory with no brain', () => {
      const brainlessCwd = makeTmpDir('dc-automations-cli-brainless');
      try {
        const out = run(['automations', 'logs'], brainlessCwd, home);
        expect(out.exitCode).toBe(0);
        expect(out.stdout).not.toMatch(/_dream_context/i);
      } finally {
        rmSync(brainlessCwd, { recursive: true, force: true });
      }
    });

    // `install` (non-`--check`) and `uninstall` are DELIBERATELY not exercised
    // for real here, even under an isolated $HOME. Both were confirmed by
    // direct source inspection to never call `ensureContextRoot()` either
    // (same fix-verification pass as `tick --all` above), so their
    // CWD-independence is not in question. But `installDispatcher`/
    // `uninstallDispatcher`'s `launchctl bootstrap`/`bootout` calls target
    // `gui/<REAL uid>/com.dreamcontext.automations` — a FIXED label under the
    // REAL user's REAL launchd domain, not scoped by $HOME in any way — and
    // the CLI exposes no `--uid` override to sandbox that. A manual
    // verification during this fix's own validation pass (isolated $HOME,
    // real `launchctl`) actually booted out a real, already-installed
    // dispatcher registration that existed under that same fixed label,
    // before being caught and restored. An automated test that can silently
    // remove a real developer's real scheduled job on whatever machine happens
    // to run `npm test` is not an acceptable trade for CI coverage, so this
    // is a disclosed scope decision, not an oversight.
  });
});
