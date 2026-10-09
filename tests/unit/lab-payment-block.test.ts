/**
 * The explorer's `payment` block (blocks/PaymentBlock.tsx): the decline rate
 * of the selected path (k/n under 100 attempts), attempts and declines, the
 * named reasons plus the residual, and one table per dimension the payment is
 * split by. The total is the source's own `{}` cell, never a sum; one cohort at
 * a time; a selection the payment is not split by says so; a funnel with no
 * payment says what is missing and how to fill it. Synthetic Acme data; static
 * markup through the dashboard's own React; a direct call gets slot-backed
 * state (slot 0 = the cohort).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, isValidElement, type ReactElement, type ReactNode } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { FunnelFrame } from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

const COPY: Record<string, string> = {
  'lab.explorer.paymentRate': 'Decline rate',
  'lab.explorer.paymentAttempts': 'Attempts',
  'lab.explorer.paymentDeclines': 'Declines',
  'lab.explorer.paymentReasons': 'Decline reasons',
  'lab.explorer.paymentOther': 'Other or unnamed',
  'lab.explorer.paymentTotal': 'Funnel total (measured)',
  'lab.explorer.paymentAllFunnels': 'All funnels: this funnel has no payment split',
  'lab.explorer.paymentNotForSel': 'Not measured for {sel}; the funnel total is shown',
  'lab.explorer.paymentClipped': 'Reasons add up to more than the declines: check the source',
  'lab.explorer.cohortFirst': 'First sale',
  'lab.explorer.cohortRenewal': 'Renewal',
  'lab.explorer.cohortAll': 'All',
  'lab.explorer.emptyPayment': 'No payment data for {funnel}. Add `payment` (attempts, declines, reasons) to the snapshot.',
  'lab.explorer.notMeasuredWhy': 'Not measured: {reason}',
  'lab.explorer.fill': 'To fill it: {hint}',
  'lab.explorer.lowSampleRow': 'Low sample',
  'lab.explorer.knTitle': 'Fewer than {min} in the denominator: shown as {k} of {n}, not as a rate',
  'lab.blocks.explorer.unknownFunnel': 'Funnel {id} is not in the data. Showing {name}.',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const H: { on: boolean; slots: unknown[]; i: number } = { on: false, slots: [], i: 0 };
vi.mock('../../dashboard/node_modules/react/index.js', async (orig) => {
  const real = (await orig()) as typeof import('react');
  return {
    ...real,
    useState: <T,>(init: T) => {
      if (!H.on) return real.useState(init);
      const k = H.i++;
      return [k < H.slots.length ? H.slots[k] : typeof init === 'function' ? (init as () => T)() : init, () => {}];
    },
  };
});

const { PaymentBlock } = await import('../../dashboard/src/components/lab/blocks/PaymentBlock.js');

const STEPS = [{ key: 'visit', label: 'Visit', users: 1000 }];
const cell = (dims: Record<string, string>, cohort: 'first' | 'renewal', attempts: number, declines: number, reasons: Record<string, number> = {}) =>
  ({ dims, cohort, attempts, declines, reasons });

/** The {} cell is NOT the sum of the country cells (1000 vs 900 attempts): the block must show the source's own total. */
function frame(): FunnelFrame {
  return {
    kind: 'funnel',
    insight: 'acme-storefront-funnels',
    segmentMode: 'lookup',
    lowSample: 100,
    dimensions: [{ key: 'country', label: 'Country', values: ['TR', 'US', 'DE'] }],
    hints: { payment: 'pull the acceptance chart by funnel and cohort' },
    paymentReasons: [
      { key: 'insufficient', label: 'Insufficient funds', note: 'card has no balance' },
      { key: 'declined', label: 'Card declined', note: null },
    ],
    funnels: [
      {
        id: 'quiz',
        name: 'Quiz checkout',
        steps: STEPS,
        payment: {
          measured: true,
          reason: null,
          cells: [
            cell({}, 'first', 1000, 200, { insufficient: 120, declined: 50 }),
            cell({ country: 'TR' }, 'first', 860, 180, { insufficient: 110, declined: 40 }),
            cell({ country: 'US' }, 'first', 40, 9, { insufficient: 4 }),
            cell({}, 'renewal', 500, 30, { insufficient: 40 }),
          ],
        },
      },
      { id: 'ladder', name: 'Activation ladder', steps: STEPS },
    ],
  };
}

const BLOCK: Block = { type: 'payment', data: 'acme-storefront-funnels', options: {} };
function props(p: Partial<BlockProps>): BlockProps & { block: Block } {
  return { frame: frame(), options: {}, block: BLOCK, ...p } as BlockProps & { block: Block };
}
const html = (p: Partial<BlockProps>) => renderToStaticMarkup(createElement(PaymentBlock as never, props(p) as never) as ReactElement);
function tree(p: Partial<BlockProps>, slots: unknown[] = []): ReactElement {
  Object.assign(H, { on: true, i: 0, slots });
  try {
    return (PaymentBlock as (x: unknown) => ReactElement)(props(p));
  } finally {
    H.on = false;
  }
}
function findAll(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<Record<string, unknown>>;
    if (pred(el)) out.push(el);
    walk(el.props.children as ReactNode);
  };
  walk(node);
  return out;
}

describe('payment: the decline rate and its reasons', () => {
  it('no selection: the {} cell, as three equal cards; the rate is declines over attempts', () => {
    const out = html({});
    expect(out).toContain('data-lab-payment=""');
    expect(out).toContain('data-scope="funnel"');
    expect(out).toContain('data-cohort="first"');
    expect(out).toMatch(/data-lab-payment-rate="20"[^>]*>20.0%</);
    expect(out).toMatch(/data-lab-payment-card="attempts"[\s\S]*?>1,000</);
    expect(out).toContain('--lab-x-cols:3');
  });

  it('named reasons in declared order, then the residual; shares are of the declines', () => {
    const out = html({});
    const keys = [...out.matchAll(/data-lab-payment-reason="([^"]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(['insufficient', 'declined', 'other']);
    expect(out).toMatch(/data-lab-payment-reason="insufficient"[^>]*title="card has no balance"/);
    expect(out).toContain('<span class="lab-pay-bar-count">120</span><span class="lab-pay-bar-share">60.0%</span>');
    expect(out).toContain('Other or unnamed');
    expect(out).toContain('<span class="lab-pay-bar-count">30</span><span class="lab-pay-bar-share">15.0%</span>');
    expect(out).toContain('width:60%');
  });

  it('the table total is the source\'s own {} cell, never the sum of its rows', () => {
    const out = html({});
    const total = out.match(/<tr[^>]*data-lab-payment-total=""[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(total).toContain('Funnel total (measured)');
    expect(total).toContain('>1,000<');
    expect(total).not.toContain('>900<');
  });

  it('a row under 100 attempts reads k/n and fades', () => {
    const us = html({}).match(/<tr[^>]*data-lab-payment-row="US"[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(us).toContain('data-low-sample="true"');
    expect(us).toContain('data-lab-kn="9/40"');
    expect(us).toContain('>9/40<');
  });
});

describe('payment: selection, cohort, scope', () => {
  it('a selection with its own cell shows that cell', () => {
    const out = html({ selection: { country: 'TR' } });
    expect(out).toMatch(/data-lab-payment-rate="20\.9[0-9]*"/);
    expect(out).not.toContain('data-lab-payment-not-for-sel');
    expect(out).toMatch(/data-lab-payment-row="TR"[^>]*data-active=""/);
  });

  it('a selection the payment is not split by says so and shows the funnel total', () => {
    const out = html({ selection: { country: 'DE' } });
    expect(out).toContain('data-lab-payment-not-for-sel=""');
    expect(out).toContain('Not measured for DE; the funnel total is shown');
    expect(out).toMatch(/data-lab-payment-rate="20"/);
  });

  it('cohorts are chips, one at a time; the renewal cohort never mixes with the first sale', () => {
    const out = html({});
    expect(out).toMatch(/data-lab-payment-cohort="first"[^>]*aria-pressed="true"/);
    expect(out).toMatch(/data-lab-payment-cohort="renewal"[^>]*aria-pressed="false"/);
    const renewal = renderToStaticMarkup(tree({}, ['renewal']));
    expect(renewal).toContain('data-cohort="renewal"');
    expect(renewal).toMatch(/data-lab-payment-rate="6"[^>]*>6.0%</);
    expect(renewal).not.toContain('data-lab-payment-row="TR"');
  });

  it('a cohort chip click sets the cohort', () => {
    const root = tree({});
    const chip = findAll(root, (e) => e.props['data-lab-payment-cohort'] === 'renewal')[0];
    expect(typeof chip.props.onClick).toBe('function');
  });

  it('reasons over the declines raise a warning', () => {
    const out = renderToStaticMarkup(tree({}, ['renewal']));
    expect(out).toContain('data-lab-payment-clipped=""');
    expect(out).toContain('Reasons add up to more than the declines: check the source');
    expect(html({})).not.toContain('data-lab-payment-clipped');
  });

  it('a funnel without its own payment shows the all-funnels one, and says so', () => {
    const f = frame();
    f.payment = f.funnels[0].payment;
    const out = html({ frame: f, options: { funnel: 'ladder' } });
    expect(out).toContain('data-scope="set"');
    expect(out).toContain('data-lab-payment-scope="set"');
    expect(out).toContain('All funnels: this funnel has no payment split');
  });
});

describe('payment: honest empty states', () => {
  it('no payment anywhere: what is missing, and how to fill it; never zeros', () => {
    const out = html({ options: { funnel: 'ladder' } });
    expect(out).toContain('data-lab-empty="payment"');
    expect(out).toContain('No payment data for Activation ladder.');
    expect(out).toContain('data-lab-hint=""');
    expect(out).toContain('To fill it: pull the acceptance chart by funnel and cohort');
    expect(out).not.toContain('data-lab-payment-rate');
    expect(out).not.toMatch(/>0%</);
  });

  it('a funnel whose payment is not measured gives its reason', () => {
    const f = frame();
    f.funnels[1].unmeasured = { payment: 'the acceptance chart carries no funnel id' };
    const out = html({ frame: f, options: { funnel: 'ladder' } });
    expect(out).toContain('Not measured: the acceptance chart carries no funnel id');
  });

  it('an unknown funnel pick says so and shows the first', () => {
    const out = html({ options: { funnel: 'gone' } });
    expect(out).toContain('Funnel gone is not in the data. Showing Quiz checkout.');
    expect(out).toContain('data-lab-payment-rate');
  });

  it('script strings render as text; no em dash in the source', () => {
    const f = frame();
    f.paymentReasons![0].label = '<b>x</b>';
    const out = html({ frame: f });
    expect(out).not.toContain('<b>x');
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
    const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/blocks/PaymentBlock.tsx'), 'utf8');
    expect(src).not.toMatch(/—/);
  });
});

describe('payment: at most five reason rows, tracks ending at one x', () => {
  it('past five, the smallest named reasons fold into "other or unnamed" and the list still adds up', async () => {
    const { reasonItems, MAX_REASON_ROWS } = await import('../../dashboard/src/components/lab/blocks/PaymentBlock.js');
    expect(MAX_REASON_ROWS).toBe(5);
    const reasons = ['a', 'b', 'c', 'd', 'e', 'f'].map((key, i) => ({ key, label: key, count: 60 - i * 10, share: null, note: null }));
    const row = { dims: {}, cohort: 'all', attempts: 1000, declines: 220, rate: 22, kn: null, reasons, other: 10, clipped: false, lowSample: false };
    const items = reasonItems(row as never, 'Other');
    expect(items.map((r) => r.key)).toEqual(['a', 'b', 'c', 'd', 'other']);
    expect(items.reduce((s, r) => s + r.count, 0)).toBe(220);
    expect(items[4].count).toBe(10 + 20 + 10);
  });

  it('the figure column is fixed, so every track ends at the same x', () => {
    const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/explorer/explorer.css'), 'utf8');
    const at = css.indexOf('.lab-pay-bar {');
    expect(css.slice(at, css.indexOf('}', at))).toMatch(/grid-template-columns: minmax\(var\(--space-24\), 30%\) minmax\(0, 1fr\) var\(--space-28\)/);
  });
});
