/**
 * The explorer's `access` block (blocks/AccessBlock.tsx): did the payers reach
 * the product, stage by stage. Each stage is its users and its share of the
 * row's base, k/n under a base of 100; a stage the source did not measure reads
 * "Not measured", never 0; rows follow the funnel and the selection. With no
 * access data the block says what is missing (the preset hides its tab).
 * Synthetic Acme data; static markup through the dashboard's own React.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { FunnelFrame } from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

const COPY: Record<string, string> = {
  'lab.explorer.picker': 'Funnel',
  'lab.explorer.accessAsOf': 'Status as of {date}; cohort from the window',
  'lab.explorer.accessOfBase': '{stage}: {pct} ({k}/{n})',
  'lab.explorer.emptyAccess': 'No access data. Add `access` to the snapshot to see this page.',
  'lab.explorer.fill': 'To fill it: {hint}',
  'lab.explorer.notMeasured': 'Not measured',
  'lab.explorer.knTitle': 'Fewer than {min} in the denominator: shown as {k} of {n}, not as a rate',
  'lab.blocks.breakdown.all': 'All traffic',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { AccessBlock } = await import('../../dashboard/src/components/lab/blocks/AccessBlock.js');

const STEPS = [{ key: 'visit', label: 'Visit', users: 1000 }];

function frame(): FunnelFrame {
  return {
    kind: 'funnel',
    insight: 'acme-storefront-funnels',
    segmentMode: 'lookup',
    dimensions: [{ key: 'language', label: 'Language', values: ['EN', 'ES'] }],
    hints: { access: 'export the account table joined to payments' },
    access: {
      asOf: '2026-10-05',
      stages: [{ key: 'paid', label: 'Paid' }, { key: 'account', label: 'Account' }, { key: 'app', label: 'Opened the app' }],
      rows: [
        { funnel: null, dims: {}, counts: { paid: 2000, account: 1500, app: 1100 } },
        { funnel: 'quiz', dims: {}, counts: { paid: 800, account: 640, app: null } },
        { funnel: 'quiz', dims: { language: 'ES' }, counts: { paid: 50, account: 35, app: 20 } },
        { funnel: 'ladder', dims: {}, counts: { paid: 300, account: 200, app: 150 } },
      ],
    },
    funnels: [
      { id: 'quiz', name: 'Quiz checkout', steps: STEPS },
      { id: 'ladder', name: 'Activation ladder', steps: STEPS },
    ],
  };
}

const BLOCK: Block = { type: 'access', data: 'acme-storefront-funnels', options: {} };
const html = (p: Partial<BlockProps>) =>
  renderToStaticMarkup(createElement(AccessBlock as never, { frame: frame(), options: {}, block: BLOCK, ...p } as never) as ReactElement);

describe('access: the ladder per row', () => {
  it('rows for every funnel and for this funnel; another funnel\'s row stays out', () => {
    const out = html({});
    const rows = [...out.matchAll(/data-lab-access-row="([^"]+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(['all', 'quiz', 'quiz']);
    expect(out).toContain('All traffic');
    expect(out).toContain('Quiz checkout · ES');
    expect(html({ options: { funnel: 'ladder' } }).match(/data-lab-access-row="([^"]+)"/g)).toEqual(['data-lab-access-row="all"', 'data-lab-access-row="ladder"']);
  });

  it('each later stage reads "{stage}: share (k/n)"; the base stage is its count', () => {
    const out = html({});
    expect(out).toContain('>2,000<');
    expect(out).toContain('Account: 75.0% (1,500/2,000)');
    expect(out).toContain('Opened the app: 55.0% (1,100/2,000)');
    expect(out).not.toContain('of Paid');
  });

  it('a base under 100 reads k/n, not a share', () => {
    const es = html({}).match(/<tr[^>]*data-lab-access-row="quiz"[^>]*>(?:(?!<\/tr>)[\s\S])*Quiz checkout · ES[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(es).toContain('data-lab-kn="35/50"');
    expect(es).toContain('35/50');
    expect(es).not.toContain('70.0%');
  });

  it('a stage the source did not measure reads Not measured, never 0', () => {
    const quiz = html({}).match(/<tr[^>]*data-lab-access-row="quiz"[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(quiz).toMatch(/data-stage="app"><span[^>]*data-lab-not-measured=""[^>]*>Not measured</);
    expect(quiz).not.toMatch(/data-stage="app">[^<]*0</);
  });

  it('a selection keeps rows whose dims agree with it', () => {
    const out = html({ selection: { language: 'EN' } });
    expect(out).not.toContain('Quiz checkout · ES');
    expect(out.match(/data-lab-access-row=/g)).toHaveLength(2);
  });

  it('as-of line', () => {
    expect(html({})).toContain('Status as of Oct 5, 2026; cohort from the window');
  });
});

describe('access: no data', () => {
  it('says what is missing and how to fill it, never a ladder of zeros', () => {
    const f = frame();
    delete f.access;
    const out = html({ frame: f });
    expect(out).toContain('data-lab-empty="access"');
    expect(out).toContain('No access data.');
    expect(out).toContain('To fill it: export the account table joined to payments');
    expect(out).not.toContain('data-lab-access-row');
  });

  it('script strings render as text; no em dash in the source', () => {
    const f = frame();
    f.access!.stages[1].label = '<script>x()</script>';
    expect(html({ frame: f })).not.toContain('<script>');
    const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/blocks/AccessBlock.tsx'), 'utf8');
    expect(src).not.toMatch(/—/);
  });
});
