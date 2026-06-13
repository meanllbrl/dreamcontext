import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildInterestProfile,
  computeDigest,
} from '../../src/lib/federation-digest.js';

function makeContextRoot(prefix: string): string {
  const root = join(
    tmpdir(),
    `dc-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    '_dream_context',
  );
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  return root;
}

interface KnowledgeOpts {
  body: string;
  tags?: string[];
  date?: string | null;
  federated?: boolean;
}

function writeKnowledge(root: string, slug: string, opts: KnowledgeOpts): void {
  const fm: string[] = [`name: ${slug}`, 'type: knowledge'];
  if (opts.tags && opts.tags.length > 0) {
    fm.push('tags:');
    for (const t of opts.tags) fm.push(`  - ${t}`);
  }
  // Quote the date so gray-matter keeps it a STRING (recall.ts reads string dates).
  if (opts.date) fm.push(`date: "${opts.date}"`);
  if (opts.federated) fm.push('federated: true');
  writeFileSync(
    join(root, 'knowledge', `${slug}.md`),
    `---\n${fm.join('\n')}\n---\n\n${opts.body}\n`,
    'utf-8',
  );
}

describe('computeDigest', () => {
  let sender: string;

  beforeEach(() => {
    sender = makeContextRoot('digest-sender');
  });
  afterEach(() => {
    rmSync(join(sender, '..'), { recursive: true, force: true });
  });

  const profile = { terms: ['observability', 'tracing'], query: 'observability tracing' };

  it('excludes docs with federated:true from the digest source set', () => {
    writeKnowledge(sender, 'native', {
      body: 'observability tracing pipeline native to the sender vault',
    });
    writeKnowledge(sender, 'ingested', {
      body: 'observability tracing pipeline ingested from a peer',
      federated: true,
    });

    const entries = computeDigest(sender, 'sender', profile, null, 10);
    const slugs = entries.map((e) => e.origin.entryId);
    expect(entries.some((e) => e.title === 'native')).toBe(true);
    // The federated doc is never re-exported (transitive-leak guard).
    expect(slugs.some((id) => id.includes('ingested'))).toBe(false);
  });

  it('excludes docs older than the sinceISO watermark', () => {
    writeKnowledge(sender, 'old', {
      body: 'observability tracing pipeline from before the watermark',
      date: '2026-01-01',
    });
    writeKnowledge(sender, 'fresh', {
      body: 'observability tracing pipeline after the watermark',
      date: '2026-06-10',
    });

    const entries = computeDigest(sender, 'sender', profile, '2026-03-01', 10);
    const titles = entries.map((e) => e.title);
    expect(titles).toContain('fresh');
    expect(titles).not.toContain('old');
  });

  it('INCLUDES docs with undefined updatedAt (no date frontmatter)', () => {
    writeKnowledge(sender, 'undated', {
      body: 'observability tracing pipeline with no date frontmatter at all',
      // no date → updatedAt undefined → must be included even with a watermark.
    });

    const entries = computeDigest(sender, 'sender', profile, '2026-03-01', 10);
    expect(entries.map((e) => e.title)).toContain('undated');
  });
});

describe('buildInterestProfile', () => {
  let peer: string;

  beforeEach(() => {
    peer = makeContextRoot('digest-peer');
  });
  afterEach(() => {
    rmSync(join(peer, '..'), { recursive: true, force: true });
  });

  it('picks up the peer corpus tags', () => {
    writeKnowledge(peer, 'doc', {
      body: 'a doc',
      tags: ['caching', 'gateway'],
    });

    const profile = buildInterestProfile(peer, null);
    // tokenize stems terms (caching → cach), so assert on the stemmed forms.
    expect(profile.terms).toContain('cach');
    expect(profile.terms).toContain('gateway');
  });

  it('honors an explicit topics override as the sole signal', () => {
    writeKnowledge(peer, 'doc', {
      body: 'a doc',
      tags: ['caching', 'gateway'],
    });

    const profile = buildInterestProfile(peer, ['billing', 'invoices']);
    // tokenize stems: billing → bill, invoices → invoic.
    expect(profile.terms).toContain('bill');
    expect(profile.terms).toContain('invoic');
    // The topic override REPLACES the corpus-derived signal.
    expect(profile.terms).not.toContain('cach');
    expect(profile.terms).not.toContain('gateway');
  });
});
