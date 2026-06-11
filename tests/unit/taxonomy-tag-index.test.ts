import { describe, it, expect } from 'vitest';
import { buildFields, tokenize, stemToken } from '../../src/lib/recall.js';

/**
 * Tag-index unit tests: verify that buildFields strips known-facet prefixes
 * from tags before tokenising, so high-df prefix tokens like 'topic' and
 * 'domain' don't pollute BM25 DF counts.
 */

describe('buildFields: tags indexed by value only (tagIndexValue applied)', () => {
  it('docA: topic:recall -> tokenSet has recall-stem but NOT bare "topic" token', () => {
    const fields = buildFields({
      slug: 'doc-a',
      title: '',
      description: '',
      tags: ['topic:recall'],
      body: '',
    });
    const recallStem = stemToken('recall');
    // The value 'recall' (stemmed) must be present.
    expect(fields.tokens).toContain(recallStem);
    // The raw prefix 'topic' must NOT appear as a standalone token.
    expect(fields.tokens).not.toContain('topic');
  });

  it('docB: domain:database -> tokenSet has database-stem but NOT bare "domain" token', () => {
    const fields = buildFields({
      slug: 'doc-b',
      title: '',
      description: '',
      tags: ['domain:database'],
      body: '',
    });
    const dbStem = stemToken('database');   // 'databas'
    expect(fields.tokens).toContain(dbStem);
    expect(fields.tokens).not.toContain('domain');
  });

  it('bare tag "architecture" is indexed unchanged (no facet prefix to strip)', () => {
    const fields = buildFields({
      slug: 'doc-c',
      title: '',
      description: '',
      tags: ['architecture'],
      body: '',
    });
    const archStem = stemToken('architecture');
    expect(fields.tokens).toContain(archStem);
  });

  it('unknown-facet tag "foo:bar" is indexed whole (foo is not a known facet)', () => {
    const fields = buildFields({
      slug: 'doc-d',
      title: '',
      description: '',
      tags: ['foo:bar'],
      body: '',
    });
    // tagIndexValue('foo:bar') returns 'foo:bar' unchanged; tokenize then splits on ':'.
    // So we expect 'foo' and 'bar' to be present (tokenization splits on colon).
    // The important thing is no crash; the value 'bar' is findable.
    const tokens = fields.tokens;
    expect(tokens.some((t) => t === 'bar' || t === stemToken('bar'))).toBe(true);
  });

  it('layer:frontend -> "frontend" stem present, "layer" prefix absent', () => {
    const fields = buildFields({
      slug: 'doc-e',
      title: '',
      description: '',
      tags: ['layer:frontend'],
      body: '',
    });
    const frontendStem = stemToken('frontend');
    expect(fields.tokens).toContain(frontendStem);
    expect(fields.tokens).not.toContain('layer');
  });

  it('kind:api -> "api" token present, "kind" prefix absent', () => {
    const fields = buildFields({
      slug: 'doc-f',
      title: '',
      description: '',
      tags: ['kind:api'],
      body: '',
    });
    expect(fields.tokens).toContain('api');
    expect(fields.tokens).not.toContain('kind');
  });
});
