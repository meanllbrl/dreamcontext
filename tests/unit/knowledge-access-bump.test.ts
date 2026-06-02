import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readSleepState,
  writeSleepState,
  bumpKnowledgeAccess,
} from '../../src/cli/commands/sleep.js';
import { today } from '../../src/lib/id.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ka-bump-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'state'), { recursive: true });
  return dir;
}

describe('bumpKnowledgeAccess', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the record on first access with count 1 and today as last_accessed', () => {
    const state = readSleepState(tmpDir);
    bumpKnowledgeAccess(state, 'jwt-auth');
    expect(state.knowledge_access['jwt-auth'].count).toBe(1);
    expect(state.knowledge_access['jwt-auth'].last_accessed).toBe(today());
  });

  it('increments count on subsequent accesses', () => {
    const state = readSleepState(tmpDir);
    bumpKnowledgeAccess(state, 'jwt-auth');
    bumpKnowledgeAccess(state, 'jwt-auth');
    bumpKnowledgeAccess(state, 'jwt-auth');
    expect(state.knowledge_access['jwt-auth'].count).toBe(3);
  });

  it('updates last_accessed to today on a pre-existing stale record', () => {
    const state = readSleepState(tmpDir);
    state.knowledge_access['rate-limiting'] = { last_accessed: '2020-01-01', count: 9 };
    bumpKnowledgeAccess(state, 'rate-limiting');
    expect(state.knowledge_access['rate-limiting'].count).toBe(10);
    expect(state.knowledge_access['rate-limiting'].last_accessed).toBe(today());
  });

  it('tracks multiple slugs independently and persists across read/write', () => {
    const state = readSleepState(tmpDir);
    bumpKnowledgeAccess(state, 'jwt-auth');
    bumpKnowledgeAccess(state, 'caching');
    bumpKnowledgeAccess(state, 'caching');
    writeSleepState(tmpDir, state);

    const reread = readSleepState(tmpDir);
    expect(reread.knowledge_access['jwt-auth'].count).toBe(1);
    expect(reread.knowledge_access['caching'].count).toBe(2);
  });
});
