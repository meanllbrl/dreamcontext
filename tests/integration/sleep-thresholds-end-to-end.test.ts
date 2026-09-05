import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A3's acceptance criterion, proved through the REAL binary rather than by
 * reasoning about the wiring: the hook directives, `sleep status` and
 * `sleep config` must all read ONE source. The bug this guards against actually
 * happened during implementation — the hook was handed the CONTEXT root where
 * `readSetupConfig` wants the PROJECT root, so it silently fell back to the
 * shipped defaults and the whole setting did nothing.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

let root = '';
let ctx = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-thresh-'));
  ctx = join(root, '_dream_context');
  mkdirSync(join(ctx, 'core'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });
  writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: test\n---\nTest soul.');
  writeFileSync(
    join(ctx, 'state', '.config.json'),
    JSON.stringify({ platforms: ['claude'], packs: [], setupVersion: '1.0.0' }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function cli(args: string): string {
  try {
    return execSync(`node ${CLI} ${args} 2>&1`, { cwd: root, encoding: 'utf-8', timeout: 20000 });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function promptHook(): string {
  const input = JSON.stringify({ session_id: '11111111-1111-1111-1111-111111111111', prompt: 'hi' });
  try {
    return execSync(`printf '%s' '${input}' | node ${CLI} hook user-prompt-submit 2>/dev/null`, {
      cwd: root, encoding: 'utf-8', timeout: 20000, shell: '/bin/bash',
    });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function setDebt(debt: number): void {
  writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify({
    debt, last_sleep: null, last_sleep_summary: null, sleep_started_at: null,
    sessions: [], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [],
  }));
}

function setLadder(drowsy: number, sleepy: number, mustSleep: number): void {
  // Order matters: each `set` validates the RESOLVED ladder, so raise/lower in
  // an order that never transiently inverts it.
  cli(`sleep config set thresholds.drowsy ${drowsy}`);
  cli(`sleep config set thresholds.sleepy ${sleepy}`);
  cli(`sleep config set thresholds.must-sleep ${mustSleep}`);
}

describe('a brain\'s configured thresholds reach every consumer', () => {
  it('the SAME debt reads Drowsy on the defaults and REQUIRED on a custom ladder', () => {
    setDebt(30);
    expect(promptHook()).toContain('After completing the current task, offer to consolidate');

    setLadder(10, 20, 30);
    expect(promptHook()).toContain('CONSOLIDATION REQUIRED');

    cli('sleep config reset thresholds');
    expect(promptHook()).toContain('After completing the current task, offer to consolidate');
  });

  it('`sleep status` labels the level on the same ladder', () => {
    setDebt(30);
    expect(cli('sleep status')).toContain('Drowsy');
    setLadder(10, 20, 30);
    expect(cli('sleep status')).toContain('Must Sleep');
  });

  it('`sleep config` reports the derived values from the OVERRIDDEN base', () => {
    setLadder(10, 20, 30);
    const out = cli('sleep config');
    expect(out).toContain('deep-authority 45');
    expect(out).toContain('cooldown-override 60');
    expect(out).toMatch(/Must Sleep:\s+30/);
  });

  it('a refused write leaves the brain on its previous ladder', () => {
    setDebt(30);
    const refused = cli('sleep config set thresholds.must-sleep 30');
    expect(refused).toContain('must be less than must-sleep (30)');
    // Still the defaults — nothing was half-applied.
    expect(promptHook()).toContain('After completing the current task, offer to consolidate');
    expect(JSON.parse(readFileSync(join(ctx, 'state', '.config.json'), 'utf8')).sleep).toBeUndefined();
  });

  it('a zero-config brain is byte-for-byte the old behaviour at every boundary', () => {
    for (const [debt, expected] of [
      [23, null],
      [24, 'offer to consolidate'],
      [40, 'Consolidation recommended'],
      [60, 'CONSOLIDATION REQUIRED'],
    ] as const) {
      setDebt(debt);
      const out = promptHook();
      if (expected === null) expect(out).not.toContain('Sleep debt is');
      else expect(out).toContain(expected);
    }
  });
});
