/**
 * The dashboard's READER of `dreamcontext://` links (`dashboard/src/lib/appLink.ts`), plus the
 * viewer window's path rules and the Notifications window's row model. The reader is outside
 * input's first line of defence: every shape parses, everything else is null and dropped whole.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../dashboard/src/lib/desktop', () => ({
  isDesktop: () => false,
  openInboxWindow: vi.fn(), openVaultWindow: vi.fn(), openViewerWindow: vi.fn(),
  vaultWindowLabel: (v: string) => `vault-${v}`,
}));
vi.mock('../../dashboard/src/lib/windowRegistry', () => ({ thisWindowLabel: async () => '', resolveLiveWindowForVault: async () => null }));

const { parseAppLink, buildAppLink, isValidAppLinkVault } = await import('../../dashboard/src/lib/appLink');
const { resolveDocumentRef, stripFrontmatter, isDocumentRelativeRef } = await import('../../dashboard/src/components/appLink/viewerPaths');
const { normalizeNotifications, relativeTime } = await import('../../dashboard/src/components/appLink/inboxModel');

const TR = 'Çalışma Öğrenim şğü';
const ID = '0b1d3c97-6daf-4943-96d5-8614e7d0960e';

describe('parseAppLink: every shape', () => {
  const shapes = [
    { kind: 'inbox' },
    { kind: 'project', vault: 'dreamcontext' },
    { kind: 'project', vault: TR },
    { kind: 'session', vault: TR, claudeId: ID },
    { kind: 'automation', vault: 'acme', slug: 'daily-brief', file: null },
    { kind: 'automation', vault: TR, slug: 'daily-brief', file: 'automations/output/daily brief/2026-09-29 #1.md' },
    { kind: 'page', vault: 'acme', page: 'sleep', id: null },
    { kind: 'page', vault: 'acme', page: 'tasks', id: 'fix-the-login.v2_x' },
    { kind: 'page', vault: 'acme', page: 'knowledge', id: 'research' },
    { kind: 'page', vault: 'acme', page: 'core', id: '0.soul.md' },
    { kind: 'view', vault: TR, path: '_dream_context/knowledge/grafik ö.md' },
  ] as const;
  for (const shape of shapes) {
    it(`round-trips ${JSON.stringify(shape)}`, () => {
      const raw = buildAppLink(shape as never);
      expect(raw.startsWith('dreamcontext://')).toBe(true);
      expect(parseAppLink(raw)).toEqual(shape);
    });
  }

  it('decodes a Turkish vault as the shell hands it over (percent-escaped UTF-8)', () => {
    expect(parseAppLink('dreamcontext://project/%C3%96%C4%9Frenim/session/abcdefgh')).toEqual(
      { kind: 'session', vault: 'Öğrenim', claudeId: 'abcdefgh' },
    );
  });

  it('reads a query written with `+` for a space (URLSearchParams writers)', () => {
    expect(parseAppLink('dreamcontext://project/a/view?path=_dream_context/a+b.md')).toEqual(
      { kind: 'view', vault: 'a', path: '_dream_context/a b.md' },
    );
  });

  it('every page is accepted without an id', () => {
    for (const page of ['sleep', 'automations', 'tasks', 'knowledge', 'core', 'lab', 'roadmap', 'hypotheses', 'settings']) {
      expect(parseAppLink(`dreamcontext://project/a/page/${page}`)).toEqual({ kind: 'page', vault: 'a', page, id: null });
    }
  });
});

describe('parseAppLink: rejects', () => {
  const bad = [
    null, 42, '', 'https://example.com', 'dreamcontext:/inbox', 'DREAMCONTEXT://inbox',
    'dreamcontext://inbox?x=1', 'dreamcontext://inbox/', 'dreamcontext://project', 'dreamcontext://project/',
    'dreamcontext://project/a/', 'dreamcontext://project/a?x=1', 'dreamcontext://settings',
    'dreamcontext://project/..', 'dreamcontext://project/.', 'dreamcontext://project/a%2Fb',
    'dreamcontext://project/a%5Cb', 'dreamcontext://project/a%00b', 'dreamcontext://project/%E0%A4%A',
    `dreamcontext://project/${'v'.repeat(129)}`,
    'dreamcontext://project/a/session/short', 'dreamcontext://project/a/session/../../evil',
    `dreamcontext://project/a/session/${'a'.repeat(65)}`, 'dreamcontext://project/a/session/abcdefgh/x',
    'dreamcontext://project/a/session/abcdefgh?x=1',
    'dreamcontext://project/a/automation/Bad_Slug', 'dreamcontext://project/a/automation/-x',
    'dreamcontext://project/a/automation/x?file=/etc/passwd', 'dreamcontext://project/a/automation/x?file=a/../../b',
    'dreamcontext://project/a/automation/x?file=', 'dreamcontext://project/a/automation/x?path=a.md',
    'dreamcontext://project/a/automation/x?file=a.md&file=b.md', `dreamcontext://project/a/automation/x?file=${'a'.repeat(513)}`,
    'dreamcontext://project/a/page/brain', 'dreamcontext://project/a/page/sleep/x', 'dreamcontext://project/a/page/tasks/a b',
    'dreamcontext://project/a/page/tasks/x/y', 'dreamcontext://project/a/page',
    'dreamcontext://project/a/view', 'dreamcontext://project/a/view?path=../x.md', 'dreamcontext://project/a/view?path=/x.md',
    'dreamcontext://project/a/view/x?path=a.md', 'dreamcontext://project/a/unknown',
    `dreamcontext://project/a/view?path=${'a'.repeat(4096)}`,
  ];
  for (const raw of bad) it(`drops ${String(raw).slice(0, 70)}`, () => expect(parseAppLink(raw)).toBeNull());

  it('vault names: 128 code points fit, control characters do not', () => {
    expect(isValidAppLinkVault('ğ'.repeat(128))).toBe(true);
    expect(isValidAppLinkVault('ğ'.repeat(129))).toBe(false);
    expect(isValidAppLinkVault('a\u007fb')).toBe(false);
  });
});

describe('viewer path rules', () => {
  const doc = '_dream_context/automations/output/brief/2026-09-29.md';
  it('resolves a picture beside the document, and one folder up', () => {
    expect(resolveDocumentRef(doc, 'chart.png')).toBe('_dream_context/automations/output/brief/chart.png');
    expect(resolveDocumentRef(doc, './img/my%20chart.png?v=2#x')).toBe('_dream_context/automations/output/brief/img/my chart.png');
    expect(resolveDocumentRef(doc, '../shared.png')).toBe('_dream_context/automations/output/shared.png');
  });
  it('leaves URLs, anchors and absolute paths alone, and refuses to climb out of the project', () => {
    for (const ref of ['https://x.io/a.png', 'data:image/png;base64,AA', 'dreamcontext://inbox', '#top', '/Users/me/a.png', '~/a.png']) {
      expect(isDocumentRelativeRef(ref)).toBe(false);
      expect(resolveDocumentRef(doc, ref)).toBeNull();
    }
    expect(resolveDocumentRef('a.md', '../../etc/passwd')).toBeNull();
  });
  it('strips a leading frontmatter block only', () => {
    expect(stripFrontmatter('---\ntitle: x\n---\n# Hi')).toBe('# Hi');
    expect(stripFrontmatter('# Hi\n---\nx\n---\n')).toBe('# Hi\n---\nx\n---\n');
  });
});

describe('inbox rows', () => {
  it('newest first, bare or wrapped, malformed rows dropped', () => {
    const rows = [
      { id: 'a', at: '2026-09-29T10:00:00Z', title: 'Old', body: 'b', link: 'dreamcontext://inbox', file: null },
      { id: 'b', at: '2026-09-29T12:00:00Z', title: 'New', link: '' },
      { id: 'c', at: 'not a date', title: 'Bad' },
      { at: '2026-09-29T12:00:00Z', title: 'No id' },
      'junk',
    ];
    const out = normalizeNotifications({ notifications: rows });
    expect(out.map((r) => r.id)).toEqual(['b', 'a']);
    expect(out[0]).toEqual({ id: 'b', at: '2026-09-29T12:00:00Z', title: 'New', body: '', link: null, file: null });
    expect(normalizeNotifications(rows).map((r) => r.id)).toEqual(['b', 'a']);
    expect(normalizeNotifications({ nope: 1 })).toEqual([]);
  });
  it('relative time', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    expect(relativeTime('2026-09-29T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-09-29T11:55:00Z', now)).toBe('5m ago');
    expect(relativeTime('2026-09-29T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-09-27T12:00:00Z', now)).toBe('2d ago');
    expect(relativeTime('nope', now)).toBe('');
  });
});
