/**
 * What the owner sees of an app's team data (app-veri-ortak r6, K9), rendered to static markup with
 * the dashboard's own React inside its I18n provider (English).
 *
 *  - An undecided app says so on its OWN tile, never as one row per app above the shelves.
 *  - An installed app's data is its publisher's call: no "Ask the agent" there; none either where
 *    nothing can be launched. A data field the server could not read shows nothing.
 *  - The owner's own open git merge is said in full, with the commands, on every surface (one piece).
 *  - Two apps waiting for approval: one filled button on the page.
 *  - Sizes in the reader's own number format.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const { AppDataNotices, AppDataTileLine, AppDataLine, PullState, formatBytes } = await import('../../dashboard/src/components/apps/AppDataNotice.js');
const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, null, el));

const base = {
  mode: 'undecided', declared: false, sharedCount: 0, sharedBytes: 0, held: {}, missing: 0, conflicts: 0,
  pendingPaths: [], sharedPaths: [], localPaths: [], declined: false, remote: null, syncOff: false, pull: 'none',
};
const undecided = (slug: string, origin: 'own' | 'installed' = 'own') => ({ slug, name: `App ${slug}`, origin, data: { ...base } });
const pending = (slug: string) => ({
  slug, name: `App ${slug}`, origin: 'own' as const,
  data: { ...base, mode: 'pending', declared: true, pendingPaths: [{ path: 'favorites/a-very-long-folder-name-that-must-wrap/', why: 'Picked by the team', files: 8, bytes: 120 * 1024 }] },
});

describe('undecided lives on the tile, not above the shelves', () => {
  it('three undecided apps add nothing above the shelves', () => {
    expect(html(createElement(AppDataNotices, { apps: [undecided('a'), undecided('b'), undecided('c')], onChanged: () => {} }))).toBe('');
  });

  it('an own app\'s tile says it and offers Ask the agent only where launching works', () => {
    const on = html(createElement(AppDataTileLine, { app: undecided('a'), canLaunch: true }));
    expect(on).toContain('Shared data not decided yet');
    expect(on).toContain('Ask the agent');
    expect(html(createElement(AppDataTileLine, { app: undecided('a'), canLaunch: false }))).not.toContain('Ask the agent');
  });

  it('an installed app\'s tile says its publisher has not decided, with no button', () => {
    const out = html(createElement(AppDataTileLine, { app: undecided('a', 'installed'), canLaunch: true }));
    expect(out).toContain('Its publisher has not decided its shared data yet');
    expect(out).not.toContain('Ask the agent');
  });

  it('a data field the server could not read is not "undecided": nothing shows', () => {
    const app = { slug: 'x', name: 'X', data: { ...base, mode: 'error', declared: null } };
    expect(html(createElement(AppDataTileLine, { app, canLaunch: true }))).toBe('');
    expect(html(createElement(AppDataLine, { app, canLaunch: true, onChanged: () => {} }))).toBe('');
  });
});

describe('the screen tells the whole truth', () => {
  it('the owner\'s own open merge is said with the commands, on the Apps page and on the app\'s own page', () => {
    const app = { slug: 'r', name: 'R', origin: 'own' as const, data: { ...base, mode: 'shared', declared: true, pull: 'user_merge' } };
    for (const out of [
      html(createElement(PullState, { pull: 'user_merge' })),
      html(createElement(AppDataNotices, { apps: [app], onChanged: () => {} })),
      html(createElement(AppDataLine, { app, canLaunch: true, onChanged: () => {} })),
    ]) {
      expect(out).toContain('/dream-sync');
      expect(out).toContain('git merge --continue');
      expect(out).toContain('git merge --abort');
    }
  });

  it('pending on the app\'s own page points to the approval on the Apps page', () => {
    expect(html(createElement(AppDataLine, { app: pending('p'), canLaunch: true, onChanged: () => {} }))).toContain('Waiting for your approval on the Apps page');
  });

  it('two apps waiting: one filled button; the notice is labelled by its own heading; a path can wrap', () => {
    const out = html(createElement(AppDataNotices, { apps: [pending('a'), pending('b')], onChanged: () => {} }));
    expect(out.match(/class="app-card__launch"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-labelledby="([^"]+)"[\s\S]*<h2 id="\1"/);
    expect(out).toContain('overflow-wrap:anywhere');
  });

  it('sizes follow the reader\'s locale', () => {
    expect(formatBytes(1.5 * 1024 * 1024, 'tr')).toBe('1,5 MB');
    expect(formatBytes(1.5 * 1024 * 1024, 'en')).toBe('1.5 MB');
    expect(formatBytes(120 * 1024, 'tr')).toBe('120 KB');
  });
});
