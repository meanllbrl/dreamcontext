/** Track T W4: an automation on Codex runs through `t3-run`, respects its accounts, and asks again
 *  when its tool changes. Everything Claude stays as `automation-account-switch` pins it. */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordToolRejection } from '../../src/lib/account-switch.js';
import { pickCodexRunAccount } from '../../src/lib/automations/codex-account.js';
import { approveAutomation, checkApproval, canonicalApprovalPayload } from '../../src/lib/automations/registry.js';
import { runAutomation, type SpawnImpl } from '../../src/lib/automations/runner.js';
import { createAutomation, getAutomation, readAutomationCache, updateAutomation } from '../../src/lib/automations/store.js';
import { adoptPrimaryCodexAccount, recordCodexUsage } from '../../src/lib/codex-accounts.js';
import { agentNotPickedMessage, setPickedAgents } from '../../src/lib/agent-pick.js';
import { readThread } from '../../src/lib/automations/threads.js';

vi.mock('../../src/lib/claude-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/claude-path.js')>()),
  findClaudeBin: () => '/fake/bin/claude',
}));
vi.mock('../../src/lib/t3-bridge/node-floor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/t3-bridge/node-floor.js')>()),
  bridgeNode: () => '/fake/bin/node',
}));

const NOW = new Date('2026-10-30T09:00:00.000Z');
let projectRoot: string;
let contextRoot: string;
let home: string;

function spawnOnce(stdout: string): { impl: SpawnImpl; calls: Array<{ bin: string; args: string[] }> } {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const impl = vi.fn((bin: string, args: string[]) => {
    const out = new EventEmitter();
    const err = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 8100 + calls.length, stdout: out, stderr: err, kill: () => {} });
    calls.push({ bin, args });
    setImmediate(() => { out.emit('data', Buffer.from(stdout)); child.emit('close', 0); });
    return child;
  }) as unknown as SpawnImpl;
  return { impl, calls };
}

const ENVELOPE = JSON.stringify({ session_id: '019a0000-0000-7000-8000-000000000001', result: '# Digest\n\nDone.', is_error: false, permission_denials: [], total_cost_usd: 0.42, num_turns: 1, duration_ms: 900, subtype: 'success', dc_tool: 'codex' });

function make(slug: string, tool?: 'codex'): void {
  const m = createAutomation(contextRoot, { slug, title: slug, days: 'daily', at: '09:00', prompt: 'Write the digest.', ...(tool ? { tool } : {}) });
  approveAutomation(projectRoot, m, NOW, home);
}

/** Account #0, signed in. */
function signIn(): void {
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'auth.json'), '{"tokens":{}}');
  adoptPrimaryCodexAccount(home);
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-auto-tool-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-auto-tool-home-'));
  process.env.DREAMCONTEXT_CLI = '/fake/cli.js';
});

afterEach(() => {
  delete process.env.DREAMCONTEXT_CLI;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('an automation on Codex', () => {
  it('runs through t3-run and records its cost', async () => {
    signIn();
    make('digest', 'codex');
    const { impl, calls } = spawnOnce(ENVELOPE);
    const outcome = await runAutomation(contextRoot, 'digest', { now: () => NOW, home, spawnImpl: impl, killImpl: vi.fn(), notify: () => {}, log: () => {} });
    expect(outcome.status).toBe('ok');
    expect(JSON.stringify(readAutomationCache(contextRoot, 'digest'))).toContain('0.42');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bin).toBe('/fake/bin/node');
    expect(calls[0]!.args.slice(0, 4)).toEqual(['/fake/cli.js', 't3-run', '--surface', 'automation']);
    expect(calls[0]!.args.join(' ')).not.toContain('bypassPermissions');
  });

  it('a Claude automation never touches t3-run', async () => {
    make('plain');
    const { impl, calls } = spawnOnce(ENVELOPE);
    await runAutomation(contextRoot, 'plain', { now: () => NOW, home, spawnImpl: impl, killImpl: vi.fn(), notify: () => {}, log: () => {} });
    expect(calls[0]!.bin).toBe('/fake/bin/claude');
    expect(calls[0]!.args).toContain('bypassPermissions');
  });

  it('adding Codex changes the hash, a Claude manifest hashes as it always did', () => {
    make('digest');
    const m = getAutomation(contextRoot, 'digest')!;
    expect(canonicalApprovalPayload(m)).not.toContain('"tool"');
    expect(canonicalApprovalPayload({ ...m, tool: 'codex' })).toContain('"tool":"codex"');
    expect(canonicalApprovalPayload({ ...m, tool: 'codex', account: 'a' })).toBe(canonicalApprovalPayload({ ...m, tool: 'codex' }));
  });

  it('a pin to an account that is gone fails the run and never spends another login', async () => {
    signIn();
    const m = createAutomation(contextRoot, { slug: 'pinned', title: 'pinned', days: 'daily', at: '09:00', prompt: 'Write.', tool: 'codex', account: 'gone1' });
    approveAutomation(projectRoot, m, NOW, home);
    const { impl, calls } = spawnOnce(ENVELOPE);
    const outcome = await runAutomation(contextRoot, 'pinned', { now: () => NOW, home, spawnImpl: impl, killImpl: vi.fn(), notify: () => {}, log: () => {} });
    expect(outcome.status).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('changing the tool blocks the run until it is approved again', () => {
    make('digest');
    const moved = updateAutomation(contextRoot, 'digest', { tool: 'codex' });
    expect(moved.tool).toBe('codex');
    expect(checkApproval(projectRoot, moved, home, 'run').approved).toBe(false);
  });
});

// Plan npmsiz-beta C17: a job whose agent is not picked on this Mac does not start (deny-only).
describe('the agent pick', () => {
  const run = (slug: string, impl: SpawnImpl, extra: Record<string, unknown> = {}) =>
    runAutomation(contextRoot, slug, { now: () => NOW, home, spawnImpl: impl, killImpl: vi.fn(), notify: () => {}, log: () => {}, ...extra });

  it('with Claude unpicked, a job with no stored tool says the sentence and spawns nothing, attended or not', async () => {
    setPickedAgents(['codex'], home);
    make('plain');
    for (const extra of [{}, { unattended: true }]) {
      const { impl, calls } = spawnOnce(ENVELOPE);
      const outcome = await run('plain', impl, extra);
      expect(outcome.status).toBe('blocked');
      expect(outcome.error).toBe(agentNotPickedMessage('claude'));
      expect(calls).toHaveLength(0);
    }
  });

  it('a still-owed refused fire narrates nothing on repeat ticks: no thread entry, fire stays owed', async () => {
    setPickedAgents(['codex'], home);
    make('plain');
    for (let tick = 0; tick < 2; tick++) {
      const { impl, calls } = spawnOnce(ENVELOPE);
      expect((await run('plain', impl, { unattended: true })).status).toBe('blocked');
      expect(calls).toHaveLength(0);
    }
    expect(readThread(contextRoot, 'plain')).toEqual([]);
    expect(readAutomationCache(contextRoot, 'plain')?.lastFireAt ?? null).toBeNull();
  });

  it('a changed manifest is refused before its approval question, which would spawn Claude', async () => {
    make('plain');
    updateAutomation(contextRoot, 'plain', { prompt: 'Write something else.' });
    setPickedAgents(['codex'], home);
    const { impl, calls } = spawnOnce(ENVELOPE);
    const outcome = await run('plain', impl);
    expect(outcome.error).toBe(agentNotPickedMessage('claude'));
    expect(calls).toHaveLength(0);
  });

  it('a pick listing Codex never moves an absent-tool job onto Codex; a job set to Codex runs on Codex', async () => {
    signIn();
    setPickedAgents(['codex'], home);
    make('digest', 'codex');
    const { impl, calls } = spawnOnce(ENVELOPE);
    expect((await run('digest', impl)).status).toBe('ok');
    expect(calls[0]!.bin).toBe('/fake/bin/node');
    make('plain');
    const second = spawnOnce(ENVELOPE);
    await run('plain', second.impl);
    expect(second.calls).toHaveLength(0);
  });

  it('a Codex job is refused when only Claude is picked; no pick record refuses nothing', async () => {
    signIn();
    make('digest', 'codex');
    setPickedAgents(['claude'], home);
    const refused = spawnOnce(ENVELOPE);
    expect((await run('digest', refused.impl)).error).toBe(agentNotPickedMessage('codex'));
    expect(refused.calls).toHaveLength(0);
    rmSync(join(home, '.dreamcontext', 'agents.json'));
    const ran = spawnOnce(ENVELOPE);
    expect((await run('digest', ran.impl)).status).toBe('ok');
  });
});

describe('the Codex account a run goes out on', () => {
  it('skips an account the API refused and an account past the threshold, unattended', () => {
    signIn();
    const now = NOW.getTime();
    const later = now + 3_600_000;
    recordCodexUsage('primary', [{ id: 's', kind: 'session', label: '5h', usedPercent: 99, resetsAt: new Date(later).toISOString() }], NOW.toISOString(), 'probe', home);
    const pick = pickCodexRunAccount({ unattended: true, home, now });
    expect(pick).toEqual({ waitUntil: later });
    // The owner asked for it: the threshold does not gate an attended run.
    expect(pickCodexRunAccount({ home, now })).toEqual({ account: 'primary' });
    recordToolRejection('codex', 'primary', { window: 'session', resetsAtMs: later, via: 'rateLimitEvent' }, home, now);
    expect(pickCodexRunAccount({ unattended: true, home, now })).toEqual({ waitUntil: later });
  });

  it('with nobody signed in there is no account, never a guess', () => {
    expect(pickCodexRunAccount({ pinned: 'gone', home })).toEqual({ none: true });
  });
});
