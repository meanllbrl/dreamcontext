import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isMarketingEnvPath } from '../../src/lib/marketing/path-guards.js';

function makeProject(): string {
  const raw = join(tmpdir(), `mk-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const root = realpathSync(raw);
  mkdirSync(join(root, '_dream_context', 'marketing'), { recursive: true });
  return root;
}

describe('marketing/path-guards', () => {
  let project: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    project = makeProject();
    process.chdir(project);
  });
  afterEach(() => {
    process.chdir(origCwd);
    rmSync(project, { recursive: true, force: true });
  });

  it('matches the absolute path to _dream_context/marketing/.env', () => {
    const target = join(project, '_dream_context', 'marketing', '.env');
    expect(isMarketingEnvPath(target)).toBe(true);
  });

  it('matches a relative path that resolves to the env file', () => {
    expect(isMarketingEnvPath('_dream_context/marketing/.env')).toBe(true);
  });

  it('does not match unrelated .env files', () => {
    expect(isMarketingEnvPath(join(project, '.env'))).toBe(false);
    expect(isMarketingEnvPath('/tmp/.env')).toBe(false);
  });

  it('does not match other files in marketing/', () => {
    expect(isMarketingEnvPath(join(project, '_dream_context', 'marketing', 'config.json'))).toBe(false);
  });

  it('returns false for empty path', () => {
    expect(isMarketingEnvPath('')).toBe(false);
  });

  it('returns false when no _dream_context/ exists in tree', () => {
    const noCtx = realpathSync(mkdirSync(join(tmpdir(), `no-ctx-${Date.now()}`), { recursive: true })!);
    process.chdir(noCtx);
    try {
      expect(isMarketingEnvPath('marketing/.env')).toBe(false);
    } finally {
      rmSync(noCtx, { recursive: true, force: true });
    }
  });
});
