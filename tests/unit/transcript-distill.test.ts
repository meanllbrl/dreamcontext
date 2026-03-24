import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { distillTranscript, formatDistilled } from '../../src/cli/commands/transcript.js';

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
    expect(result.userMessages.length).toBeGreaterThanOrEqual(2);
    expect(result.userMessages[0]).toContain('First block');
    expect(result.userMessages[0]).toContain('Second block');
    expect(result.userMessages[1]).toContain('success');
    expect(result.userMessages[1]).toContain('Result details');
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
