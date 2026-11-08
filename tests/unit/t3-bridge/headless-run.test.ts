/** `dreamcontext t3-run`: one turn, approvals declined, one document `claude -p` would print. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeJson } from '../../../src/lib/automations/runner.js';
import { estimateGptCostUsd } from '../../../src/lib/model-facts.js';
import { readOnlyAllows, runT3Headless } from '../../../src/lib/t3-bridge/run.js';
import { loadFixture, policyFor, replayFactory } from './replay-harness.js';

const home = () => mkdtempSync(join(tmpdir(), 'dc-headless-'));

describe('headless Codex run', () => {
  it('declines the approval, finishes the turn, and prints one parseable document', async () => {
    const f = loadFixture('tool_call_read_only_on_request');
    const lines: string[] = [];
    const code = await runT3Headless(
      { cwd: f.workspace, prompt: f.prompt, surface: 'automation', model: f.model },
      { write: (l) => lines.push(l), env: {}, home: home(), brain: null, envGate: true, clientFactory: replayFactory(f.transcript), runtimePolicyOverride: policyFor(f) },
    );
    expect(lines).toHaveLength(1);
    const parsed = parseClaudeJson(lines[0]!);
    expect(parsed.parsed).toBe(true);
    expect(parsed.sessionId).toBeTruthy();
    expect(parsed.permissionDenials).toBe(1);
    expect(code).toBe(parsed.isError ? 1 : 0);
  }, 40_000);

  it('refuses a Claude-only surface without starting Codex', async () => {
    const lines: string[] = [];
    const code = await runT3Headless({ cwd: '/tmp', prompt: 'x', surface: 'board-agent' }, { write: (l) => lines.push(l), env: {}, brain: null });
    expect(code).toBe(1);
    expect(parseClaudeJson(lines[0]!)).toMatchObject({ isError: true, parsed: true });
    expect(lines[0]).toContain('read-denies');
  });

  it('refuses a run with no .env gate, before Codex starts', async () => {
    const lines: string[] = [];
    const code = await runT3Headless({ cwd: home(), prompt: 'x', surface: 'automation' }, { write: (l) => lines.push(l), env: {}, home: home(), brain: null });
    expect(code).toBe(1);
    expect(lines[0]).toContain('install --tool codex');
  });

  it('reads a Codex limit the way the switch expects', () => {
    const r = parseClaudeJson(JSON.stringify({ type: 'result', result: 'x', is_error: true, dc_limit: { resetsAtMs: 5 } }));
    expect(r.limit).toEqual({ window: 'unknown', resetsAtMs: 5, via: 'rateLimitEvent' });
  });

  it('estimates cost by tier, and has no estimate for a tier it does not know', () => {
    expect(estimateGptCostUsd('gpt-5.6-terra', { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(14);
    expect(estimateGptCostUsd('gpt-6-luna', { input: 1_000_000 })).toBeCloseTo(0.2);
    expect(estimateGptCostUsd('gpt-reserve', { input: 1 })).toBeNull();
  });

  it('refuses a surface Antigravity cannot hold, naming its own limit, before the agent starts', async () => {
    const lines: string[] = [];
    const code = await runT3Headless({ cwd: '/tmp', prompt: 'x', surface: 'board-agent', tool: 'antigravity' }, { write: (l) => lines.push(l), env: {}, brain: null });
    expect(code).toBe(1);
    const doc = JSON.parse(lines[0]!) as { result: string; dc_tool: string };
    expect(doc.dc_tool).toBe('antigravity');
    expect(doc.result).toContain('reads files without asking');
  });

  it('a read-only Antigravity run allows reads and plain read commands, never an edit', () => {
    expect(readOnlyAllows('Read', { file_path: '/x' })).toBe(true);
    expect(readOnlyAllows('Grep', { pattern: 'x' })).toBe(true);
    expect(readOnlyAllows('Bash', { command: 'cat server/package.json' })).toBe(true);
    expect(readOnlyAllows('Bash', { command: 'cat a > b' })).toBe(false);
    expect(readOnlyAllows('Bash', {})).toBe(false);
    expect(readOnlyAllows('Edit', { file_path: '/x' })).toBe(false);
    expect(readOnlyAllows('Write', { file_path: '/x' })).toBe(false);
    expect(readOnlyAllows('mcp__dreamcontext', {})).toBe(false);
    expect(readOnlyAllows('AskUserQuestion', {})).toBe(false);
  });
});

describe('an Antigravity account out of quota', () => {
  it('is a limit with its reset, never a finished turn', async () => {
    const { antigravityQuotaReply } = await import('../../../src/lib/t3-bridge/run.js');
    const now = 1_000_000;
    const real = 'Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 6 days, 18 hours.';
    expect(antigravityQuotaReply(real, now)).toEqual({ resetsAtMs: now + 6 * 86_400_000 + 18 * 3_600_000 });
    expect(antigravityQuotaReply('Usage Limit Reached', now)).toEqual({ resetsAtMs: null });
    // An answer that merely talks about quotas is an answer.
    expect(antigravityQuotaReply('The API quota for this project is 100 requests per minute.', now)).toBeNull();
    expect(antigravityQuotaReply(`${'x'.repeat(700)} reached your current quota for this period`, now)).toBeNull();
    expect(antigravityQuotaReply(undefined, now)).toBeNull();
  });
});
