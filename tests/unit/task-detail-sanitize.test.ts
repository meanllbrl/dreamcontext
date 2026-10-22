import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_FORBID_TAGS, isBlockedUrl } from '../../dashboard/src/components/tasks/detail/sanitize';

/**
 * The task drawer's sanitizer (AC10). The repo has no DOM implementation for vitest (no jsdom),
 * so the DOMPurify run itself is proven in real Chromium by `npm run verify:task-ui` (a body
 * with script / onerror / iframe / javascript: / an /api/ image renders stripped). Here: the
 * URL rule, the forbidden-tag list, and that every marked output in the drawer goes through it.
 */
const BASE = 'http://127.0.0.1:4173/';

describe('isBlockedUrl', () => {
  it.each([
    '/api/tasks', '/API/tasks/x/assets/raw?path=a.png', 'javascript:alert(1)', ' JavaScript:alert(1)',
    'java\tscript:alert(1)', 'http://127.0.0.1:4173/api/health', '//127.0.0.1:4173/api/x', 'api/tasks',
  ])('blocks %s', (u) => {
    expect(isBlockedUrl(u, BASE)).toBe(true);
  });

  it.each(['https://example.com/a.png', 'https://example.com/api/x', '#anchor', 'mailto:a@b.c', '', null])('keeps %s', (u) => {
    expect(isBlockedUrl(u as string, BASE)).toBe(false);
  });
});

describe('forbidden tags', () => {
  it('forbids script, style, iframe, object, embed and form', () => {
    expect([...TASK_FORBID_TAGS].sort()).toEqual(['embed', 'form', 'iframe', 'object', 'script', 'style']);
  });
});

describe('every marked output in the drawer is sanitized', () => {
  const dir = join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'tasks');
  const files = ['TaskDetailPanel.tsx', 'detail/BodySections.tsx', 'detail/CriteriaSection.tsx', 'detail/SubtasksSection.tsx'];
  it.each(files)('%s: no raw marked HTML reaches dangerouslySetInnerHTML', (f) => {
    const src = readFileSync(join(dir, f), 'utf-8');
    for (const m of src.matchAll(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+)\}\}/g)) {
      expect(m[1], `${f}: ${m[1]}`).toMatch(/sanitizeTaskHtml\(|Html\b/);
    }
    for (const m of src.matchAll(/marked\.(parse|parseInline)\(/g)) {
      const at = m.index ?? 0;
      expect(src.slice(Math.max(0, at - 40), at + 120), `${f}: marked call not wrapped`).toMatch(/sanitizeTaskHtml\(/);
    }
  });
});

describe('every URL attribute is checked', () => {
  it('a later srcset candidate pointing at /api/ is blocked', async () => {
    const { attrHasBlockedUrl } = await import('../../dashboard/src/components/tasks/detail/sanitize');
    expect(attrHasBlockedUrl('srcset', 'a.png 1x, /api/tasks 2x', BASE)).toBe(true);
    expect(attrHasBlockedUrl('srcset', 'a.png 1x, b.png 2x', BASE)).toBe(false);
    expect(attrHasBlockedUrl('background', '/api/launcher/discover', BASE)).toBe(true);
    expect(attrHasBlockedUrl('xlink:href', '/api/launcher/detect', BASE)).toBe(true);
  });
  it('the config forbids the style and background attributes', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'tasks', 'detail', 'sanitize.ts'), 'utf-8');
    expect(src).toMatch(/FORBID_ATTR:\s*\['style', 'background'\]/);
    expect(src).toMatch(/'xlink:href'/);
  });
});
