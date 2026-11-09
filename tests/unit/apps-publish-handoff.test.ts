import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishPrompt } from '../../dashboard/src/components/apps/publishPrompt.js';

/**
 * Share (Publish) hands the publish to Claude, no form (owner 2026-11-06, yayinla-claude). The
 * real click is observed by scripts/verify/apps-share-trial.mjs; this pins the prompt, the wiring
 * and the docs Claude follows.
 */
const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('the publish prompt', () => {
  const text = publishPrompt({ slug: 'hava-notu', name: 'Hava Notu', grant: 'G-123_abc', visibility: 'private', published: null });

  it('has Claude do the whole publish, in order, with the grant on the CLI', () => {
    expect(text.startsWith('/apps Publish the app "Hava Notu" (hava-notu).')).toBe(true);
    const at = (s: string) => { const i = text.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const read1 = at('Read every file that would go out');
    const pixels = at('look at the pixels');
    const clean = at('Find personal or business data');
    const readme = at('Write or refresh README.md');
    const gate = at('the gate is the last hard stop');
    const ask = at('Ask me ONE question');
    const go = at('dreamcontext apps publish hava-notu --go --grant G-123_abc');
    const list = at('End with a short plain list');
    expect([read1, pixels, clean, readme, gate, ask, go, list]).toEqual([...[read1, pixels, clean, readme, gate, ask, go, list]].sort((a, b) => a - b));
    expect(text).toContain('`config` template');
    expect(text).toContain('and commit');
    expect(text).toContain('never work around one');
    expect(text).toContain('It has never been published.');
    expect(text).toContain('Private: people I invite');
    expect(text).not.toContain('--public');
  });

  it('a public click says public; the app\'s name never goes on a command line', () => {
    const name = 'Evil"$(rm -rf ~)"';
    const pub = publishPrompt({ slug: 's', name, grant: 'g', visibility: 'public', published: { fullName: 'ornek/s-app', public: true } });
    expect(pub).toContain('Public: anyone with the link, for good');
    expect(pub).toContain('--go --grant g --public');
    expect(pub).toContain('already on GitHub as ornek/s-app');
    for (const cmd of pub.match(/`[^`]*`/g) ?? []) expect(cmd, cmd).not.toContain(name);
    expect(pub).not.toContain('--confirm-name');
  });
});

describe('the update publish (Güncellemeyi yayınla)', () => {
  const up = publishPrompt({ slug: 'hava-notu', name: 'Hava Notu', grant: 'G-1', visibility: 'private', published: { fullName: 'ornek/hava-notu-app', public: false }, update: true });

  it('never asks visibility or invitees, and publishes with the grant', () => {
    expect(up).toContain('Do not ask me about visibility or invitees.');
    expect(up).toContain('already on GitHub as ornek/hava-notu-app, private');
    expect(up).toContain('dreamcontext apps publish hava-notu --go --grant G-1 --note');
    expect(up).not.toContain('--invite');
    expect(up).not.toContain('--public');
    const pub = publishPrompt({ slug: 's', name: 'S', grant: 'g', visibility: 'public', published: { fullName: 'o/s-app', public: true }, update: true });
    expect(pub).toContain('--go --grant g --public');
  });

  it('the band shows for an own published app with unpublished files, and hands over in update mode', () => {
    const card = read('dashboard/src/components/apps/AppCard.tsx');
    expect(card).toMatch(/!following && app\.publish && app\.unpublished && canLaunch/);
    expect(card).toMatch(/handToClaude\(app\.publish!\.public \? 'public' : 'private', true\)\}>\{t\('share\.card\.publishUpdate'\)\}/);
    const i18n = read('dashboard/src/context/I18nContext.tsx');
    expect(i18n).toContain('"share.card.unpublished": "Yerelde yayınlanmamış yeni sürüm var."');
    expect(i18n).toContain('"share.card.publishUpdate": "Güncellemeyi yayınla"');
  });

  it('a publish handoff never lands in the Super composer: it falls through to a new chat', () => {
    expect(read('dashboard/src/components/apps/AppCard.tsx')).toMatch(/askAgent\(bus, prompt, \{\s*notSuper: true,/);
    expect(read('dashboard/src/components/sleepy/chat/Composer.tsx')).toMatch(/if \(superView && detail\.notSuper\) return;/);
  });
});

describe('the Share button', () => {
  const card = read('dashboard/src/components/apps/AppCard.tsx');

  it('opens no form: it takes the grant and hands the prompt to Chat', () => {
    expect(existsSync(join(ROOT, 'dashboard/src/components/apps/PublishSheet.tsx'))).toBe(false);
    expect(read('dashboard/src/components/apps/ShareSheets.tsx')).not.toContain('PublishSheet');
    expect(card).not.toMatch(/PublishSheet|setSheet\('publish'\)/);
    expect(card).toMatch(/onClick=\{\(\) => void handToClaude\('private'\)\}>\{t\('share\.card\.share'\)\}/);
    expect(card).toMatch(/onClick=\{\(\) => void handToClaude\('public'\)\}>\{t\('share\.card\.sharePublic'\)\}/);
    expect(card).toContain('/publish/grant');
    // Going public asks first; a new version of an already public app changes no one's access.
    expect(card).toMatch(/visibility === 'public' && !\(update && app\.publish\?\.public\) && !\(await confirmAction\(/);
    expect(card).toMatch(/askAgent\(bus, prompt, \{/);
    // No chat on screen can take it: a new chat starts with it, shown.
    expect(card).toMatch(/requestDelegateAgent\(bus, \{ title: ts\('store\.publish\.tab'[\s\S]*?reveal: true \}\)\) onClose\(\)/);
  });

  it('the push stays the owner\'s page or his grant; the grant route is the owner page only', () => {
    const route = read('src/server/routes/apps-share.ts');
    const grantFn = route.slice(route.indexOf('export async function handlePublishGrant'), route.indexOf('export async function handlePublish('));
    expect(grantFn).toMatch(/if \(!ownerOnly\(req, res\)\) return;/);
    const pushFn = route.slice(route.indexOf('export async function handlePublish('), route.indexOf('// ─── Shared Apps'));
    // The owner's page, or a grant for exactly this app and action (app-onay-karti C2).
    expect(pushFn).toMatch(/const gate = ownerOrGrant\(req, res, \{ projectRoot: rec\.projectRoot, key: rec\.slug, action: 'publish' \}, b\.grant\);/);
    expect(pushFn).toMatch(/sendError\(res, 403, 'owner_page_only'/);
    // Going public needs the owner's own public click; the grant is spent once the push went out.
    expect(pushFn).toMatch(/held && !bound && held\.visibility !== visibility\) \{\s*held\.done\(false\);\s*sendError\(res, 403, 'grant_scope'/);
    expect(pushFn).toContain('onPushed: (fullName) => { pushedTo = fullName; done?.(true, fullName); }');
    // A failure after the push still answers that it went out.
    expect(pushFn).toMatch(/if \(pushedTo\) \{[^\n]*pushed: true/);
    expect(route).toContain("sendError(res, 409, 'grant_used'");
    expect(read('src/lib/apps/share/publish.ts')).toMatch(/refs\/heads\/main:refs\/heads\/main'\][^\n]*\n\s*opts\.onPushed\?\.\(fullName\);/);
  });
});

describe('the docs Claude follows', () => {
  it('say the Publish click hands the job over and the CLI publishes with the grant', () => {
    for (const p of ['skill-apps/references/sharing.md', 'skill-apps/SKILL.md', 'skill/references/apps.md']) {
      const t = read(p);
      expect(t, p).toContain('--go --grant');
      expect(t, p).not.toMatch(/push is (the owner's|his) click/);
    }
  });
});
