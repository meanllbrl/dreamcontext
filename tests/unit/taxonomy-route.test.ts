/**
 * Unit tests for GET /api/taxonomy route handler.
 *
 * Verifies that handleTaxonomyGet:
 *   - Returns HTTP 200 with vocabulary, usage, and audit keys.
 *   - vocabulary contains facetTags, aliases, bareTags.
 *   - usage is a Record<string, number> (may be empty in a bare fixture).
 *   - audit contains the four AuditBuckets keys.
 *   - Correctly counts tag usage from corpus docs.
 *   - Resolves aliases onto canonical forms in usage counts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleTaxonomyGet } from '../../src/server/routes/taxonomy.js';
import type { TaxonomyResponse } from '../../dashboard/src/hooks/useTaxonomy.js';

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

// Minimal knowledge file front matter with a faceted tag
const KNOWLEDGE_DOC = [
  '---',
  'name: test-knowledge',
  'description: A test knowledge file',
  'tags:',
  '  - topic:recall',
  '  - domain:database',
  'date: "2026-01-01"',
  'pinned: false',
  '---',
  '',
  'Content here.',
  '',
].join('\n');

// Second knowledge file using an alias
const KNOWLEDGE_DOC_ALIAS = [
  '---',
  'name: alias-knowledge',
  'description: Uses an alias tag',
  'tags:',
  '  - search',
  'date: "2026-01-01"',
  'pinned: false',
  '---',
  '',
  'Recall via alias.',
  '',
].join('\n');

beforeEach(() => {
  tmpDir = join(tmpdir(), `tax-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  contextRoot = join(tmpDir, '_dream_context');
  mkdirSync(join(contextRoot, 'knowledge'), { recursive: true });
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  mkdirSync(join(contextRoot, 'core'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/taxonomy', () => {
  it('returns HTTP 200', async () => {
    const { res, status } = makeRes();
    await handleTaxonomyGet(makeGetReq(), res, {}, contextRoot);
    expect(status()).toBe(200);
  });

  it('response has vocabulary, usage, and audit keys', async () => {
    const { res, body } = makeRes();
    await handleTaxonomyGet(makeGetReq(), res, {}, contextRoot);
    const payload = body() as TaxonomyResponse;
    expect(payload).toHaveProperty('vocabulary');
    expect(payload).toHaveProperty('usage');
    expect(payload).toHaveProperty('audit');
  });

  it('vocabulary has facetTags, aliases, and bareTags', async () => {
    const { res, body } = makeRes();
    await handleTaxonomyGet(makeGetReq(), res, {}, contextRoot);
    const { vocabulary } = body() as TaxonomyResponse;
    expect(vocabulary).toHaveProperty('facetTags');
    expect(vocabulary).toHaveProperty('aliases');
    expect(vocabulary).toHaveProperty('bareTags');
    // facetTags should contain the four known facets
    expect(vocabulary.facetTags).toHaveProperty('domain');
    expect(vocabulary.facetTags).toHaveProperty('layer');
    expect(vocabulary.facetTags).toHaveProperty('kind');
    expect(vocabulary.facetTags).toHaveProperty('topic');
    expect(Array.isArray(vocabulary.facetTags.domain)).toBe(true);
  });

  it('audit has untagged, nonCanonical, orphan, nearDups', async () => {
    const { res, body } = makeRes();
    await handleTaxonomyGet(makeGetReq(), res, {}, contextRoot);
    const { audit } = body() as TaxonomyResponse;
    expect(Array.isArray(audit.untagged)).toBe(true);
    expect(Array.isArray(audit.nonCanonical)).toBe(true);
    expect(Array.isArray(audit.orphan)).toBe(true);
    expect(Array.isArray(audit.nearDups)).toBe(true);
  });

  it('counts tag usage from corpus docs', async () => {
    writeFileSync(join(contextRoot, 'knowledge', 'test-knowledge.md'), KNOWLEDGE_DOC);

    const { res, body } = makeRes();
    await handleTaxonomyGet(makeGetReq(), res, {}, contextRoot);
    const { usage } = body() as TaxonomyResponse;
    // topic:recall and domain:database appear once each
    expect(usage['topic:recall']).toBe(1);
    expect(usage['domain:database']).toBe(1);
  });

  it('resolves alias tags onto canonical form in usage', async () => {
    // "search" is an alias for "topic:recall" in DEFAULT_VOCABULARY
    writeFileSync(join(contextRoot, 'knowledge', 'alias-knowledge.md'), KNOWLEDGE_DOC_ALIAS);

    const { res, body } = makeRes();
    await handleTaxonomyGet(makeGetReq(), res, {}, contextRoot);
    const { usage } = body() as TaxonomyResponse;
    // alias "search" should aggregate onto canonical "topic:recall"
    expect(usage['topic:recall']).toBeGreaterThanOrEqual(1);
    // raw alias key should not appear as a separate tally
    expect(usage['search']).toBeUndefined();
  });

  it('returns 200 even with no corpus docs', async () => {
    // Empty contextRoot (no knowledge dir files)
    const { res, status, body } = makeRes();
    await handleTaxonomyGet(makeGetReq(), res, {}, contextRoot);
    expect(status()).toBe(200);
    const payload = body() as TaxonomyResponse;
    expect(payload.usage).toEqual({});
  });
});
