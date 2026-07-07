import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

function makeTmpDir(): string {
  const raw = join(tmpdir(), `ac-platform-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(`node ${CLI} ${cmd} 2>&1`, { cwd, encoding: 'utf-8', timeout: 20000 });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

describe('platform-aware install flow (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('init --yes writes default platform selection (claude)', () => {
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    const path = join(tmpDir, '_dream_context', 'state', '.platforms.json');
    expect(existsSync(path)).toBe(true);

    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { selected: string[]; version: number };
    expect(parsed.version).toBe(1);
    expect(parsed.selected).toEqual(['claude']);
  });

  it('install-skill installs the initializer core skill + 3 sub-agents (claude)', () => {
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    run('install-skill --platforms claude', tmpDir);

    // The interactive bootstrap orchestrator ships as a core skill alongside dreamcontext.
    expect(existsSync(join(tmpDir, '.claude', 'skills', 'initializer', 'SKILL.md'))).toBe(true);
    const skill = readFileSync(join(tmpDir, '.claude', 'skills', 'initializer', 'SKILL.md'), 'utf-8');
    expect(skill).toContain('name: initializer');

    // Its 3 worker sub-agents install via the core agents/ glob.
    for (const a of ['initializer-scout', 'initializer-ingestor', 'initializer-verifier']) {
      expect(existsSync(join(tmpDir, '.claude', 'agents', `${a}.md`))).toBe(true);
    }
  });

  it('install-skill installs the curator core skill + 3 sub-agents (claude)', () => {
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    run('install-skill --platforms claude', tmpDir);

    // The interactive brain-refactor orchestrator ships as a core skill alongside dreamcontext.
    expect(existsSync(join(tmpDir, '.claude', 'skills', 'curator', 'SKILL.md'))).toBe(true);
    const skill = readFileSync(join(tmpDir, '.claude', 'skills', 'curator', 'SKILL.md'), 'utf-8');
    expect(skill).toContain('name: curator');

    // Its 3 worker sub-agents install via the core agents/ glob.
    for (const a of ['curator-auditor', 'curator-worker', 'curator-verifier']) {
      expect(existsSync(join(tmpDir, '.claude', 'agents', `${a}.md`))).toBe(true);
    }
  });

  it('install-skill installs the deep-research core skill (claude)', () => {
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    run('install-skill --platforms claude', tmpDir);

    // The iterative corpus-synthesis orchestrator ships as a core skill alongside dreamcontext.
    const skillPath = join(tmpDir, '.claude', 'skills', 'dreamcontext-deep-research', 'SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
    const skill = readFileSync(skillPath, 'utf-8');
    expect(skill).toContain('name: dreamcontext-deep-research');

    // It reuses the existing dreamcontext-explore searcher — no dedicated sub-agent file.
    expect(existsSync(join(tmpDir, '.claude', 'agents', 'dreamcontext-explore.md'))).toBe(true);
  });

  it('install-instructions installs CLAUDE.md for the claude platform', () => {
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    run('install-instructions --platforms claude --mode append', tmpDir);

    const claude = readFileSync(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('dreamcontext:claude:start');
  });
});
