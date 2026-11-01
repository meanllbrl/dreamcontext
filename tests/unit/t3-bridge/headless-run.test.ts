/** `dreamcontext t3-run`: one turn, approvals declined, one document `claude -p` would print. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeJson } from '../../../src/lib/automations/runner.js';
import { estimateGptCostUsd } from '../../../src/lib/model-facts.js';
import { runT3Headless } from '../../../src/lib/t3-bridge/run.js';
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
});
