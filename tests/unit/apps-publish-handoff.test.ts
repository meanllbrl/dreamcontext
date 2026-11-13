import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishPrompt } from '../../dashboard/src/components/apps/publishPrompt.js';
import { publishJob } from '../../src/lib/apps/share/job.js';

/**
 * Share (Publish) hands the publish to Claude, no form (owner 2026-11-06, yayinla-claude). Since
 * app-ux-genel K6 the click sends ONE line in the owner's language to a new named chat; the ordered
 * steps are `dreamcontext apps job <slug> --grant <id>` (src/lib/apps/share/job.ts).
 */
const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/** The real tables: the line is what the owner sees, in his language. */
const i18n = read('dashboard/src/context/I18nContext.tsx');
function table(lang: 'en' | 'tr'): (key: string, vars?: Record<string, string>) => string {
  return (key, vars = {}) => {
    const all = [...i18n.matchAll(new RegExp(`^\\s*"${key.replace(/\./g, '\\.')}": "(.*)",$`, 'gm'))].map((m) => m[1]!);
    const raw = (lang === 'en' ? all[0] : all[1]) ?? key;
    return Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), raw);
  };
}

describe('the publish line (K6)', () => {
  it('is one line in the UI language naming the slug and the grant; the steps are apps job', () => {
    const tr = publishPrompt({ slug: 'hava-notu', name: 'Hava Notu', grant: 'G-123_abcdef', visibility: 'private' }, table('tr'));
    expect(tr).toBe('/apps hava-notu: paylaş. Adımlar: dreamcontext apps job hava-notu --grant G-123_abcdef');
    const en = publishPrompt({ slug: 'hava-notu', name: 'Hava Notu', grant: 'G-123_abcdef', visibility: 'private' }, table('en'));
    expect(en).toBe('/apps hava-notu: share it. Steps: dreamcontext apps job hava-notu --grant G-123_abcdef');
    const up = publishPrompt({ slug: 'hava-notu', name: 'Hava Notu', grant: 'G-123_abcdef', visibility: 'private', update: true }, table('tr'));
    expect(up).toContain('yeni sürümü yayınla');
    expect(up.split('\n')).toHaveLength(1);
  });

  it('refuses a slug or a grant that could carry a command', () => {
    expect(() => publishPrompt({ slug: 'x; rm -rf ~', name: 'X', grant: 'G-123_abcdef', visibility: 'private' }, table('en'))).toThrow();
    expect(() => publishPrompt({ slug: 'ok', name: 'Ok', grant: '$(evil)', visibility: 'private' }, table('en'))).toThrow();
  });

  it('the steps apps job prints keep the whole publish, in order', () => {
    const text = publishJob({ slug: 'hava-notu', name: 'Hava Notu', grant: 'G-123_abcdef', visibility: 'private', published: null });
    const at = (s: string) => { const i = text.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const order = [at('Read every file that would go out'), at('look at the pixels'), at('Find personal or business data'), at('Write or refresh README.md'), at('the gate is the last hard stop'), at('Ask him ONE plain question'), at('dreamcontext apps publish hava-notu --go --grant G-123_abcdef'), at('End with a short plain list')];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).not.toContain('--public');
    const pub = publishJob({ slug: 's', name: 'Evil"$(rm -rf ~)"', grant: 'G-123_abcdef', visibility: 'public', published: { fullName: 'ornek/s-app', public: true } });
    expect(pub).toContain('--go --grant G-123_abcdef --public');
    for (const cmd of pub.match(/`[^`]*`/g) ?? []) expect(cmd, cmd).not.toContain('Evil');
  });
});

describe('the update publish (Güncellemeyi yayınla)', () => {
  it('the steps never ask visibility or invitees, and publish with the grant', () => {
    const up = publishJob({ slug: 'hava-notu', name: 'Hava Notu', grant: 'G-123_abcdef', visibility: 'private', published: { fullName: 'ornek/hava-notu-app', public: false } });
    expect(up).toContain('never ask about visibility or invitees');
    expect(up).toContain('dreamcontext apps publish hava-notu --go --grant G-123_abcdef --note');
    expect(up).not.toContain('--invite');
  });

  it('the band shows for an own published app with unpublished files, and hands over in update mode', () => {
    const card = read('dashboard/src/components/apps/AppCard.tsx');
    expect(card).toMatch(/!following && app\.publish && app\.unpublished && canLaunch/);
    expect(card).toMatch(/handToClaude\(app\.publish!\.public \? 'public' : 'private', true\)\}>\{t\('share\.card\.publishUpdate'\)\}/);
    expect(i18n).toContain('"share.card.unpublished": "Yerelde yayınlanmamış yeni sürüm var."');
    expect(i18n).toContain('"share.card.publishUpdate": "Güncellemeyi yayınla"');
  });

  it('a publish handoff never lands in another chat: it is always a new named chat, sent and shown', () => {
    const card = read('dashboard/src/components/apps/AppCard.tsx');
    expect(card).toMatch(/handOff\(bus, vault, ts\('handoff\.publishTab'/);
    expect(card).not.toMatch(/askAgent\(bus, prompt/);
    const ask = read('dashboard/src/components/apps/askAgent.ts');
    expect(ask).toMatch(/requestDelegateAgent\(bus, \{ title, prompt: pp\.inline, promptToken: pp\.token, bypass: false, reveal: true,/);
  });
});

describe('the Share button', () => {
  const card = read('dashboard/src/components/apps/AppCard.tsx');

  it('opens no form: it sits beside Open, takes the grant and hands one line to a new chat', () => {
    expect(existsSync(join(ROOT, 'dashboard/src/components/apps/PublishSheet.tsx'))).toBe(false);
    expect(read('dashboard/src/components/apps/ShareSheets.tsx')).not.toContain('PublishSheet');
    expect(card).not.toMatch(/PublishSheet|setSheet\('publish'\)/);
    expect(card).toMatch(/onClick=\{\(\) => void handToClaude\('private', false, true\)\}>\{t\('share\.card\.share'\)\}/);
    expect(card).toMatch(/onClick=\{\(\) => void handToClaude\('public'\)\}>\{t\('share\.card\.sharePublic'\)\}/);
    expect(card).toContain('/publish/grant');
    // Going public asks first; a new version of an already public app changes no one's access.
    expect(card).toMatch(/visibility === 'public' && !\(update && app\.publish\?\.public\) && !\(await confirmAction\(/);
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
