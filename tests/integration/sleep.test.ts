import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

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
    run('sleep add 2 Bug fix', tmpDir);
    run('sleep add 3 Arch change', tmpDir);

    const output = run('sleep status', tmpDir);
    expect(output).toContain('5');
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

  it('sleep add rejects invalid score', () => {
    const output0 = run('sleep add 0 Invalid', tmpDir);
    expect(output0).toContain('Score must be 1, 2, or 3');

    const output4 = run('sleep add 4 Invalid', tmpDir);
    expect(output4).toContain('Score must be 1, 2, or 3');

    const outputNaN = run('sleep add abc Invalid', tmpDir);
    expect(outputNaN).toContain('Score must be 1, 2, or 3');
  });

  it('snapshot includes sleep state after adds', () => {
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: test\n---\n\nTest project.\n',
    );
    run('sleep add 2 Bug fix', tmpDir);
    run('sleep add 3 Arch change', tmpDir);

    const output = run('snapshot', tmpDir);
    expect(output).toContain('## Sleep State');
    expect(output).toContain('Debt: 5 (Drowsy)');
    expect(output).toContain('Bug fix');
    expect(output).toContain('Arch change');
  });

  it('snapshot omits sleep state when unused', () => {
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: test\n---\n\nTest project.\n',
    );
    const output = run('snapshot', tmpDir);
    expect(output).not.toContain('## Sleep State');
  });

  it('snapshot shows sleep state after done (last_sleep set)', () => {
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: test\n---\n\nTest project.\n',
    );
    run('sleep add 2 Some work', tmpDir);
    run('sleep done Consolidated things', tmpDir);

    const output = run('snapshot', tmpDir);
    expect(output).toContain('## Sleep State');
    expect(output).toContain('Debt: 0 (Alert)');
    expect(output).toContain('Last sleep:');
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

  it('sleep start warns when epoch already set', () => {
    run('sleep start', tmpDir);
    const output = run('sleep start', tmpDir);
    expect(output).toContain('already in progress');
    expect(output).toContain('Consolidation epoch set');
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

  it('snapshot shows consolidation in progress when epoch is set', () => {
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: test\n---\n\nTest project.\n',
    );
    run('sleep add 1 Some work', tmpDir);
    run('sleep start', tmpDir);

    const output = run('snapshot', tmpDir);
    expect(output).toContain('Consolidation in progress');
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
    // But sleep state should still appear in its own section
    expect(output).toContain('## Sleep State');
  });
});
