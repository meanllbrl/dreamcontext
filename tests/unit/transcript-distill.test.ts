import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import {
  distillTranscript, formatDistilled, isSystemNoiseMessage,
  mergeDistilled, distillSubagents, registerTranscriptCommand,
  type DistilledSection,
} from '../../src/cli/commands/transcript.js';
import { resolveTranscript } from '../../src/lib/transcript-locate.js';
import { readSleepState, writeSleepState } from '../../src/cli/commands/sleep.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-distill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEntry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [] },
    ...overrides,
  });
}

function userMessage(text: string): string {
  return JSON.stringify({
    type: 'human',
    message: { role: 'user', content: text },
  });
}

function assistantText(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

function toolCall(name: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name, input }],
    },
  });
}

describe('distillTranscript', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty sections for non-existent file', () => {
    const result = distillTranscript('/tmp/nonexistent-file.jsonl');
    expect(result.userMessages).toEqual([]);
    expect(result.agentDecisions).toEqual([]);
    expect(result.codeChanges).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.bookmarks).toEqual([]);
  });

  it('returns empty sections for empty file', () => {
    const file = join(tmpDir, 'empty.jsonl');
    writeFileSync(file, '');
    const result = distillTranscript(file);
    expect(result.userMessages).toEqual([]);
  });

  it('extracts user messages', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      userMessage('Add rate limiting to auth endpoints'),
      userMessage('Use the existing middleware pattern'),
    ].join('\n'));

    const result = distillTranscript(file);
    expect(result.userMessages).toHaveLength(2);
    expect(result.userMessages[0]).toContain('rate limiting');
    expect(result.userMessages[1]).toContain('middleware pattern');
  });

  it('extracts user messages from array content (multi-block)', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'First block of text' },
            { type: 'text', text: 'Second block of text' },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Tool result: success' },
            { type: 'tool_result', content: [
              { type: 'text', text: 'Result details here' },
            ]},
          ],
        },
      }),
    ].join('\n'));

    const result = distillTranscript(file);
    // Genuine typed text blocks are kept; tool_result blocks (machine output)
    // are dropped so they can never seed a false 'User correction' bookmark.
    expect(result.userMessages).toHaveLength(2);
    expect(result.userMessages[0]).toContain('First block');
    expect(result.userMessages[0]).toContain('Second block');
    expect(result.userMessages[1]).toContain('success');
    expect(result.userMessages[1]).not.toContain('Result details');
  });

  it('does NOT fold tool_result output into userMessages (false-correction guard)', () => {
    const file = join(tmpDir, 'test.jsonl');
    // A Claude Code tool result arrives as a role:'user' record carrying a
    // tool_result block. Output like "No open tabs" must NOT become a user msg.
    writeFileSync(file, [
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', content: [
              { type: 'text', text: 'No open tabs available' },
            ]},
          ],
        },
      }),
    ].join('\n'));

    const result = distillTranscript(file);
    expect(result.userMessages).toEqual([]);
  });

  it('extracts agent text responses', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      assistantText('I chose token bucket algorithm over sliding window for rate limiting because it handles burst traffic better.'),
    ].join('\n'));

    const result = distillTranscript(file);
    expect(result.agentDecisions).toHaveLength(1);
    expect(result.agentDecisions[0]).toContain('token bucket');
  });

  it('includes all agent responses including trivial ones', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      assistantText('Done!'),
      assistantText('OK'),
      assistantText('This is a longer meaningful response'),
    ].join('\n'));

    const result = distillTranscript(file);
    expect(result.agentDecisions).toHaveLength(3);
    expect(result.agentDecisions[0]).toBe('Done!');
    expect(result.agentDecisions[1]).toBe('OK');
    expect(result.agentDecisions[2]).toContain('meaningful');
  });

  it('extracts Write and Edit tool calls with full content', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      toolCall('Write', { file_path: '/src/middleware/rate-limit.ts', content: 'const limit = 100;\nconst window = 60000;' }),
      toolCall('Edit', { file_path: '/src/routes/auth.ts', old_string: 'if (user) {', new_string: 'if (user && auth.verified) {' }),
    ].join('\n'));

    const result = distillTranscript(file);
    expect(result.codeChanges).toHaveLength(2);
    expect(result.codeChanges[0]).toContain('WRITE /src/middleware/rate-limit.ts');
    expect(result.codeChanges[0]).toContain('2 lines');
    expect(result.codeChanges[0]).toContain('const limit = 100'); // Full content
    expect(result.codeChanges[1]).toContain('EDIT /src/routes/auth.ts');
    expect(result.codeChanges[1]).toContain('--- OLD ---');
    expect(result.codeChanges[1]).toContain('if (user) {');
    expect(result.codeChanges[1]).toContain('--- NEW ---');
    expect(result.codeChanges[1]).toContain('if (user && auth.verified) {');
  });

  it('discards Read, Glob, Grep tool calls (noise)', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      toolCall('Read', { file_path: '/src/config.ts' }),
      toolCall('Glob', { pattern: '**/*.ts' }),
      toolCall('Grep', { pattern: 'rate.*limit' }),
    ].join('\n'));

    const result = distillTranscript(file);
    expect(result.codeChanges).toEqual([]);
    expect(result.agentDecisions).toEqual([]);
  });

  it('extracts modifying Bash commands', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      toolCall('Bash', { command: 'npm install express-rate-limit@7' }),
      toolCall('Bash', { command: 'git commit -m "add rate limiting"' }),
    ].join('\n'));

    const result = distillTranscript(file);
    expect(result.codeChanges).toHaveLength(2);
    expect(result.codeChanges[0]).toContain('npm install');
    expect(result.codeChanges[1]).toContain('git commit');
  });

  it('extracts bookmark bash commands', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      toolCall('Bash', { command: 'dreamcontext bookmark add "Critical: always validate auth tokens" -s 3' }),
    ].join('\n'));

    const result = distillTranscript(file);
    expect(result.bookmarks).toHaveLength(1);
    expect(result.bookmarks[0]).toContain('dreamcontext bookmark');
  });

  it('keeps full user messages (no truncation)', () => {
    const file = join(tmpDir, 'test.jsonl');
    const longMsg = 'A'.repeat(600);
    writeFileSync(file, userMessage(longMsg));

    const result = distillTranscript(file);
    expect(result.userMessages[0].length).toBe(600);
    expect(result.userMessages[0]).not.toContain('...');
  });

  it('handles malformed JSONL lines gracefully', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      'not valid json',
      userMessage('Valid message'),
      '{incomplete',
    ].join('\n'));

    const result = distillTranscript(file);
    expect(result.userMessages).toHaveLength(1);
    expect(result.userMessages[0]).toContain('Valid message');
  });
});

describe('distillTranscript with sinceTimestamp', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('filters out entries before sinceTimestamp', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'human', timestamp: '2026-02-27T10:00:00.000Z', message: { role: 'user', content: 'Old message before consolidation' } }),
      JSON.stringify({ type: 'human', timestamp: '2026-02-27T14:00:00.000Z', message: { role: 'user', content: 'New message after consolidation' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-02-27T14:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'New agent response' }] } }),
    ].join('\n'));

    const result = distillTranscript(file, '2026-02-27T12:00:00.000Z');
    expect(result.userMessages).toHaveLength(1);
    expect(result.userMessages[0]).toContain('New message after consolidation');
    expect(result.agentDecisions).toHaveLength(1);
    expect(result.agentDecisions[0]).toContain('New agent response');
  });

  it('includes all entries when sinceTimestamp is not provided', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'human', timestamp: '2026-02-27T10:00:00.000Z', message: { role: 'user', content: 'First message' } }),
      JSON.stringify({ type: 'human', timestamp: '2026-02-27T14:00:00.000Z', message: { role: 'user', content: 'Second message' } }),
    ].join('\n'));

    const result = distillTranscript(file);
    expect(result.userMessages).toHaveLength(2);
  });

  it('includes entries without timestamp when sinceTimestamp is set', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'human', message: { role: 'user', content: 'No timestamp entry' } }),
      JSON.stringify({ type: 'human', timestamp: '2026-02-27T14:00:00.000Z', message: { role: 'user', content: 'Timestamped entry' } }),
    ].join('\n'));

    // Entries without timestamps pass through (they can't be compared)
    const result = distillTranscript(file, '2026-02-27T12:00:00.000Z');
    expect(result.userMessages).toHaveLength(2);
  });

  it('filters exact timestamp match (entry at sinceTimestamp is excluded)', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'human', timestamp: '2026-02-27T12:00:00.000Z', message: { role: 'user', content: 'At exact boundary' } }),
      JSON.stringify({ type: 'human', timestamp: '2026-02-27T12:00:00.001Z', message: { role: 'user', content: 'Just after boundary' } }),
    ].join('\n'));

    const result = distillTranscript(file, '2026-02-27T12:00:00.000Z');
    expect(result.userMessages).toHaveLength(1);
    expect(result.userMessages[0]).toContain('Just after boundary');
  });

  it('filters code changes and errors by timestamp too', () => {
    const file = join(tmpDir, 'test.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'assistant', timestamp: '2026-02-27T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/old.ts', content: 'old code' } }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-02-27T15:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/new.ts', content: 'new code' } }] } }),
    ].join('\n'));

    const result = distillTranscript(file, '2026-02-27T12:00:00.000Z');
    expect(result.codeChanges).toHaveLength(1);
    expect(result.codeChanges[0]).toContain('/new.ts');
  });
});

describe('formatDistilled', () => {
  it('formats distilled transcript as markdown', () => {
    const output = formatDistilled('sess-123', {
      userMessages: ['Add rate limiting'],
      agentDecisions: ['Chose token bucket algorithm'],
      codeChanges: ['WRITE /src/rate-limit.ts'],
      errors: ['express-rate-limit v7 API changed'],
      bookmarks: ['dreamcontext bookmark "critical constraint"'],
    });

    expect(output).toContain('## Session sess-123');
    expect(output).toContain('### User Messages');
    expect(output).toContain('Add rate limiting');
    expect(output).toContain('### Agent Decisions');
    expect(output).toContain('token bucket');
    expect(output).toContain('### Code Changes');
    expect(output).toContain('WRITE /src/rate-limit.ts');
    expect(output).toContain('### Errors');
    expect(output).toContain('### Bookmarks');
  });

  it('shows since timestamp in header when provided', () => {
    const output = formatDistilled('sess-789', {
      userMessages: ['Test'],
      agentDecisions: [],
      codeChanges: [],
      errors: [],
      bookmarks: [],
    }, '2026-02-27T14:00:00.000Z');

    expect(output).toContain('## Session sess-789 -- Distilled Transcript (since 2026-02-27T14:00:00.000Z)');
  });

  it('omits empty sections', () => {
    const output = formatDistilled('sess-456', {
      userMessages: ['Hello'],
      agentDecisions: [],
      codeChanges: [],
      errors: [],
      bookmarks: [],
    });

    expect(output).toContain('### User Messages');
    expect(output).not.toContain('### Agent Decisions');
    expect(output).not.toContain('### Code Changes');
    expect(output).not.toContain('### Errors');
    expect(output).not.toContain('### Bookmarks');
  });
});

describe('isSystemNoiseMessage', () => {
  it('flags sub-agent task-notification XML blocks', () => {
    expect(isSystemNoiseMessage('<task-notification>Agent foo done</task-notification>')).toBe(true);
    expect(isSystemNoiseMessage('  <task-notification>\n  ...\n  </task-notification>  ')).toBe(true);
  });

  it('flags agent-resume JSON envelopes', () => {
    expect(isSystemNoiseMessage('{"success":true,"message":"Agent abc had no active task; resumed at turn 3"}')).toBe(true);
    expect(isSystemNoiseMessage('{"success":false,"message":"Agent xyz resumed"}')).toBe(true);
  });

  it('flags skill-loader headers', () => {
    expect(isSystemNoiseMessage('Base directory for this skill: /home/u/.claude/skills/foo')).toBe(true);
  });

  it('flags empty/whitespace-only turns', () => {
    expect(isSystemNoiseMessage('   ')).toBe(true);
  });

  it('does NOT flag genuine user messages (even containing "success" or "agent")', () => {
    expect(isSystemNoiseMessage('No, actually use yarn instead of npm here.')).toBe(false);
    expect(isSystemNoiseMessage('The deploy was a success, ship it.')).toBe(false);
    expect(isSystemNoiseMessage('Make the agent retry on failure.')).toBe(false);
    expect(isSystemNoiseMessage('Tool result: success — Result details here')).toBe(false);
  });
});

describe('distillTranscript drops system coordination noise from user messages', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('excludes task-notification, agent-resume JSON, and skill-loader turns', () => {
    const file = join(tmpDir, 'noise.jsonl');
    writeFileSync(file, [
      userMessage('<task-notification>Agent foo finished; no action needed instead.</task-notification>'),
      userMessage('{"success":true,"message":"Agent abc had no active task; resumed instead."}'),
      userMessage('Base directory for this skill: /home/u/.claude/skills/no-instead'),
      userMessage('No, actually use yarn instead of npm here.'),
    ].join('\n'));

    const result = distillTranscript(file);
    // Only the real human correction survives.
    expect(result.userMessages).toEqual(['No, actually use yarn instead of npm here.']);
  });
});

function emptySection(): DistilledSection {
  return { userMessages: [], agentDecisions: [], codeChanges: [], errors: [], bookmarks: [] };
}

describe('mergeDistilled', () => {
  it('merges an empty list into an all-empty section', () => {
    expect(mergeDistilled([])).toEqual(emptySection());
  });

  it('preserves section order and within-section order', () => {
    const a: DistilledSection = { ...emptySection(), userMessages: ['a1', 'a2'], agentDecisions: ['dA'] };
    const b: DistilledSection = { ...emptySection(), userMessages: ['b1'], agentDecisions: ['dB'] };
    const merged = mergeDistilled([a, b]);
    expect(merged.userMessages).toEqual(['a1', 'a2', 'b1']);
    expect(merged.agentDecisions).toEqual(['dA', 'dB']);
  });

  it('dedups identical items within the same array across sections', () => {
    const a: DistilledSection = { ...emptySection(), errors: ['boom'], codeChanges: ['EDIT x'] };
    const b: DistilledSection = { ...emptySection(), errors: ['boom'], codeChanges: ['EDIT x'] };
    const merged = mergeDistilled([a, b]);
    expect(merged.errors).toEqual(['boom']);
    expect(merged.codeChanges).toEqual(['EDIT x']);
  });

  it('dedups within a single section (not just across sections)', () => {
    const a: DistilledSection = { ...emptySection(), bookmarks: ['bm1', 'bm1', 'bm2'] };
    expect(mergeDistilled([a]).bookmarks).toEqual(['bm1', 'bm2']);
  });

  it('does not cross-dedup across different arrays (same string, different fields)', () => {
    const a: DistilledSection = { ...emptySection(), userMessages: ['shared'], errors: ['shared'] };
    const merged = mergeDistilled([a]);
    expect(merged.userMessages).toEqual(['shared']);
    expect(merged.errors).toEqual(['shared']);
  });

  it('does not mutate its inputs', () => {
    const a: DistilledSection = { ...emptySection(), userMessages: ['a1'] };
    const snapshot = JSON.parse(JSON.stringify(a));
    mergeDistilled([a]).userMessages.push('mutated');
    expect(a).toEqual(snapshot);
  });
});

describe('distillSubagents', () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = join(tmpdir(), `ac-subagents-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(sessionDir, 'subagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  /** Real-shape fixture (verified 2026-07-18): the FIRST line of a subagent
   *  transcript is a `fork-context-ref` record with NO `message` field — it
   *  must be skipped by distillTranscript's existing `if (!entry.message) continue`
   *  guard, not treated as an error or a blank entry. */
  function writeSubagentTranscript(agentId: string, text: string): string {
    const p = join(sessionDir, 'subagents', `agent-${agentId}.jsonl`);
    writeFileSync(p, [
      JSON.stringify({ type: 'fork-context-ref', agentId, parentSessionId: 'parent-1', contextLength: 42 }),
      assistantText(text),
    ].join('\n'));
    return p;
  }

  it('returns an all-empty section when sessionDir is null', () => {
    expect(distillSubagents({ mainPath: null, sessionDir: null, layout: 'none' })).toEqual(emptySection());
  });

  it('returns an all-empty section when subagents/ has no matching files', () => {
    const loc = { mainPath: null, sessionDir, layout: 'dir' as const };
    expect(distillSubagents(loc)).toEqual(emptySection());
  });

  it('distills a subagent transcript and prefixes agentDecisions with [subagent:<id>]', () => {
    writeSubagentTranscript('a80407b614ff89f5e', 'Merged the two duplicate knowledge files.');
    const loc = { mainPath: null, sessionDir, layout: 'dir' as const };

    const result = distillSubagents(loc);
    expect(result.agentDecisions).toEqual(['[subagent:a80407b614ff89f5e] Merged the two duplicate knowledge files.']);
    // The fork-context-ref line (no `message`) produced no error/noise entry.
    expect(result.errors).toEqual([]);
  });

  it('does NOT prefix userMessages/codeChanges/errors/bookmarks — only agentDecisions', () => {
    const p = join(sessionDir, 'subagents', 'agent-xyz.jsonl');
    writeFileSync(p, [
      JSON.stringify({ type: 'fork-context-ref', agentId: 'xyz', parentSessionId: 'p', contextLength: 1 }),
      userMessage('a user-role turn inside the subagent transcript'),
    ].join('\n'));
    const loc = { mainPath: null, sessionDir, layout: 'dir' as const };
    const result = distillSubagents(loc);
    expect(result.userMessages).toEqual(['a user-role turn inside the subagent transcript']);
  });

  it('merges multiple subagent transcripts, each tagged with its own id', () => {
    writeSubagentTranscript('agentone', 'Decision from agent one.');
    writeSubagentTranscript('agenttwo', 'Decision from agent two.');
    const loc = { mainPath: null, sessionDir, layout: 'dir' as const };
    const result = distillSubagents(loc);
    expect(result.agentDecisions).toContain('[subagent:agentone] Decision from agent one.');
    expect(result.agentDecisions).toContain('[subagent:agenttwo] Decision from agent two.');
    expect(result.agentDecisions).toHaveLength(2);
  });

  it('honors opts.max, capping the number of subagent transcripts harvested', () => {
    for (let i = 0; i < 5; i++) writeSubagentTranscript(`a${i}`, `Decision ${i}`);
    const loc = { mainPath: null, sessionDir, layout: 'dir' as const };
    const result = distillSubagents(loc, { max: 2 });
    expect(result.agentDecisions).toHaveLength(2);
  });

  it('forwards sinceTimestamp to each subagent distillTranscript call', () => {
    const p = join(sessionDir, 'subagents', 'agent-time.jsonl');
    writeFileSync(p, [
      JSON.stringify({ type: 'fork-context-ref', agentId: 'time', parentSessionId: 'p', contextLength: 1 }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'new' }] } }),
    ].join('\n'));
    const loc = { mainPath: null, sessionDir, layout: 'dir' as const };
    const result = distillSubagents(loc, { sinceTimestamp: '2026-03-01T00:00:00.000Z' });
    expect(result.agentDecisions).toEqual(['[subagent:time] new']);
  });
});

describe('transcript distill CLI — layout fallback + subagent harvest', () => {
  let projectDir: string;
  let contextRoot: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const SID = 'cli-distill-session';

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = join(tmpdir(), `ac-cli-distill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    contextRoot = join(projectDir, '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    process.chdir(projectDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function seedSession(transcriptPath: string): void {
    const state = readSleepState(contextRoot);
    state.sessions.push({
      session_id: SID,
      transcript_path: transcriptPath,
      stopped_at: new Date().toISOString(),
      last_assistant_message: 'done',
      change_count: 0,
      tool_count: 0,
      score: 1,
      task_slugs: [],
    });
    writeSleepState(contextRoot, state);
  }

  function runDistill(args: string[]): Promise<void> {
    const program = new Command();
    registerTranscriptCommand(program);
    return program.parseAsync(['transcript', 'distill', SID, ...args], { from: 'user' });
  }

  it('resolves the flat transcript exactly as before (regression)', async () => {
    const flatPath = join(projectDir, `${SID}.jsonl`);
    writeFileSync(flatPath, assistantText('Chose token bucket for rate limiting.') + '\n');
    seedSession(flatPath);

    await runDistill([]);

    expect(errorSpy).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('token bucket');
  });

  it('errors naming BOTH probed layouts when neither flat file nor session dir exists', async () => {
    const missingFlat = join(projectDir, `${SID}.jsonl`);
    seedSession(missingFlat);

    await runDistill([]);

    expect(errorSpy).toHaveBeenCalled();
    const combined = errorSpy.mock.calls.flat().join(' ');
    expect(combined).toContain('flat');
    expect(combined).toContain('dir');
    expect(combined).toContain(missingFlat);
    expect(combined).toContain(join(projectDir, SID));
  });

  it('errors naming BOTH probed layouts when the session dir exists but holds no main transcript', async () => {
    const missingFlat = join(projectDir, `${SID}.jsonl`);
    const dirPath = join(projectDir, SID);
    mkdirSync(join(dirPath, 'subagents'), { recursive: true });
    mkdirSync(join(dirPath, 'tool-results'), { recursive: true });
    seedSession(missingFlat);

    await runDistill([]);

    expect(errorSpy).toHaveBeenCalled();
    const combined = errorSpy.mock.calls.flat().join(' ');
    expect(combined).toContain('flat');
    expect(combined).toContain(missingFlat);
    expect(combined).toContain(dirPath);
    expect(combined.toLowerCase()).toContain('no main transcript');
  });

  it('--subagents merges sub-agent findings into the output', async () => {
    const flatPath = join(projectDir, `${SID}.jsonl`);
    writeFileSync(flatPath, assistantText('Main agent decision.') + '\n');
    const dirPath = join(projectDir, SID);
    mkdirSync(join(dirPath, 'subagents'), { recursive: true });
    writeFileSync(join(dirPath, 'subagents', 'agent-sub1.jsonl'), [
      JSON.stringify({ type: 'fork-context-ref', agentId: 'sub1', parentSessionId: SID, contextLength: 1 }),
      assistantText('Sub-agent found a duplicate.'),
    ].join('\n'));
    seedSession(flatPath);

    await runDistill(['--subagents']);

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Main agent decision.');
    expect(output).toContain('[subagent:sub1] Sub-agent found a duplicate.');
  });

  it('output is byte-identical whether or not a subagents/ dir exists, when --subagents is omitted', async () => {
    const flatPath = join(projectDir, `${SID}.jsonl`);
    writeFileSync(flatPath, assistantText('Main agent decision only.') + '\n');
    seedSession(flatPath);

    await runDistill([]);
    const withoutDir = logSpy.mock.calls.map((c) => c[0]).join('\n');
    logSpy.mockClear();

    const dirPath = join(projectDir, SID);
    mkdirSync(join(dirPath, 'subagents'), { recursive: true });
    writeFileSync(join(dirPath, 'subagents', 'agent-sub1.jsonl'), [
      JSON.stringify({ type: 'fork-context-ref', agentId: 'sub1', parentSessionId: SID, contextLength: 1 }),
      assistantText('This must NOT appear without --subagents.'),
    ].join('\n'));

    await runDistill([]);
    const withDirButNoFlag = logSpy.mock.calls.map((c) => c[0]).join('\n');

    expect(withDirButNoFlag).toBe(withoutDir);
    expect(withDirButNoFlag).not.toContain('subagent');
  });

  it('resolveTranscript itself confirms the dir-layout fallback used by the CLI', () => {
    const dirPath = join(projectDir, SID);
    mkdirSync(join(dirPath, 'subagents'), { recursive: true });
    const loc = resolveTranscript(join(projectDir, `${SID}.jsonl`), { sessionId: SID });
    expect(loc).toEqual({ mainPath: null, sessionDir: dirPath, layout: 'dir' });
  });
});
