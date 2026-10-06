// r14 (smoke #4, owner-visible): the hands-free lock banner and the chrome button belong to the
// project ON the cloud machine. The trip was from hf-smoke, yet the dreamcontext window said
// "This project is on the cloud machine" with Return / Abandon, and its chip read "On the cloud
// machine": the UI read only the global phase. The server now says, per window project, whether
// it is in the trip (`here`); these render the real banner and button against that answer.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { HandsfreeJob, HandsfreeStatus } from '../../dashboard/src/components/handsfree/handsfreeTypes.js';

/** The real English copy, straight from the i18n table (so a wording regression shows here). */
const EN: Record<string, string> = (() => {
  const src = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'context', 'I18nContext.tsx'), 'utf8');
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/^ {4}'((?:handsfree|staleServer)\.[^']+)': '((?:[^'\\]|\\.)*)',$/gm)) out[m[1]] ??= m[2].replace(/\\'/g, "'");
  return out;
})();

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => EN[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/lib/desktop.js', () => ({ isDesktop: () => true }));

let activeVault = '';
vi.mock('../../dashboard/src/components/layout/WindowChrome.js', () => ({ useChrome: () => ({ activeVault }) }));

let snap: { status: HandsfreeStatus | null; unavailable: boolean; job: HandsfreeJob | null; error: string | null };
vi.mock('../../dashboard/src/components/handsfree/handsfreeStore.js', async (orig) => {
  const real = await orig<typeof import('../../dashboard/src/components/handsfree/handsfreeStore.js')>();
  return {
    ...real,
    // The real decision, on the test's snapshot (a static render runs no effects).
    useHandsfreeFor: (vault: string | null | undefined) => ({ ...snap, view: real.handsfreeView(snap.status, vault) }),
    useHandsfree: () => snap,
  };
});
vi.mock('../../dashboard/src/components/handsfree/HandsfreeSheet.js', () => ({ HandsfreeSheet: () => null }));
vi.mock('../../dashboard/src/components/handsfree/HandsfreeReceipt.js', () => ({ HandsfreeReceipt: () => null }));

const { HandsfreeBanner } = await import('../../dashboard/src/components/handsfree/HandsfreeBanner.js');
const { HandsfreeButton, ElsewhereDialog, chipAction } = await import('../../dashboard/src/components/handsfree/HandsfreeButton.js');

const TRIP_ROOT = '/Users/me/projects/hf-smoke';
function away(here: HandsfreeStatus['here'] | undefined, over: Partial<HandsfreeStatus> = {}): HandsfreeStatus {
  return {
    phase: 'away', tripId: 't-20261006-9982c661', unreadable: null, setUp: true, laptopId: 'l', codespace: null,
    url: 'https://cs-8080.app.github.dev', verifier: null, queued: null, lastTrip: null, uptime: { usedCoreMinutes: 0, budgetCoreMinutes: 7200 },
    journal: null, offers: ['return', 'abandon'], warnings: [], job: null,
    ...(here ? { here } : {}), away: { name: 'hf-smoke', path: TRIP_ROOT }, ...over,
  };
}
const banner = () => renderToStaticMarkup(createElement(HandsfreeBanner));
const button = (vault: string) => renderToStaticMarkup(createElement(HandsfreeButton, { vault }));
const LOCK = 'This project is on the cloud machine';

beforeEach(() => { snap = { status: null, unavailable: false, job: null, error: null }; });

describe('r14: the lock banner is for the trip\'s project only', () => {
  it('the trip\'s project: the lock banner, Return, Show link, Abandon, and the chip says it is on the cloud machine', () => {
    activeVault = 'hf-smoke';
    snap.status = away({ vault: 'hf-smoke', inTrip: true, rootId: 'r-08890df73f7e84e6' });
    const html = banner();
    expect(html).toContain('data-testid="hf-banner"');
    expect(html).toContain(LOCK);
    expect(html).toContain('data-testid="hf-return"');
    expect(html).toContain('Show link');
    expect(button('hf-smoke')).toContain('On the cloud machine');
  });

  it('ANOTHER project (smoke #4: dreamcontext; r16: Tilki): NO banner row at all; only the chip, which names the away project', () => {
    activeVault = 'dreamcontext';
    snap.status = away({ vault: 'dreamcontext', inTrip: false });
    expect(banner()).toBe('');
    const b = button('dreamcontext');
    expect(b).not.toContain('On the cloud machine');
    expect(b).toContain('hf-smoke away');
    expect(b).toContain('data-phase="elsewhere"');
  });

  it('the chip in another project opens the elsewhere dialog with Return and Show link (the trip project\'s chip focuses its banner)', () => {
    expect(chipAction('other', 'away', false)).toBe('elsewhere');
    expect(chipAction('other', 'going', true)).toBe('elsewhere');
    expect(chipAction('trip', 'away', false)).toBe('banner');
    expect(chipAction('home', 'home', false)).toBe('sheet');
    expect(chipAction('trip', 'going', true)).toBe('sheet');
    const status = away({ vault: 'dreamcontext', inTrip: false });
    const html = renderToStaticMarkup(createElement(ElsewhereDialog, { status, job: null, name: 'hf-smoke', onClose: () => {} }));
    expect(html).toContain('data-testid="hf-elsewhere"');
    expect(html).toContain('hf-smoke is on the cloud machine.');
    expect(html).toContain('data-testid="hf-elsewhere-return"');
    expect(html).toContain('Show link');
    expect(html).not.toContain(LOCK);
  });

  it('a window that switched project never shows the previous project\'s lock while its own answer is on the way', () => {
    activeVault = 'dreamcontext';
    snap.status = away({ vault: 'hf-smoke', inTrip: true, rootId: 'r-08890df73f7e84e6' }); // the old tab's answer
    expect(banner()).toBe('');
    expect(button('dreamcontext')).not.toContain('On the cloud machine');
  });

  it('the launcher (no project on screen): no banner at all', () => {
    activeVault = '';
    snap.status = away({ vault: null, inTrip: false });
    expect(banner()).toBe('');
  });

  it('a running go shows its progress in the chip\'s dialog, never as a banner in another project', () => {
    activeVault = 'dreamcontext';
    const status = away({ vault: 'dreamcontext', inTrip: false }, { phase: 'going' });
    snap.status = status;
    const job: HandsfreeJob = { id: 'j1', kind: 'go', status: 'running', step: 'go.files', detail: null, running: [], startedAt: 0, finishedAt: null, result: null, error: null };
    snap.job = job;
    expect(banner()).toBe('');
    expect(button('dreamcontext')).toContain('data-phase="elsewhere"');
    const html = renderToStaticMarkup(createElement(ElsewhereDialog, { status, job, name: 'hf-smoke', onClose: () => {} }));
    expect(html).toContain('hf-smoke is moving to the cloud machine.');
    expect(html).not.toContain('data-testid="hf-elsewhere-return"'); // no Return while a job runs
    expect(html).not.toMatch(/This project/);
  });

  it('a server a build behind (no `here`) keeps the old behaviour; an unreadable state stays locked everywhere', () => {
    activeVault = 'dreamcontext';
    snap.status = away(undefined);
    expect(banner()).toContain(LOCK);
    snap.status = away({ vault: 'dreamcontext', inTrip: false }, { unreadable: 'bad json' });
    expect(banner()).toContain('cannot be read');
  });
});
