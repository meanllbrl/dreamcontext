/**
 * The Develop lead-edit backstop (src/lib/develop-lead-guard.ts): in a Develop chat the lead's
 * own Edit/Write/MultiEdit may only reach `<root>/_dream_context/` and `<root>/tmp/`; builders
 * (spawned with the env var stripped), nested sessions and every other mode are untouched.
 * Pattern: isMarketingEnvPath + marketing-path-guards.test.ts, one case per rule.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { developLeadWriteDenied, DEVELOP_LEAD_DENY_REASON } from '../../src/lib/develop-lead-guard.js';

let base: string;
let root: string;
const lead = (filePath: string, over: Partial<Parameters<typeof developLeadWriteDenied>[0]> = {}) =>
  developLeadWriteDenied({ filePath, root, envValue: '1', nested: false, ...over });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'dev-lead-'));
  root = join(base, 'proj');
  mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'x');
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('developLeadWriteDenied', () => {
  it('denies a lead Edit on product code', () => {
    expect(lead(join(root, 'src', 'a.ts'))).toBe(true);
  });

  it('denies a Write of a file that does not exist yet, in a directory that does not either', () => {
    expect(lead(join(root, 'src', 'new', 'x.ts'))).toBe(true);
    expect(lead(join(root, 'README.md'))).toBe(true);
  });

  it('allows a new file under _dream_context/state/ and under tmp/ (even before tmp/ exists)', () => {
    expect(lead(join(root, '_dream_context', 'state', 'task.md'))).toBe(false);
    expect(lead(join(root, 'tmp', 'develop', 'demo', 'w1-A.md'))).toBe(false);
  });

  it('denies a path that climbs out of _dream_context/ with ..', () => {
    expect(lead(join(root, '_dream_context', '..', 'src', 'x.ts'))).toBe(true);
    expect(lead(`${root}/_dream_context/../src/x.ts`)).toBe(true);
  });

  it('allows _dream_context/ writes in a project whose root is reached through a symlink', () => {
    const link = join(base, 'link');
    symlinkSync(root, link);
    expect(developLeadWriteDenied({ filePath: join(link, '_dream_context', 'state', 't.md'), root: link, envValue: '1', nested: false })).toBe(false);
    expect(developLeadWriteDenied({ filePath: join(realpathSync(root), '_dream_context', 't.md'), root: link, envValue: '1', nested: false })).toBe(false);
    expect(developLeadWriteDenied({ filePath: join(link, 'src', 'a.ts'), root: link, envValue: '1', nested: false })).toBe(true);
  });

  it('allows writes into a brain that is itself a symlink', () => {
    const brain = join(base, 'brain');
    mkdirSync(join(brain, 'state'), { recursive: true });
    rmSync(join(root, '_dream_context'), { recursive: true });
    symlinkSync(brain, join(root, '_dream_context'));
    expect(lead(join(root, '_dream_context', 'state', 't.md'))).toBe(false);
  });

  it('a relative path resolves against the project root', () => {
    expect(lead('src/a.ts')).toBe(true);
    expect(lead('_dream_context/state/t.md')).toBe(false);
  });

  it('allows when the env var is absent or empty (every other mode, and builders)', () => {
    expect(lead(join(root, 'src', 'a.ts'), { envValue: undefined })).toBe(false);
    expect(lead(join(root, 'src', 'a.ts'), { envValue: '' })).toBe(false);
    expect(lead(join(root, 'src', 'a.ts'), { envValue: '0' })).toBe(false);
  });

  it('allows a nested session', () => {
    expect(lead(join(root, 'src', 'a.ts'), { nested: true })).toBe(false);
  });

  it('holds after /clear: nothing here is keyed on a session id', () => {
    // The predicate takes no session id at all: the env of the chat child is the key, and a
    // /clear is written into that same child's stdin, so a new session_id changes nothing.
    expect(developLeadWriteDenied.length).toBe(1);
    expect(lead(join(root, 'src', 'a.ts'))).toBe(true);
  });

  it('denies when the context root is null or resolution throws', () => {
    expect(lead(join(root, 'src', 'a.ts'), { root: null })).toBe(true);
    expect(lead(join(root, '_dream_context', 'state', 't.md'), { root: join(base, 'no-such-root') })).toBe(true);
  });

  it('the deny message points the lead at the owning builder', () => {
    expect(DEVELOP_LEAD_DENY_REASON).toMatch(/builder that owns this file/);
    expect(DEVELOP_LEAD_DENY_REASON).toContain('_dream_context/ and tmp/');
  });
});
