import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

/**
 * Issue #11 M2 — token onboarding + backend toggle, end-to-end via the built
 * CLI (dist/index.js), including the "token never committable" git proof.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const TOKEN = 'pk_integration_secret_84121';

function makeTmpDir(): string {
  const raw = join(tmpdir(), `dc-cu-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function run(cmd: string, cwd: string, input?: string): string {
  try {
    return execSync(`node ${CLI} ${cmd} 2>&1`, {
      cwd,
      encoding: 'utf-8',
      timeout: 15000,
      input,
    });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', timeout: 15000 });
}

describe('clickup config onboarding (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('config task-backend clickup writes config, gitignores derived files; local restores', () => {
    const out = run('config task-backend clickup', tmpDir);
    expect(out).toContain('Task backend set to clickup');

    const cfg = JSON.parse(readFileSync(join(tmpDir, '_dream_context', 'state', '.config.json'), 'utf-8'));
    expect(cfg.taskBackend).toBe('clickup');
    expect(cfg.cloudTaskManagement).toBe(true);

    const gi = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
    expect(gi).toContain('_dream_context/state/*.md');
    expect(gi).toContain('_dream_context/state/.tasks-sync.json');
    expect(gi).toContain('_dream_context/state/.tasks-queue.json');
    expect(gi).toContain('_dream_context/state/.conflicts/');
    expect(gi).toContain('_dream_context/state/.secrets.json');

    const back = run('config task-backend local', tmpDir);
    expect(back).toContain('Task backend set to local');
    const cfg2 = JSON.parse(readFileSync(join(tmpDir, '_dream_context', 'state', '.config.json'), 'utf-8'));
    expect(cfg2.taskBackend).toBe('local');
  });

  it('config clickup-token stores a piped token in the gitignored secrets file (0600) and config show masks it', () => {
    run('config task-backend clickup', tmpDir);
    const out = run('config clickup-token', tmpDir, `${TOKEN}\n`);
    expect(out).toContain('ClickUp token stored');
    expect(out).not.toContain(TOKEN);

    const secretsPath = join(tmpDir, '_dream_context', 'state', '.secrets.json');
    expect(existsSync(secretsPath)).toBe(true);
    expect(readFileSync(secretsPath, 'utf-8')).toContain(TOKEN);

    const show = run('config show', tmpDir);
    expect(show).toContain('Task backend');
    expect(show).toContain('clickup');
    expect(show).toContain('present');
    expect(show).not.toContain(TOKEN);
    // Mask shows at most the last 4 characters.
    expect(show).toContain(TOKEN.slice(-4));
  });

  it('token never lands in any committable file (git add -A proof)', () => {
    git('init -q', tmpDir);
    run('config task-backend clickup', tmpDir);
    run(`config clickup-token ${TOKEN}`, tmpDir);

    git('add -A', tmpDir);
    const staged = git('diff --cached', tmpDir);
    expect(staged).not.toContain(TOKEN);
    const stagedFiles = git('diff --cached --name-only', tmpDir);
    expect(stagedFiles).not.toContain('.secrets.json');
  });

  it('default stays local: a project with no taskBackend field never prints task-backend lines', () => {
    const show = run('config show', tmpDir);
    expect(show).not.toContain('Task backend');
    expect(show).not.toContain('ClickUp');
    expect(show).not.toContain('Advanced');
  });

  it('config show groups the backend under Advanced once clickup is enabled', () => {
    run('config task-backend clickup', tmpDir);
    const show = run('config show', tmpDir);
    expect(show).toContain('Advanced');
    expect(show).toContain('Task backend');
  });

  it('non-interactive task-backend switch prints next-step hints instead of prompting', () => {
    // execSync has no TTY → the guided prompts must NOT fire (would hang).
    const out = run('config task-backend clickup', tmpDir);
    expect(out).toContain('Task backend set to clickup');
    expect(out).toContain('clickup-token');
    expect(out).toContain('clickup-list');
  });

  it('config clickup-member maps a person to a ClickUp member id (+ optional token env)', () => {
    const out = run('config clickup-member "Alice Smith" 501 --token-env ALICE_TOKEN', tmpDir);
    expect(out).toContain('alice-smith');
    expect(out).toContain('501');

    const cfg = JSON.parse(readFileSync(join(tmpDir, '_dream_context', 'state', '.config.json'), 'utf-8'));
    expect(cfg.peopleIdentity['alice-smith']).toEqual({ clickupMemberId: '501', tokenEnv: 'ALICE_TOKEN' });

    // Re-mapping merges instead of clobbering.
    run('config clickup-member "Alice Smith" 777', tmpDir);
    const cfg2 = JSON.parse(readFileSync(join(tmpDir, '_dream_context', 'state', '.config.json'), 'utf-8'));
    expect(cfg2.peopleIdentity['alice-smith']).toEqual({ clickupMemberId: '777', tokenEnv: 'ALICE_TOKEN' });
  });

  it('setup --yes never asks about cloud tasks and leaves the backend unset (advanced setting)', () => {
    const fresh = makeTmpDir();
    try {
      const out = run('setup --yes', fresh);
      expect(out).not.toContain('Cloud Task Management');
      const cfgRaw = readFileSync(join(fresh, '_dream_context', 'state', '.config.json'), 'utf-8');
      expect(JSON.parse(cfgRaw).taskBackend).toBeUndefined();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
