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
  const text = publishPrompt({ slug: 'hava-notu', name: 'Hava Notu', grant: 'G-123_abc', published: null });

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
  });

  it('a new version keeps the visibility it has', () => {
    expect(publishPrompt({ slug: 's', name: 'S', grant: 'g', published: { fullName: 'ornek/s-app', public: true } })).toContain('already on GitHub as ornek/s-app (public)');
  });
});

describe('the Share button', () => {
  const card = read('dashboard/src/components/apps/AppCard.tsx');

  it('opens no form: it takes the grant and hands the prompt to Chat', () => {
    expect(existsSync(join(ROOT, 'dashboard/src/components/apps/PublishSheet.tsx'))).toBe(false);
    expect(read('dashboard/src/components/apps/ShareSheets.tsx')).not.toContain('PublishSheet');
    expect(card).not.toMatch(/PublishSheet|setSheet\('publish'\)/);
    expect(card).toMatch(/onClick=\{\(\) => void handToClaude\(\)\}>\{t\('share\.card\.share'\)\}/);
    expect(card).toContain('/publish/grant');
    expect(card).toMatch(/askAgent\(bus, prompt, \{/);
    // No chat on screen can take it: a new chat starts with it, shown.
    expect(card).toMatch(/requestDelegateAgent\(bus, \{ title: ts\('store\.publish\.tab'[\s\S]*?reveal: true \}\)\) onClose\(\)/);
  });

  it('the push stays the owner\'s page or his grant; the grant route is the owner page only', () => {
    const route = read('src/server/routes/apps-share.ts');
    const grantFn = route.slice(route.indexOf('export async function handlePublishGrant'), route.indexOf('export async function handlePublish('));
    expect(grantFn).toMatch(/if \(!ownerOnly\(req, res\)\) return;/);
    const pushFn = route.slice(route.indexOf('export async function handlePublish('), route.indexOf('// ─── Shared Apps'));
    expect(pushFn).toMatch(/const done = owner \? null : takePublishGrant\(rec\.projectRoot, rec\.slug, b\.grant\);/);
    expect(pushFn).toMatch(/if \(!owner && !done\) \{ sendError\(res, 403, 'owner_page_only'/);
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
