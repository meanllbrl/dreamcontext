/**
 * A8 — path-traversal hardening: tests for safeChildPath guards in
 * handleTasksGet, handleKnowledgeGet, handleFeaturesGet.
 *
 * Each handler must:
 *   - Return 400 invalid_path for traversal slugs before touching the filesystem.
 *   - Return 404 (not 500) for slug='.' (resolves to the nonexistent dotfile ..md).
 *   - Return 404 for a legitimate-but-absent slug.
 *   - Return 200 + payload for a legitimate existing slug.
 *
 * A sentinel file is placed OUTSIDE the base dir. Tests verify it is never read
 * (the guard must fire before any filesystem access outside the base).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleTasksGet } from '../../src/server/routes/tasks.js';
import { handleKnowledgeGet } from '../../src/server/routes/knowledge.js';
import { handleFeaturesGet } from '../../src/server/routes/features.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRes(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let statusCode = 0;
  let responseBody: unknown = null;

  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) {
      try { responseBody = JSON.parse(data); } catch { responseBody = data; }
    },
    setHeader() {},
  } as unknown as ServerResponse;

  return { res, status: () => statusCode, body: () => responseBody };
}

function makeGetReq(): IncomingMessage {
  return { method: 'GET', headers: {} } as unknown as IncomingMessage;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let contextRoot: string;
/** File placed OUTSIDE the _dream_context/ base — must never be read. */
let sentinelOutside: string;

const VALID_TASK_FRONTMATTER = [
  '---',
  'id: task_TEST123',
  'name: test-task',
  'description: A test task',
  'priority: medium',
  'urgency: low',
  'status: todo',
  'created_at: "2026-01-01"',
  'updated_at: "2026-01-01"',
  'tags: []',
  'parent_task: null',
  'related_feature: null',
  'version: null',
  '---',
  '',
  '## Why',
  'Test.',
  '',
  '## Changelog',
  '',
].join('\n');

const VALID_KNOWLEDGE_FRONTMATTER = [
  '---',
  'name: test-knowledge',
  'description: A test knowledge file',
  'tags: []',
  'date: "2026-01-01"',
  'pinned: false',
  '---',
  '',
  'Content here.',
  '',
].join('\n');

const VALID_FEATURE_FRONTMATTER = [
  '---',
  'id: feat_TEST',
  'status: planning',
  'created: "2026-01-01"',
  'updated: "2026-01-01"',
  'tags: []',
  'related_tasks: []',
  '---',
  '',
  '## Why',
  'Test feature.',
  '',
].join('\n');

beforeEach(() => {
  tmpDir = join(tmpdir(), `trav-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  contextRoot = join(tmpDir, '_dream_context');

  // Create required directories
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  mkdirSync(join(contextRoot, 'knowledge'), { recursive: true });
  mkdirSync(join(contextRoot, 'knowledge', 'features'), { recursive: true });

  // Seed a sentinel OUTSIDE the _dream_context/ base — verifies the guard fires
  // before any filesystem read outside the base.
  sentinelOutside = join(tmpDir, 'sentinel.md');
  writeFileSync(sentinelOutside, '# SENTINEL — must never be read by a route handler\n');

  // Seed a legitimate task, knowledge, and feature file
  writeFileSync(join(contextRoot, 'state', 'my-task.md'), VALID_TASK_FRONTMATTER);
  writeFileSync(join(contextRoot, 'knowledge', 'my-knowledge.md'), VALID_KNOWLEDGE_FRONTMATTER);
  writeFileSync(join(contextRoot, 'knowledge', 'features', 'my-feature.md'), VALID_FEATURE_FRONTMATTER);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── handleTasksGet ───────────────────────────────────────────────────────────

describe('handleTasksGet — path-traversal guard', () => {
  it('returns 400 invalid_path for ../../etc/passwd', async () => {
    const { res, status, body } = makeRes();
    await handleTasksGet(makeGetReq(), res, { slug: '../../etc/passwd' }, contextRoot);
    expect(status()).toBe(400);
    expect((body() as { error: string }).error).toBe('invalid_path');
  });

  it('returns 400 invalid_path for ../sentinel (escapes state dir)', async () => {
    const { res, status, body } = makeRes();
    // The sentinel is at tmpDir/sentinel.md; from state/ that's ../../sentinel
    await handleTasksGet(makeGetReq(), res, { slug: '../../sentinel' }, contextRoot);
    expect(status()).toBe(400);
    expect((body() as { error: string }).error).toBe('invalid_path');
  });

  it('returns 404 (not 500) for slug="." — resolves to nonexistent ..md dotfile', async () => {
    const { res, status, body } = makeRes();
    await handleTasksGet(makeGetReq(), res, { slug: '.' }, contextRoot);
    expect(status()).toBe(404);
    expect((body() as { error: string }).error).toBe('not_found');
  });

  it('returns 404 for a legitimate-but-absent slug', async () => {
    const { res, status, body } = makeRes();
    await handleTasksGet(makeGetReq(), res, { slug: 'nonexistent-task' }, contextRoot);
    expect(status()).toBe(404);
    expect((body() as { error: string }).error).toBe('not_found');
  });

  it('returns 200 with task data for a legitimate existing slug', async () => {
    const { res, status, body } = makeRes();
    await handleTasksGet(makeGetReq(), res, { slug: 'my-task' }, contextRoot);
    expect(status()).toBe(200);
    expect((body() as { task: { slug: string } }).task.slug).toBe('my-task');
  });
});

// ─── handleKnowledgeGet ───────────────────────────────────────────────────────

describe('handleKnowledgeGet — path-traversal guard', () => {
  it('returns 400 invalid_path for ../../etc/passwd', async () => {
    const { res, status, body } = makeRes();
    await handleKnowledgeGet(makeGetReq(), res, { slug: '../../etc/passwd' }, contextRoot);
    expect(status()).toBe(400);
    expect((body() as { error: string }).error).toBe('invalid_path');
  });

  it('returns 400 invalid_path for ../sentinel (escapes knowledge dir)', async () => {
    const { res, status, body } = makeRes();
    // From knowledge/ one level up is _dream_context/, two is tmpDir; sentinel is at tmpDir/sentinel
    await handleKnowledgeGet(makeGetReq(), res, { slug: '../../../sentinel' }, contextRoot);
    expect(status()).toBe(400);
    expect((body() as { error: string }).error).toBe('invalid_path');
  });

  it('returns 404 (not 500) for slug="." — resolves to nonexistent ..md dotfile', async () => {
    const { res, status, body } = makeRes();
    await handleKnowledgeGet(makeGetReq(), res, { slug: '.' }, contextRoot);
    expect(status()).toBe(404);
    expect((body() as { error: string }).error).toBe('not_found');
  });

  it('returns 404 for a legitimate-but-absent slug', async () => {
    const { res, status, body } = makeRes();
    await handleKnowledgeGet(makeGetReq(), res, { slug: 'no-such-knowledge' }, contextRoot);
    expect(status()).toBe(404);
    expect((body() as { error: string }).error).toBe('not_found');
  });

  it('returns 200 with knowledge data for a legitimate existing slug', async () => {
    const { res, status, body } = makeRes();
    await handleKnowledgeGet(makeGetReq(), res, { slug: 'my-knowledge' }, contextRoot);
    expect(status()).toBe(200);
    expect((body() as { entry: { slug: string } }).entry.slug).toBe('my-knowledge');
  });
});

// ─── handleFeaturesGet ────────────────────────────────────────────────────────

describe('handleFeaturesGet — path-traversal guard', () => {
  it('returns 400 invalid_path for ../../etc/passwd', async () => {
    const { res, status, body } = makeRes();
    await handleFeaturesGet(makeGetReq(), res, { slug: '../../etc/passwd' }, contextRoot);
    expect(status()).toBe(400);
    expect((body() as { error: string }).error).toBe('invalid_path');
  });

  it('returns 400 invalid_path for ../sentinel (escapes features dir)', async () => {
    const { res, status, body } = makeRes();
    // From knowledge/features/ up 4 levels reaches tmpDir; sentinel is at tmpDir/sentinel
    await handleFeaturesGet(makeGetReq(), res, { slug: '../../../../sentinel' }, contextRoot);
    expect(status()).toBe(400);
    expect((body() as { error: string }).error).toBe('invalid_path');
  });

  it('returns 404 (not 500) for slug="." — resolves to nonexistent ..md dotfile', async () => {
    const { res, status, body } = makeRes();
    await handleFeaturesGet(makeGetReq(), res, { slug: '.' }, contextRoot);
    expect(status()).toBe(404);
    expect((body() as { error: string }).error).toBe('not_found');
  });

  it('returns 404 for a legitimate-but-absent slug', async () => {
    const { res, status, body } = makeRes();
    await handleFeaturesGet(makeGetReq(), res, { slug: 'no-such-feature' }, contextRoot);
    expect(status()).toBe(404);
    expect((body() as { error: string }).error).toBe('not_found');
  });

  it('returns 200 with feature data for a legitimate existing slug', async () => {
    const { res, status, body } = makeRes();
    await handleFeaturesGet(makeGetReq(), res, { slug: 'my-feature' }, contextRoot);
    expect(status()).toBe(200);
    expect((body() as { feature: { slug: string } }).feature.slug).toBe('my-feature');
  });
});
