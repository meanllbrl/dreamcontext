import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

function makeTmpDir(): string {
  const raw = join(tmpdir(), `dc-link-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

/** A minimal dreamcontext project directory (just enough for ensureContextRoot). */
function makeProjectDir(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  return realpathSync(dir);
}

/** A real local git repo with an `origin` remote, for linkRepo's S3 origin-match check. */
function makeGitRepo(base: string, name: string, origin: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir, stdio: 'ignore' });
  return realpathSync(dir);
}

function run(args: string, cwd: string, home: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, HOME: home },
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    const stdout = (e.stdout ?? '') + (e.stderr ?? '');
    const exitCode = typeof e.status === 'number' ? e.status : 1;
    return { stdout, exitCode };
  }
}

describe('link CLI (integration)', () => {
  let home: string;
  let base: string;
  let projectDir: string;

  beforeEach(() => {
    home = makeTmpDir();
    base = makeTmpDir();
    projectDir = makeProjectDir(base, 'proj');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('link add binds a repo and prints the resolved path', () => {
    const repoDir = makeGitRepo(base, 'api', 'https://github.com/acme/api.git');
    const { stdout, exitCode } = run(`link add api ${repoDir}`, projectDir, home);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('https://github.com/acme/api.git');
    expect(stdout).toContain(repoDir);
  });

  it('link ls (and the top-level links alias) show the linked repo as present', () => {
    const repoDir = makeGitRepo(base, 'api', 'https://github.com/acme/api.git');
    run(`link add api ${repoDir}`, projectDir, home);

    const ls = run('link ls', projectDir, home);
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout).toContain('api');
    expect(ls.stdout).toMatch(/present/);

    const alias = run('links', projectDir, home);
    expect(alias.exitCode).toBe(0);
    expect(alias.stdout).toContain('api');
    expect(alias.stdout).toMatch(/present/);
  });

  it('link is a pure group — `link clone` targets a repo literally named "clone" via `link add clone <path>`', () => {
    // `link` has no parent positional action, so `link add clone <path>` binds a
    // repo NAMED "clone" — the group verb and a same-named repo never collide.
    const repoDir = makeGitRepo(base, 'clone', 'https://github.com/acme/clone.git');
    const { stdout, exitCode } = run(`link add clone ${repoDir}`, projectDir, home);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('https://github.com/acme/clone.git');
  });

  it('link rm removes the entry (and links / unlink hit the SAME handlers as link ls / link rm)', () => {
    const repoDir = makeGitRepo(base, 'api', 'https://github.com/acme/api.git');
    run(`link add api ${repoDir}`, projectDir, home);

    const rm = run('link rm api', projectDir, home);
    expect(rm.exitCode).toBe(0);
    expect(rm.stdout.toLowerCase()).toMatch(/unlinked/);

    const lsAfter = run('link ls', projectDir, home);
    expect(lsAfter.stdout).not.toMatch(/api/);

    // Re-link, then remove via the top-level `unlink` alias — must behave identically.
    run(`link add api ${repoDir}`, projectDir, home);
    const unlinkAlias = run('unlink api', projectDir, home);
    expect(unlinkAlias.exitCode).toBe(0);
    expect(unlinkAlias.stdout.toLowerCase()).toMatch(/unlinked/);

    const lsFinal = run('link ls', projectDir, home);
    expect(lsFinal.stdout).not.toMatch(/api/);
  });

  it('unlink on an unknown name reports not-found (same handler as link rm)', () => {
    const rm = run('link rm ghost', projectDir, home);
    expect(rm.exitCode).not.toBe(0);

    const unlinkAlias = run('unlink ghost', projectDir, home);
    expect(unlinkAlias.exitCode).not.toBe(0);
    expect(unlinkAlias.stdout.toLowerCase()).toMatch(/no linked repo/);
  });

  it('link clone refuses without confirmation and emits the team-writable-URL trust warning', () => {
    const { stdout, exitCode } = run('link clone api', projectDir, home);
    expect(exitCode).not.toBe(0);
    expect(stdout.toLowerCase()).toMatch(/team|trust|writable/);
    expect(stdout.toLowerCase()).toMatch(/confirmation/);
    // Refused BEFORE any confirmation — --yes was never passed.
    expect(stdout).not.toMatch(/cloned/i);
  });
});
