import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
  statSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

/**
 * The installed pre-commit hook resolves the GLOBAL `dreamcontext` binary and
 * fails OPEN (exit 0) when it isn't on PATH. A dev's dogfooding machine has it
 * installed globally, but a clean CI runner does not — so without a shim the hook
 * silently skips and the "commit is blocked" assertion fails only on CI. Put a
 * `dreamcontext` shim that points at the built CLI on PATH so the end-to-end guard
 * is exercised hermetically on any machine.
 */
function makeCliShim(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mk-cli-shim-')));
  const shim = join(dir, 'dreamcontext');
  writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  chmodSync(shim, 0o755);
  return dir;
}

function makeRepo(): string {
  const raw = join(tmpdir(), `mk-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const root = realpathSync(raw);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  return root;
}

function run(args: string, cwd: string): { stdout: string; status: number } {
  try {
    const out = execSync(`node ${CLI} ${args} 2>&1`, { cwd, encoding: 'utf-8', timeout: 10000 });
    return { stdout: out, status: 0 };
  } catch (e: any) {
    return {
      stdout: (e.stdout ?? '') + (e.stderr ?? ''),
      status: typeof e.status === 'number' ? e.status : 1,
    };
  }
}

describe('mk hooks (integration)', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  describe('install', () => {
    it('writes an executable pre-commit hook into .git/hooks/', () => {
      const r = run('mk hooks install', repo);
      expect(r.status).toBe(0);
      const target = join(repo, '.git', 'hooks', 'pre-commit');
      expect(existsSync(target)).toBe(true);
      const content = readFileSync(target, 'utf-8');
      expect(content).toContain('dreamcontext mk hooks check-staged');
      // exec bit
      const mode = statSync(target).mode;
      expect(mode & 0o111).not.toBe(0);
    });

    it('refuses to overwrite a non-managed pre-commit hook without --force', () => {
      mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho user-hook\n', { mode: 0o755 });
      const r = run('mk hooks install', repo);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toMatch(/already exists/i);
      // Existing hook untouched
      const after = readFileSync(join(repo, '.git', 'hooks', 'pre-commit'), 'utf-8');
      expect(after).toContain('user-hook');
    });

    it('overwrites a non-managed pre-commit hook with --force', () => {
      mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho user-hook\n', { mode: 0o755 });
      const r = run('mk hooks install --force', repo);
      expect(r.status).toBe(0);
      const after = readFileSync(join(repo, '.git', 'hooks', 'pre-commit'), 'utf-8');
      expect(after).toContain('dreamcontext mk hooks check-staged');
    });

    it('refreshes a managed dreamcontext hook idempotently', () => {
      const r1 = run('mk hooks install', repo);
      expect(r1.status).toBe(0);
      const r2 = run('mk hooks install', repo);
      expect(r2.status).toBe(0);
      expect(r2.stdout).toMatch(/already managed|refreshing/i);
    });
  });

  describe('check-staged', () => {
    it('exits 0 when no marketing binary paths are staged', () => {
      writeFileSync(join(repo, 'README.md'), '# hi\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repo });
      const r = run('mk hooks check-staged', repo);
      expect(r.status).toBe(0);
    });

    it('exits 1 and lists offenders when an _assets/ path is staged', () => {
      mkdirSync(join(repo, '_dream_context', 'marketing', 'competitors', '_assets'), { recursive: true });
      writeFileSync(join(repo, '_dream_context', 'marketing', 'competitors', '_assets', 'big.mp4'), 'x');
      execFileSync('git', ['add', '-f', '_dream_context/marketing/competitors/_assets/big.mp4'], { cwd: repo });
      const r = run('mk hooks check-staged', repo);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('_dream_context/marketing/competitors/_assets/big.mp4');
      expect(r.stdout).toMatch(/binary guard|refus/i);
    });

    it('exits 1 when an _media/ path is staged', () => {
      mkdirSync(join(repo, '_dream_context', 'marketing', '_youtube', '_media'), { recursive: true });
      writeFileSync(join(repo, '_dream_context', 'marketing', '_youtube', '_media', 'frame.jpg'), 'x');
      execFileSync('git', ['add', '-f', '_dream_context/marketing/_youtube/_media/frame.jpg'], { cwd: repo });
      const r = run('mk hooks check-staged', repo);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('frame.jpg');
    });
  });

  describe('end-to-end via git commit', () => {
    it('blocks an actual git commit attempt when hook is installed', () => {
      run('mk hooks install', repo);
      // Add a benign file first to make sure the rest of the commit machinery works.
      writeFileSync(join(repo, 'ok.txt'), 'ok\n');
      execFileSync('git', ['add', 'ok.txt'], { cwd: repo });
      execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: repo });

      // Now try to stage a binary path. .gitignore is not in play here because
      // we haven't installed one — the hook is the only line of defense.
      mkdirSync(join(repo, '_dream_context', 'marketing', 'competitors', '_assets'), { recursive: true });
      writeFileSync(join(repo, '_dream_context', 'marketing', 'competitors', '_assets', 'big.mp4'), 'x');
      execFileSync('git', ['add', '-f', '_dream_context/marketing/competitors/_assets/big.mp4'], { cwd: repo });

      // The hook needs a resolvable `dreamcontext` on PATH (it fails open without
      // one) — supply a shim pointing at the built CLI so this works on CI too.
      const shimDir = makeCliShim();
      let failed = false;
      try {
        execFileSync('git', ['commit', '-m', 'should-fail'], {
          cwd: repo,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` },
        });
      } catch {
        failed = true;
      } finally {
        rmSync(shimDir, { recursive: true, force: true });
      }
      expect(failed).toBe(true);
    });
  });
});
