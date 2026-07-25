/**
 * Unit tests for agent-chat.ts's transcript-history replay (`parseTranscriptHistory`) and
 * the client control-id gate (`sanitizeControlId`) — task_nQb0y85X follow-up work (resumed
 * chats replay their transcript; rewind targets a user entry's transcript uuid). Fixture
 * lines mirror real `~/.claude/projects/<slug>/<uuid>.jsonl` entries observed on CLI
 * 2.1.218 (session scratchpad spikes, 2026-07-24).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseTranscriptHistory, sanitizeControlId, sanitizeSubagentId, handleAgentChatHistory,
} from '../../src/server/routes/agent-chat.js';

const U1 = '13b74217-a64f-4902-a275-2a4c3dd2d67d';
const U2 = '6f345b66-c54e-4978-9011-b6d0f3225b6f';

const jsonl = (entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

describe('parseTranscriptHistory', () => {
  it('replays user text, assistant text/thinking, and merged tool_use+tool_result in order', () => {
    const raw = jsonl([
      { type: 'user', uuid: U1, message: { role: 'user', content: [{ type: 'text', text: 'Write hi to /tmp/x.txt' }] } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan', signature: 's' }] } },
      { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Write', input: { file_path: '/tmp/x.txt' } }] } },
      { type: 'user', uuid: U2, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'wrote 2 bytes', is_error: false }] } },
      { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
    ]);
    expect(parseTranscriptHistory(raw)).toEqual([
      { kind: 'user', uuid: U1, text: 'Write hi to /tmp/x.txt' },
      { kind: 'thinking', text: 'plan' },
      { kind: 'tool', toolUseId: 'toolu_01', name: 'Write', input: { file_path: '/tmp/x.txt' }, status: 'done', result: 'wrote 2 bytes' },
      { kind: 'text', text: 'Done.' },
    ]);
  });

  it('an is_error tool_result flips the merged card to error', () => {
    const raw = jsonl([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'false' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'exit 1', is_error: true }] } },
    ]);
    const [tool] = parseTranscriptHistory(raw);
    expect(tool).toMatchObject({ kind: 'tool', toolUseId: 'toolu_02', status: 'error', result: 'exit 1' });
  });

  it('skips what a human never typed: meta/synthetic entries and <…>-wrapped command/reminder stubs', () => {
    const raw = jsonl([
      { type: 'user', uuid: 'm1', isMeta: true, message: { role: 'user', content: 'Caveat: the messages below…' } },
      { type: 'user', uuid: 'm2', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: '[Your previous response had no visible output.]' }] } },
      { type: 'user', uuid: 'm3', message: { role: 'user', content: '<local-command-stdout>Set model to sonnet</local-command-stdout>' } },
      { type: 'user', uuid: 'm4', message: { role: 'user', content: [{ type: 'text', text: '<command-name>/effort</command-name>' }] } },
      { type: 'user', uuid: U1, message: { role: 'user', content: 'a real question' } },
    ]);
    expect(parseTranscriptHistory(raw)).toEqual([{ kind: 'user', uuid: U1, text: 'a real question' }]);
  });

  it("skips a SUB-AGENT's inlined turns (isSidechain) — a resumed chat must not replay another agent's tool calls as its own", () => {
    // CLI 2.1.220 keeps sub-agent turns in `<uuid>/subagents/agent-<taskId>.jsonl`, so a
    // current main transcript has none of these; an OLDER CLI inlined them, and replaying one
    // would reproduce on resume exactly the leak the live stream path had.
    const raw = jsonl([
      { type: 'user', uuid: U1, message: { role: 'user', content: 'audit the repo with 3 agents' } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: "I'll start by listing the files." }] } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sub', content: 'a.ts' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All three agents finished.' }] } },
    ]);
    expect(parseTranscriptHistory(raw)).toEqual([
      { kind: 'user', uuid: U1, text: 'audit the repo with 3 agents' },
      { kind: 'text', text: 'All three agents finished.' },
    ]);
  });

  it('tolerates foreign entry types, malformed lines, and blank lines (an append-only log written by another program)', () => {
    const raw = [
      JSON.stringify({ type: 'summary', summary: 'A chat about x', leafUuid: 'x' }),
      JSON.stringify({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} }),
      '{ not json',
      '',
      JSON.stringify({ type: 'user', uuid: U1, message: { role: 'user', content: 'hello' } }),
    ].join('\n');
    expect(parseTranscriptHistory(raw)).toEqual([{ kind: 'user', uuid: U1, text: 'hello' }]);
  });

  it('truncates oversized tool results instead of shipping hundreds of KB into the seed payload', () => {
    const raw = jsonl([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_03', name: 'Read', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_03', content: 'x'.repeat(20000) }] } },
    ]);
    const [tool] = parseTranscriptHistory(raw);
    expect(typeof tool.result).toBe('string');
    expect((tool.result as string).length).toBeLessThan(5000);
    expect(tool.result as string).toContain('[truncated]');
  });

  it('caps the replay at the transcript TAIL (the last 500 items), never the head', () => {
    const entries = Array.from({ length: 600 }, (_, i) => (
      { type: 'user', uuid: U1, message: { role: 'user', content: `message ${i}` } }
    ));
    const items = parseTranscriptHistory(jsonl(entries));
    expect(items).toHaveLength(500);
    expect(items[0].text).toBe('message 100');
    expect(items[499].text).toBe('message 599');
  });
});

describe('sanitizeControlId', () => {
  it('passes short token-charset ids through verbatim (they must round-trip for ack matching)', () => {
    expect(sanitizeControlId('sm-chat-1-2')).toBe('sm-chat-1-2');
    expect(sanitizeControlId('rw_ABC-123')).toBe('rw_ABC-123');
  });

  it('rejects everything else to empty (whitespace, injection chars, oversized, non-strings)', () => {
    expect(sanitizeControlId('has space')).toBe('');
    expect(sanitizeControlId('quote"inject')).toBe('');
    expect(sanitizeControlId('x'.repeat(65))).toBe('');
    expect(sanitizeControlId('')).toBe('');
    expect(sanitizeControlId(42)).toBe('');
    expect(sanitizeControlId(undefined)).toBe('');
  });
});

// ─── sanitizeSubagentId (state-9 drill-in follow-up) ────────────────────────────────

describe('sanitizeSubagentId', () => {
  it('passes a task-id-shaped token through verbatim', () => {
    expect(sanitizeSubagentId('ab12cd34')).toBe('ab12cd34');
    expect(sanitizeSubagentId('AB12-cd34')).toBe('AB12-cd34');
  });

  it('rejects traversal and other unsafe input to empty', () => {
    expect(sanitizeSubagentId('../escape')).toBe('');
    expect(sanitizeSubagentId('a/b')).toBe('');
    expect(sanitizeSubagentId('a\0b')).toBe('');
    expect(sanitizeSubagentId('has space')).toBe('');
    expect(sanitizeSubagentId('x'.repeat(129))).toBe('');
    expect(sanitizeSubagentId('')).toBe('');
    expect(sanitizeSubagentId(null)).toBe('');
  });
});

// ─── handleAgentChatHistory — subagent sidechain drill-in ──────────────────────────
//
// Claude Code writes each dispatched sub-agent's own turns to
// `~/.claude/projects/<slug>/<conversationUuid>/subagents/agent-<taskId>.jsonl` (spike-
// verified, CLI 2.1.218). These tests fake that layout under a scratch HOME and drive the
// real handler end-to-end (not just the pure parser) to prove the server-side derivation.

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as any };
}

function makeReq(url: string): IncomingMessage {
  return { url, headers: {} } as unknown as IncomingMessage;
}

describe('handleAgentChatHistory — subagent param (sidechain transcript)', () => {
  const CONVERSATION = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
  const TASK_ID = 'task-42';
  let tmpHome: string;
  let originalHome: string | undefined;
  let contextRoot: string;

  beforeEach(() => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tmpHome = join(tmpdir(), `dc-chat-history-subagent-${stamp}`);
    const projectDir = join(tmpHome, '.claude', 'projects', 'my-slug');
    mkdirSync(projectDir, { recursive: true });
    // The parent conversation's own transcript — its EXISTENCE + filename is what the
    // sidechain path derives from (findFirstTranscriptPath + basename), never a
    // client-supplied path.
    writeFileSync(join(projectDir, `${CONVERSATION}.jsonl`), '{"type":"user","message":{"role":"user","content":"hi"}}\n', 'utf-8');

    const subagentsDir = join(projectDir, CONVERSATION, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const sidechainLines = [
      // Plain-STRING user content (not an array) — the shape the finding flagged;
      // parseTranscriptHistory must already tolerate this (verified below).
      { type: 'user', uuid: 'sc1', isSidechain: true, agentId: TASK_ID, message: { role: 'user', content: 'Plain string sub-agent instruction' } },
      // An 'attachment' sidechain entry — must be skipped, not just ignored-with-a-warning.
      { type: 'attachment', uuid: 'sc2', isSidechain: true, agentId: TASK_ID, message: { role: 'user', content: 'ignored binary attachment' } },
      { type: 'assistant', uuid: 'sc3', isSidechain: true, agentId: TASK_ID, message: { role: 'assistant', content: [{ type: 'text', text: 'Sub-agent reply' }] } },
    ];
    writeFileSync(
      join(subagentsDir, `agent-${TASK_ID}.jsonl`),
      sidechainLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf-8',
    );

    contextRoot = join(tmpHome, 'vault', '_dream_context');
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    process.env.DREAMCONTEXT_DESKTOP = '1';
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete process.env.DREAMCONTEXT_DESKTOP;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('replays the derived sidechain transcript, tolerating plain-string user content and skipping attachment entries', async () => {
    const { res, status, body } = makeRes();
    await handleAgentChatHistory(
      makeReq(`/api/agent/chat-history?claudeId=${CONVERSATION}&subagent=${TASK_ID}`),
      res, {}, contextRoot,
    );
    expect(status()).toBe(200);
    expect(body().items).toEqual([
      { kind: 'user', uuid: 'sc1', text: 'Plain string sub-agent instruction' },
      { kind: 'text', text: 'Sub-agent reply' },
    ]);
  });

  it('returns items:[] when the sidechain file does not exist yet (not-flushed degrade path)', async () => {
    const { res, status, body } = makeRes();
    await handleAgentChatHistory(
      makeReq(`/api/agent/chat-history?claudeId=${CONVERSATION}&subagent=never-ran`),
      res, {}, contextRoot,
    );
    expect(status()).toBe(200);
    expect(body().items).toEqual([]);
  });

  it('returns the PARENT transcript (unaffected) when no subagent param is given', async () => {
    const { res, status, body } = makeRes();
    await handleAgentChatHistory(makeReq(`/api/agent/chat-history?claudeId=${CONVERSATION}`), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().items).toEqual([{ kind: 'user', text: 'hi' }]);
  });
});
