import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { runAutomation, type SpawnImpl } from '../../src/lib/automations/runner.js';
import { automationAccountWithoutProbe, pickAutomationAccount } from '../../src/lib/automations/account.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { readThread } from '../../src/lib/automations/threads.js';
import { sandboxDirFor, setSwitchPolicy, upsertClaudeAccount } from '../../src/lib/claude-accounts.js';
import { readAccountRejections, recordAccountRejection } from '../../src/lib/claude-limit-rejections.js';
import type { ProbeOutcome } from '../../src/lib/claude-usage-probe.js';

/**
 * AUTOMATIONS USE EVERY ACCOUNT, not only the preferred one.
 *
 * Reported 2026-09-28 with a screenshot: two Monday-morning runs both failed at the 5-hour
 * limit ("Nothing was published") while the owner's second signed-in account had room.
 * Chat already moved to another account; automations went out on the preferred account
 * whatever its state and ended there. These tests hold both halves of the fix: the pick
 * BEFORE the spawn, and the move to the next account when the API refuses mid-run.
 */

const NOW = new Date('2026-09-28T09:00:00.000Z');
const BANNER = "You've hit your session limit · resets 2pm (Europe/Istanbul)";

let projectRoot: string;
let contextRoot: string;
let home: string;

function addAccounts(): void {
  upsertClaudeAccount({
    id: 'first', accountUuid: 'uuid-first', email: 'first@example.test', organizationUuid: 'org',
    organizationName: 'Example Org', tier: 'max', configDir: null, preferred: true,
  }, home);
  upsertClaudeAccount({
    id: 'second', accountUuid: 'uuid-second', email: 'second@example.test', organizationUuid: 'org',
    organizationName: 'Example Org', tier: 'max', configDir: sandboxDirFor('second', home), preferred: false,
  }, home);
}

function limits(percent: number): ProbeOutcome {
  return {
    status: 'ok',
    limits: {
      limits: [
        { key: 'session', percent, resetsAt: NOW.getTime() + 2 * 3_600_000 },
        { key: 'weekly', percent: 10, resetsAt: NOW.getTime() + 3 * 86_400_000 },
      ],
      fetchedAtMs: NOW.getTime(),
    },
  };
}

function envelope(result: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'sess_1', result, is_error: false, permission_denials: [],
    total_cost_usd: 0.01, num_turns: 1, duration_ms: 900, subtype: 'success', ...extra,
  });
}

/** One fake child per spawn, each answering with the next scripted stdout. */
function scriptedSpawn(outputs: string[]): { impl: SpawnImpl; calls: Array<{ args: string[]; env: Record<string, string | undefined> }> } {
  const calls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
  const impl = vi.fn((_bin: string, args: string[], options: { env?: Record<string, string | undefined> }) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 7000 + calls.length, stdout, stderr, kill: () => {} });
    const out = outputs[calls.length] ?? envelope('unexpected extra spawn');
    calls.push({ args, env: options.env ?? {} });
    setImmediate(() => {
      stdout.emit('data', Buffer.from(out, 'utf-8'));
      child.emit('close', 0);
    });
    return child;
  }) as unknown as SpawnImpl;
  return { impl, calls };
}

function createApproved(slug: string): void {
  const manifest = createAutomation(contextRoot, {
    slug, title: `Test ${slug}`, days: 'daily', at: '09:00', prompt: 'Write the digest.',
  });
  approveAutomation(projectRoot, manifest, NOW, home);
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-auto-account-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-auto-account-home-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('picking the account before the run', () => {
  it('one account: the preferred one, synchronously, with no probe', () => {
    const probe = vi.fn();
    expect(automationAccountWithoutProbe({ home, probe })).toEqual({ id: null, configDir: home, label: null });
    expect(probe).not.toHaveBeenCalled();
  });

  it('a preferred account the API already refused hands the run to the next one', async () => {
    addAccounts();
    recordAccountRejection('first', { window: 'session', resetsAtMs: NOW.getTime() + 3_600_000, via: 'apiError' }, home, NOW.getTime());
    const probe = vi.fn(async () => limits(20));
    expect(automationAccountWithoutProbe({ home, probe, now: NOW.getTime() })).toBeNull();
    const picked = await pickAutomationAccount({ home, probe, now: NOW.getTime() });
    expect(picked.id).toBe('second');
    expect(picked.configDir).toBe(sandboxDirFor('second', home));
  });

  it('score: a preferred account at the wall is left for one with room', async () => {
    addAccounts();
    const probe = vi.fn(async (dir: string) => (dir === home ? limits(95) : limits(15)));
    const picked = await pickAutomationAccount({ home, probe, now: NOW.getTime() });
    expect(picked.id).toBe('second');
  });

  it('score: a preferred account with room keeps the run', async () => {
    addAccounts();
    const probe = vi.fn(async () => limits(30));
    expect((await pickAutomationAccount({ home, probe, now: NOW.getTime() })).id).toBe('first');
  });

  it('sequential never forecasts: the preferred account serves until it is refused', () => {
    addAccounts();
    setSwitchPolicy({ strategy: 'sequential' }, home);
    const probe = vi.fn();
    expect(automationAccountWithoutProbe({ home, probe, now: NOW.getTime() })?.id).toBe('first');
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('a run the API refuses moves to the next account', () => {
  it('continues on the second account, publishes, and records the refusal', async () => {
    addAccounts();
    setSwitchPolicy({ strategy: 'sequential' }, home);
    createApproved('digest');
    const { impl, calls } = scriptedSpawn([envelope(BANNER), envelope('# Digest\n\nAll good.\n')]);
    const outcome = await runAutomation(contextRoot, 'digest', {
      now: () => NOW, home, spawnImpl: impl, killImpl: vi.fn(), notify: () => {}, log: () => {},
      probeUsage: async () => limits(10),
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.outputPath).not.toBeNull();
    expect(calls).toHaveLength(2);
    // First attempt on the machine's own account (no CLAUDE_CONFIG_DIR), second in the sandbox.
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(calls[1].env.CLAUDE_CONFIG_DIR).toBe(sandboxDirFor('second', home));
    // Refused on its first turn: nothing to continue, so the job starts over, not a resume.
    expect(calls[1].args).not.toContain('--resume');
    expect(Object.keys(readAccountRejections(home))).toEqual(['first']);
    const thread = readThread(contextRoot, 'digest');
    expect(thread.some((e) => e.text.includes('Continuing on second@example.test'))).toBe(true);
    expect(thread.filter((e) => e.text === 'Run started.')).toHaveLength(1);
  });

  it('a run that had already worked resumes its own session on the next account', async () => {
    addAccounts();
    setSwitchPolicy({ strategy: 'sequential' }, home);
    createApproved('digest');
    const { impl, calls } = scriptedSpawn([
      envelope(BANNER, { num_turns: 7, session_id: 'sess_worked' }),
      envelope('# Digest\n\nDone.\n'),
    ]);
    const outcome = await runAutomation(contextRoot, 'digest', {
      now: () => NOW, home, spawnImpl: impl, killImpl: vi.fn(), notify: () => {}, log: () => {},
      probeUsage: async () => limits(10),
    });
    expect(outcome.status).toBe('ok');
    expect(calls[1].args.slice(0, 2)).toEqual(['--resume', 'sess_worked']);
  });

  it('the sandboxed account gets the machine\'s MCP servers by reference; account #0 needs none', async () => {
    addAccounts();
    setSwitchPolicy({ strategy: 'sequential' }, home);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { slack: { type: 'stdio', command: 'slack-mcp' } } }));
    createApproved('digest');
    const { impl, calls } = scriptedSpawn([envelope(BANNER), envelope('# Digest\n\nAll good.\n')]);
    const outcome = await runAutomation(contextRoot, 'digest', {
      now: () => NOW, home, spawnImpl: impl, killImpl: vi.fn(), notify: () => {}, log: () => {},
      probeUsage: async () => limits(10),
    });
    expect(outcome.status).toBe('ok');
    expect(calls[0].args).not.toContain('--mcp-config');
    // Variadic flag: last in argv, pointing at the one shared file.
    expect(calls[1].args.slice(-2)).toEqual(['--mcp-config', join(home, '.dreamcontext', 'claude-accounts', 'mcp-config.json')]);
  });

  it('every account refused: one attempt each, then the honest limit failure', async () => {
    addAccounts();
    setSwitchPolicy({ strategy: 'sequential' }, home);
    createApproved('digest');
    const { impl, calls } = scriptedSpawn([envelope(BANNER), envelope(BANNER)]);
    const outcome = await runAutomation(contextRoot, 'digest', {
      now: () => NOW, home, spawnImpl: impl, killImpl: vi.fn(), notify: () => {}, log: () => {},
      probeUsage: async () => limits(10),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.outputPath).toBeNull();
    expect(outcome.error).toContain('usage limit');
    expect(calls).toHaveLength(2);
    expect(Object.keys(readAccountRejections(home)).sort()).toEqual(['first', 'second']);
  });

  it('auto-switch off: one attempt on the preferred account, as before', async () => {
    addAccounts();
    const { setAutoSwitchEnabled } = await import('../../src/lib/claude-accounts.js');
    setAutoSwitchEnabled(false, home);
    createApproved('digest');
    const { impl, calls } = scriptedSpawn([envelope(BANNER)]);
    const outcome = await runAutomation(contextRoot, 'digest', {
      now: () => NOW, home, spawnImpl: impl, killImpl: vi.fn(), notify: () => {}, log: () => {},
    });
    expect(outcome.status).toBe('failed');
    expect(calls).toHaveLength(1);
  });
});
