/**
 * One-row page headers (task codex-tarzi-yeni-kabuk W2-B, AC 11): every non-chat page of the new
 * shell has its title at the left of its own toolbar row (or a title-only bar when it has no
 * toolbar), from the rail's own label, and only in the new shell: each title is gated on the
 * shell (or on a prop only the new shell passes), so classic markup is unchanged. The OFF pixel
 * lock (e2e/new-layout-off.spec.ts) proves the classic half on screen.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../dashboard/src/${rel}`, import.meta.url)), 'utf-8');
const { PageTitle, PageBar } = await import('../../dashboard/src/components/layout/PageBar.js');
const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
const inI18n = (el: unknown) => renderToStaticMarkup(createElement(I18nProvider, null, el as never));

/** Page → [the file that draws its title, the label key, how it is gated]. */
const INLINE: Record<string, [string, string, RegExp]> = {
  tasks: ['components/tasks/KanbanBoard.tsx', 'nav.tasks', /title=\{newShell \? t\('nav\.tasks'\) : undefined\}/],
  roadmap: ['components/roadmap/RoadmapBoard.tsx', 'nav.roadmap', /pageTitle=\{newShell \? t\('nav\.roadmap'\) : undefined\}/],
  hypotheses: ['components/theses/ThesisBoard.tsx', 'nav.hypotheses', /pageTitle=\{newShell \? t\('nav\.hypotheses'\) : undefined\}/],
  lab: ['components/lab/board/BoardPage.tsx', 'nav.labpage', /\{newShell && <PageTitle title=\{t\('nav\.labpage'\)\} \/>\}/],
  knowledge: ['pages/KnowledgePage.tsx', 'nav.knowledge', /pageTitle=\{newShell \? t\('nav\.knowledge'\) : undefined\}/],
  brain: ['pages/BrainPage.tsx', 'nav.brain', /newShell \? \(\s*<>\s*<PageTitle title=\{t\('nav\.brain'\)\} \/>/],
  council: ['components/council/CouncilHall.tsx', 'nav.council', /\{newShell && <PageTitle title=\{t\('nav\.council'\)\} \/>\}/],
  whiteboards: ['pages/WhiteboardsPage.tsx', 'nav.whiteboard', /\{newShell && <PageTitle title=\{t\('nav\.whiteboard'\)\} \/>\}/],
  automations: ['pages/AiTeamPage.tsx', 'nav.aiTeam', /if \(!newShell\) return page;[\s\S]*<PageBar title=\{t\('nav\.aiTeam'\)\}>/],
};
const TITLE_ONLY = ['core', 'taxonomy', 'sleep', 'packs', 'announcements', 'about'];

describe('page headers', () => {
  it('every inline title sits in its row, from the rail label, gated on the new shell', () => {
    for (const [page, [file, , gate]] of Object.entries(INLINE)) {
      expect(read(file), page).toMatch(gate);
    }
  });

  it('a page state with no toolbar row (off, empty) still carries the one title bar', () => {
    expect(read('pages/HypothesesPage.tsx')).toMatch(/return newShell \? <div className="ns-empty-page"><PageBar title=\{t\('nav\.hypotheses'\)\} \/>\{off\}<\/div> : off;/);
    expect(read('components/lab/board/BoardPage.tsx')).toMatch(/board-page--empty">\s*\{newShell && <PageBar title=\{t\('nav\.labpage'\)\} \/>\}/);
    expect(read('components/council/CouncilHall.tsx')).toMatch(/if \(newShell\) return <><PageBar flush title=\{t\('nav\.council'\)\} \/><CouncilEmptyState/);
  });

  it('the toolbar components draw the title only when given one, and mark the row', () => {
    for (const file of ['components/tasks/BoardViewTabs.tsx', 'components/roadmap/RoadmapToolbar.tsx', 'components/theses/ThesisBoardToolbar.tsx', 'components/search/BrainSearch.tsx']) {
      const src = read(file);
      expect(src, file).toMatch(/<PageTitle title=\{(p\.)?(title|pageTitle)\} \/>/);
      expect(src, file).toMatch(/data-page-row/);
    }
  });

  it('pages without a toolbar get a title-only bar from the router, in the new shell only', () => {
    const src = read('ProjectInstance.tsx');
    const set = /const TITLE_BAR_PAGES[^=]*= new Set<Page>\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? '';
    expect(set.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual(TITLE_ONLY);
    expect(src).toMatch(/\{TITLE_BAR_PAGES\.has\(nav\.page\) && <PageBar flush title=\{t\(PAGE_LABEL_KEY\[nav\.page\]\)\} \/>\}/);
    expect(src).toMatch(/\{newShell \? \(\s*<NewShellPage nav=\{nav\}>/);
  });

  it('covers all sixteen non-chat pages with exactly one title each (Settings draws its own bar)', () => {
    const pages = [...Object.keys(INLINE), ...TITLE_ONLY, 'settings'];
    expect(new Set(pages).size).toBe(16);
    expect(read('pages/SettingsPage.tsx')).toMatch(/<PageBar[^>]*title=\{t\('nav\.settings'\)\}/);
    // The AI Team roster drops its own h1 under the page bar.
    expect(read('components/aiteam/TeamRoster.tsx')).toMatch(/\{!headless && \(\s*<div className="aiteam-roster-head">/);
  });

  it('a title is one 18px h1 of the bar\'s class; "← Chat" shows only for a page a chat opened', () => {
    const plain = inI18n(createElement(PageTitle, { title: 'Tasks' }));
    expect(plain.match(/<h1 /g)).toHaveLength(1);
    expect(plain).toContain('class="page-bar-title page-bar-title--inline"');
    expect(plain).not.toContain('page-bar-back');
    const bar = inI18n(createElement(PageBar, { title: 'Core', onBackToChat: () => {} }));
    expect(bar).toContain('page-bar-back');
    const css = read('components/layout/PageBar.css');
    expect(css).toMatch(/\.page-bar-title \{[^}]*font-size: calc\(18px \* var\(--zoom\)\)/);
    expect(css).toMatch(/\[data-page-row\] \{[^}]*min-height: var\(--space-13\);[^}]*border-bottom: 1px solid var\(--color-border\)/);
  });
});
