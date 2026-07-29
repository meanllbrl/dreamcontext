import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { SESSION_SCORE_MAX, DEBT_DROWSY } from '../../src/lib/sleep-consolidation.js';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-sleep-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function scaffold(root: string): string {
  const ctx = join(root, '_dream_context');
  mkdirSync(join(ctx, 'core', 'features'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });
  return ctx;
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(`node ${CLI} ${cmd} 2>&1`, { cwd, encoding: 'utf-8', timeout: 10000 });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

describe('sleep (integration)', () => {
  let tmpDir: string;
  let ctx: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ctx = scaffold(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sleep debt outputs 0 on fresh project', () => {
    const output = run('sleep debt', tmpDir);
    expect(output.trim()).toBe('0');
  });

  it('sleep status shows default state on fresh project', () => {
    const output = run('sleep status', tmpDir);
    expect(output).toContain('0');
    expect(output).toContain('Alert');
    expect(output).toContain('never');
  });

  it('sleep add creates .sleep.json with session entry and accumulates debt', () => {
    run('sleep add 2 Bug fix: auth token refresh', tmpDir);
    const sleepFile = join(ctx, 'state', '.sleep.json');
    expect(existsSync(sleepFile)).toBe(true);

    const state = JSON.parse(readFileSync(sleepFile, 'utf-8'));
    expect(state.debt).toBe(2);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].score).toBe(2);
    expect(state.sessions[0].last_assistant_message).toBe('Bug fix: auth token refresh');
    expect(state.sessions[0].session_id).toMatch(/^manual-/);
    expect(state.sessions[0].stopped_at).toBeTruthy();
  });

  it('multiple sleep add calls accumulate debt (LIFO order)', () => {
    run('sleep add 2 First change', tmpDir);
    run('sleep add 3 Second change', tmpDir);
    run('sleep add 1 Third change', tmpDir);

    const output = run('sleep debt', tmpDir);
    expect(output.trim()).toBe('6');

    const sleepFile = join(ctx, 'state', '.sleep.json');
    const state = JSON.parse(readFileSync(sleepFile, 'utf-8'));
    expect(state.sessions).toHaveLength(3);
    // LIFO: newest first
    expect(state.sessions[0].last_assistant_message).toBe('Third change');
    expect(state.sessions[1].last_assistant_message).toBe('Second change');
    expect(state.sessions[2].last_assistant_message).toBe('First change');
  });

  it('sleep status shows sessions after adds', () => {
    // Debt 8 lands in the (rescaled) Drowsy band 8–13.
    // Add exactly enough manual debt to land in the Drowsy band, whatever the
    // current scale is (the entry point moved 8 -> 12 with the 0-10 rescale).
    let added = 0;
    while (added < DEBT_DROWSY) {
      const chunk = Math.min(SESSION_SCORE_MAX, DEBT_DROWSY - added);
      run(`sleep add ${chunk} Bug fix`, tmpDir);
      added += chunk;
    }
    run('sleep add 1 Arch change', tmpDir);

    const output = run('sleep status', tmpDir);
    expect(output).toContain(String(added + 1));
    expect(output).toContain('Drowsy');
    expect(output).toContain('Bug fix');
    expect(output).toContain('Arch change');
  });

  it('sleep done resets debt and clears sessions', () => {
    run('sleep add 2 Some work', tmpDir);
    run('sleep add 3 More work', tmpDir);

    const doneOutput = run('sleep done Consolidated auth decisions', tmpDir);
    expect(doneOutput).toContain('Debt reset from 5 to 0');

    const sleepFile = join(ctx, 'state', '.sleep.json');
    const state = JSON.parse(readFileSync(sleepFile, 'utf-8'));
    expect(state.debt).toBe(0);
    expect(state.sessions).toHaveLength(0);
    expect(state.last_sleep).toBeTruthy();
    expect(state.last_sleep_summary).toBe('Consolidated auth decisions');
  });

  it('sleep status after done shows last sleep info', () => {
    run('sleep add 2 Some work', tmpDir);
    run('sleep done Test consolidation', tmpDir);

    const output = run('sleep status', tmpDir);
    expect(output).toContain('0');
    expect(output).toContain('Alert');
    expect(output).toContain('Test consolidation');
  });

  it('sleep add rejects a score outside 1..SESSION_SCORE_MAX', () => {
    const expected = `Score must be an integer from 1 to ${SESSION_SCORE_MAX}`;

    expect(run('sleep add 0 Invalid', tmpDir)).toContain(expected);
    expect(run(`sleep add ${SESSION_SCORE_MAX + 1} Invalid`, tmpDir)).toContain(expected);
    expect(run('sleep add abc Invalid', tmpDir)).toContain(expected);

    // The range widened with the 0-10 rescale: 4 used to be rejected.
    expect(run('sleep add 4 Now valid', tmpDir)).not.toContain(expected);
  });

  it('persists accumulated debt to .sleep.json; snapshot stays lean', () => {
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: test\n---\n\nTest project.\n',
    );
    run('sleep add 2 Bug fix', tmpDir);
    run('sleep add 3 Arch change', tmpDir);

    const state = JSON.parse(readFileSync(join(ctx, 'state', '.sleep.json'), 'utf-8'));
    expect(state.debt).toBe(5);

    // The sleep-state block is DEPRECATED in the snapshot (v0.4.0+): debt pressure is
    // delivered by the session-start / user-prompt-submit hooks, not the raw snapshot.
    const output = run('snapshot', tmpDir);
    expect(output).not.toContain('## Sleep State');
  });

  it('snapshot omits sleep state when unused', () => {
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: test\n---\n\nTest project.\n',
    );
    const output = run('snapshot', tmpDir);
    expect(output).not.toContain('## Sleep State');
  });

  it('records consolidation in .sleep.json after done; snapshot stays lean', () => {
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: test\n---\n\nTest project.\n',
    );
    run('sleep add 2 Some work', tmpDir);
    run('sleep done Consolidated things', tmpDir);

    const state = JSON.parse(readFileSync(join(ctx, 'state', '.sleep.json'), 'utf-8'));
    expect(state.debt).toBe(0);
    expect(state.last_sleep).toBeTruthy();

    const output = run('snapshot', tmpDir);
    expect(output).not.toContain('## Sleep State');
  });

  // --- Epoch-based consolidation tests ---

  it('sleep start sets sleep_started_at in .sleep.json', () => {
    const output = run('sleep start', tmpDir);
    expect(output).toContain('Consolidation epoch set');

    const sleepFile = join(ctx, 'state', '.sleep.json');
    const state = JSON.parse(readFileSync(sleepFile, 'utf-8'));
    expect(state.sleep_started_at).toBeTruthy();
    expect(new Date(state.sleep_started_at).getTime()).not.toBeNaN();
  });

  it('sleep start REFUSES a second sleep while a live lock is held (no overwrite)', () => {
    const first = run('sleep start', tmpDir);
    expect(first).toContain('Consolidation epoch set');

    const sleepFile = join(ctx, 'state', '.sleep.json');
    const firstEpoch = JSON.parse(readFileSync(sleepFile, 'utf-8')).sleep_started_at;

    const second = run('sleep start', tmpDir);
    expect(second).toContain('already in progress');
    expect(second).toContain('--force');
    // Refusal must NOT stamp a new epoch — the original lock is preserved intact.
    expect(second).not.toContain('Consolidation epoch set');
    const afterEpoch = JSON.parse(readFileSync(sleepFile, 'utf-8')).sleep_started_at;
    expect(afterEpoch).toBe(firstEpoch);
  });

  it('sleep start --force takes over a live lock', () => {
    run('sleep start', tmpDir);
    const output = run('sleep start --force', tmpDir);
    expect(output).toContain('taking over');
    expect(output).toContain('Consolidation epoch set');
  });

  it('sleep start auto-reclaims a STALE lock without --force', () => {
    run('sleep start', tmpDir);
    // Backdate the lock past the 30m TTL to simulate a crashed sleep.
    const sleepFile = join(ctx, 'state', '.sleep.json');
    const state = JSON.parse(readFileSync(sleepFile, 'utf-8'));
    state.sleep_started_at = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    writeFileSync(sleepFile, JSON.stringify(state, null, 2));

    const output = run('sleep start', tmpDir);
    expect(output).toContain('Reclaiming a stale consolidation lock');
    expect(output).toContain('Consolidation epoch set');
  });

  it('sleep start REFUSES while another start holds a FRESH stamp lock (closes the TOCTOU race)', () => {
    // Simulate a concurrent `sleep start` mid-stamp by planting a fresh stamp lock.
    const stampLock = join(ctx, 'state', '.sleep.start.lock');
    writeFileSync(stampLock, JSON.stringify({ pid: 999999, at: Date.now() }) + '\n');

    const output = run('sleep start', tmpDir);
    expect(output).toContain('another `sleep start` is stamping');
    // No epoch may be stamped while another start owns the stamp mutex.
    const sleepFile = join(ctx, 'state', '.sleep.json');
    const epoch = existsSync(sleepFile) ? JSON.parse(readFileSync(sleepFile, 'utf-8')).sleep_started_at : null;
    expect(epoch).toBeNull();
  });

  it('sleep start reclaims a STALE stamp lock (a crashed prior stamp) and cleans it up', () => {
    const stampLock = join(ctx, 'state', '.sleep.start.lock');
    // Backdate past the 60s stamp-lock TTL to simulate a `sleep start` that died mid-stamp.
    writeFileSync(stampLock, JSON.stringify({ pid: 999999, at: Date.now() - 120_000 }) + '\n');

    const output = run('sleep start', tmpDir);
    expect(output).toContain('Consolidation epoch set');
    // The stamp lock is released on exit — never left behind to wedge the next start.
    expect(existsSync(stampLock)).toBe(false);
  });

  it('sleep done with epoch preserves post-epoch sessions', () => {
    // Add pre-epoch session
    run('sleep add 2 Pre-epoch work', tmpDir);

    // Set epoch
    run('sleep start', tmpDir);

    // Simulate a post-epoch session by manually writing to .sleep.json
    const sleepFile = join(ctx, 'state', '.sleep.json');
    const state = JSON.parse(readFileSync(sleepFile, 'utf-8'));
    const futureTime = new Date(Date.now() + 60000).toISOString();
    state.sessions.unshift({
      session_id: 'post-epoch-sess',
      transcript_path: null,
      stopped_at: futureTime,
      last_assistant_message: 'Post-epoch work',
      change_count: 5,
      score: 2,
    });
    state.debt += 2;
    writeFileSync(sleepFile, JSON.stringify(state, null, 2));

    // Run sleep done
    const doneOutput = run('sleep done Consolidated pre-epoch work', tmpDir);
    expect(doneOutput).toContain('post-epoch session(s) preserved');

    // Verify post-epoch session survives
    const finalState = JSON.parse(readFileSync(sleepFile, 'utf-8'));
    expect(finalState.sessions).toHaveLength(1);
    expect(finalState.sessions[0].session_id).toBe('post-epoch-sess');
    expect(finalState.debt).toBe(2);
    expect(finalState.sleep_started_at).toBeNull();
    expect(finalState.last_sleep_summary).toBe('Consolidated pre-epoch work');
  });

  it('sleep done with epoch preserves post-epoch dashboard changes', () => {
    run('sleep start', tmpDir);

    // Manually add a dashboard change with post-epoch timestamp
    const sleepFile = join(ctx, 'state', '.sleep.json');
    const state = JSON.parse(readFileSync(sleepFile, 'utf-8'));
    const futureTime = new Date(Date.now() + 60000).toISOString();
    state.dashboard_changes = [
      {
        timestamp: futureTime,
        entity: 'task',
        action: 'update',
        target: 'some-task',
        summary: 'Post-epoch dashboard change',
      },
    ];
    writeFileSync(sleepFile, JSON.stringify(state, null, 2));

    run('sleep done Consolidated things', tmpDir);
    const finalState = JSON.parse(readFileSync(sleepFile, 'utf-8'));
    expect(finalState.dashboard_changes).toHaveLength(1);
    expect(finalState.dashboard_changes[0].summary).toBe('Post-epoch dashboard change');
  });

  it('sleep done without epoch clears all sessions (backward compat)', () => {
    run('sleep add 2 Some work', tmpDir);
    run('sleep add 3 More work', tmpDir);

    // Do NOT call sleep start
    const doneOutput = run('sleep done Consolidated everything', tmpDir);
    expect(doneOutput).toContain('Debt reset from 5 to 0');

    const sleepFile = join(ctx, 'state', '.sleep.json');
    const state = JSON.parse(readFileSync(sleepFile, 'utf-8'));
    expect(state.debt).toBe(0);
    expect(state.sessions).toHaveLength(0);
  });

  it('records the consolidation epoch in .sleep.json when started', () => {
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: test\n---\n\nTest project.\n',
    );
    run('sleep add 1 Some work', tmpDir);
    run('sleep start', tmpDir);

    const state = JSON.parse(readFileSync(join(ctx, 'state', '.sleep.json'), 'utf-8'));
    expect(state.sleep_started_at).toBeTruthy();

    // Epoch state does not surface in the raw snapshot (consolidation pressure is hook-delivered)
    const output = run('snapshot', tmpDir);
    expect(output).not.toContain('## Sleep State');
  });

  it('.sleep.json is not listed as a task in snapshot', () => {
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: test\n---\n\nTest project.\n',
    );
    run('sleep add 2 Some work', tmpDir);

    // Also add a real task to ensure tasks section shows up
    writeFileSync(
      join(ctx, 'state', 'real-task.md'),
      '---\nstatus: active\npriority: high\nupdated_at: "2026-02-25"\n---\n\nA real task.\n',
    );

    const output = run('snapshot', tmpDir);
    expect(output).toContain('## Active Tasks');
    expect(output).toContain('real-task');
    // .sleep.json should NOT appear as a task
    expect(output).not.toContain('.sleep');
  });

  // --- Post-sleep brain-repo sync wiring (github-cloud-collaboration-brain-repo-sync, M1) ---

  it('sleep done runs the post-sleep brain-repo sync when brainRepo.autoSync is enabled (regression: config must resolve from the PROJECT root, not the _dream_context root)', () => {
    // In-tree mode commits into the CODE repo (the project root) and never
    // pushes, so a real local git repo (no remote) is enough to exercise it.
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir });
    execSync('git config user.name "Test"', { cwd: tmpDir });

    writeFileSync(
      join(ctx, 'state', '.config.json'),
      JSON.stringify(
        {
          platforms: [],
          packs: [],
          multiProduct: false,
          setupVersion: '0.0.0',
          disableNativeMemory: true,
          brainRepo: { mode: 'in-tree', enabled: true, autoSync: true },
        },
        null,
        2,
      ),
    );

    run('sleep add 2 Some work', tmpDir);
    const output = run('sleep done Consolidated with brain sync', tmpDir);

    // Old (buggy) code silently skipped the whole block — `cfg` was always
    // null because readSetupConfig() was handed the `_dream_context` path
    // instead of the project root. On the fix, the gate resolves true and
    // the in-tree commit actually happens.
    expect(output).toContain('Brain sync: committed');

    const log = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' });
    expect(log).toContain('chore(brain): sync (in-tree)');
  });

  // --- C2 needsTaskSync flag clearing (github-cloud-collaboration-brain-repo-sync, M3, review fix 1) ---

  it('sleep done clears a STALE needsTaskSync flag left by an earlier background pull, even when this run\'s own merge found nothing new', () => {
    // In-tree mode, real git, no remote — mirrors the test above. taskBackend
    // is 'github' with NO owner/repo configured, so the task backend's own
    // sync() records an internal error and returns normally (never throws) —
    // exactly the "ran to completion" case the flag-clear must react to.
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir });
    execSync('git config user.name "Test"', { cwd: tmpDir });

    writeFileSync(
      join(ctx, 'state', '.config.json'),
      JSON.stringify(
        {
          platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0', disableNativeMemory: true,
          taskBackend: 'github',
          brainRepo: { mode: 'in-tree', enabled: true, autoSync: true },
        },
        null, 2,
      ),
    );
    // Simulate a PRIOR background pull (session-start's detached spawn) that
    // found task-referencing changes and set the persisted flag, then the
    // remote went quiet — this run's OWN in-tree commit never touches
    // `needsTaskSync` itself (it's an auto/separate-mode-only concept).
    writeFileSync(join(ctx, 'state', '.brain-local.json'), JSON.stringify({ needsTaskSync: true }, null, 2));

    run('sleep add 2 Some work', tmpDir);
    run('sleep done Consolidated, clearing the stale task-sync flag', tmpDir);

    const brainLocal = JSON.parse(readFileSync(join(ctx, 'state', '.brain-local.json'), 'utf-8'));
    expect(brainLocal.needsTaskSync).toBe(false);
  });

  it('dreamcontext tasks sync clears a STALE needsTaskSync flag — the literal documented remedy resolves the nag', () => {
    // Default (local) task backend — sync() is a genuine no-op, no config needed.
    writeFileSync(join(ctx, 'state', '.brain-local.json'), JSON.stringify({ needsTaskSync: true }, null, 2));

    const output = run('tasks sync', tmpDir);
    expect(output).not.toMatch(/error|fail/i);

    const brainLocal = JSON.parse(readFileSync(join(ctx, 'state', '.brain-local.json'), 'utf-8'));
    expect(brainLocal.needsTaskSync).toBe(false);
  });

  // ─── Change C — automation output consumption + the privacy gate ──────────

  describe('automation outputs + private-derivation gate (Change C)', () => {
    // `automations create` auto-approves and writes the machine-local registry
    // (~/.dreamcontext/automations.json) — a test must NEVER let that land on
    // the REAL machine's home directory. `run()`'s execSync has no explicit
    // `env`, so it inherits `process.env` from THIS process; overriding
    // `process.env.HOME` here therefore reaches the spawned CLI too, and
    // `os.homedir()` (which the registry path helpers use) honours $HOME on
    // POSIX. Restore the prior value afterwards and PROVE the real path was
    // untouched — comparing CONTENT, not just existence, since a real dev
    // machine may legitimately already have approvals from actual usage.
    let fakeHome: string;
    let originalHome: string | undefined;
    const realRegistryPath = join(homedir(), '.dreamcontext', 'automations.json');
    let realRegistryBefore: string | null;

    beforeEach(() => {
      originalHome = process.env.HOME;
      realRegistryBefore = existsSync(realRegistryPath) ? readFileSync(realRegistryPath, 'utf-8') : null;
      fakeHome = mkdtempSync(join(tmpdir(), 'dc-sleep-automations-home-'));
      process.env.HOME = fakeHome;
    });

    afterEach(() => {
      if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
      rmSync(fakeHome, { recursive: true, force: true });
      // The load-bearing proof: the real machine's registry is byte-identical
      // to before this test ran — not merely "the test passed".
      const realRegistryAfter = existsSync(realRegistryPath) ? readFileSync(realRegistryPath, 'utf-8') : null;
      expect(realRegistryAfter).toBe(realRegistryBefore);
    });

    function writeAutomationOutput(slug: string, date: string): void {
      const dir = join(ctx, 'automations', 'output', slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${date}.md`), '# output\n', 'utf-8');
    }

    function writeMarker(slug = 'private-notes', outputPath = 'automations/output/private-notes/2026-07-26.md'): string {
      const markerPath = join(ctx, 'state', '.sleep-private-derivation.json');
      mkdirSync(join(ctx, 'state'), { recursive: true });
      writeFileSync(
        markerPath,
        JSON.stringify({
          derivedFrom: [{ slug, outputPath }],
          knowledgePaths: ['knowledge/competitor-notes.md'],
          writtenAt: '2026-07-26T10:00:00.000Z',
        }),
      );
      return markerPath;
    }

    it('sleep start --json carries automationOutputs with shared attached per slug, and skipped populated', () => {
      // Bootstrap: last_consolidated_at is null on a fresh brain, and the
      // documented "null -> consume nothing" rule means no output written
      // BEFORE the first completed cycle is ever picked up. Complete one
      // first so later output files (written with the real, later
      // wall-clock mtime) fall after the boundary.
      run('sleep done Bootstrap cycle', tmpDir);

      run('automations create eod-digest --title "EOD Digest" --days daily --at 18:00 --shared', tmpDir);
      run('automations create private-notes --title "Private Notes" --days daily --at 09:00', tmpDir);

      writeAutomationOutput('eod-digest', '2026-07-26');
      writeAutomationOutput('private-notes', '2026-07-26');
      // A dangling symlink: readdir lists it by name (no implicit stat), the
      // subsequent statSync fails -> lands in `skipped` with reason
      // 'unreadable' (consumption.ts's own documented mechanism). Cheaper
      // than manufacturing 20+ files or a 200KB payload to hit the other
      // two caps.
      const eodDir = join(ctx, 'automations', 'output', 'eod-digest');
      symlinkSync(join(eodDir, 'does-not-exist'), join(eodDir, 'broken.md'));

      const output = run('sleep start --force --json', tmpDir);
      const parsed = JSON.parse(output);
      const bySlug: Record<string, boolean> = Object.fromEntries(
        parsed.automationOutputs.outputs.map((o: { slug: string; shared: boolean }) => [o.slug, o.shared]),
      );
      expect(bySlug['eod-digest']).toBe(true);
      expect(bySlug['private-notes']).toBe(false);
      expect(
        parsed.automationOutputs.skipped.some((s: { reason: string }) => s.reason === 'unreadable'),
      ).toBe(true);
    });

    it('sleep done refuses while a private-derivation marker exists, listing the source slug and knowledge path, and never leaks a -y/--yes shortcut', () => {
      const markerPath = writeMarker();

      const refused = run('sleep done Trying to consolidate', tmpDir);
      expect(refused).toMatch(/Refusing to consolidate/);
      expect(refused).toContain('private-notes');
      expect(refused).toContain('knowledge/competitor-notes.md');
      expect(refused).toContain('--ack-private-derivation');
      expect(existsSync(markerPath)).toBe(true); // a refusal never clears it

      // Deliberately no -y/--yes alias exists for this gate — assert
      // commander rejects it as an unknown option rather than silently
      // acknowledging.
      const withDashY = run('sleep done -y Trying again', tmpDir);
      expect(withDashY).toMatch(/unknown option|error/i);
      expect(existsSync(markerPath)).toBe(true);

      const acked = run('sleep done --ack-private-derivation Consolidating with ack', tmpDir);
      expect(acked).not.toMatch(/Refusing to consolidate/);
      expect(existsSync(markerPath)).toBe(false);
    });

    it('B3 — a refused sleep done leaves sleep_started_at, last_consolidated_at, and the history file UNCHANGED', () => {
      run('sleep start', tmpDir);
      const sleepFile = join(ctx, 'state', '.sleep.json');
      const before = JSON.parse(readFileSync(sleepFile, 'utf-8'));
      const historyFile = join(ctx, 'state', '.sleep-history.json');
      const historyBefore = existsSync(historyFile) ? readFileSync(historyFile, 'utf-8') : null;

      writeMarker();
      run('sleep done Should be refused', tmpDir);

      const after = JSON.parse(readFileSync(sleepFile, 'utf-8'));
      expect(after.sleep_started_at).toBe(before.sleep_started_at);
      expect(after.last_consolidated_at).toBe(before.last_consolidated_at);
      const historyAfter = existsSync(historyFile) ? readFileSync(historyFile, 'utf-8') : null;
      expect(historyAfter).toBe(historyBefore);
    });

    it('sleep start clears a marker stranded by a crashed cycle — a new cycle supersedes the old disclosure', () => {
      const markerPath = writeMarker();

      run('sleep start --force', tmpDir);

      expect(existsSync(markerPath)).toBe(false);
    });

    it('a REFUSED sleep start (live lock, no --force) does NOT clear a stranded marker — no new cycle actually began', () => {
      run('sleep start', tmpDir); // holds a live (non-stale) lock
      const markerPath = writeMarker();

      const output = run('sleep start', tmpDir); // refused: live lock, no --force
      expect(output).toContain('already in progress');
      expect(existsSync(markerPath)).toBe(true);
    });
  });
});
