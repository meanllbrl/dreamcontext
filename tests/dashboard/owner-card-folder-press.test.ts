/**
 * The folder the owner SAW is the folder that runs or is written to (end review r2, class
 * shown-is-not-what-runs-on-the-bar, the dashboard half):
 *  - a run press mints its ticket with `root` = the drawn `folder.path`; a secret save carries it;
 *  - a `folder_changed` refusal shows ownerCard.folderChanged, reads the folder again, and is
 *    never pressed again by the card;
 *  - no folder drawn: no Run on the slot's run card, no Save on its secret card.
 * Also the end-r2 minors: the bar request's message says what the card offers, a slot-started
 * run says "on this Mac", the folder text draws the raw cwd.
 * Fictional project and commands (synthetic-fixtures pattern).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const { TEMPLATES } = vi.hoisted(() => ({
  TEMPLATES: {
    'ownerCard.folderChanged': "This card's folder changed: it is now {name}. Look again, then press.",
    'ownerCard.folderChangedReading': "This card's folder changed. Reading where it is now.",
    'ownerCard.folderUnknown': 'Where this card runs is not known yet, so it cannot be pressed here.',
    'ownerCard.cannotConfirm': "Can't confirm this card's folder from here. Do it on the Mac.",
  } as Record<string, string>,
}));
vi.mock('../../dashboard/src/context/I18nContext.js', () => {
  const t = (key: string) => TEMPLATES[key] ?? key;
  return { useI18n: () => ({ locale: 'en', setLocale: () => {}, t }), useOwnerCardT: () => t, I18nProvider: ({ children }: { children: unknown }) => children };
});
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({ get: async () => ({}), ownerPost: async () => ({}) }), useVaultId: () => ({ vault: 'acme-shop' }) }));
vi.mock('../../dashboard/src/components/sleepy/chat/InlineTerminal.js', () => ({ InlineTerminal: () => null }));
(globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {}, matchMedia: () => ({ matches: false }) };

const {
  _resetCardRecords, canPressWith, cardFolderText, cardTerminalUrl, folderLine, isFolderChanged, phoneFolderOf, pressRun, secretSaveBody,
  settleFolderCheck, useShownFolder, FOLDER_CHANGED,
} = await import('../../dashboard/src/lib/cardRecords.js');
const { RequestError } = await import('../../dashboard/src/api/client.js');
const { RunCard } = await import('../../dashboard/src/components/sleepy/chat/RunCard.js');
const { SecretCard } = await import('../../dashboard/src/components/sleepy/chat/SecretCard.js');
type OwnerCardHandle = import('../../dashboard/src/lib/superTypes.js').OwnerCardHandle;

const SID = '11111111-2222-4333-8444-555555555555';
const REF = 'a'.repeat(32);
const FOLDER = { path: '/w/acme-shop-look', name: 'acme-shop-look' };
const RUN = { type: 'run', id: 'look', command: 'npm ci' } as const;
const SECRET = { type: 'secret', id: 'stripe', title: 'Stripe test key', file: '.env', fields: [{ key: 'STRIPE_SECRET_KEY' }] } as const;
const handleOf = (spec: unknown): OwnerCardHandle => ({
  cardRef: REF, postingSession: SID, vault: 'acme-shop', postingConversationId: SID, spec: spec as OwnerCardHandle['spec'],
  childRecordId: 'main', childId: SID, deliverTo: SID,
});
const t = (k: string) => TEMPLATES[k] ?? k;
const has = (html: string, id: string) => html.includes(`data-testid="${id}"`);
const read = (p: string) => readFileSync(new URL(`../../dashboard/src/${p}`, import.meta.url), 'utf-8');

beforeEach(() => _resetCardRecords());

describe('a press names the folder it drew', () => {
  it('the run mint carries root = folder.path, with the command and the action', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const api = { ownerPost: async <T,>(path: string, body: unknown) => { calls.push({ path, body }); return { ticket: 'T'.repeat(22), expiresAt: 1 } as T; } };
    const r = await pressRun(api, { session: SID, card: REF, action: 'start', shown: RUN.command, root: FOLDER.path }, { folderChanged: () => { throw new Error('not changed'); } });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ path: '/agent/card-ticket', body: { session: SID, card: REF, action: 'start', shown: RUN.command, root: FOLDER.path } }]);
  });

  it('RunCard presses with the folder it draws (its drawn root, never a re-resolved one)', () => {
    const src = read('components/sleepy/chat/RunCard.tsx');
    expect(src).toMatch(/const root = drawnRootRef\.current;\s*if \(!root\) return \{ ok: false, error: 'no_folder'/);
    expect(src).toMatch(/pressRun\(api, \{\s*session: target\.sessionId, card: target\.cardRef, action: ticketActionOf\(target\), shown: spec\.command, root,\s*\}/);
    expect(src).toMatch(/const drawnRoot = shownFolder\.folder\?\.path \?\? null;/);
  });

  it('the secret save carries root, the record and the values', () => {
    const body = secretSaveBody({ sessionId: SID, cardRef: REF, root: FOLDER.path, spec: SECRET, values: { STRIPE_SECRET_KEY: ' sk_test_fake ' } });
    expect(body).toEqual({ sessionId: SID, cardRef: REF, root: FOLDER.path, file: '.env', title: 'Stripe test key', entries: [{ key: 'STRIPE_SECRET_KEY', value: 'sk_test_fake' }] });
    expect(secretSaveBody({ root: null, spec: { ...SECRET, app: 'shop' }, values: {} })).not.toHaveProperty('root');
    expect(read('components/sleepy/chat/SecretCard.tsx')).toMatch(/api\.ownerPost<SecretResponse>\('\/agent\/secret', secretSaveBody\(\{\s*sessionId, cardRef: record\?\.cardRef, root, spec, values,/);
  });
});

describe('folder_changed: the line, a fresh read, never a retry', () => {
  it('a refused mint tells the card once, with the folder it named, and is not pressed again', async () => {
    let posts = 0;
    const api = { ownerPost: async () => { posts += 1; throw new RequestError('The folder changed.', 409, FOLDER_CHANGED); } };
    const changed: string[] = [];
    const r = await pressRun(api, { session: SID, card: REF, action: 'start', shown: RUN.command, root: FOLDER.path }, { folderChanged: (root) => changed.push(root) });
    expect(r).toMatchObject({ ok: false, error: 'folder_changed' });
    expect(changed).toEqual([FOLDER.path]);
    expect(posts).toBe(1);
  });

  it('the cards react by reading the folder again, never by pressing', () => {
    const run = read('components/sleepy/chat/RunCard.tsx');
    const changedFn = /const folderChanged = useCallback\(\(from: string \| null\) => \{([\s\S]*?)\}, \[\]\);/.exec(run)?.[1] ?? '';
    expect(changedFn).toMatch(/setCheck\(\{ from: named, state: 'reading' \}\);\s*void rereadRef\.current\(\)\.then\(\(now\) => setCheck\(settleFolderCheck\(named, now\)\)\);/);
    expect(changedFn).not.toMatch(/start|pressRun|mint/);
    const secret = read('components/sleepy/chat/SecretCard.tsx');
    const branch = /if \(isFolderChanged\(err\)\) \{([\s\S]*?)\n\s*\}/.exec(secret)?.[1] ?? '';
    expect(branch).toMatch(/void shownFolder\.reread\(\)\.then\(\(now\) => setCheck\(settleFolderCheck\(named, now\)\)\);/);
    expect(branch).not.toMatch(/submit|ownerPost/);
    expect(isFolderChanged(new RequestError('x', 409, 'folder_changed'))).toBe(true);
    expect(isFolderChanged(new RequestError('x', 409, 'card_closed'))).toBe(false);
  });

  it('the re-read SETTLES: another folder is "now <name>", none or the same one is "do it on the Mac"', () => {
    const moved = { path: '/w/other-repo', name: 'other-repo' };
    const now = settleFolderCheck(FOLDER.path, moved);
    expect(folderLine(t, { check: now, spec: { cwd: 'web' }, unknown: false }))
      .toBe("This card's folder changed: it is now other-repo · web. Look again, then press.");
    expect(canPressWith(moved.path, now)).toBe(true);
    // A refusal whose folder is null, or a re-read that returns none: the plain line, no press, no "Reading".
    for (const read of [null, FOLDER]) {
      const cannot = settleFolderCheck(FOLDER.path, read);
      const line = folderLine(t, { check: cannot, spec: {}, unknown: false });
      expect(line).toBe("Can't confirm this card's folder from here. Do it on the Mac.");
      expect(line).not.toContain('Reading');
      expect(canPressWith(FOLDER.path, cannot)).toBe(false);
    }
    // While reading (a request in flight, it always settles): no press.
    expect(canPressWith(FOLDER.path, { from: FOLDER.path, state: 'reading' })).toBe(false);
    expect(folderLine(t, { check: null, spec: {}, unknown: true })).toBe(TEMPLATES['ownerCard.folderUnknown']);
    expect(folderLine(t, { check: null, spec: {}, unknown: false })).toBeNull();
    expect(canPressWith(null, null)).toBe(false);
  });

  it('reread asks the slot for a fresh state and resolves (never hangs) when nothing can be read', async () => {
    let reread: (() => Promise<unknown>) | null = null;
    let asked = 0;
    (globalThis as { fetch?: unknown }).fetch = async () => { throw new Error('offline'); };
    const Probe = () => { reread = useShownFolder('acme-shop', { postingSession: SID, cardRef: REF }, FOLDER, () => { asked += 1; }).reread; return null; };
    renderToStaticMarkup(createElement(Probe));
    expect(await reread!()).toBeNull();
    expect(asked).toBe(1);
  });

  it('the phone re-reads through its own card read, and resolves null when it carries no folder', async () => {
    let reread: (() => Promise<unknown>) | null = null;
    const Probe = () => { reread = useShownFolder('acme-shop', { postingSession: SID, cardRef: REF }, null, undefined, async () => null).reread; return null; };
    renderToStaticMarkup(createElement(Probe));
    expect(await reread!()).toBeNull();
  });
});

describe('no folder drawn: no press offered', () => {
  const runCard = (folder: typeof FOLDER | null) => renderToStaticMarkup(createElement(RunCard, { spec: RUN as never, host: { record: handleOf(RUN) }, folder }));
  const secretCard = (folder: typeof FOLDER | null, spec: object = SECRET) => renderToStaticMarkup(createElement(SecretCard, { spec: spec as never, host: { record: handleOf(spec) }, folder }));

  it('the slot run card: no Run without a folder, its line says why; Run with one', () => {
    const none = runCard(null);
    expect(has(none, 'run-card-play')).toBe(false);
    expect(none).toContain(TEMPLATES['ownerCard.folderUnknown']);
    expect(has(runCard(FOLDER), 'run-card-play')).toBe(true);
  });

  it('the slot secret card: no Save without a folder; Save with one; an app secret keeps the app', () => {
    const none = secretCard(null);
    expect(has(none, 'secret-card-save')).toBe(false);
    expect(none).toContain(TEMPLATES['ownerCard.folderUnknown']);
    expect(has(secretCard(FOLDER), 'secret-card-save')).toBe(true);
    expect(has(secretCard(null, { ...SECRET, app: 'shop' }), 'secret-card-save')).toBe(true);
  });
});

describe('the phone is shown the folder and presses with it (end review r3)', () => {
  it('the phone run URL carries the folder it drew; the Mac URL never does (its ticket binds it)', () => {
    const phone = cardTerminalUrl({ sessionId: SID, cardRef: REF, start: true, phone: true, root: FOLDER.path }, 'dark');
    expect(phone.startsWith('/api/agent/run-terminal?')).toBe(true);
    expect(new URL(phone, 'http://x').searchParams.get('root')).toBe(FOLDER.path);
    const mac = cardTerminalUrl({ sessionId: SID, cardRef: REF, start: true, root: FOLDER.path }, 'dark', 'T'.repeat(22));
    expect(new URL(mac, 'http://x').searchParams.get('root')).toBeNull();
  });

  it('RunCard puts the drawn folder on the phone press and the phone attach', () => {
    const run = read('components/sleepy/chat/RunCard.tsx');
    expect(run).toMatch(/rerun: closed, phone, \.\.\.\(phone && drawnRoot \? \{ root: drawnRoot \} : \{\}\) \}/);
    expect(run).toMatch(/start: false, phone, \.\.\.\(phone && drawnRootRef\.current \? \{ root: drawnRootRef\.current \} : \{\}\) \}/);
    expect(run).toMatch(/const given = folder !== undefined \? folder : phone \? phoneFolderOf\(sessionId, record\?\.cardRef\) : undefined;/);
    expect(run).toMatch(/const pressable = canPressWith\(drawnRoot, check\);/);
  });

  it('the phone secret save carries the folder it drew', () => {
    const body = secretSaveBody({ sessionId: SID, cardRef: REF, root: FOLDER.path, spec: SECRET, values: { STRIPE_SECRET_KEY: 'x' } });
    expect(body.root).toBe(FOLDER.path);
    const secret = read('components/sleepy/chat/SecretCard.tsx');
    expect(secret).toMatch(/const given = folder !== undefined \? folder : phone \? phoneFolderOf\(sessionId, record\?\.cardRef\) : undefined;/);
    // The phone is no longer exempt: with a record and no app, no folder means no Save.
    expect(secret).toMatch(/const needsFolder = !!sessionId && !!record && !spec\.app;/);
  });

  it('the phone reads the folder from its own card read (no read yet: none)', () => {
    expect(phoneFolderOf(SID, REF)).toBeNull();
    expect(phoneFolderOf(undefined, REF)).toBeNull();
  });
});

describe('end-r2 minors', () => {
  it('the bar request says what the card offers: running, no folder, its own button, or nothing', () => {
    const run = read('components/sleepy/chat/RunCard.tsx');
    expect(run).toMatch(/else if \(view\.phase === 'running'\) setRefusal\(t\('ownerCard\.barRunning'\)\);/);
    expect(run).toMatch(/else if \(!pressable\) setRefusal\(t\('ownerCard\.barNoFolder'\)\);/);
    expect(run).toMatch(/t\('ownerCard\.notStarted'\)\.replace\('\{label\}'/);
    expect(run).toMatch(/else setRefusal\(t\('ownerCard\.barCannotRun'\)\);/);
  });

  it('a slot-started run says it ran on this Mac, never "in chat"', () => {
    const run = read('components/sleepy/chat/RunCard.tsx');
    expect(run).toMatch(/recordHost && view\.title === 'Ran in chat' \? t\('ownerCard\.ranOnMac'\)/);
    expect(run).toMatch(/recordHost && view\.title === 'Running in chat' \? t\('ownerCard\.runningOnMac'\)/);
    const i18n = read('context/I18nContext.tsx');
    expect(i18n).toContain("'ownerCard.ranOnMac': 'Ran on this Mac',");
    expect(i18n).toContain("'ownerCard.ranOnMac': \"Bu Mac'te çalıştı\",");
  });

  it('the folder text draws the raw cwd the server resolves', () => {
    expect(cardFolderText(FOLDER, { cwd: ' web ' })).toBe('acme-shop-look ·  web ');
  });
});
