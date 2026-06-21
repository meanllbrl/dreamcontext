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

  it('init --platforms persists explicit multi-selection', () => {
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p" --platforms codex,claude', tmpDir);
    const path = join(tmpDir, '_dream_context', 'state', '.platforms.json');
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { selected: string[] };
    expect(parsed.selected).toEqual(['codex', 'claude']);
  });

  it('install-skill --platforms codex installs codex artifacts', () => {
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    const output = run('install-skill --platforms codex', tmpDir);

    expect(output).toContain('Integration installed for Codex');
    expect(existsSync(join(tmpDir, '.agents', 'skills', 'dreamcontext', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tmpDir, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(join(tmpDir, '.codex', 'agents', 'dreamcontext-explore.toml'))).toBe(true);
    expect(existsSync(join(tmpDir, 'AGENTS.md'))).toBe(true);

    const codexAgent = readFileSync(join(tmpDir, '.codex', 'agents', 'dreamcontext-explore.toml'), 'utf-8');
    expect(codexAgent).not.toContain('disallowed_tools');
    expect(codexAgent).not.toContain('tools =');
    expect(codexAgent).not.toContain('instructions_file');
    expect(codexAgent).toContain('developer_instructions = ');

    const codexConfig = readFileSync(join(tmpDir, '.codex', 'config.toml'), 'utf-8');
    expect(codexConfig).toContain('[features]');
    expect(codexConfig).toContain('codex_hooks = true');
    expect(codexConfig).toContain('[[hooks.SessionStart]]');
    expect(codexConfig).toContain('[[hooks.SessionStart.hooks]]');
    expect(codexConfig).toContain('matcher = "startup|resume|clear"');
    expect(codexConfig).not.toContain('hooks.session_start = ');
  });

  it('install-skill defaults to saved project platforms when --platforms is omitted', () => {
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p" --platforms codex', tmpDir);
    run('install-skill', tmpDir);

    expect(existsSync(join(tmpDir, '.agents', 'skills', 'dreamcontext', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude', 'skills', 'dreamcontext', 'SKILL.md'))).toBe(false);
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

  it('install-skill installs the initializer core skill for codex too', () => {
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    run('install-skill --platforms codex', tmpDir);
    expect(existsSync(join(tmpDir, '.agents', 'skills', 'initializer', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tmpDir, '.codex', 'agents', 'initializer-scout.toml'))).toBe(true);
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

  it('install-skill installs the curator core skill for codex too', () => {
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    run('install-skill --platforms codex', tmpDir);
    expect(existsSync(join(tmpDir, '.agents', 'skills', 'curator', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tmpDir, '.codex', 'agents', 'curator-auditor.toml'))).toBe(true);
  });

  it('install-instructions can install both CLAUDE.md and AGENTS.md in one command', () => {
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    run('install-instructions --platforms claude,codex --mode append', tmpDir);

    const claude = readFileSync(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    const agents = readFileSync(join(tmpDir, 'AGENTS.md'), 'utf-8');

    expect(claude).toContain('dreamcontext:claude:start');
    expect(agents).toContain('dreamcontext:codex:start');
  });
});
