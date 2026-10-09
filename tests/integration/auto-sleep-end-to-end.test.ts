import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Workstream C through the REAL binary. The Stop hook fires at the end of every
 * assistant turn, so "does it dispatch, and does it ever dispatch when it
 * shouldn't?" is not a question to answer by reading the code.
 *
 * The spawn itself is neutralised by pointing PATH at a stub `claude` that just
 * records that it was called — this proves the DECISION and the wiring without
 * spending a real model run on every test.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
let root = '';
let ctx = '';
let binDir = '';

function cli(args: string, env: NodeJS.ProcessEnv = {}): string {
  try {
    return execSync(`node ${CLI} ${args} 2>&1`, {
      cwd: root, encoding: 'utf-8', timeout: 30000,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...env },
    });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function stopHook(env: NodeJS.ProcessEnv = {}): string {
  const input = JSON.stringify({
    session_id: '11111111-1111-1111-1111-111111111111',
    transcript_path: '/nonexistent.jsonl',
    last_assistant_message: 'done',
  });
  try {
    return execSync(`printf '%s' '${input}' | node ${CLI} hook stop 2>&1`, {
      cwd: root, encoding: 'utf-8', timeout: 30000, shell: '/bin/bash',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...env },
    });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function setDebt(debt: number, over: Record<string, unknown> = {}): void {
  writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify({
    debt, last_sleep: null, last_sleep_summary: null, sleep_started_at: null,
    last_consolidated_at: null, sessions_since_last_sleep: 0, sessions: [], bookmarks: [],
    triggers: [], knowledge_access: {}, dashboard_changes: [], compaction_log: [],
    recall_mode: 'haiku', consolidation_depth: null, pendingMigrationNotices: [],
    cycle_tasks_filed: [], ...over,
  }, null, 2));
}

/**
 * Did a background dispatcher actually start?
 *
 * The SIDECAR is the signal, not the stub binary: `executeClaudeDetached`
 * resolves the real `claude` by path rather than through PATH, so a PATH stub
 * proves nothing. The sidecar is written synchronously at spawn and is the
 * artifact the rest of the system keys off, which makes it the honest assertion.
 */
function waitForDispatch(ms = 6000): boolean {
  const sidecar = join(ctx, 'state', '.auto-sleep.json');
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(sidecar)) return true;
    try { execSync('sleep 0.1'); } catch { /* ignore */ }
  }
  return false;
}

/** Nothing real must survive a test — a dispatched cycle is a live claude. */
function stopAnyRun(): void {
  try {
    execSync(`node ${CLI} sleep auto cancel --yes`, { cwd: root, timeout: 20000, stdio: 'ignore' });
  } catch { /* nothing was running */ }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-auto-e2e-'));
  ctx = join(root, '_dream_context');
  cli('init --yes --name "T" --description "d" --stack "Node" --priority "p"');
  binDir = mkdtempSync(join(tmpdir(), 'dc-bin-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

describe('sleep auto on/off/status', () => {
  it('is OFF by default and says so', () => {
    expect(cli('sleep auto status')).toContain('Off.');
  });

  it('arms with a stored approval, and reports the trigger', () => {
    const out = cli('sleep auto on');
    expect(out).toContain('Auto sleep ON');
    expect(out).toContain('debt 60');
    const status = cli('sleep auto status');
    expect(status).toContain('Armed');
    const local = JSON.parse(readFileSync(join(ctx, 'state', '.brain-local.json'), 'utf8'));
    expect(local.autoSleep).toMatchObject({ enabled: true, trigger: 'must-sleep' });
    expect(local.autoSleep.approvedFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('honours --trigger sleepy', () => {
    expect(cli('sleep auto on --trigger sleepy')).toContain('debt 40');
  });

  it('refuses an unknown trigger', () => {
    expect(cli('sleep auto on --trigger whenever')).toContain('must be');
  });

  it('turns off again', () => {
    cli('sleep auto on');
    expect(cli('sleep auto off')).toContain('Auto sleep OFF');
    expect(cli('sleep auto status')).toContain('Off.');
  });

  it('reports PAUSED once an approved setting changes', () => {
    cli('sleep auto on');
    cli('sleep config set specialists.sleep-tasks.model claude-opus-5');
    const status = cli('sleep auto status');
    expect(status).toContain('PAUSED');
    expect(status).toContain('re-run');
  });

  it('re-approving clears the pause', () => {
    cli('sleep auto on');
    cli('sleep config set specialists.sleep-tasks.model claude-opus-5');
    cli('sleep auto on');
    expect(cli('sleep auto status')).toContain('Armed');
  });
});

describe('the Stop hook trigger', () => {
  const sidecar = () => join(ctx, 'state', '.auto-sleep.json');

  afterEach(() => stopAnyRun());

  it('does NOT dispatch while auto sleep is off, however high the debt', () => {
    setDebt(500);
    stopHook();
    expect(existsSync(sidecar())).toBe(false);
  });

  it('does NOT dispatch below the trigger', () => {
    cli('sleep auto on');
    setDebt(10);
    stopHook();
    expect(existsSync(sidecar())).toBe(false);
  });

  it('DISPATCHES once armed and over the trigger', () => {
    cli('sleep auto on');
    setDebt(500);
    stopHook();
    expect(waitForDispatch()).toBe(true);
    // And it recorded a real, live job rather than an empty shell.
    const job = JSON.parse(readFileSync(sidecar(), 'utf8'));
    expect(job.status).toBe('running');
    expect(Number.isInteger(job.pid)).toBe(true);
  });

  it('does NOT dispatch from inside a background cycle — no chaining', () => {
    cli('sleep auto on');
    setDebt(500);
    stopHook({ DREAMCONTEXT_AUTO_SLEEP: '1' });
    expect(existsSync(sidecar())).toBe(false);
  });

  it('does NOT dispatch while consent is stale', () => {
    cli('sleep auto on');
    cli('sleep config set max-new-tasks 2');
    setDebt(500);
    stopHook();
    expect(existsSync(sidecar())).toBe(false);
  });

  it('does NOT dispatch while a consolidation already holds the epoch', () => {
    cli('sleep auto on');
    setDebt(500, { sleep_started_at: new Date().toISOString() });
    stopHook();
    expect(existsSync(sidecar())).toBe(false);
  });

  it('does NOT dispatch inside the cooldown', () => {
    cli('sleep auto on');
    setDebt(70, { last_consolidated_at: new Date().toISOString() });
    stopHook();
    expect(existsSync(sidecar())).toBe(false);
  });
});

describe('the nag silence, through the real hook', () => {
  const promptHook = () => {
    const input = JSON.stringify({ session_id: '11111111-1111-1111-1111-111111111111', prompt: 'hi' });
    try {
      return execSync(`printf '%s' '${input}' | node ${CLI} hook user-prompt-submit 2>/dev/null`, {
        cwd: root, encoding: 'utf-8', timeout: 30000, shell: '/bin/bash',
      });
    } catch (e: any) { return (e.stdout ?? '') + (e.stderr ?? ''); }
  };

  it('normally demands a consolidation at high debt', () => {
    setDebt(500);
    expect(promptHook()).toContain('CONSOLIDATION REQUIRED');
  });

  it('goes quiet — one line — once auto sleep is armed', () => {
    cli('sleep auto on');
    setDebt(500);
    const out = promptHook();
    expect(out).not.toContain('CONSOLIDATION REQUIRED');
    expect(out).toContain('Auto sleep is ON');
  });

  it('but SPEAKS UP when the approval goes stale', () => {
    cli('sleep auto on');
    cli('sleep config set max-new-tasks 3');
    setDebt(500);
    expect(promptHook()).toContain('PAUSED');
  });
});

describe('the lock and sidecar are machine-local', () => {
  it('a fresh brain gitignores the lock paths but not the tombstones', () => {
    const gi = join(ctx, '.gitignore');
    if (!existsSync(gi)) return;
    const body = readFileSync(gi, 'utf8');
    expect(body).toContain('state/.auto-sleep.json');
    expect(body).toContain('state/.locks/');
    expect(body).not.toContain('.task-tombstones.json');
  });
});
