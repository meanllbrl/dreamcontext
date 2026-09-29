/**
 * End to end: `dreamcontext update` refreshes an existing managed CLAUDE.md block,
 * keeps the user's text around it byte-identical, and never creates CLAUDE.md.
 * Needs a built dist (`npm run build`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const START = '<!-- dreamcontext:claude:start -->';
const END = '<!-- dreamcontext:claude:end -->';

function makeTmpDir(): string {
  const raw = join(tmpdir(), `dc-update-claude-md-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(`node ${CLI} ${cmd} 2>&1`, { cwd, encoding: 'utf-8', timeout: 30000 });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

describe('update refreshes the managed CLAUDE.md block (integration)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmp);
    run('install-skill --platforms claude', tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rewrites a stale block and keeps the text around it byte-identical', () => {
    const head = '# House rules\n\nMine.\n\n';
    const tail = '\n\n## Mine too\n';
    writeFileSync(join(tmp, 'CLAUDE.md'), `${head}${START}\nstale managed text\n${END}${tail}`, 'utf-8');

    const output = run('update --yes', tmp);

    const after = readFileSync(join(tmp, 'CLAUDE.md'), 'utf-8');
    expect(after).not.toContain('stale managed text');
    expect(after.slice(0, after.indexOf(START))).toBe(head);
    expect(after.slice(after.indexOf(END) + END.length)).toBe(tail);
    expect(output).toContain('Root instructions: CLAUDE.md managed block refreshed');
    expect(existsSync(join(tmp, 'AGENTS.md'))).toBe(false);
  });

  it('never creates CLAUDE.md', () => {
    rmSync(join(tmp, 'CLAUDE.md'), { force: true });

    const output = run('update --yes', tmp);

    expect(existsSync(join(tmp, 'CLAUDE.md'))).toBe(false);
    expect(output).toContain('Root instructions: no dreamcontext block in CLAUDE.md, left alone');
  });

  it('leaves the block alone under --packs-only', () => {
    const stale = `${START}\nstale managed text\n${END}\n`;
    writeFileSync(join(tmp, 'CLAUDE.md'), stale, 'utf-8');

    run('update --packs-only --yes', tmp);

    expect(readFileSync(join(tmp, 'CLAUDE.md'), 'utf-8')).toBe(stale);
  });
});
