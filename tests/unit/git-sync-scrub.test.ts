import { describe, it, expect } from 'vitest';
import { scrubContent, summarizeScrub } from '../../src/lib/git-sync/scrub.js';

describe('git-sync/scrub — scrubContent', () => {
  it('clean content has no hits', () => {
    expect(scrubContent('knowledge/x.md', 'Just some ordinary prose about the architecture.')).toEqual([]);
  });

  it('BLOCKs a GitHub PAT (ghp_ + 36 chars)', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const hits = scrubContent('state/.secrets.json', `token: ${token}`);
    expect(hits.some((h) => h.rule === 'github-pat' && h.severity === 'block')).toBe(true);
  });

  it('BLOCKs a GitHub fine-grained PAT', () => {
    const hits = scrubContent('a.md', `github_pat_${'a'.repeat(25)}`);
    expect(hits.some((h) => h.rule === 'github-pat-fine-grained' && h.severity === 'block')).toBe(true);
  });

  it('BLOCKs GitHub OAuth-style tokens (gho_/ghu_/ghs_/ghr_)', () => {
    for (const prefix of ['gho_', 'ghu_', 'ghs_', 'ghr_']) {
      const hits = scrubContent('a.md', `${prefix}${'b'.repeat(36)}`);
      expect(hits.some((h) => h.rule === 'github-oauth-token' && h.severity === 'block')).toBe(true);
    }
  });

  it('BLOCKs an AWS access key', () => {
    const hits = scrubContent('a.md', 'AKIAABCDEFGHIJKLMNOP');
    expect(hits.some((h) => h.rule === 'aws-access-key' && h.severity === 'block')).toBe(true);
  });

  it('BLOCKs a Google API key', () => {
    const hits = scrubContent('a.md', `AIza${'A'.repeat(35)}`);
    expect(hits.some((h) => h.rule === 'google-api-key' && h.severity === 'block')).toBe(true);
  });

  it('BLOCKs a Slack token', () => {
    const hits = scrubContent('a.md', `xoxb-${'1'.repeat(12)}`);
    expect(hits.some((h) => h.rule === 'slack-token' && h.severity === 'block')).toBe(true);
  });

  it('BLOCKs an Anthropic key', () => {
    const hits = scrubContent('a.md', `sk-ant-${'a'.repeat(30)}`);
    expect(hits.some((h) => h.rule === 'anthropic-key' && h.severity === 'block')).toBe(true);
  });

  it('BLOCKs a Stripe live key', () => {
    const hits = scrubContent('a.md', `sk_live_${'a'.repeat(20)}`);
    expect(hits.some((h) => h.rule === 'stripe-live-key' && h.severity === 'block')).toBe(true);
  });

  it('BLOCKs an OpenAI-style key', () => {
    const hits = scrubContent('a.md', `sk-${'a'.repeat(25)}`);
    expect(hits.some((h) => h.rule === 'openai-key' && h.severity === 'block')).toBe(true);
  });

  it('BLOCKs a private key header', () => {
    const hits = scrubContent('a.pem', '-----BEGIN RSA PRIVATE KEY-----');
    expect(hits.some((h) => h.rule === 'private-key-header' && h.severity === 'block')).toBe(true);
  });

  it('BLOCKs a 3-part JWT', () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(20)}.${'b'.repeat(20)}`;
    const hits = scrubContent('a.md', jwt);
    expect(hits.some((h) => h.rule === 'jwt' && h.severity === 'block')).toBe(true);
  });

  it('WARNs (does not block) on a home-directory path', () => {
    const hits = scrubContent('knowledge/setup.md', 'The install lives at /Users/alice/projects/thing.');
    expect(hits.some((h) => h.rule === 'home-path' && h.severity === 'warn')).toBe(true);
    expect(hits.some((h) => h.severity === 'block')).toBe(false);
  });

  it('WARNs on a generic secret-looking assignment', () => {
    const hits = scrubContent('a.md', 'token = "abcdefghijklmnop"');
    expect(hits.some((h) => h.rule === 'generic-secret-assignment' && h.severity === 'warn')).toBe(true);
  });

  it('never echoes the secret in the excerpt (redaction)', () => {
    const token = `ghp_${'z'.repeat(36)}`;
    const hits = scrubContent('a.md', `export GITHUB_TOKEN=${token}`);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.excerpt).not.toContain(token);
      expect(h.excerpt).toContain('[REDACTED]');
    }
  });

  it('summarizeScrub partitions blocks vs warns', () => {
    const hits = scrubContent('a.md', [
      `ghp_${'a'.repeat(36)}`,
      '/Users/bob/repo',
    ].join('\n'));
    const { blocks, warns } = summarizeScrub(hits);
    expect(blocks.length).toBe(1);
    expect(warns.length).toBe(1);
  });
});
