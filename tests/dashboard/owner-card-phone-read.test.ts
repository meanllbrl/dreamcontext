/**
 * The phone's card read as the server answers it (end review r3, integration with lane B):
 * GET /api/agent/cards on the phone is `{ session, cards, folders }`, `folders[cardRef]` =
 * `{ path, name }` or null, at the TOP level. The phone draws that folder on the run and secret
 * cards and presses with its `path` as `root`. A later `cards` frame (no folders) keeps them.
 * Fictional project and commands (synthetic-fixtures pattern).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

// This page is the hands-free phone (phoneSurface reads its meta tag once).
(globalThis as { document?: unknown }).document = {
  querySelector: (sel: string) => (sel.startsWith('meta[') ? { getAttribute: () => 'mac' } : null),
};
(globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false }) };

vi.mock('../../dashboard/src/context/I18nContext.js', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ locale: 'en', setLocale: () => {}, t }), useOwnerCardT: () => t, I18nProvider: ({ children }: { children: unknown }) => children };
});
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({ get: async () => ({}), ownerPost: async () => ({}) }), useVaultId: () => ({ vault: 'acme-shop' }) }));
vi.mock('../../dashboard/src/components/sleepy/chat/InlineTerminal.js', () => ({ InlineTerminal: () => null }));

const { _resetCardRecords, applyCardsFrame, cardTerminalUrl, phoneFolderOf, refreshCards, secretSaveBody } = await import('../../dashboard/src/lib/cardRecords.js');
const { isMacPhoneSurface } = await import('../../dashboard/src/lib/phoneSurface.js');
const { RunCard } = await import('../../dashboard/src/components/sleepy/chat/RunCard.js');
const { SecretCard } = await import('../../dashboard/src/components/sleepy/chat/SecretCard.js');

const SID = '11111111-2222-4333-8444-555555555555';
const RUN_REF = 'a'.repeat(32);
const SECRET_REF = 'b'.repeat(32);
const APP_REF = 'c'.repeat(32);
const FOLDER = { path: '/w/acme-shop-look', name: 'acme-shop-look' };
const RUN = { type: 'run', id: 'look', command: 'npm ci' } as const;
const SECRET = { type: 'secret', id: 'stripe', title: 'Stripe test key', file: '.env', fields: [{ key: 'STRIPE_SECRET_KEY' }] } as const;
const APP_SECRET = { ...SECRET, id: 'shop-key', app: 'shop' } as const;
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);

/** The server's real phone answer (src/server/routes/run-terminal.ts handleAgentCards). */
const PHONE_ANSWER = {
  session: SID,
  cards: [
    { id: RUN.id, cardRef: RUN_REF, kind: 'run', spec: RUN, state: 'open', run: null },
    { id: SECRET.id, cardRef: SECRET_REF, kind: 'secret', spec: SECRET, state: 'open', run: null },
    { id: APP_SECRET.id, cardRef: APP_REF, kind: 'secret', spec: APP_SECRET, state: 'open', run: null },
  ],
  folders: { [RUN_REF]: FOLDER, [SECRET_REF]: FOLDER, [APP_REF]: null },
};

beforeEach(async () => {
  _resetCardRecords();
  await refreshCards(SID, async () => PHONE_ANSWER);
});

describe('the phone draws the folder from { session, cards, folders } and presses with it', () => {
  it('this page is the phone', () => {
    expect(isMacPhoneSurface()).toBe(true);
  });

  it('folders[cardRef] is read from the top level of the answer', () => {
    expect(phoneFolderOf(SID, RUN_REF)).toEqual(FOLDER);
    expect(phoneFolderOf(SID, SECRET_REF)).toEqual(FOLDER);
    expect(phoneFolderOf(SID, APP_REF)).toBeNull();
    expect(phoneFolderOf(SID, 'd'.repeat(32))).toBeNull();
  });

  it('the run card draws the folder and offers Run; its press names that folder', () => {
    const html = renderToStaticMarkup(createElement(RunCard, { spec: RUN as never, sessionId: SID }));
    expect(html).toContain('acme-shop-look');
    expect(has(html, 'run-card-play')).toBe(true);
    expect(html).not.toContain('ownerCard.cannotConfirm');
    // The press RunCard builds on the phone carries `root: drawnRoot` (pinned in owner-card-folder-press):
    const url = cardTerminalUrl({ sessionId: SID, cardRef: RUN_REF, start: true, phone: true, root: phoneFolderOf(SID, RUN_REF)!.path }, 'dark');
    expect(new URL(url, 'http://x').searchParams.get('root')).toBe(FOLDER.path);
    const src = readFileSync(new URL('../../dashboard/src/components/sleepy/chat/RunCard.tsx', import.meta.url), 'utf-8');
    expect(src).toMatch(/rerun: closed, phone, \.\.\.\(phone && drawnRoot \? \{ root: drawnRoot \} : \{\}\) \}/);
  });

  it('the secret card draws the folder, offers Save, and its save carries root', () => {
    const html = renderToStaticMarkup(createElement(SecretCard, { spec: SECRET as never, sessionId: SID }));
    expect(html).toContain('acme-shop-look · .env');
    expect(has(html, 'secret-card-save')).toBe(true);
    const body = secretSaveBody({ sessionId: SID, cardRef: SECRET_REF, root: phoneFolderOf(SID, SECRET_REF)?.path ?? null, spec: SECRET, values: { STRIPE_SECRET_KEY: 'x' } });
    expect(body.root).toBe(FOLDER.path);
  });

  it('an app secret (folder null) keeps its app and its Save', () => {
    const html = renderToStaticMarkup(createElement(SecretCard, { spec: APP_SECRET as never, sessionId: SID }));
    expect(html).toContain('shop · .env');
    expect(has(html, 'secret-card-save')).toBe(true);
  });

  it('a later cards frame (no folders) keeps the folders the read gave', () => {
    applyCardsFrame(SID, PHONE_ANSWER.cards);
    expect(phoneFolderOf(SID, RUN_REF)).toEqual(FOLDER);
  });

  it('a read without folders (the Mac\'s answer) draws no phone folder: no Run', async () => {
    _resetCardRecords();
    await refreshCards(SID, async () => ({ session: SID, cards: PHONE_ANSWER.cards }));
    const html = renderToStaticMarkup(createElement(RunCard, { spec: RUN as never, sessionId: SID }));
    expect(has(html, 'run-card-play')).toBe(false);
  });
});
