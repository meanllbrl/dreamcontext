import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MARKETING_PATHS, marketingRoot, marketingPath } from '../../src/lib/marketing/paths.js';

function makeProject(): string {
  const raw = join(tmpdir(), `mk-paths-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const root = realpathSync(raw);
  mkdirSync(join(root, '_dream_context', 'marketing'), { recursive: true });
  return root;
}

describe('marketing/paths', () => {
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

  it('marketingRoot resolves under _dream_context/', () => {
    expect(marketingRoot()).toBe(join(project, '_dream_context', 'marketing'));
  });

  it('marketingPath joins segments', () => {
    expect(marketingPath('cohorts', 'c1.json'))
      .toBe(join(project, '_dream_context', 'marketing', 'cohorts', 'c1.json'));
  });

  it('all MARKETING_PATHS getters live under marketingRoot', () => {
    const root = marketingRoot();
    for (const [name, fn] of Object.entries(MARKETING_PATHS)) {
      const p = (fn as () => string)();
      expect(p.startsWith(root), `${name} should be under marketingRoot`).toBe(true);
    }
  });

  it('venvPython is under .venv/bin/python', () => {
    expect(MARKETING_PATHS.venvPython()).toBe(
      join(project, '_dream_context', 'marketing', '.venv', 'bin', 'python'),
    );
  });
});
