import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

/**
 * Issue #10 — `config people` seeds the roster and syncs the ## People block in
 * 1.user.md, end-to-end via the built CLI (dist/index.js). This is the writer
 * the initializer uses to seed a multi-person roster from git authors.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

function makeTmpDir(): string {
  const raw = join(tmpdir(), `dc-people-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(`node ${CLI} ${cmd} 2>&1`, { cwd, encoding: 'utf-8', timeout: 15000 });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function readConfig(tmpDir: string): any {
  return JSON.parse(readFileSync(join(tmpDir, '_dream_context', 'state', '.config.json'), 'utf-8'));
}

function readUserMd(tmpDir: string): string {
  return readFileSync(join(tmpDir, '_dream_context', 'core', '1.user.md'), 'utf-8');
}

describe('config people (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('seeds a multi-person roster and inserts the ## People block', () => {
    const out = run('config people "Alice Smith" "Bob Jones"', tmpDir);
    expect(out).toContain('People roster set: Alice Smith, Bob Jones');

    const cfg = readConfig(tmpDir);
    expect(cfg.people).toEqual(['Alice Smith', 'Bob Jones']);

    const userMd = readUserMd(tmpDir);
    expect(userMd).toContain('## People');
    expect(userMd).toContain('- Alice Smith (`person:alice-smith`)');
    expect(userMd).toContain('- Bob Jones (`person:bob-jones`)');
  });

  it('dedupes by slug and is idempotent on the user.md block', () => {
    run('config people "Alice" "alice" "Alice"', tmpDir);
    const cfg = readConfig(tmpDir);
    // collapses to a single entry; single person => no block, multi-person off
    expect(cfg.people).toEqual(['Alice']);
    expect(readUserMd(tmpDir)).not.toContain('## People');

    // re-running a 2-person roster twice yields a byte-identical user.md
    run('config people "Alice" "Bob"', tmpDir);
    const first = readUserMd(tmpDir);
    run('config people "Alice" "Bob"', tmpDir);
    expect(readUserMd(tmpDir)).toBe(first);
  });

  it('--clear empties the roster', () => {
    run('config people "Alice" "Bob"', tmpDir);
    expect(readConfig(tmpDir).people).toEqual(['Alice', 'Bob']);

    const out = run('config people --clear', tmpDir);
    expect(out).toContain('roster cleared');
    // [] reads as single-person (isMultiPerson([]) === false)
    expect(readConfig(tmpDir).people).toEqual([]);
  });

  it('rejects an empty roster without --clear', () => {
    const out = run('config people', tmpDir);
    expect(out).toContain('No valid names provided');
  });
});
