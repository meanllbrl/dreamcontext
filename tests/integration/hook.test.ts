import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-hook-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function scaffold(root: string): string {
  const ctx = join(root, '_agent_context');
  mkdirSync(join(ctx, 'core', 'features'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });
  // Minimal soul file so snapshot has content
  writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: test\n---\nTest soul.');
  return ctx;
}

/**
 * Run a CLI command with piped stdin via shell.
 * Uses printf to handle JSON with special chars better than echo.
 */
function runWithStdin(cmd: string, stdin: string, cwd: string): string {
  try {
    // Use printf and pipe through shell
    const escaped = stdin.replace(/'/g, "'\\''");
    return execSync(`printf '%s' '${escaped}' | node ${CLI} ${cmd} 2>&1`, {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
      shell: '/bin/bash',
    });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(`node ${CLI} ${cmd} 2>&1`, { cwd, encoding: 'utf-8', timeout: 10000 });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function toolUseLine(name: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input: {} }] },
  });
}

function readSleep(ctx: string): Record<string, unknown> {
  const f = join(ctx, 'state', '.sleep.json');
  if (!existsSync(f)) return {};
  return JSON.parse(readFileSync(f, 'utf-8'));
}

function writeSleep(ctx: string, data: Record<string, unknown>): void {
  writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify(data, null, 2) + '\n');
}

// ─── hook stop ─────────────────────────────────────────────────────────────

describe('hook stop (integration)', () => {
  let tmpDir: string;
  let ctx: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ctx = scaffold(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records session in sessions array with last_assistant_message', () => {
    const input = JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: '/tmp/transcript-abc.jsonl',
      last_assistant_message: 'I refactored the auth module and added tests.',
      hook_event_name: 'Stop',
    });
    runWithStdin('hook stop', input, tmpDir);

    const state = readSleep(ctx);
    const sessions = state.sessions as any[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].session_id).toBe('sess-abc');
    expect(sessions[0].transcript_path).toBe('/tmp/transcript-abc.jsonl');
    expect(sessions[0].last_assistant_message).toBe('I refactored the auth module and added tests.');
    expect(sessions[0].stopped_at).toBeTruthy();
    // Transcript doesn't exist at /tmp/transcript-abc.jsonl, so 0 changes/tools
    expect(sessions[0].score).toBe(0);
    expect(sessions[0].change_count).toBe(0);
    expect(sessions[0].tool_count).toBe(0);
  });

  it('records stopped_at as ISO 8601 timestamp', () => {
    const input = JSON.stringify({ session_id: 'sess-ts', transcript_path: '/tmp/t.jsonl' });
    runWithStdin('hook stop', input, tmpDir);

    const state = readSleep(ctx);
    const sessions = state.sessions as any[];
    const stoppedAt = sessions[0].stopped_at as string;
    expect(new Date(stoppedAt).toISOString()).toBe(stoppedAt);
  });

  it('is idempotent (same session_id updates in place)', () => {
    const input1 = JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: '/tmp/t1.jsonl',
      last_assistant_message: 'First message',
    });
    runWithStdin('hook stop', input1, tmpDir);

    const input2 = JSON.stringify({
      session_id: 'sess-abc',
      transcript_path: '/tmp/t2.jsonl',
      last_assistant_message: 'Updated message',
    });
    runWithStdin('hook stop', input2, tmpDir);

    const state = readSleep(ctx);
    const sessions = state.sessions as any[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].transcript_path).toBe('/tmp/t2.jsonl');
    expect(sessions[0].last_assistant_message).toBe('Updated message');
  });

  it('pushes to front (LIFO) for different session_ids', () => {
    const input1 = JSON.stringify({ session_id: 'sess-1', transcript_path: '/tmp/t1.jsonl' });
    runWithStdin('hook stop', input1, tmpDir);

    const input2 = JSON.stringify({ session_id: 'sess-2', transcript_path: '/tmp/t2.jsonl' });
    runWithStdin('hook stop', input2, tmpDir);

    const state = readSleep(ctx);
    const sessions = state.sessions as any[];
    expect(sessions).toHaveLength(2);
    expect(sessions[0].session_id).toBe('sess-2'); // newest first
    expect(sessions[1].session_id).toBe('sess-1');
  });

  it('adds debt immediately based on transcript analysis', () => {
    const transcriptPath = join(tmpDir, 'stop-transcript.jsonl');
    writeFileSync(transcriptPath, Array(5).fill(toolUseLine('Write')).join('\n'));

    const input = JSON.stringify({ session_id: 'sess-abc', transcript_path: transcriptPath });
    runWithStdin('hook stop', input, tmpDir);

    const state = readSleep(ctx);
    expect(state.debt).toBe(2); // 5 writes -> score 2
    const sessions = state.sessions as any[];
    expect(sessions[0].change_count).toBe(5);
    expect(sessions[0].tool_count).toBe(5);
    expect(sessions[0].score).toBe(2);
  });

  it('preserves existing debt when adding new session', () => {
    writeSleep(ctx, { debt: 5, sessions: [
      { session_id: 'old', transcript_path: null, stopped_at: '2026-02-25T00:00:00Z', last_assistant_message: null, change_count: 3, score: 2 },
    ]});

    // No real transcript -> score 0
    const input = JSON.stringify({ session_id: 'sess-abc', transcript_path: '/tmp/t.jsonl' });
    runWithStdin('hook stop', input, tmpDir);

    const state = readSleep(ctx);
    expect(state.debt).toBe(5); // 5 + 0
  });

  it('does not double-count debt on idempotent stop', () => {
    const transcriptPath = join(tmpDir, 'idem-transcript.jsonl');
    writeFileSync(transcriptPath, Array(4).fill(toolUseLine('Edit')).join('\n'));

    const input = JSON.stringify({ session_id: 'sess-idem', transcript_path: transcriptPath });
    runWithStdin('hook stop', input, tmpDir);
    runWithStdin('hook stop', input, tmpDir);

    const state = readSleep(ctx);
    expect(state.debt).toBe(2); // 4 edits -> score 2, not 4
  });

  it('stores null last_assistant_message when not provided', () => {
    const input = JSON.stringify({ session_id: 'sess-no-msg', transcript_path: '/tmp/t.jsonl' });
    runWithStdin('hook stop', input, tmpDir);

    const state = readSleep(ctx);
    const sessions = state.sessions as any[];
    expect(sessions[0].last_assistant_message).toBeNull();
  });

  it('stores full (not truncated) last_assistant_message', () => {
    const longMessage = 'A'.repeat(2000);
    const input = JSON.stringify({
      session_id: 'sess-long',
      transcript_path: '/tmp/t.jsonl',
      last_assistant_message: longMessage,
    });
    runWithStdin('hook stop', input, tmpDir);

    const state = readSleep(ctx);
    const sessions = state.sessions as any[];
    expect(sessions[0].last_assistant_message).toBe(longMessage);
  });

  it('exits 0 when no _agent_context/ exists', () => {
    const noCtxDir = makeTmpDir();
    try {
      const input = JSON.stringify({ session_id: 'sess-abc', transcript_path: '/tmp/t.jsonl' });
      const output = runWithStdin('hook stop', input, noCtxDir);
      expect(output.trim()).toBe('');
    } finally {
      rmSync(noCtxDir, { recursive: true, force: true });
    }
  });
});

// ─── hook session-start ────────────────────────────────────────────────────

describe('hook session-start (integration)', () => {
  let tmpDir: string;
  let ctx: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ctx = scaffold(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('outputs snapshot on first session (no previous sessions)', () => {
    const input = JSON.stringify({ session_id: 'sess-1', source: 'startup', transcript_path: '/tmp/t1.jsonl' });
    const output = runWithStdin('hook session-start', input, tmpDir);

    expect(output).toContain('# Agent Context');
    expect(output).toContain('Test soul');
  });

  it('analyzes unanalyzed session and adds debt', () => {
    // Create a fake transcript with 5 Write calls
    const transcriptPath = join(tmpDir, 'old-transcript.jsonl');
    writeFileSync(transcriptPath, Array(5).fill(toolUseLine('Write')).join('\n'));

    // Pre-seed: one unanalyzed session
    writeSleep(ctx, {
      debt: 0,
      sessions: [{
        session_id: 'sess-1',
        transcript_path: transcriptPath,
        stopped_at: '2026-02-25T10:00:00.000Z',
        last_assistant_message: 'Did some work',
        change_count: null,
        score: null,
      }],
    });

    const input = JSON.stringify({ session_id: 'sess-2', source: 'startup', transcript_path: '/tmp/t2.jsonl' });
    const output = runWithStdin('hook session-start', input, tmpDir);

    expect(output).toContain('# Agent Context');

    const state = readSleep(ctx);
    // 5 Write calls -> score 2
    expect(state.debt).toBe(2);
    const sessions = state.sessions as any[];
    expect(sessions[0].change_count).toBe(5);
    expect(sessions[0].tool_count).toBe(5);
    expect(sessions[0].score).toBe(2);
  });

  it('skips already-analyzed sessions (resume safety)', () => {
    writeSleep(ctx, {
      debt: 2,
      sessions: [{
        session_id: 'sess-1',
        transcript_path: '/tmp/t.jsonl',
        stopped_at: '2026-02-25T10:00:00.000Z',
        last_assistant_message: 'Work done',
        change_count: 5,
        score: 2,  // already analyzed
      }],
    });

    // Resume same session
    const input = JSON.stringify({ session_id: 'sess-1', source: 'resume', transcript_path: '/tmp/t.jsonl' });
    runWithStdin('hook session-start', input, tmpDir);

    const state = readSleep(ctx);
    expect(state.debt).toBe(2); // unchanged
  });

  it('handles multiple unanalyzed sessions (multi-session)', () => {
    const t1 = join(tmpDir, 't1.jsonl');
    writeFileSync(t1, Array(2).fill(toolUseLine('Write')).join('\n')); // 2 changes -> score 1

    const t2 = join(tmpDir, 't2.jsonl');
    writeFileSync(t2, Array(5).fill(toolUseLine('Edit')).join('\n')); // 5 changes -> score 2

    writeSleep(ctx, {
      debt: 0,
      sessions: [
        {
          session_id: 'sess-2',
          transcript_path: t2,
          stopped_at: '2026-02-25T11:00:00.000Z',
          last_assistant_message: 'Edited files',
          change_count: null,
          score: null,
        },
        {
          session_id: 'sess-1',
          transcript_path: t1,
          stopped_at: '2026-02-25T10:00:00.000Z',
          last_assistant_message: 'Wrote files',
          change_count: null,
          score: null,
        },
      ],
    });

    const input = JSON.stringify({ session_id: 'sess-3', source: 'startup', transcript_path: '/tmp/t3.jsonl' });
    runWithStdin('hook session-start', input, tmpDir);

    const state = readSleep(ctx);
    expect(state.debt).toBe(3); // 1 + 2
    const sessions = state.sessions as any[];
    expect(sessions).toHaveLength(2);
    // Both should be analyzed
    expect(sessions[0].score).toBe(2); // sess-2: 5 edits
    expect(sessions[1].score).toBe(1); // sess-1: 2 writes
  });

  it('sets score 0 for sessions with no transcript', () => {
    writeSleep(ctx, {
      debt: 0,
      sessions: [{
        session_id: 'sess-no-transcript',
        transcript_path: null,
        stopped_at: '2026-02-25T10:00:00.000Z',
        last_assistant_message: 'Read-only session',
        change_count: null,
        score: null,
      }],
    });

    const input = JSON.stringify({ session_id: 'sess-2', source: 'startup', transcript_path: '/tmp/t.jsonl' });
    runWithStdin('hook session-start', input, tmpDir);

    const state = readSleep(ctx);
    expect(state.debt).toBe(0);
    const sessions = state.sessions as any[];
    expect(sessions[0].score).toBe(0);
    expect(sessions[0].change_count).toBe(0);
  });

  it('prepends CRITICAL directive when debt >= 10', () => {
    writeSleep(ctx, { debt: 10, sessions: [] });

    const input = JSON.stringify({ session_id: 'sess-1', source: 'resume', transcript_path: '/tmp/t.jsonl' });
    const output = runWithStdin('hook session-start', input, tmpDir);

    expect(output).toContain('CONSOLIDATION REQUIRED');
    expect(output).toContain('Context files are stale and bloated');
    expect(output).toContain('# Agent Context');
  });

  it('prepends elevated note when debt 7-9', () => {
    writeSleep(ctx, { debt: 8, sessions: [] });

    const input = JSON.stringify({ session_id: 'sess-1', source: 'resume', transcript_path: '/tmp/t.jsonl' });
    const output = runWithStdin('hook session-start', input, tmpDir);

    expect(output).toContain('CONSOLIDATION RECOMMENDED');
    expect(output).toContain('8/10');
  });

  it('shows drowsy directive when debt 4-6', () => {
    writeSleep(ctx, { debt: 5, sessions: [] });

    const input = JSON.stringify({ session_id: 'sess-1', source: 'resume', transcript_path: '/tmp/t.jsonl' });
    const output = runWithStdin('hook session-start', input, tmpDir);

    expect(output).toContain('Sleep debt is 5');
    expect(output).toContain('MUST offer to consolidate');
    expect(output).not.toContain('CONSOLIDATION REQUIRED');
    expect(output).not.toContain('CONSOLIDATION RECOMMENDED');
    expect(output).toContain('# Agent Context');
  });

  it('no directive when debt < 4', () => {
    writeSleep(ctx, { debt: 2, sessions: [] });

    const input = JSON.stringify({ session_id: 'sess-1', source: 'resume', transcript_path: '/tmp/t.jsonl' });
    const output = runWithStdin('hook session-start', input, tmpDir);

    expect(output).not.toContain('CONSOLIDATION');
    expect(output).not.toContain('Sleep debt is');
    expect(output).toContain('# Agent Context');
  });

  it('shows rhythm advisory when 3+ sessions since last sleep', () => {
    writeSleep(ctx, { debt: 1, sessions_since_last_sleep: 4, sessions: [] });

    const input = JSON.stringify({ session_id: 'sess-1', source: 'resume', transcript_path: '/tmp/t.jsonl' });
    const output = runWithStdin('hook session-start', input, tmpDir);

    expect(output).toContain('4 sessions since last consolidation');
    expect(output).toContain('offer to consolidate');
  });

  it('handles missing transcript file gracefully', () => {
    writeSleep(ctx, {
      debt: 0,
      sessions: [{
        session_id: 'sess-1',
        transcript_path: '/tmp/nonexistent-transcript.jsonl',
        stopped_at: '2026-02-25T10:00:00.000Z',
        last_assistant_message: 'Some work',
        change_count: null,
        score: null,
      }],
    });

    const input = JSON.stringify({ session_id: 'sess-2', source: 'startup', transcript_path: '/tmp/t2.jsonl' });
    runWithStdin('hook session-start', input, tmpDir);

    const state = readSleep(ctx);
    expect(state.debt).toBe(0); // No crash, no debt added
    const sessions = state.sessions as any[];
    expect(sessions[0].score).toBe(0); // Analyzed as 0
    expect(sessions[0].change_count).toBe(0);
  });

  it('backward compat: works with old .sleep.json (no sessions field)', () => {
    writeSleep(ctx, {
      debt: 3,
      last_sleep: '2026-01-01',
      last_sleep_summary: 'test',
      entries: [{ date: '2026-02-25', score: 1, description: 'old entry' }],
      last_session_id: 'old-sess',
      last_transcript_path: '/tmp/old.jsonl',
    });

    const input = JSON.stringify({ session_id: 'sess-1', source: 'startup', transcript_path: '/tmp/t.jsonl' });
    const output = runWithStdin('hook session-start', input, tmpDir);

    expect(output).toContain('# Agent Context');
    const state = readSleep(ctx);
    expect(state.debt).toBe(3); // Unchanged (no unanalyzed sessions)
  });

  it('scores debt from tool_count when no Write/Edit present', () => {
    const transcriptPath = join(tmpDir, 'read-only.jsonl');
    writeFileSync(transcriptPath, [toolUseLine('Read'), toolUseLine('Glob')].join('\n'));

    writeSleep(ctx, {
      debt: 0,
      sessions: [{
        session_id: 'sess-1',
        transcript_path: transcriptPath,
        stopped_at: '2026-02-25T10:00:00.000Z',
        last_assistant_message: 'Read-only session',
        change_count: null,
        score: null,
      }],
    });

    const input = JSON.stringify({ session_id: 'sess-2', source: 'startup', transcript_path: '/tmp/t2.jsonl' });
    runWithStdin('hook session-start', input, tmpDir);

    const state = readSleep(ctx);
    // 2 tool calls (Read + Glob) -> toolScore 1, changeScore 0 -> max = 1
    expect(state.debt).toBe(1);
    const sessions = state.sessions as any[];
    expect(sessions[0].score).toBe(1);
    expect(sessions[0].change_count).toBe(0);
    expect(sessions[0].tool_count).toBe(2);
  });

  it('scores debt from tool_count for Bash-heavy sessions', () => {
    const transcriptPath = join(tmpDir, 'bash-heavy.jsonl');
    const lines = [
      ...Array(20).fill(toolUseLine('Bash')),
      ...Array(5).fill(toolUseLine('Read')),
      ...Array(10).fill(toolUseLine('Glob')),
    ];
    writeFileSync(transcriptPath, lines.join('\n'));

    const input = JSON.stringify({ session_id: 'sess-bash', transcript_path: transcriptPath });
    runWithStdin('hook stop', input, tmpDir);

    const state = readSleep(ctx);
    // 35 tools -> toolScore 2, 0 changes -> changeScore 0 -> max = 2
    expect(state.debt).toBe(2);
    const sessions = state.sessions as any[];
    expect(sessions[0].change_count).toBe(0);
    expect(sessions[0].tool_count).toBe(35);
    expect(sessions[0].score).toBe(2);
  });

  it('outputs empty when no _agent_context/', () => {
    const noCtxDir = makeTmpDir();
    try {
      const input = JSON.stringify({ session_id: 'sess-1', source: 'startup', transcript_path: '/tmp/t.jsonl' });
      const output = runWithStdin('hook session-start', input, noCtxDir);
      expect(output.trim()).toBe('');
    } finally {
      rmSync(noCtxDir, { recursive: true, force: true });
    }
  });

  it('accumulates debt across full stop/start lifecycle', () => {
    // Session 1 transcript: 2 writes
    const t1 = join(tmpDir, 't1.jsonl');
    writeFileSync(t1, [toolUseLine('Write'), toolUseLine('Write')].join('\n'));

    // Session 2 transcript: 5 edits
    const t2 = join(tmpDir, 't2.jsonl');
    writeFileSync(t2, Array(5).fill(toolUseLine('Edit')).join('\n'));

    // Stop hook records session 1 and scores immediately (2 writes -> +1)
    const stop1 = JSON.stringify({ session_id: 'sess-1', transcript_path: t1, last_assistant_message: 'Session 1 work' });
    runWithStdin('hook stop', stop1, tmpDir);

    let state = readSleep(ctx);
    expect(state.debt).toBe(1); // scored at stop time

    // Session 2 starts: no unanalyzed sessions, just outputs snapshot
    const input2 = JSON.stringify({ session_id: 'sess-2', source: 'startup', transcript_path: '/tmp/t2.jsonl' });
    runWithStdin('hook session-start', input2, tmpDir);

    // Stop hook records session 2 and scores immediately (5 edits -> +2)
    const stop2 = JSON.stringify({ session_id: 'sess-2', transcript_path: t2, last_assistant_message: 'Session 2 work' });
    runWithStdin('hook stop', stop2, tmpDir);

    state = readSleep(ctx);
    expect(state.debt).toBe(3); // 1 + 2
    const sessions = state.sessions as any[];
    expect(sessions).toHaveLength(2);
    expect(sessions[0].score).toBe(2); // sess-2
    expect(sessions[1].score).toBe(1); // sess-1
  });

  it('snapshot includes last session summary from sessions array', () => {
    writeSleep(ctx, {
      debt: 2,
      sessions: [{
        session_id: 'sess-1',
        transcript_path: '/tmp/t.jsonl',
        stopped_at: '2026-02-25T10:30:00.000Z',
        last_assistant_message: 'Refactored the auth module with JWT validation.',
        change_count: 5,
        score: 2,
      }],
    });

    const output = run('snapshot', tmpDir);
    expect(output).toContain('Last session ended: 2026-02-25T10:30:00.000Z');
    expect(output).toContain('Last session summary: Refactored the auth module');
  });

  it('snapshot includes tool_count in session entries', () => {
    writeSleep(ctx, {
      debt: 2,
      sessions: [{
        session_id: 'sess-1',
        transcript_path: '/tmp/t.jsonl',
        stopped_at: '2026-02-25T10:30:00.000Z',
        last_assistant_message: 'Bash-heavy session.',
        change_count: 0,
        tool_count: 35,
        score: 2,
      }],
    });

    const output = run('snapshot', tmpDir);
    expect(output).toContain('0 changes');
    expect(output).toContain('35 tools');
  });
});

// ─── hook subagent-start ──────────────────────────────────────────────────

describe('hook subagent-start (integration)', () => {
  let tmpDir: string;
  let ctx: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ctx = scaffold(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('outputs valid JSON with hookSpecificOutput.additionalContext', () => {
    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SubagentStart');
  });

  it('additionalContext contains sub-agent briefing header', () => {
    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    const ctx_text = parsed.hookSpecificOutput.additionalContext;
    expect(ctx_text).toContain('Sub-agent Briefing');
  });

  it('includes project summary from soul file', () => {
    // scaffold() creates soul file with "Test soul." content
    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    const ctx_text = parsed.hookSpecificOutput.additionalContext;
    expect(ctx_text).toContain('test');
  });

  it('includes active tasks', () => {
    // Create a task file
    mkdirSync(join(ctx, 'state'), { recursive: true });
    writeFileSync(join(ctx, 'state', 'fix-auth-bug.md'), [
      '---',
      'status: in_progress',
      'priority: high',
      'created_at: "2026-02-25"',
      '---',
      'Fix the auth bug.',
    ].join('\n'));

    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    const ctx_text = parsed.hookSpecificOutput.additionalContext;
    expect(ctx_text).toContain('fix-auth-bug');
    expect(ctx_text).toContain('in_progress');
  });

  it('includes knowledge index', () => {
    mkdirSync(join(ctx, 'knowledge'), { recursive: true });
    writeFileSync(join(ctx, 'knowledge', 'api-patterns.md'), [
      '---',
      'name: API Patterns',
      'description: REST API design patterns used in this project',
      'tags: [api, architecture]',
      '---',
      '# API Patterns',
      'We use RESTful conventions.',
    ].join('\n'));

    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    const ctx_text = parsed.hookSpecificOutput.additionalContext;
    expect(ctx_text).toContain('api-patterns');
    expect(ctx_text).toContain('REST API design patterns');
    expect(ctx_text).toContain('[api, architecture]');
  });

  it('includes pinned knowledge full content', () => {
    mkdirSync(join(ctx, 'knowledge'), { recursive: true });
    writeFileSync(join(ctx, 'knowledge', 'critical-info.md'), [
      '---',
      'name: Critical Info',
      'description: Must-know information',
      'tags: [architecture]',
      'pinned: true',
      '---',
      '# Critical Info',
      'This content should appear in full in the briefing.',
    ].join('\n'));

    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    const ctx_text = parsed.hookSpecificOutput.additionalContext;
    expect(ctx_text).toContain('This content should appear in full in the briefing.');
  });

  it('does NOT include soul/user/memory full content', () => {
    writeFileSync(join(ctx, 'core', '0.soul.md'), [
      '---',
      'name: test',
      '---',
      '## Project Identity',
      'This is a detailed soul file with lots of identity context.',
      '## Constraints',
      'Never do X. Always do Y.',
    ].join('\n'));
    writeFileSync(join(ctx, 'core', '1.user.md'), [
      '---',
      'name: user',
      '---',
      '## User Preferences',
      'The user prefers dark mode and vim keybindings.',
    ].join('\n'));
    writeFileSync(join(ctx, 'core', '2.memory.md'), [
      '---',
      'name: memory',
      '---',
      '## Active Memory',
      '### 2026-02-25 - Session Log Entry',
      'Detailed memory content about past sessions.',
    ].join('\n'));

    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    const ctx_text = parsed.hookSpecificOutput.additionalContext;
    // Should NOT contain full soul sections
    expect(ctx_text).not.toContain('## Constraints');
    expect(ctx_text).not.toContain('Never do X. Always do Y.');
    // Should NOT contain user preferences
    expect(ctx_text).not.toContain('## User Preferences');
    expect(ctx_text).not.toContain('vim keybindings');
    // Should NOT contain memory content
    expect(ctx_text).not.toContain('## Active Memory');
    expect(ctx_text).not.toContain('Session Log Entry');
  });

  it('does NOT include sleep state', () => {
    writeSleep(ctx, { debt: 8, sessions: [{
      session_id: 'sess-1',
      transcript_path: '/tmp/t.jsonl',
      stopped_at: '2026-02-25T10:00:00.000Z',
      last_assistant_message: 'Some work done',
      change_count: 5,
      score: 2,
    }]});

    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    const ctx_text = parsed.hookSpecificOutput.additionalContext;
    expect(ctx_text).not.toContain('Sleep State');
    expect(ctx_text).not.toContain('Debt');
    expect(ctx_text).not.toContain('Drowsy');
  });

  it('exits silently when no _agent_context/', () => {
    const noCtxDir = makeTmpDir();
    try {
      const output = run('hook subagent-start', noCtxDir);
      expect(output.trim()).toBe('');
    } finally {
      rmSync(noCtxDir, { recursive: true, force: true });
    }
  });

  it('handles minimal context (only soul file, no knowledge, no tasks)', () => {
    // scaffold() already creates minimal soul file
    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    const ctx_text = parsed.hookSpecificOutput.additionalContext;
    expect(ctx_text).toContain('Sub-agent Briefing');
    expect(ctx_text).toContain('MANDATORY');
  });

  it('includes context directory reference', () => {
    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    const ctx_text = parsed.hookSpecificOutput.additionalContext;
    expect(ctx_text).toContain('Context Directory');
    expect(ctx_text).toContain('_agent_context/core/');
    expect(ctx_text).toContain('_agent_context/knowledge/');
    expect(ctx_text).toContain('features/');
  });

  it('includes extended core files index', () => {
    writeFileSync(join(ctx, 'core', '4.tech_stack.md'), [
      '---',
      'name: Tech Stack',
      'type: reference',
      'summary: TypeScript CLI with Node.js',
      '---',
      '# Tech Stack',
      'Node.js + TypeScript',
    ].join('\n'));

    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    const ctx_text = parsed.hookSpecificOutput.additionalContext;
    expect(ctx_text).toContain('Core Files');
    expect(ctx_text).toContain('Tech Stack');
    expect(ctx_text).toContain('TypeScript CLI with Node.js');
  });

  it('includes features in briefing with name, status, and why', () => {
    mkdirSync(join(ctx, 'core', 'features'), { recursive: true });
    writeFileSync(join(ctx, 'core', 'features', 'web-dashboard.md'), [
      '---',
      'status: active',
      'tags: [frontend, architecture]',
      'related_tasks: [web-dashboard]',
      '---',
      '',
      '## Why',
      '',
      'Users need a visual interface to manage agent context without using the terminal.',
      '',
      '## User Stories',
      '',
      '- As a user, I want a Kanban board',
    ].join('\n'));

    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    const ctx_text = parsed.hookSpecificOutput.additionalContext;
    expect(ctx_text).toContain('## Features');
    expect(ctx_text).toContain('web-dashboard');
    expect(ctx_text).toContain('Tags: frontend, architecture');
    expect(ctx_text).toContain('visual interface');
    expect(ctx_text).toContain('Tasks: web-dashboard');
    // Each feature includes a direct read path
    expect(ctx_text).toContain('--> Read: _agent_context/core/features/web-dashboard.md');
  });

  it('includes top-priority directive to check context before searching', () => {
    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    const ctx_text = parsed.hookSpecificOutput.additionalContext;
    expect(ctx_text).toContain('MANDATORY');
    expect(ctx_text).toContain('MUST check the feature list');
    expect(ctx_text).toContain('BEFORE using Glob, Grep, or searching code');
    // Directive should appear near the start (within first 500 chars)
    expect(ctx_text.indexOf('MANDATORY')).toBeLessThan(500);
  });

  it('includes Task Awareness section with plan-to-task workflow', () => {
    const output = run('hook subagent-start', tmpDir);
    const parsed = JSON.parse(output);
    const ctx_text = parsed.hookSpecificOutput.additionalContext;
    expect(ctx_text).toContain('## Task Awareness');
    expect(ctx_text).toContain('linked to a task');
    expect(ctx_text).toContain('agentcontext tasks create');
    expect(ctx_text).toContain('save this plan as an agentcontext task');
  });
});

// ─── hook pre-tool-use ────────────────────────────────────────────────────

describe('hook pre-tool-use (integration)', () => {
  let tmpDir: string;
  let ctx: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ctx = scaffold(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks default Explore agent when _agent_context/ exists', () => {
    const input = JSON.stringify({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find auth files' },
    });
    const output = runWithStdin('hook pre-tool-use', input, tmpDir);
    const parsed = JSON.parse(output);

    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('agentcontext-explore');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('Default Explorer blocked');
  });

  it('allows default Explore agent when no _agent_context/ exists', () => {
    const noCtxDir = makeTmpDir();
    try {
      const input = JSON.stringify({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'Explore', prompt: 'Find auth files' },
      });
      const output = runWithStdin('hook pre-tool-use', input, noCtxDir);
      // Should exit 0 with no output (allow)
      expect(output.trim()).toBe('');
    } finally {
      rmSync(noCtxDir, { recursive: true, force: true });
    }
  });

  it('allows non-Explore Agent calls (Plan)', () => {
    const input = JSON.stringify({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Plan', prompt: 'Plan the auth feature' },
    });
    const output = runWithStdin('hook pre-tool-use', input, tmpDir);
    expect(output.trim()).toBe('');
  });

  it('allows non-Explore Agent calls (agentcontext-rem-sleep)', () => {
    const input = JSON.stringify({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'agentcontext-rem-sleep', prompt: 'Consolidate' },
    });
    const output = runWithStdin('hook pre-tool-use', input, tmpDir);
    expect(output.trim()).toBe('');
  });

  it('allows agentcontext-explore Agent calls (our custom explorer)', () => {
    const input = JSON.stringify({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'agentcontext-explore', prompt: 'Find auth files' },
    });
    const output = runWithStdin('hook pre-tool-use', input, tmpDir);
    expect(output.trim()).toBe('');
  });

  it('allows non-Agent tool calls (Bash, Read, etc.)', () => {
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    });
    const output = runWithStdin('hook pre-tool-use', input, tmpDir);
    expect(output.trim()).toBe('');
  });

  it('allows when no stdin provided', () => {
    const output = run('hook pre-tool-use', tmpDir);
    expect(output.trim()).toBe('');
  });

  it('deny reason mentions context files as the reason for blocking', () => {
    const input = JSON.stringify({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'Find files' },
    });
    const output = runWithStdin('hook pre-tool-use', input, tmpDir);
    const parsed = JSON.parse(output);
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;

    expect(reason).toContain('_agent_context/');
    expect(reason).toContain('context files first');
    expect(reason).toContain('saving thousands of tokens');
  });
});

// ─── hook user-prompt-submit ────────────────────────────────────────────────

describe('hook user-prompt-submit (integration)', () => {
  let tmpDir: string;
  let ctx: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ctx = scaffold(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('silent when debt < 4 (no output)', () => {
    writeSleep(ctx, { debt: 2, sessions: [], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [] });
    const input = JSON.stringify({ session_id: 'sess-1', prompt: 'hello' });
    const output = runWithStdin('hook user-prompt-submit', input, tmpDir);
    expect(output.trim()).toBe('');
  });

  it('outputs reminder when debt is 5 (Drowsy range)', () => {
    writeSleep(ctx, { debt: 5, sessions: [], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [] });
    const input = JSON.stringify({ session_id: 'sess-1', prompt: 'fix the bug' });
    const output = runWithStdin('hook user-prompt-submit', input, tmpDir);
    expect(output).toContain('Sleep debt is 5');
    expect(output).toContain('offer to consolidate');
  });

  it('outputs stronger message when debt is 8 (Sleepy range)', () => {
    writeSleep(ctx, { debt: 8, sessions: [], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [] });
    const input = JSON.stringify({ session_id: 'sess-1', prompt: 'add feature' });
    const output = runWithStdin('hook user-prompt-submit', input, tmpDir);
    expect(output).toContain('Sleep debt is 8');
    expect(output).toContain('recommended');
  });

  it('outputs REQUIRED message when debt >= 10', () => {
    writeSleep(ctx, { debt: 12, sessions: [], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [] });
    const input = JSON.stringify({ session_id: 'sess-1', prompt: 'do something' });
    const output = runWithStdin('hook user-prompt-submit', input, tmpDir);
    expect(output).toContain('Sleep debt is 12');
    expect(output).toContain('CONSOLIDATION REQUIRED');
  });

  it('critical bookmark triggers output even at low debt', () => {
    writeSleep(ctx, {
      debt: 1,
      sessions: [],
      bookmarks: [{ message: 'Switched to GraphQL', salience: 3, created_at: new Date().toISOString() }],
      triggers: [],
      knowledge_access: {},
      dashboard_changes: [],
    });
    const input = JSON.stringify({ session_id: 'sess-1', prompt: 'check status' });
    const output = runWithStdin('hook user-prompt-submit', input, tmpDir);
    expect(output).toContain('critical bookmark');
    expect(output).toContain('consolidation');
  });

  it('silent when no context root exists (graceful exit)', () => {
    const emptyDir = makeTmpDir();
    const input = JSON.stringify({ session_id: 'sess-1', prompt: 'hello' });
    const output = runWithStdin('hook user-prompt-submit', input, emptyDir);
    expect(output.trim()).toBe('');
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

// ─── hook post-tool-use ─────────────────────────────────────────────────────

describe('hook post-tool-use (integration)', () => {
  let tmpDir: string;
  let ctx: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ctx = scaffold(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits silently for non-Edit/Write tools', () => {
    const input = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test.ts' },
    });
    const output = runWithStdin('hook post-tool-use', input, tmpDir);
    expect(output.trim()).toBe('');
  });

  it('exits silently for non-JS/TS files', () => {
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.py' },
    });
    const output = runWithStdin('hook post-tool-use', input, tmpDir);
    expect(output.trim()).toBe('');
  });

  it('exits silently when no formatter or tsconfig found', () => {
    const filePath = join(tmpDir, 'orphan.ts');
    writeFileSync(filePath, 'const x = 1;');
    const input = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: filePath },
    });
    const output = runWithStdin('hook post-tool-use', input, tmpDir);
    expect(output.trim()).toBe('');
  });

  it('exits silently when no stdin provided', () => {
    const output = run('hook post-tool-use', tmpDir);
    expect(output.trim()).toBe('');
  });

  it('exits silently when file_path is missing from tool_input', () => {
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: { content: 'hello' },
    });
    const output = runWithStdin('hook post-tool-use', input, tmpDir);
    expect(output.trim()).toBe('');
  });

  it('outputs JSON with tsc errors when TypeScript errors exist', () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ['*.ts'],
    }));
    const filePath = join(tmpDir, 'bad.ts');
    writeFileSync(filePath, 'const x: number = "not a number";');

    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: filePath },
    });
    const output = runWithStdin('hook post-tool-use', input, tmpDir);

    if (output.trim()) {
      const parsed = JSON.parse(output);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('TypeScript errors');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('bad.ts');
    }
    // Test passes regardless if tsc is not installed (graceful skip)
  });
});

// ─── hook pre-compact ───────────────────────────────────────────────────────

describe('hook pre-compact (integration)', () => {
  let tmpDir: string;
  let ctx: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ctx = scaffold(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves compaction record to sleep state', () => {
    writeSleep(ctx, {
      debt: 5,
      sessions: [{ session_id: 'sess-1', transcript_path: null, stopped_at: '2026-03-01T00:00:00Z', last_assistant_message: 'test', change_count: 3, tool_count: 10, score: 2 }],
      bookmarks: [{ id: 'bk-1', message: 'test bookmark', salience: 2, created_at: '2026-03-01T00:00:00Z', session_id: 'sess-1' }],
      triggers: [],
      knowledge_access: {},
      dashboard_changes: [],
      compaction_log: [],
    });

    const input = JSON.stringify({ trigger: 'auto', custom_instructions: '' });
    runWithStdin('hook pre-compact', input, tmpDir);

    const state = readSleep(ctx);
    const log = state.compaction_log as any[];
    expect(log).toHaveLength(1);
    expect(log[0].trigger).toBe('auto');
    expect(log[0].debt_at_compaction).toBe(5);
    expect(log[0].sessions_count).toBe(1);
    expect(log[0].bookmarks_count).toBe(1);
    expect(log[0].timestamp).toBeTruthy();
  });

  it('records manual trigger type', () => {
    writeSleep(ctx, { debt: 0, sessions: [], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [], compaction_log: [] });
    const input = JSON.stringify({ trigger: 'manual' });
    runWithStdin('hook pre-compact', input, tmpDir);

    const state = readSleep(ctx);
    const log = state.compaction_log as any[];
    expect(log[0].trigger).toBe('manual');
  });

  it('caps compaction_log at 20 entries', () => {
    const existingLog = Array.from({ length: 20 }, (_, i) => ({
      timestamp: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      trigger: 'auto',
      debt_at_compaction: i,
      sessions_count: 0,
      bookmarks_count: 0,
    }));
    writeSleep(ctx, { debt: 0, sessions: [], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [], compaction_log: existingLog });

    const input = JSON.stringify({ trigger: 'manual' });
    runWithStdin('hook pre-compact', input, tmpDir);

    const state = readSleep(ctx);
    const log = state.compaction_log as any[];
    expect(log).toHaveLength(20);
    expect(log[0].trigger).toBe('manual'); // newest first (LIFO)
  });

  it('exits silently when no _agent_context/', () => {
    const noCtxDir = makeTmpDir();
    const input = JSON.stringify({ trigger: 'auto' });
    const output = runWithStdin('hook pre-compact', input, noCtxDir);
    expect(output.trim()).toBe('');
    rmSync(noCtxDir, { recursive: true, force: true });
  });

  it('handles missing stdin gracefully (trigger defaults to unknown)', () => {
    writeSleep(ctx, { debt: 0, sessions: [], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [], compaction_log: [] });
    // No stdin - the hook should still work
    const output = run('hook pre-compact', tmpDir);

    const state = readSleep(ctx);
    const log = state.compaction_log as any[];
    expect(log).toHaveLength(1);
    expect(log[0].trigger).toBe('unknown');
  });
});
