/**
 * The funnel lane's not-measured node and its zoom control speak the dashboard's language:
 * every string comes from I18nContext (EN + TR), none is typed into FunnelLane.tsx.
 * Synthetic Acme steps only.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const I18N = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'context', 'I18nContext.tsx'), 'utf-8');
/** The TR string the real context ships for `key` (the second, unindented dictionary). */
function tr(key: string): string {
  const m = new RegExp(`^  '${key.replace(/\./g, '\\.')}': '([^']*)'`, 'm').exec(I18N);
  if (!m) throw new Error(`no TR string for ${key}`);
  return m[1];
}

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'tr', setLocale: () => {}, t: (key: string) => tr(key) }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { FunnelLane } = await import('../../dashboard/src/components/lab/funnel/FunnelLane.js');

const STEPS = [
  { key: 'landing', label: 'Landing', users: 1200 },
  { key: 'clicked', label: 'Clicked', users: 0, measured: false, reason: null },
  { key: 'paid', label: 'Paid', users: 90 },
];

describe('FunnelLane copy is localised', () => {
  it('a not-measured node reads "Ölçülmüyor" in Turkish, never the English literal', () => {
    const html = renderToStaticMarkup(createElement(FunnelLane, { steps: STEPS }));
    expect(tr('lab.explorer.notMeasured')).toBe('Ölçülmüyor');
    expect(html).toContain('Ölçülmüyor');
    expect(html).toContain('aria-label="Clicked: Ölçülmüyor"');
    expect(html).not.toContain('Not measured');
  });

  it('the reason rides the localised "why" string', () => {
    const html = renderToStaticMarkup(createElement(FunnelLane, { steps: [STEPS[0], { ...STEPS[1], reason: 'kanal kırılımı yok' }, STEPS[2]] }));
    expect(html).toContain('Clicked: Ölçülmüyor: kanal kırılımı yok');
  });

  it('the zoom control has EN and TR copy, and the component types none', () => {
    expect(I18N).toContain("'lab.funnel.zoomToFit': 'Zoom to fit'");
    expect(I18N).toContain("'lab.funnel.actualSize': 'Actual size'");
    expect(tr('lab.funnel.zoomToFit')).toBe('Sığdır');
    expect(tr('lab.funnel.actualSize')).toBe('Gerçek boyut');
    const src = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'lab', 'funnel', 'FunnelLane.tsx'), 'utf-8');
    expect(src).not.toMatch(/'(Zoom to fit|Actual size)'|>Not measured<|`Not measured/);
  });
});
