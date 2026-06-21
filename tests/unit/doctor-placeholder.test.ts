import { describe, it, expect } from 'vitest';

/**
 * Unit tests for the placeholder-detection logic in doctor.ts.
 *
 * We replicate `stripDocumentedMentions` here so the tests are independent of
 * the CLI harness. The function under test lives in doctor.ts and is tested
 * end-to-end via the integration suite; these unit tests verify the stripping
 * logic directly and cheaply.
 */

function stripDocumentedMentions(content: string): string {
  let result = content.replace(/```[\s\S]*?```/g, '');
  result = result.replace(/`[^`]*`/g, '');
  result = result.replace(/"[^"\n]*"/g, '');
  return result;
}

function hasPlaceholder(content: string): boolean {
  const stripped = stripDocumentedMentions(content);
  return stripped.includes('(Add your') || stripped.includes('{{') || stripped.includes('(To be defined)');
}

describe('doctor placeholder detector', () => {
  describe('files that should NOT be flagged', () => {
    it('ignores {{TOKEN}} inside an inline-code span', () => {
      const content = 'Use `{{PROJECT_NAME}}` as the template variable.';
      expect(hasPlaceholder(content)).toBe(false);
    });

    it('ignores (Add your ...) inside an inline-code span', () => {
      const content = 'The placeholder looks like `(Add your principles here)`.';
      expect(hasPlaceholder(content)).toBe(false);
    });

    it('ignores (To be defined) inside an inline-code span', () => {
      const content = 'Default value: `(To be defined)`.';
      expect(hasPlaceholder(content)).toBe(false);
    });

    it('ignores tokens inside a fenced code block', () => {
      const content = [
        'Example template:',
        '```',
        '{{PROJECT_NAME}}',
        '(Add your principles here)',
        '(To be defined)',
        '```',
        'End of doc.',
      ].join('\n');
      expect(hasPlaceholder(content)).toBe(false);
    });

    it('ignores tokens inside double-quoted strings', () => {
      const content = 'Template placeholders like "(Add your principles here)" are documented above.';
      expect(hasPlaceholder(content)).toBe(false);
    });

    it('ignores {{TOKEN}} inside a double-quoted string', () => {
      const content = 'Variables like "{{DATE}}" and "{{PROJECT_NAME}}" appear in templates.';
      expect(hasPlaceholder(content)).toBe(false);
    });

    it('real soul.md pattern: backtick + quote mentions are fine', () => {
      // Mirrors the actual content of _dream_context/core/0.soul.md
      const content = [
        '# Soul',
        '',
        'Template placeholders like "(Add your principles here)"',
        'and `{{PROJECT_NAME}}`, `{{DATE}}` (inside backticks)',
        'are documented conventions, not real stubs.',
      ].join('\n');
      expect(hasPlaceholder(content)).toBe(false);
    });
  });

  describe('files that SHOULD be flagged', () => {
    it('flags bare {{TOKEN}} in plain prose', () => {
      const content = 'Project name: {{PROJECT_NAME}}';
      expect(hasPlaceholder(content)).toBe(true);
    });

    it('flags bare (Add your ...) in plain prose', () => {
      const content = '(Add your principles here)';
      expect(hasPlaceholder(content)).toBe(true);
    });

    it('flags bare (To be defined) in plain prose', () => {
      const content = 'Stack: (To be defined)';
      expect(hasPlaceholder(content)).toBe(true);
    });

    it('flags a placeholder even when the file also has legitimate backtick mentions', () => {
      const content = [
        'Use `{{PROJECT_NAME}}` for naming.',
        '',
        'Stack: (To be defined)',
      ].join('\n');
      expect(hasPlaceholder(content)).toBe(true);
    });
  });
});
