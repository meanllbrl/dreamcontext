/**
 * Unit tests for agent-drop pure utilities:
 *   - sanitizeDropFilename  — rejects path traversal, strips separators, UUID fallback
 *   - sniffImageType        — magic-byte content-type detection
 *   - MAX_DROP_BYTES        — documented 25 MB cap constant
 */

import { describe, it, expect } from 'vitest';
import { sanitizeDropFilename, sniffImageType, MAX_DROP_BYTES } from '../../src/server/routes/agent-drop.js';

// ── PNG magic bytes: 8-byte signature ─────────────────────────────────────────
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// ── JPEG magic bytes: FF D8 FF ────────────────────────────────────────────────
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00]);
// ── GIF89a ────────────────────────────────────────────────────────────────────
const GIF89_HEADER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
// ── GIF87a ────────────────────────────────────────────────────────────────────
const GIF87_HEADER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00, 0x00]);
// ── WebP: RIFF????WEBP ────────────────────────────────────────────────────────
const WEBP_HEADER = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
]);
// ── non-image (PDF) ───────────────────────────────────────────────────────────
const PDF_HEADER = Buffer.from([0x25, 0x50, 0x44, 0x46]);

// UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\./;

describe('MAX_DROP_BYTES', () => {
  it('is exactly 25 MB', () => {
    expect(MAX_DROP_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('sniffImageType', () => {
  it('identifies PNG', () => {
    expect(sniffImageType(PNG_HEADER)).toBe('image/png');
  });

  it('identifies JPEG', () => {
    expect(sniffImageType(JPEG_HEADER)).toBe('image/jpeg');
  });

  it('identifies GIF89a', () => {
    expect(sniffImageType(GIF89_HEADER)).toBe('image/gif');
  });

  it('identifies GIF87a', () => {
    expect(sniffImageType(GIF87_HEADER)).toBe('image/gif');
  });

  it('identifies WebP', () => {
    expect(sniffImageType(WEBP_HEADER)).toBe('image/webp');
  });

  it('returns null for non-image (PDF header)', () => {
    expect(sniffImageType(PDF_HEADER)).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for a short buffer that does not match any signature', () => {
    expect(sniffImageType(Buffer.from([0x00, 0x01]))).toBeNull();
  });
});

describe('sanitizeDropFilename', () => {
  describe('path traversal rejection', () => {
    it('strips "../" components and produces a safe basename', () => {
      const result = sanitizeDropFilename('../../../etc/passwd', '.png');
      // basename('etc/passwd') → 'passwd', no dots stripped, but no extension → append
      expect(result).not.toContain('..');
      expect(result).not.toContain('/');
      expect(result).not.toContain('\\');
    });

    it('strips Windows path separators', () => {
      const result = sanitizeDropFilename('C:\\Users\\evil\\img.png', '.png');
      expect(result).not.toContain('\\');
      expect(result).not.toContain('/');
    });

    it('strips Unix path separators embedded in the name', () => {
      const result = sanitizeDropFilename('a/b/c.jpg', '.jpg');
      expect(result).not.toContain('/');
      // basename of 'a/b/c.jpg' is 'c.jpg', which should be kept as-is
      expect(result).toContain('c');
    });
  });

  describe('leading-dot removal', () => {
    it('strips leading dots to prevent hidden files or ".." names', () => {
      const result = sanitizeDropFilename('.hidden.png', '.png');
      expect(result.startsWith('.')).toBe(false);
    });

    it('strips multiple leading dots', () => {
      const result = sanitizeDropFilename('...only-dots', '.png');
      // After stripping leading dots → 'only-dots', which is safe
      expect(result.startsWith('.')).toBe(false);
    });
  });

  describe('UUID fallback', () => {
    it('falls back to UUID when name is empty', () => {
      const result = sanitizeDropFilename('', '.png');
      expect(UUID_RE.test(result)).toBe(true);
    });

    it('falls back to UUID when name has no alphanumeric chars after sanitize', () => {
      const result = sanitizeDropFilename('...', '.jpg');
      // Leading-dot strip leaves '', triggers UUID fallback
      expect(UUID_RE.test(result)).toBe(true);
    });

    it('UUID fallback carries the given extension', () => {
      const result = sanitizeDropFilename('', '.webp');
      expect(result.endsWith('.webp')).toBe(true);
    });
  });

  describe('extension handling', () => {
    it('preserves existing extension when present', () => {
      const result = sanitizeDropFilename('screenshot.png', '.jpg');
      // The file already has an extension, keep it
      expect(result).toMatch(/\.[A-Za-z0-9]+$/);
      expect(result).toContain('screenshot');
    });

    it('appends derived extension when name has none', () => {
      const result = sanitizeDropFilename('screenshot', '.webp');
      expect(result).toMatch(/\.webp$/);
    });
  });

  describe('character allow-list', () => {
    it('replaces special characters with underscores', () => {
      const result = sanitizeDropFilename('my file (1).png', '.png');
      // spaces and parens become underscores; result must not have spaces
      expect(result).not.toContain(' ');
      expect(result).not.toContain('(');
    });

    it('preserves word characters, dots, and hyphens', () => {
      const result = sanitizeDropFilename('my-photo_2024.jpg', '.jpg');
      expect(result).toBe('my-photo_2024.jpg');
    });
  });
});
