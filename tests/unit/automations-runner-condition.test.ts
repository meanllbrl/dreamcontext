/**
 * kosullu-otomasyon W2 L2: the condition gate through the REAL runner. The fictional project
 * "Northwind Bakery" has one routine, `new-orders-check`, whose script asks whether new orders
 * came in. The condition itself is injected (`conditionImpl`), the model spawn too: nothing here
 * starts a shell or a model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAutomation, type SpawnImpl } from '../../src/lib/automations/runner.js';
import { createAutomation, readAutomationCache, recordRun } from '../../src/lib/automations/store.js';
import { approveAutomation, getApproval, manifestHash } from '../../src/lib/automations/registry.js';
import { readAutomationsRegistry, writeAutomationsRegistry } from '../../src/lib/automations/registry.js';
import type { ConditionResult, runCondition } from '../../src/lib/automations/condition.js';
import { adoptPrimaryCodexAccount } from '../../src/lib/codex-accounts.js';
import { approvedTextsDir } from '../../src/lib/automations/approved-text.js';
import { listScheduleItems } from '../../src/lib/super/schedule-queue.js';
import { scheduleTurnText } from '../../src/lib/super/schedule-job.js';
import { scopeOfContextRoot } from '../../src/lib/telegram/config.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';

vi.mock('../../src/lib/claude-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/claude-path.js')>()),
  findClaudeBin: () => '/fake/bin/claude',
}));
vi.mock('../../src/lib/t3-bridge/node-floor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/t3-bridge/node-floor.js')>()),
  bridgeNode: () => '/fake/bin/node',
}));

const NOW = new Date('2026-11-15T09:00:00.000Z');
const SLUG = 'new-orders-check';
const SCRIPT = '# any new orders since the last check?\ntest -s orders/new.csv && cat orders/new.csv';
let projectRoot: string;
let contextRoot: string;
let home: string;

const CLAUDE_OK = JSON.stringify({ session_id: 'sess_nw', result: '# Orders\n\nTwo new.', is_error: false, permission_denials: [], total_cost_usd: 0.01, num_turns: 1, duration_ms: 500, subtype: 'success' });
const CODEX_OK = JSON.stringify({ session_id: '019a0000-0000-7000-8000-000000000002', result: '# Orders', is_error: false, permission_denials: [], total_cost_usd: 0.02, num_turns: 1, duration_ms: 500, subtype: 'success', dc_tool: 'codex' });

function spawnRecorder(stdout = CLAUDE_OK): { impl: SpawnImpl; calls: Array<{ bin: string; args: string[] }> } {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const impl = vi.fn((bin: string, args: string[]) => {
    const out = new EventEmitter();
    const err = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 9100 + calls.length, stdout: out, stderr: err, kill: () => {} });
    calls.push({ bin, args });
    setImmediate(() => { out.emit('data', Buffer.from(stdout)); child.emit('close', 0); });
    return child;
  }) as unknown as SpawnImpl;
  return { impl, calls };
}

/** A condition that answers `verdict` without a shell, counting its calls. */
function cond(r: Partial<ConditionResult> & { verdict: ConditionResult['verdict'] }): typeof runCondition & { calls: number } {
  const f = Object.assign(async () => {
    f.calls++;
    return { data: '', stderrTail: '', exitCode: r.verdict === 'true' ? 0 : r.verdict === 'false' ? 1 : 3, ...r };
  }, { calls: 0 });
  return f as unknown as typeof runCondition & { calls: number };
}

function routine(over: Record<string, unknown> = {}, witnessed = true): AutomationManifest {
  const m = createAutomation(contextRoot, { slug: SLUG, title: 'New orders check', days: 'daily', at: '09:00', prompt: 'Summarise the new orders for the bakery.', condition: SCRIPT, ...over });
  const consent = over.target === 'super' ? 'super-verb' as const : undefined;
  approveAutomation(projectRoot, m, NOW, home, consent, witnessed ? { kind: 'owner-terminal' } : undefined);
  return m;
}

const base = (impl: SpawnImpl, conditionImpl: typeof runCondition, extra: Record<string, unknown> = {}) => ({
  now: () => NOW, fireAt: NOW, home, spawnImpl: impl, killImpl: vi.fn(), log: () => {}, scheduledFire: true as const, conditionImpl, ...extra,
});

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-cond-runner-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-cond-runner-home-'));
  process.env.DREAMCONTEXT_CLI = '/fake/cli.js';
});
afterEach(() => {
  delete process.env.DREAMCONTEXT_CLI;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('false: nothing wakes', () => {
  it('no model turn, one condition-false row, the watermark advances, nobody is told', async () => {
    routine();
    const { impl, calls } = spawnRecorder();
    const notify = vi.fn();
    const c = cond({ verdict: 'false' });
    const out = await runAutomation(contextRoot, SLUG, base(impl, c, { notify }));
    expect(out.status).toBe('condition-false');
    expect(c.calls).toBe(1);
    expect(calls).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    const cache = readAutomationCache(contextRoot, SLUG)!;
    expect(cache.lastFireAt).toBe(NOW.toISOString());
    expect(cache.history[0]!.status).toBe('condition-false');
  });

  it('a second false folds into the same row, and an earlier failed face survives', async () => {
    routine();
    const iso = new Date(NOW.getTime() - 3_600_000).toISOString();
    recordRun(contextRoot, SLUG, { firedAt: iso, startedAt: iso, finishedAt: iso, status: 'failed', durationMs: 10, outputPath: null, error: 'boom', exitCode: 1, sessionId: null, costUsd: null, numTurns: null, permissionDenials: 0 });
    const { impl } = spawnRecorder();
    await runAutomation(contextRoot, SLUG, base(impl, cond({ verdict: 'false' }), { notify: () => {} }));
    const later = new Date(NOW.getTime() + 3_600_000);
    await runAutomation(contextRoot, SLUG, base(impl, cond({ verdict: 'false' }), { notify: () => {}, now: () => later, fireAt: later }));
    const cache = readAutomationCache(contextRoot, SLUG)!;
    expect(cache.history.filter((h) => h.status === 'condition-false')).toHaveLength(1);
    expect(cache.history[0]!.firedAt).toBe(later.toISOString());
    expect(cache.history[0]!.startedAt).toBe(NOW.toISOString());
    expect(cache.status).toBe('failed');
    expect(cache.error).toBe('boom');
    expect(cache.lastFireAt).toBe(later.toISOString());
  });

  it('wake=false flips it: a false check wakes the agent, a true one stays quiet', async () => {
    routine({ conditionWake: false });
    const a = spawnRecorder();
    expect((await runAutomation(contextRoot, SLUG, base(a.impl, cond({ verdict: 'false', data: 'no oven heartbeat' }), { notify: () => {} }))).status).toBe('ok');
    expect(a.calls).toHaveLength(1);
    const later = new Date(NOW.getTime() + 3_600_000);
    const b = spawnRecorder();
    expect((await runAutomation(contextRoot, SLUG, base(b.impl, cond({ verdict: 'true' }), { notify: () => {}, now: () => later, fireAt: later }))).status).toBe('condition-false');
    expect(b.calls).toHaveLength(0);
  });
});

describe('true: one run, the data fenced', () => {
  it('spawns once and the prompt carries the stdout under a CONDITION OUTPUT nonce', async () => {
    routine();
    const { impl, calls } = spawnRecorder();
    const out = await runAutomation(contextRoot, SLUG, base(impl, cond({ verdict: 'true', data: '2 new orders: rye x3, croissant x12' }), { notify: () => {} }));
    expect(out.status).toBe('ok');
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.args.join('\n');
    const m = /--- CONDITION OUTPUT ([0-9a-f]+) ---\n2 new orders: rye x3, croissant x12\n--- END CONDITION OUTPUT \1 ---/.exec(prompt);
    expect(m).not.toBeNull();
  });

  it('an empty stdout on true adds no block', async () => {
    routine();
    const { impl, calls } = spawnRecorder();
    await runAutomation(contextRoot, SLUG, base(impl, cond({ verdict: 'true', data: '' }), { notify: () => {} }));
    expect(calls[0]!.args.join('\n')).not.toContain('CONDITION OUTPUT');
  });
});

describe('error: loud, no model', () => {
  for (const [name, r] of [
    ['exit 3', { verdict: 'error' as const, reason: 'exit 3', stderrTail: 'curl: (6) could not resolve host' }],
    ['timeout', { verdict: 'error' as const, reason: 'timed out after 60 s', stderrTail: '' }],
  ] as const) {
    it(`${name}: a failed row with the reason, notified like a failed run`, async () => {
      routine();
      const { impl, calls } = spawnRecorder();
      const notify = vi.fn();
      const out = await runAutomation(contextRoot, SLUG, base(impl, cond(r), { notify }));
      expect(out.status).toBe('failed');
      expect(out.error).toContain(r.reason);
      if (r.stderrTail) expect(out.error).toContain(r.stderrTail);
      expect(calls).toHaveLength(0);
      expect(notify).toHaveBeenCalledTimes(1);
    });
  }
});

describe('not gated: a human-started run evaluates nothing', () => {
  it('a run without scheduledFire (Run now, --force) never runs the script', async () => {
    routine();
    const { impl, calls } = spawnRecorder();
    const c = cond({ verdict: 'false' });
    const out = await runAutomation(contextRoot, SLUG, { now: () => NOW, fireAt: NOW, home, spawnImpl: impl, killImpl: vi.fn(), log: () => {}, notify: () => {}, conditionImpl: c, force: true });
    expect(out.status).toBe('ok');
    expect(c.calls).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('a server-host Run now evaluates nothing either', async () => {
    routine();
    const { impl, calls } = spawnRecorder();
    const c = cond({ verdict: 'false' });
    await runAutomation(contextRoot, SLUG, { now: () => NOW, fireAt: NOW, home, spawnImpl: impl, killImpl: vi.fn(), log: () => {}, notify: () => {}, conditionImpl: c, host: 'server', registerChild: () => () => {} });
    expect(c.calls).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe('no mark, no run', () => {
  it('an approved entry without the witness mark runs no script and spawns nothing', async () => {
    routine();
    // Forge the entry: strip the mark, bypassing approvalEntryFor.
    const reg = readAutomationsRegistry(home);
    for (const p of Object.values(reg.projects ?? {}) as Array<{ approvals: Record<string, { conditionWitnessed?: string }> }>) {
      if (p.approvals?.[SLUG]) delete p.approvals[SLUG].conditionWitnessed;
    }
    writeAutomationsRegistry(reg, home);
    expect(getApproval(projectRoot, SLUG, home)?.conditionWitnessed).toBeUndefined();
    const { impl, calls } = spawnRecorder();
    const c = cond({ verdict: 'true' });
    const out = await runAutomation(contextRoot, SLUG, base(impl, c, { notify: () => {} }));
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/not approved by you/);
    expect(c.calls).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('a routine whose condition changed pauses its schedule until the owner approves; Run now goes on', async () => {
    const m = routine();
    const { readFileSync } = await import('node:fs');
    writeFileSync(m.path, readFileSync(m.path, 'utf8').replace('test -s orders/new.csv', 'test -s orders/urgent.csv'));
    const c = cond({ verdict: 'true' });
    const a = spawnRecorder();
    const out = await runAutomation(contextRoot, SLUG, base(a.impl, c, { notify: () => {} }));
    expect(out.status).toBe('blocked');
    expect(out.error).toMatch(/condition changed and waits for you/);
    expect(c.calls).toBe(0);
    expect(a.calls).toHaveLength(0);
    // A prompt-only change keeps the schedule running on the last approved text.
    const b = spawnRecorder();
    const manual = await runAutomation(contextRoot, SLUG, { now: () => NOW, fireAt: NOW, home, spawnImpl: b.impl, killImpl: vi.fn(), log: () => {}, notify: () => {}, force: true });
    expect(manual.status).toBe('ok');
    expect(b.calls).toHaveLength(1);
  });

  it('a prompt-only change keeps the approved condition checking', async () => {
    const m = routine();
    const { readFileSync } = await import('node:fs');
    writeFileSync(m.path, readFileSync(m.path, 'utf8').replace('Summarise the new orders for the bakery.', 'Summarise the new orders in two lines.'));
    const seen: string[] = [];
    const c = Object.assign(async (script: string) => { seen.push(script); return { verdict: 'false' as const, data: '', stderrTail: '', exitCode: 1 }; }, {}) as unknown as typeof runCondition;
    const { impl } = spawnRecorder();
    const out = await runAutomation(contextRoot, SLUG, base(impl, c, { notify: () => {} }));
    expect(out.status).toBe('condition-false');
    expect(seen).toEqual([SCRIPT]);
  });

  it('a changed routine with no approved text to fall back on gets no approval question: blocked, naming the card', async () => {
    const m = routine();
    const { readFileSync } = await import('node:fs');
    writeFileSync(m.path, readFileSync(m.path, 'utf8').replace('test -s orders/new.csv', 'test -s orders/urgent.csv'));
    rmSync(approvedTextsDir(home), { recursive: true, force: true });
    const { impl, calls } = spawnRecorder();
    const c = cond({ verdict: 'true' });
    const out = await runAutomation(contextRoot, SLUG, base(impl, c, { notify: () => {} }));
    expect(out.status).toBe('blocked');
    expect(out.error).toMatch(/approve it on its card/);
    expect(c.calls).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('a manifest approved without a witness never got a mark: approve throws, nothing is written', () => {
    const m = createAutomation(contextRoot, { slug: SLUG, title: 'x', days: 'daily', at: '09:00', prompt: 'x', condition: SCRIPT });
    expect(() => approveAutomation(projectRoot, m, NOW, home)).toThrow(/waits for you/);
    expect(getApproval(projectRoot, SLUG, home)).toBeNull();
    expect(() => approveAutomation(projectRoot, m, NOW, home, undefined, { kind: 'shown', hash: 'stale' })).toThrow(/changed since you looked/);
    expect(approveAutomation(projectRoot, m, NOW, home, undefined, { kind: 'shown', hash: manifestHash(m) }).conditionWitnessed).toBeTruthy();
  });
});

describe('Codex', () => {
  function signIn(): void {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), '{"tokens":{}}');
    adoptPrimaryCodexAccount(home);
  }
  it('false spawns no codex; true spawns one carrying the block', async () => {
    signIn();
    routine({ tool: 'codex' });
    const a = spawnRecorder(CODEX_OK);
    expect((await runAutomation(contextRoot, SLUG, base(a.impl, cond({ verdict: 'false' }), { notify: () => {} }))).status).toBe('condition-false');
    expect(a.calls).toHaveLength(0);
    const later = new Date(NOW.getTime() + 3_600_000);
    const b = spawnRecorder(CODEX_OK);
    const out = await runAutomation(contextRoot, SLUG, base(b.impl, cond({ verdict: 'true', data: 'rye x3' }), { notify: () => {}, now: () => later, fireAt: later }));
    expect(out.status).toBe('ok');
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]!.args.slice(1, 2)).toEqual(['t3-run']);
    expect(b.calls[0]!.args.join('\n')).toMatch(/--- CONDITION OUTPUT [0-9a-f]+ ---\nrye x3/);
  });
});

describe('Super target', () => {
  it('false writes no item; true writes a bounded item that renders fenced', async () => {
    routine({ target: 'super' });
    const scope = scopeOfContextRoot(contextRoot);
    const spawn = vi.fn(() => { throw new Error('must not spawn'); }) as unknown as SpawnImpl;
    expect((await runAutomation(contextRoot, SLUG, base(spawn, cond({ verdict: 'false' }), { notify: () => {}, unattended: true }))).status).toBe('condition-false');
    expect(listScheduleItems(scope, home)).toHaveLength(0);
    const later = new Date(NOW.getTime() + 3_600_000);
    const big = 'sipariş: çavdar ekmeği ×3 '.repeat(800);
    const out = await runAutomation(contextRoot, SLUG, base(spawn, cond({ verdict: 'true', data: big }), { notify: () => {}, unattended: true, now: () => later, fireAt: later }));
    expect(out.status).toBe('ok');
    const items = listScheduleItems(scope, home);
    expect(items).toHaveLength(1);
    expect(Buffer.byteLength(items[0]!.data!, 'utf8')).toBeLessThanOrEqual(8192);
    expect(items[0]!.data!.startsWith('sipariş: çavdar')).toBe(true);
    const text = scheduleTurnText(SLUG, items[0]!.fireIso, 'Summarise the new orders.', items[0]!.data);
    expect(text).toContain('CONDITION OUTPUT');
  });

  it('a pending Super target whose condition changed fires nothing', async () => {
    const m = routine({ target: 'super' });
    const { readFileSync } = await import('node:fs');
    writeFileSync(m.path, readFileSync(m.path, 'utf8').replace('orders/new.csv && cat orders/new.csv', 'orders/late.csv'));
    const c = cond({ verdict: 'true' });
    const spawn = vi.fn(() => { throw new Error('must not spawn'); }) as unknown as SpawnImpl;
    const out = await runAutomation(contextRoot, SLUG, base(spawn, c, { notify: () => {}, unattended: true }));
    expect(out.status).toBe('blocked');
    expect(c.calls).toBe(0);
    expect(listScheduleItems(scopeOfContextRoot(contextRoot), home)).toHaveLength(0);
  });
});
