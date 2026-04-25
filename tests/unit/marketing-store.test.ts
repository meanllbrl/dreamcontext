import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonWithBridge, acquireLock, LockBusyError, beginRun } from '../../src/lib/marketing/store.js';

function makeProject(): string {
  const raw = join(tmpdir(), `mk-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const root = realpathSync(raw);
  mkdirSync(join(root, '_dream_context', 'marketing'), { recursive: true });
  return root;
}

describe('marketing/store', () => {
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

  it('writeJsonWithBridge writes both files atomically', () => {
    const jsonP = join(project, '_dream_context', 'marketing', 'cohorts', 'c1.json');
    const mdP = join(project, '_dream_context', 'marketing', 'cohorts', 'c1.md');
    writeJsonWithBridge(jsonP, mdP, { id: 'c1', name: 'demo' }, '# c1\n');
    expect(existsSync(jsonP)).toBe(true);
    expect(existsSync(mdP)).toBe(true);
    expect(JSON.parse(readFileSync(jsonP, 'utf8'))).toEqual({ id: 'c1', name: 'demo' });
    expect(readFileSync(mdP, 'utf8')).toBe('# c1\n');
  });

  it('acquireLock + release', () => {
    const release = acquireLock();
    expect(existsSync(join(project, '_dream_context', 'marketing', '.lock'))).toBe(true);
    release();
    expect(existsSync(join(project, '_dream_context', 'marketing', '.lock'))).toBe(false);
  });

  it('acquireLock throws LockBusyError if lock held by live PID', () => {
    const release = acquireLock();
    try {
      expect(() => acquireLock()).toThrow(LockBusyError);
    } finally {
      release();
    }
  });

  it('acquireLock clears stale lock from dead PID', () => {
    const lockPath = join(project, '_dream_context', 'marketing', '.lock');
    writeFileSync(lockPath, '999999\n', 'utf8'); // implausibly-high PID, almost certainly dead
    const release = acquireLock();
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('beginRun writes WAL JSON + index.md, succeed flips status', () => {
    const run = beginRun('competitor-ingest', { target: '@demo' });
    expect(existsSync(run.path)).toBe(true);
    run.appendEvent({ event: 'start' });
    run.succeed({ posts_ingested: 1 });
    const final = JSON.parse(readFileSync(run.path, 'utf8'));
    expect(final.status).toBe('success');
    expect(final.outputs).toEqual({ posts_ingested: 1 });
    const index = readFileSync(join(project, '_dream_context', 'marketing', 'runs', 'index.md'), 'utf8');
    expect(index).toContain('competitor-ingest');
    expect(index).toContain(run.id);
  });

  it('beginRun redacts secrets in inputs/outputs/events', () => {
    const run = beginRun('competitor-ingest', { token: 'Bearer EAAVeryLongRedactablePayload12345' });
    run.appendEvent({ url: 'https://x.com?access_token=EAAabcdef0123456789' });
    run.succeed();
    const final = readFileSync(run.path, 'utf8');
    expect(final).not.toContain('EAAVeryLong');
    expect(final).not.toContain('EAAabcdef0123456789');
    expect(final).toContain('[REDACTED]');
  });
});
