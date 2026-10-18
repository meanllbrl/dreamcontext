/**
 * THE RENDERING RULE on the task screens (plan r3 S4, § 5f): every task-authored string — a
 * card section, a criterion, a decision, a journal body, a note, a proposal, a learned quote,
 * an audit note — renders as React text or through `renderMarkdown` (marked + DOMPurify).
 *
 * A source scan: the root suite has no DOM. What the sanitizer actually does to a payload is
 * proven in Chromium by `scripts/verify/task-ui.mjs`, which seeds `onerror` / `onload` /
 * `<script>` / `<iframe>` / `javascript:` payloads and fails if any of them runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '..', '..', 'dashboard', 'src');
const read = (p: string): string => readFileSync(p, 'utf-8');
/** The source with its comments taken out, so a pin cannot pass (or fail) on a comment. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1 ');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mts)$/.test(name)) out.push(p);
  }
  return out;
}

const PAGES = ['TaskPage.tsx', 'InboxPage.tsx', 'PlanningPage.tsx', 'ReleasesPage.tsx'].map((f) => join(SRC, 'pages', f));
const DIRS = ['components/tasks/page', 'components/inbox', 'components/planning', 'components/releases', 'components/agent-door'];
const FILES = [...PAGES, ...DIRS.flatMap((d) => walk(join(SRC, d)))];
const rel = (p: string) => relative(SRC, p);

describe('the task screens have no raw HTML sink', () => {
  it('covers every file under the listed directories', () => {
    expect(FILES.length).toBeGreaterThan(20);
    for (const d of DIRS) expect(FILES.some((f) => rel(f).startsWith(d)), d).toBe(true);
  });

  it('no innerHTML / outerHTML assignment and no insertAdjacentHTML', () => {
    const hits = FILES.filter((f) => /\.(inner|outer)HTML\s*=|insertAdjacentHTML|document\.write/.test(code(read(f)))).map(rel);
    expect(hits).toEqual([]);
  });

  it('dangerouslySetInnerHTML only where it is fed by renderMarkdown', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = code(read(f));
      if (!src.includes('dangerouslySetInnerHTML')) continue;
      const imports = /import\s*\{[^}]*\brenderMarkdown\b[^}]*\}\s*from\s*'\.\/taskMarkdown'/.test(src);
      // Every `__html:` value is an identifier assigned from renderMarkdown(…) in this file.
      const values = [...src.matchAll(/__html:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
      const fed = values.length > 0 && values.every((v) => new RegExp(`\\b${v}\\s*=\\s*(?:useMemo\\(\\s*\\(\\)\\s*=>\\s*)?renderMarkdown\\(`).test(src));
      const inlineHtml = /dangerouslySetInnerHTML=\{\{/.test(src) && !/__html:\s*renderMarkdown\(/.test(src);
      if (!imports || !fed || inlineHtml) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
    // The one place that does it: the shared markdown block.
    expect(FILES.filter((f) => code(read(f)).includes('dangerouslySetInnerHTML')).map(rel)).toEqual(['components/tasks/page/MarkdownBlock.tsx']);
  });

  it('taskMarkdown.ts sanitizes what marked.parse returns', () => {
    const src = code(read(join(SRC, 'components/tasks/page/taskMarkdown.ts')));
    expect(src).toMatch(/import DOMPurify from 'dompurify'/);
    const fn = /export function renderMarkdown\(text: string\): string \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(fn).toMatch(/const html = marked\.parse\(/);
    expect(fn).toMatch(/return purify\.sanitize\(html, SANITIZE_CONFIG\);/);
    // Nothing returns unsanitized HTML on another path.
    expect(fn.match(/return /g)).toHaveLength(2); // the empty-text early return and the sanitized one
    expect(fn).toMatch(/if \(!text\) return '';/);
  });

  // Owner decision 2026-10-19 (the third pass's third flag): an ALLOW-list, and media keeps
  // working. What it does to a real payload is driven in Chromium by scripts/verify/task-ui.mjs.
  it('the sanitizer is an allow-list on its own instance: exactly these tags and attributes', async () => {
    const src = code(read(join(SRC, 'components/tasks/page/taskMarkdown.ts')));
    expect(src).toMatch(/const purify = DOMPurify\(\);/);
    expect(src).not.toMatch(/DOMPurify\.addHook/);
    expect(src).not.toMatch(/FORBID_TAGS|FORBID_ATTR|ADD_TAGS|ADD_ATTR/);
    const { SANITIZE_CONFIG } = await import('../../dashboard/src/components/tasks/page/taskMarkdown');
    expect([...SANITIZE_CONFIG.ALLOWED_TAGS].sort()).toEqual([
      'a', 'audio', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em', 'figcaption', 'figure',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
      's', 'source', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr',
      'ul', 'video',
    ]);
    for (const banned of ['style', 'svg', 'math', 'iframe', 'form', 'button', 'object', 'embed', 'link', 'meta', 'base', 'picture', 'track', 'script', 'image']) {
      expect(SANITIZE_CONFIG.ALLOWED_TAGS, banned).not.toContain(banned);
    }
    expect([...SANITIZE_CONFIG.ALLOWED_ATTR].sort()).toEqual([
      'align', 'alt', 'checked', 'class', 'colspan', 'controls', 'dir', 'disabled', 'height', 'href', 'lang',
      'loop', 'muted', 'open', 'playsinline', 'poster', 'preload', 'rowspan', 'src', 'start', 'title', 'type', 'width',
    ]);
    for (const banned of ['style', 'srcset', 'target', 'onerror', 'onclick', 'xlink:href', 'background', 'mask']) {
      expect(SANITIZE_CONFIG.ALLOWED_ATTR, banned).not.toContain(banned);
    }
    expect(SANITIZE_CONFIG.ALLOW_DATA_ATTR).toBe(false);
    expect(SANITIZE_CONFIG.ALLOW_ARIA_ATTR).toBe(false);
  });

  it('the hook applies the predicates: inputs, href, src/poster, type and class', () => {
    const src = code(read(join(SRC, 'components/tasks/page/taskMarkdown.ts')));
    const hook = /purify\.addHook\('afterSanitizeAttributes', \(node\) => \{[\s\S]*?\n\}\);/.exec(src)?.[0] ?? '';
    expect(hook).toMatch(/tag === 'input' && !\(el\.getAttribute\('type'\) === 'checkbox' && el\.hasAttribute\('disabled'\)\)/);
    expect(hook).toMatch(/el\.remove\(\)/);
    expect(hook).toMatch(/name === 'href' && !\(tag === 'a' && hrefAllowed\(value\)\)/);
    expect(hook).toMatch(/\(name === 'src' \|\| name === 'poster'\) && !sourceAllowed\(tag, value, window\.location\.href\)/);
    expect(hook).toMatch(/name === 'type' && !\(tag === 'input' \|\| \(tag === 'source' && mediaTypeAllowed\(value\)\)\)/);
    expect(hook).toMatch(/keptClasses\(value\)/);
  });

  it('hrefAllowed: http(s), mailto, relative and #; nothing else', async () => {
    const { hrefAllowed } = await import('../../dashboard/src/components/tasks/page/taskMarkdown');
    for (const ok of ['https://github.com/x', 'http://example.com', 'mailto:owner@example.com', '/tasks/a', 'docs/a.md', '#criteria', '?q=1']) {
      expect(hrefAllowed(ok), ok).toBe(true);
    }
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' javascript:x', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', 'blob:https://x/y']) {
      expect(hrefAllowed(bad), bad).toBe(false);
    }
  });

  it('sourceAllowed: https, same-origin, relative, and data:image on img only', async () => {
    const { sourceAllowed } = await import('../../dashboard/src/components/tasks/page/taskMarkdown');
    const base = 'http://127.0.0.1:4173/tasks/fix-login';
    // Synced media loads by the owner's choice: GitHub attachments, Firebase Storage, any https.
    expect(sourceAllowed('img', 'https://github.com/user-attachments/assets/x.png', base)).toBe(true);
    expect(sourceAllowed('img', 'https://firebasestorage.googleapis.com/v0/b/x/o/a.png?alt=media', base)).toBe(true);
    expect(sourceAllowed('video', 'https://x.test/v.mp4', base)).toBe(true);
    expect(sourceAllowed('source', 'https://x.test/v.webm', base)).toBe(true);
    // This app's own files and relative paths.
    expect(sourceAllowed('img', 'shots/a.png', base)).toBe(true);
    expect(sourceAllowed('img', '/api/files/a.png', base)).toBe(true);
    expect(sourceAllowed('img', 'http://127.0.0.1:4173/a.png', base)).toBe(true);
    // data:image on <img> only.
    expect(sourceAllowed('img', 'data:image/png;base64,AAAA', base)).toBe(true);
    expect(sourceAllowed('video', 'data:image/png;base64,AAAA', base)).toBe(false);
    expect(sourceAllowed('img', 'data:text/html,<script>x</script>', base)).toBe(false);
    // http from elsewhere, protocol-relative to http, and every other scheme.
    expect(sourceAllowed('video', 'http://x.test/p.png', base)).toBe(false);
    expect(sourceAllowed('img', '//x.test/a.png', base)).toBe(false);
    for (const bad of ['javascript:alert(1)', 'blob:https://x.test/1', 'file:///etc/passwd', 'ftp://x.test/a.png', 'java\nscript:x']) {
      expect(sourceAllowed('img', bad, base), bad).toBe(false);
    }
  });

  it('class keeps only language-*; a <source> type is a media type', async () => {
    const { keptClasses, mediaTypeAllowed } = await import('../../dashboard/src/components/tasks/page/taskMarkdown');
    expect(keptClasses('language-ts')).toBe('language-ts');
    expect(keptClasses('language-mermaid hljs')).toBe('language-mermaid');
    expect(keptClasses('btn btn--primary')).toBe('');
    expect(keptClasses('sidebar-badge language-')).toBe('');
    expect(mediaTypeAllowed('video/mp4')).toBe(true);
    expect(mediaTypeAllowed('audio/ogg')).toBe(true);
    expect(mediaTypeAllowed('text/html')).toBe(false);
    expect(mediaTypeAllowed('image/svg+xml')).toBe(false);
  });

  it('mermaid is reached only through lib/mermaidRender (securityLevel strict)', () => {
    const direct = FILES.filter((f) => /from\s+'mermaid'|import\(\s*'mermaid'\s*\)|require\('mermaid'\)/.test(code(read(f)))).map(rel);
    expect(direct).toEqual([]);
    const lib = read(join(SRC, 'lib/mermaidRender.ts'));
    expect(lib).toMatch(/securityLevel: 'strict'/);
    expect(lib).not.toMatch(/securityLevel: '(loose|antiscript|sandbox)'/);
  });

  it('the markdown block loads diagrams lazily, only for a mermaid fence', () => {
    const src = code(read(join(SRC, 'components/tasks/page/MarkdownBlock.tsx')));
    expect(src).toMatch(/import\('\.\.\/\.\.\/\.\.\/lib\/mermaidRender'\)/);
    expect(src).not.toMatch(/^import .*mermaidRender/m);
    expect(src).toMatch(/hasMermaidFence\(text\)/);
  });
});
