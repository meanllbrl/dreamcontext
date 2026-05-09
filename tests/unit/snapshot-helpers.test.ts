import { describe, it, expect } from 'vitest';
import {
  extractFirstParagraph,
  extractPinnedPreview,
  DEFAULT_PINNED_PREVIEW_LINES,
} from '../../src/cli/commands/snapshot.js';

describe('extractFirstParagraph', () => {
  it('extracts first paragraph from markdown content', () => {
    const content = `# JWT Auth Flow

JWT authentication uses RS256 with 24h access tokens and 7d refresh tokens.
The refresh flow uses httpOnly cookies with strict SameSite policy.

## Details

More content here.`;

    const result = extractFirstParagraph(content);
    expect(result).toContain('JWT authentication uses RS256');
    expect(result).toContain('httpOnly cookies');
    expect(result).not.toContain('## Details');
  });

  it('returns empty string for heading-only content', () => {
    const content = `# Title

## Section 1

## Section 2`;

    const result = extractFirstParagraph(content);
    expect(result).toBe('');
  });

  it('caps long paragraphs at 300 chars', () => {
    const content = 'A'.repeat(400);
    const result = extractFirstParagraph(content);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(result).toContain('...');
  });

  it('skips frontmatter markers', () => {
    const content = `---
name: Test
---

First paragraph of content.

Second paragraph.`;

    const result = extractFirstParagraph(content);
    expect(result).toBe('First paragraph of content.');
  });

  it('handles empty content', () => {
    expect(extractFirstParagraph('')).toBe('');
    expect(extractFirstParagraph('\n\n\n')).toBe('');
  });

  it('joins multi-line paragraphs', () => {
    const content = `# Title

Line one of paragraph.
Line two of paragraph.
Line three.

Next paragraph.`;

    const result = extractFirstParagraph(content);
    expect(result).toBe('Line one of paragraph. Line two of paragraph. Line three.');
  });
});

describe('extractPinnedPreview', () => {
  it('returns full content untruncated when under cap', () => {
    const body = ['## Heading', '', 'Line 1', 'Line 2'].join('\n');
    const result = extractPinnedPreview(body, 60);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(4);
    expect(result.preview).toBe(body);
  });

  it('truncates to maxLines when over cap', () => {
    const body = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join('\n');
    const result = extractPinnedPreview(body, 60);
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(200);
    expect(result.preview.split('\n')).toHaveLength(60);
    expect(result.preview).toContain('Line 60');
    expect(result.preview).not.toContain('Line 61');
  });

  it('strips leading frontmatter before counting', () => {
    const body = ['---', 'name: Test', 'pinned: true', '---', '', 'Real line 1', 'Real line 2'].join('\n');
    const result = extractPinnedPreview(body, 60);
    expect(result.preview).toBe('Real line 1\nReal line 2');
    expect(result.totalLines).toBe(2);
  });

  it('handles empty content', () => {
    const result = extractPinnedPreview('', 60);
    expect(result.preview).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(1);
  });

  it('exposes default cap as 60', () => {
    expect(DEFAULT_PINNED_PREVIEW_LINES).toBe(60);
  });
});
