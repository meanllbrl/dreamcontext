import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import matter from 'gray-matter';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

function makeProject(): string {
  const raw = join(tmpdir(), `mk-council-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function run(cmd: string, cwd: string): { stdout: string; status: number } {
  try {
    const out = execSync(`node ${CLI} ${cmd} 2>&1`, { cwd, encoding: 'utf-8', timeout: 15000 });
    return { stdout: out, status: 0 };
  } catch (e: any) {
    return {
      stdout: (e.stdout ?? '') + (e.stderr ?? ''),
      status: typeof e.status === 'number' ? e.status : 1,
    };
  }
}

describe('mk council (integration)', () => {
  let project: string;

  beforeEach(() => {
    project = makeProject();
    // Bootstrap a project so council create works
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', project);
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('creates a debate with all 4 marketing personas pre-registered', () => {
    const r = run('mk council "should we scale Cohort 4?" --rounds 2', project);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Debate created:');
    expect(r.stdout).toContain('strategy-optimizer');
    expect(r.stdout).toContain('performance-monitor');
    expect(r.stdout).toContain('creative-director');
    expect(r.stdout).toContain('risk-officer');

    // Verify on-disk debate state
    const councilDir = join(project, '_dream_context', 'council');
    expect(existsSync(councilDir)).toBe(true);
    const debates = readdirSync(councilDir).filter((n) => n.startsWith('council_'));
    expect(debates.length).toBe(1);
    const debateDir = join(councilDir, debates[0]);

    // debate.md exists and lists all 4 personas
    const debateFile = join(debateDir, 'debate.md');
    expect(existsSync(debateFile)).toBe(true);
    const { data } = matter(readFileSync(debateFile, 'utf-8'));
    expect(Array.isArray(data.personas)).toBe(true);
    expect(data.personas).toEqual(
      expect.arrayContaining(['strategy-optimizer', 'performance-monitor', 'creative-director', 'risk-officer']),
    );
    expect(data.rounds_planned).toBe(2);

    // Each persona dir has the body persisted
    for (const slug of ['strategy-optimizer', 'performance-monitor', 'creative-director', 'risk-officer']) {
      const personaFile = join(debateDir, slug, 'context-and-persona.md');
      expect(existsSync(personaFile)).toBe(true);
      const personaContent = readFileSync(personaFile, 'utf-8');
      // Body content from the bundled persona file should be present
      expect(personaContent).toContain('## Persona');
    }
  });

  it('--persona flag filters to the requested subset', () => {
    const r = run('mk council "test topic" -p strategy-optimizer,risk-officer', project);
    expect(r.status).toBe(0);
    const councilDir = join(project, '_dream_context', 'council');
    const debates = readdirSync(councilDir).filter((n) => n.startsWith('council_'));
    const debateDir = join(councilDir, debates[0]);
    const { data } = matter(readFileSync(join(debateDir, 'debate.md'), 'utf-8'));
    expect(data.personas).toEqual(['strategy-optimizer', 'risk-officer']);
  });

  it('rejects unknown persona slug', () => {
    const r = run('mk council "test" -p strategy-optimizer,not-a-persona', project);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/Unknown persona slug/i);
  });

  it('rejects invalid --rounds', () => {
    expect(run('mk council "test" --rounds 0', project).status).not.toBe(0);
    expect(run('mk council "test" --rounds 99', project).status).not.toBe(0);
  });

  it('refuses without a topic', () => {
    const r = run('mk council', project);
    expect(r.status).not.toBe(0);
  });
});
