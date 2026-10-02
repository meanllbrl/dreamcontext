/**
 * A v1 app insight on a board (LabAppBody + InsightBlock): the insight block's `page` pins any app
 * page, `nav: true` puts the page pills in the card and makes the frame interactive (mode 'full',
 * with onNavigate), and `nav` off keeps today's card preview (mode 'card', spec.card ?? spec.entry,
 * no router). The frame is keyed `slug:page`, so every page switch is a REMOUNT (the
 * sandboxed-app-bridge teardown contract). LabAppFrame is stubbed: it needs a DOM, and its own
 * invariants are pinned in lab-app-body.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { AppSpec } from '../../dashboard/src/components/lab/appModel.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/ThemeContext.js', () => ({
  useTheme: () => ({ theme: 'light', resolved: 'light', setTheme: () => {} }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/components/lab/LabAppFrame.js', async () => {
  const React = await import('../../dashboard/node_modules/react/index.js');
  return {
    LabAppFrame: (p: { pageId: string; mode: string; onNavigate?: unknown }) => React.createElement('iframe', {
      'data-stub-page': p.pageId, 'data-stub-mode': p.mode, 'data-stub-router': p.onNavigate ? 'yes' : 'no',
    }),
  };
});

const { LabAppBody } = await import('../../dashboard/src/components/lab/LabAppBody.js');
const { InsightBlock } = await import('../../dashboard/src/components/lab/blocks/InsightBlock.js');

const spec: AppSpec = {
  kind: 'app/v1',
  entry: 'overview',
  card: 'summary',
  pages: [
    { id: 'overview', title: 'Overview', html: '<div>o</div>' },
    { id: 'summary', title: 'Summary', html: '<div>s</div>' },
    { id: 'cohorts', title: 'Cohorts', html: '<div>c</div>' },
  ],
};
const summary = { slug: 'acme-onboarding-app', title: 'Acme onboarding', render: 'app' } as never;
const cache = { app: { spec, notices: [], range: { fromISO: '', toISO: '' } } } as never;

const body = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(LabAppBody, {
  summary, cache, series: [], ...props,
}));

describe('LabAppBody preview (nav off) is today\'s card', () => {
  it('previews spec.card in card mode with no router and no pills', () => {
    const html = body({});
    expect(html).toContain('data-stub-page="summary"');
    expect(html).toContain('data-stub-mode="card"');
    expect(html).toContain('data-stub-router="no"');
    expect(html).not.toContain('data-lab-app-pill');
  });

  it('a pinned page is previewed; an unknown pinned page falls back to spec.card and says so', () => {
    expect(body({ pageId: 'cohorts' })).toContain('data-stub-page="cohorts"');
    const html = body({ pageId: 'gone' });
    expect(html).toContain('data-stub-page="summary"');
    expect(html).toContain('data-lab-app-page-missing="gone"');
    expect(html).toContain('lab.blocks.insight.pageMissing');
  });
});

describe('LabAppBody in-card nav', () => {
  it('draws one pill per page (tablist), the open page selected, and ONE interactive frame', () => {
    const html = body({ nav: true, pageId: 'cohorts', onNavigate: () => {} });
    expect(html).toContain('role="tablist"');
    expect(html.match(/data-lab-app-pill=/g)).toHaveLength(3);
    expect(html).toMatch(/data-lab-app-pill="cohorts"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-lab-app-pill="cohorts"/);
    expect(html).toMatch(/aria-selected="false"[^>]*data-lab-app-pill="overview"|data-lab-app-pill="overview"[^>]*aria-selected="false"/);
    expect(html.match(/<iframe/g)).toHaveLength(1);
    expect(html).toContain('data-stub-mode="full"');
    expect(html).toContain('data-stub-router="yes"');
    expect(html).toContain('data-lab-app-page="cohorts"');
  });

  it('with no pinned page it opens the card page', () => {
    expect(body({ nav: true })).toContain('data-stub-page="summary"');
  });

  it('keys the frame slug:page in both modes (a page switch remounts)', () => {
    const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/LabAppBody.tsx'), 'utf8');
    const keys = src.match(/key=\{`\$\{summary\.slug\}:\$\{page\}`\}/g) ?? [];
    expect(keys).toHaveLength(2);
    // A pill click and the frame's own lab.navigate go through the same switch.
    expect(src).toMatch(/onNavigate=\{\(id\) => go\(id\)\}/);
    expect(src).toMatch(/onClick=\{\(\) => go\(p\.id\)\}/);
  });
});

describe('InsightBlock: page and nav options, the card\'s open page wins', () => {
  const draw = (options: Record<string, unknown>, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(InsightBlock, {
    block: { type: 'insight', data: 'acme-onboarding-app', options }, frame: null, options, summary, cache, ...extra,
  } as never));

  it('nav:false (default) keeps the card preview', () => {
    const html = draw({});
    expect(html).toContain('data-stub-mode="card"');
    expect(html).not.toContain('data-lab-app-pill');
  });

  it('page pins the page; nav:true fills the cell with pills', () => {
    expect(draw({ page: 'cohorts' })).toContain('data-stub-page="cohorts"');
    const html = draw({ page: 'cohorts', nav: true }, { onAppPage: () => {} });
    expect(html).toContain('data-insight-fit="fill"');
    expect(html).toContain('data-stub-mode="full"');
    expect(html).toContain('data-stub-page="cohorts"');
  });

  it('the card\'s open page (appPage) wins over the page option', () => {
    const html = draw({ page: 'cohorts', nav: true }, { appPage: 'overview', onAppPage: () => {} });
    expect(html).toContain('data-stub-page="overview"');
  });

  it('nav is only honoured for a literal true', () => {
    expect(draw({ nav: 'yes' })).toContain('data-stub-mode="card"');
  });
});
