import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ToWire, codexLimitResetMs } from '../../../src/lib/t3-bridge/to-wire.js';
import { runOnBridgeNode } from '../../../src/cli/commands/t3-node-hop.js';

// The sentence Codex printed on a real quota hit (the headless job that found it, 2026-11-13).
const REAL = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Nov 24th, 2026 7:09 PM.";
const NOW = new Date(2026, 10, 13, 10, 0).getTime();

const terminal = (message: string, resetAt: string | null = null, cls = 'usage_limit') =>
  new ToWire({ tool: 'codex', model: 'gpt-5.5', cwd: '/tmp/project', permissionMode: 'default' })
    .translate({ type: 'turn.terminal', status: 'failed', failure: { class: cls, message, code: 'usageLimitExceeded', retryable: false, resetAt } } as never, NOW)
    .find((f) => f.type === 'result')!;

describe('Codex usage-limit reset read from its own sentence', () => {
  it('a refusal with no rate-limit snapshot keeps the date Codex named (it was null)', () => {
    expect(terminal(REAL).dc_limit).toEqual({ resetsAtMs: new Date(2026, 10, 24, 19, 9).getTime() });
  });

  it('the snapshot T3 read still wins over the sentence', () => {
    const at = new Date(NOW + 3_600_000).toISOString();
    expect(terminal(REAL, at).dc_limit).toEqual({ resetsAtMs: Date.parse(at) });
  });

  it('the sentence alone marks a limit even when the failure class did not', () => {
    expect(terminal(REAL, null, 'provider_error').dc_limit).toEqual({ resetsAtMs: new Date(2026, 10, 24, 19, 9).getTime() });
    expect(terminal('boom', null, 'provider_error').dc_limit).toBeUndefined();
  });

  it('reads every form Codex prints', () => {
    // Another day, other ordinals.
    expect(codexLimitResetMs("You've hit your usage limit. Try again at Dec 1st, 2026 12:05 AM.", NOW)).toBe(new Date(2026, 11, 1, 0, 5).getTime());
    expect(codexLimitResetMs("You've hit your usage limit for GPT-5-Codex-Mini. Switch to another model now, or try again at Jan 3rd, 2027 12:30 PM.", NOW)).toBe(new Date(2027, 0, 3, 12, 30).getTime());
    // The same day: only a time; one already past is tomorrow.
    expect(codexLimitResetMs("You've hit your usage limit. Try again at 7:09 PM.", NOW)).toBe(new Date(2026, 10, 13, 19, 9).getTime());
    expect(codexLimitResetMs("You've hit your usage limit. Try again at 9:15 AM.", NOW)).toBe(new Date(2026, 10, 14, 9, 15).getTime());
    // Older Codex: a duration.
    expect(codexLimitResetMs("You've hit your usage limit. Try again in 2 days 3 hours 15 minutes.", NOW)).toBe(NOW + 2 * 86_400_000 + 3 * 3_600_000 + 15 * 60_000);
    // No reset named, or not this sentence.
    expect(codexLimitResetMs("You've hit your usage limit. Try again later.", NOW)).toBeNull();
    expect(codexLimitResetMs('try again at Nov 24th, 2026 7:09 PM', NOW)).toBeNull();
    expect(codexLimitResetMs("You've hit your usage limit. Try again at Feb 31st, 2027 7:09 PM.", NOW)).toBeNull();
  });
});

describe('the bridge commands on a Node without node:sqlite', () => {
  const fakeSpawn = (code: number, calls: unknown[][]) => ((...a: unknown[]) => {
    calls.push(a);
    const child = Object.assign(new EventEmitter(), { kill: () => true });
    setImmediate(() => child.emit('exit', code));
    return child;
  }) as never;

  it('a Node at the floor loads the bridge itself', async () => {
    expect(await runOnBridgeNode({ version: 'v22.16.0', find: () => { throw new Error('no search'); } })).toBe('here');
  });

  it('Node 20 runs the same command again on a good Node beside it', async () => {
    const calls: unknown[][] = [];
    const r = await runOnBridgeNode({ version: 'v20.19.0', execPath: '/old/node', execArgv: ['--disable-sigusr1'], argv: ['/old/node', '/cli/index.js', 't3-account', 'probe'], env: {}, find: () => '/good/node', spawn: fakeSpawn(3, calls) });
    expect(r).toBe(3);
    expect(calls[0]![0]).toBe('/good/node');
    expect(calls[0]![1]).toEqual(['--disable-sigusr1', '/cli/index.js', 't3-account', 'probe']);
    expect((calls[0]![2] as { env: NodeJS.ProcessEnv }).env.DREAMCONTEXT_BRIDGE_HOP).toBe('1');
  });

  it('no good Node, or a re-run that is still old, is a plain "none" and never a second hop', async () => {
    expect(await runOnBridgeNode({ version: 'v20.19.0', env: {}, find: () => null })).toBe('none');
    expect(await runOnBridgeNode({ version: 'v20.19.0', env: { DREAMCONTEXT_BRIDGE_HOP: '1' }, find: () => '/good/node' })).toBe('none');
  });
});
