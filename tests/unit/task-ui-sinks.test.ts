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

  // End review, finding 6: no form controls, and no image that loads from another origin.
  it('the sanitizer forbids form controls and drops a remote image src, on its own instance', () => {
    const src = code(read(join(SRC, 'components/tasks/page/taskMarkdown.ts')));
    expect(src).toMatch(/const SANITIZE_CONFIG = \{ FORBID_TAGS: \['form', 'input', 'button', 'iframe'\] \};/);
    // A private instance: the hook must not change the other DOMPurify callers.
    expect(src).toMatch(/const purify = DOMPurify\(\);/);
    expect(src).not.toMatch(/DOMPurify\.addHook/);
    const hook = /purify\.addHook\('afterSanitizeAttributes', \(node\) => \{[\s\S]*?\n\}\);/.exec(src)?.[0] ?? '';
    expect(hook).toMatch(/node\.nodeName !== 'IMG'/);
    expect(hook).toMatch(/removeAttribute\('srcset'\)/);
    expect(hook).toMatch(/!imageSourceAllowed\(src, window\.location\.href\)\) el\.removeAttribute\('src'\)/);
  });

  it('imageSourceAllowed keeps data: and same-origin images and drops the rest', async () => {
    const { imageSourceAllowed } = await import('../../dashboard/src/components/tasks/page/taskMarkdown');
    const base = 'http://localhost:4173/tasks/fix-login';
    expect(imageSourceAllowed('data:image/png;base64,AAAA', base)).toBe(true);
    expect(imageSourceAllowed('/api/files/shot.png', base)).toBe(true);
    expect(imageSourceAllowed('http://localhost:4173/a.png', base)).toBe(true);
    expect(imageSourceAllowed('https://tracker.example/p.gif?u=1', base)).toBe(false);
    expect(imageSourceAllowed('//tracker.example/p.gif', base)).toBe(false);
    expect(imageSourceAllowed('http://localhost:9999/a.png', base)).toBe(false);
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
