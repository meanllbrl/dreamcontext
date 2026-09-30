import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  APP_LINK_MAX_LENGTH,
  APP_LINK_PAGES,
  AppLinkError,
  appLinkForContextRoot,
  brainRelativePath,
  buildAppLink,
  findRegisteredVault,
  isValidAppLink,
  parseAppLink,
  vaultNameForContextRoot,
  type AppLinkTarget,
} from '../../src/lib/app-link.js';

/**
 * The `dreamcontext://` WRITER (src/lib/app-link.ts). The dashboard's `lib/appLink.ts` is the
 * reader that routes a click; the grammar lives in the task contract and both sides validate it
 * independently. These pin the Node half: every contract shape round-trips through build and
 * parse, a Turkish vault name survives percent-encoding, and anything outside the grammar
 * parses to null whole.
 */

const TURKISH = 'Öğrenci Koçu şçğüı';
const ID = '0b1d3c97-6daf-4943-96d5-8614e7d0960e';

describe('buildAppLink / parseAppLink round-trip every contract shape', () => {
  const shapes: AppLinkTarget[] = [
    { kind: 'inbox' },
    { kind: 'project', vault: 'dreamcontext' },
    { kind: 'project', vault: TURKISH },
    { kind: 'session', vault: TURKISH, claudeId: ID },
    { kind: 'automation', vault: TURKISH, slug: 'daily-digest' },
    { kind: 'automation', vault: TURKISH, slug: 'daily-digest', file: 'automations/output/daily-digest/2026-09-29 özet.md' },
    { kind: 'page', vault: TURKISH, page: 'sleep' },
    { kind: 'page', vault: 'v', page: 'tasks', id: 'fix-the-login.loop_2' },
    { kind: 'page', vault: 'v', page: 'knowledge', id: 'federation-cross-vault' },
    { kind: 'page', vault: 'v', page: 'core', id: '0.soul.md' },
    { kind: 'view', vault: TURKISH, path: 'docs/görsel rapor.md' },
  ];
  for (const shape of shapes) {
    it(`${shape.kind}${'page' in shape ? `/${shape.page}` : ''}${'file' in shape ? '+file' : ''}`, () => {
      const link = buildAppLink(shape);
      expect(link.startsWith('dreamcontext://')).toBe(true);
      expect(isValidAppLink(link)).toBe(true);
      const parsed = parseAppLink(link);
      // `file`/`id` absent and null mean the same thing; normalise before comparing.
      const expected = { ...shape } as Record<string, unknown>;
      if (expected.file === null) delete expected.file;
      expect(parsed).toEqual(expected);
    });
  }

  it('every page the grammar names builds', () => {
    for (const page of APP_LINK_PAGES) {
      expect(parseAppLink(buildAppLink({ kind: 'page', vault: 'v', page }))).toEqual({ kind: 'page', vault: 'v', page });
    }
  });

  it('percent-encodes the vault as UTF-8 so a Turkish name survives the round trip', () => {
    const link = buildAppLink({ kind: 'project', vault: 'Kitap Ağacı' });
    expect(link).toBe('dreamcontext://project/Kitap%20A%C4%9Fac%C4%B1');
    expect(parseAppLink(link)).toEqual({ kind: 'project', vault: 'Kitap Ağacı' });
  });

  it('encodes a file query value whole, slashes included', () => {
    expect(buildAppLink({ kind: 'automation', vault: 'v', slug: 's', file: 'a/b c.md' }))
      .toBe('dreamcontext://project/v/automation/s?file=a%2Fb%20c.md');
  });

  it('pins the exact wire form of the session and inbox shapes', () => {
    expect(buildAppLink({ kind: 'inbox' })).toBe('dreamcontext://inbox');
    expect(buildAppLink({ kind: 'session', vault: 'dreamcontext', claudeId: ID }))
      .toBe(`dreamcontext://project/dreamcontext/session/${ID}`);
    expect(buildAppLink({ kind: 'page', vault: 'v', page: 'sleep' })).toBe('dreamcontext://project/v/page/sleep');
    expect(buildAppLink({ kind: 'view', vault: 'v', path: 'x.md' })).toBe('dreamcontext://project/v/view?path=x.md');
  });
});

describe('buildAppLink refuses what the reader would drop, and says why', () => {
  const refusals: Array<[string, AppLinkTarget]> = [
    ['a traversal vault', { kind: 'project', vault: '..' }],
    ['a dot vault', { kind: 'project', vault: '.' }],
    ['a slash in the vault', { kind: 'project', vault: 'a/b' }],
    ['a backslash in the vault', { kind: 'project', vault: 'a\\b' }],
    ['an empty vault', { kind: 'project', vault: '' }],
    ['a control char in the vault', { kind: 'project', vault: 'a\nb' }],
    ['a 129-char vault', { kind: 'project', vault: 'a'.repeat(129) }],
    ['a traversal session id', { kind: 'session', vault: 'v', claudeId: '../../evil' }],
    ['a short session id', { kind: 'session', vault: 'v', claudeId: 'abc' }],
    ['an uppercase slug', { kind: 'automation', vault: 'v', slug: 'Daily' }],
    ['an absolute file', { kind: 'automation', vault: 'v', slug: 's', file: '/etc/passwd' }],
    ['a dot-dot file', { kind: 'automation', vault: 'v', slug: 's', file: 'a/../../etc' }],
    ['a 513-char file', { kind: 'automation', vault: 'v', slug: 's', file: 'a'.repeat(513) }],
    ['an unknown page', { kind: 'page', vault: 'v', page: 'nowhere' as 'sleep' }],
    ['an id on a page that takes none', { kind: 'page', vault: 'v', page: 'sleep', id: 'x' }],
    ['a bad page id', { kind: 'page', vault: 'v', page: 'tasks', id: 'a/b' }],
    ['a view outside the project', { kind: 'view', vault: 'v', path: '../secret.md' }],
  ];
  for (const [name, target] of refusals) {
    it(name, () => {
      expect(() => buildAppLink(target)).toThrow(AppLinkError);
    });
  }

  it('a 128-char vault (in code points, so Turkish counts as one each) is fine', () => {
    expect(() => buildAppLink({ kind: 'project', vault: 'ğ'.repeat(128) })).not.toThrow();
  });
});

describe('parseAppLink is strict: anything else parses to null whole', () => {
  const bad = [
    '',
    'https://project/v',
    'DREAMCONTEXT://inbox',
    'dreamcontext://',
    'dreamcontext://inbox/',
    'dreamcontext://inbox?x=1',
    'dreamcontext://project',
    'dreamcontext://project/',
    'dreamcontext://project/v/',
    'dreamcontext://project/%2E%2E',
    'dreamcontext://project/a%2Fb',
    'dreamcontext://project/%E0%A4%A',
    'dreamcontext://project/v?x=1',
    'dreamcontext://project/v/session/abc',
    `dreamcontext://project/v/session/${ID}/extra`,
    'dreamcontext://project/v/automation/s?path=x.md',
    'dreamcontext://project/v/automation/s?file=%2Fetc%2Fpasswd',
    'dreamcontext://project/v/automation/s?file=..%2Fx',
    'dreamcontext://project/v/automation/s?file=a&file=b',
    'dreamcontext://project/v/page/sleep/x',
    'dreamcontext://project/v/page/tasks/a/b',
    'dreamcontext://project/v/page/unknown',
    'dreamcontext://project/v/view',
    'dreamcontext://project/v/view?file=x.md',
    'dreamcontext://project/v/unknown/x',
    'dreamcontext://project/v#frag',
    `dreamcontext://project/${'a'.repeat(APP_LINK_MAX_LENGTH)}`,
  ];
  for (const raw of bad) {
    it(JSON.stringify(raw.length > 80 ? `${raw.slice(0, 60)}…` : raw), () => {
      expect(parseAppLink(raw)).toBeNull();
      expect(isValidAppLink(raw)).toBe(false);
    });
  }
});

describe('vault resolution against the registry', () => {
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dc-app-link-home-'));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dc-app-link-proj-')));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  function register(vaults: Array<{ name: string; path: string }>): void {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults }));
  }

  it('names the registered vault for a context root, matching on realpath through a symlink', () => {
    const project = join(scratch, 'kitup');
    mkdirSync(join(project, '_dream_context'), { recursive: true });
    const alias = join(scratch, 'alias');
    symlinkSync(project, alias);
    register([{ name: 'Kitap Ağacı', path: alias }]);
    expect(vaultNameForContextRoot(join(project, '_dream_context'), home)).toBe('Kitap Ağacı');
    expect(vaultNameForContextRoot(project, home)).toBe('Kitap Ağacı');
  });

  it('is null for an unregistered project, and never names the Assistant', () => {
    const project = join(scratch, 'p');
    mkdirSync(join(project, '_dream_context'), { recursive: true });
    expect(vaultNameForContextRoot(join(project, '_dream_context'), home)).toBeNull();
    register([{ name: '__assistant__', path: project }]);
    expect(vaultNameForContextRoot(join(project, '_dream_context'), home)).toBeNull();
    expect(appLinkForContextRoot(join(project, '_dream_context'), { kind: 'project' }, home)).toBeNull();
  });

  it('finds the vault that contains a subdirectory (a hook cwd)', () => {
    const project = join(scratch, 'p');
    mkdirSync(join(project, 'src', 'deep'), { recursive: true });
    register([{ name: 'p', path: project }]);
    expect(findRegisteredVault(join(project, 'src', 'deep'), home)?.name).toBe('p');
    expect(findRegisteredVault(scratch, home)).toBeNull();
  });

  it('builds a link for a place in a registered project, null when the place is invalid', () => {
    const project = join(scratch, 'p');
    mkdirSync(join(project, '_dream_context'), { recursive: true });
    register([{ name: 'p', path: project }]);
    const root = join(project, '_dream_context');
    expect(appLinkForContextRoot(root, { kind: 'page', page: 'sleep' }, home)).toBe('dreamcontext://project/p/page/sleep');
    expect(appLinkForContextRoot(root, { kind: 'automation', slug: 'NOT A SLUG' }, home)).toBeNull();
  });

  it('brainRelativePath is the posix path under the brain, null outside it', () => {
    const root = join(scratch, 'p', '_dream_context');
    expect(brainRelativePath(root, join(root, 'automations', 'out', 'd.md'))).toBe('automations/out/d.md');
    expect(brainRelativePath(root, join(scratch, 'p', 'README.md'))).toBeNull();
    expect(brainRelativePath(root, root)).toBeNull();
  });
});
