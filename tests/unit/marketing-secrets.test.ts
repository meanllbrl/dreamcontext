import { describe, it, expect } from 'vitest';
import { redactSecrets, redactDeep } from '../../src/lib/marketing/secrets.js';

describe('marketing/secrets.redactSecrets', () => {
  it('redacts Bearer tokens', () => {
    const out = redactSecrets('Authorization: Bearer EAAGm0PX4ZCpsBOzZBshouldnotappear');
    expect(out).not.toContain('EAAGm0PX4ZCpsBOzZB');
    expect(out).toContain('Bearer [REDACTED]');
  });

  it('redacts access_token in URL', () => {
    const out = redactSecrets('https://graph.facebook.com/v21.0/me?access_token=EAA12345abcde&fields=id');
    expect(out).not.toContain('EAA12345abcde');
    expect(out).toContain('access_token=[REDACTED]');
  });

  it('redacts EAA-prefixed Graph tokens', () => {
    const out = redactSecrets('token: EAAQQQQ12345678901234567890abcdefABCDEF99');
    expect(out).not.toContain('EAAQQQQ');
  });

  it('redacts SHA-256 hashes', () => {
    const sha = 'a'.repeat(64);
    expect(redactSecrets(`hash=${sha}`)).not.toContain(sha);
  });

  it('redacts long opaque blobs ≥ 40 chars', () => {
    const blob = 'X' + 'k7Lp9q1r3sUvWxY2zA4bC6dE8fG0hI2jK4lM6nO8'; // 41 chars total
    const out = redactSecrets(`token=${blob}`);
    expect(out).not.toContain(blob);
  });

  it('passes short non-sensitive strings through unchanged', () => {
    expect(redactSecrets('hello world')).toBe('hello world');
    expect(redactSecrets('campaign_id=120209876543210')).toContain('120209876543210');
  });

  it('redactDeep walks nested objects/arrays/strings', () => {
    const input = {
      url: 'https://x.com?access_token=EAAabcdef12345',
      list: ['Bearer EAAVeryLongBlob123456'],
      nested: { sha: 'b'.repeat(64), keep: 'value' },
    };
    const out = redactDeep(input) as typeof input;
    expect(out.url).toContain('[REDACTED]');
    expect(out.list[0]).toContain('Bearer [REDACTED]');
    expect(out.nested.sha).toBe('[REDACTED]');
    expect(out.nested.keep).toBe('value');
  });
});
