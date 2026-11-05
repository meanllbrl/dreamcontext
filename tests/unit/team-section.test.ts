/**
 * The Team row that opens in place (plan r4 D1-D4, AC 1-5): folded by default, its open state
 * kept per project; up to 8 members a plain list, over 8 a box that scrolls inside, over 12 a
 * search field; no switch on a sidebar row; one end mark per member; pop-outs under the folded
 * row (approval, question, unread; at most 3, then "+N daha"); the ring when a member works for
 * the owner, else the aggregate count.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { TeamSection, filterMembers, teamOpenKey } from '../../dashboard/src/components/layout/newshell/TeamSection.js';
import type { EkipMember } from '../../dashboard/src/components/aiteam/teamModel.js';
import { I18nProvider } from '../../dashboard/src/context/I18nContext.js';

const member = (slug: string, o: Partial<EkipMember> = {}): EkipMember => ({
  slug, title: slug.toUpperCase(), hasPhoto: false, global: false, enabled: true, ownerWorking: 0, asking: false, approval: false,
  unread: 0, superOnly: false, lastAt: 0, question: null, ...o,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => member(`m${i}`));

const g = globalThis as unknown as { window?: unknown };
function withStore(open: Record<string, string>) {
  g.window = { localStorage: { getItem: (k: string) => open[k] ?? null, setItem: () => undefined, removeItem: () => undefined } };
}
afterEach(() => { delete g.window; });

const render = (members: EkipMember[], o: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(I18nProvider, null, createElement(TeamSection, { members, kind: 'project', vault: 'acme', label: 'Team', testid: 'drawer-team-row', onOpen: () => undefined, onManage: () => undefined, ...o })));
const countOf = (html: string, needle: string) => html.split(needle).length - 1;

describe('the Team row in place', () => {
  it('starts folded (no list), a chevron, aria-expanded false; open when the project says so', () => {
    const folded = render(many(5));
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toContain('ns-team-chev');
    expect(folded).not.toContain('data-testid="team-list"');
    withStore({ [teamOpenKey('project', 'acme')]: '1' });
    const open = render(many(5));
    expect(open).toContain('aria-expanded="true"');
    expect(countOf(open, 'data-testid="team-list-member"')).toBe(5);
    // Another project's key does not open this one.
    withStore({ [teamOpenKey('project', 'other')]: '1' });
    expect(render(many(5))).toContain('aria-expanded="false"');
    expect(teamOpenKey('global', null)).toBe('dc.drawer.team.global');
  });

  it('8 members: no box, no search; 9: a box; 13: box and search', () => {
    withStore({ [teamOpenKey('project', 'acme')]: '1' });
    const eight = render(many(8));
    expect(eight).not.toContain('data-boxed');
    expect(eight).not.toContain('team-search');
    const nine = render(many(9));
    expect(nine).toContain('data-boxed="true"');
    expect(nine).toContain('max-height:calc(8 * var(--ns-team-mrow-h))');
    expect(nine).not.toContain('team-search');
    const thirteen = render(many(13));
    expect(thirteen).toContain('data-boxed="true"');
    expect(thirteen).toContain('data-testid="team-search"');
    expect(countOf(thirteen, 'data-testid="team-list-member"')).toBe(13);
  });

  it('no switch in the sidebar list; one end mark per member', () => {
    withStore({ [teamOpenKey('project', 'acme')]: '1' });
    const html = render([
      member('card', { approval: true, unread: 2 }), member('ring', { ownerWorking: 1, asking: true }),
      member('ask', { asking: true, unread: 1 }), member('read', { unread: 2 }), member('sup', { superOnly: true }),
      member('off', { enabled: false, unread: 4 }), member('idle'),
    ]);
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('team-member-switch');
    for (const id of ['team-mark-approval', 'team-mark-working', 'team-mark-question', 'team-mark-unread', 'team-mark-super']) expect(countOf(html, id), id).toBe(1);
    expect(html).toMatch(/data-slug="off" data-off="true"/);
  });

  it('a photo is read from the row\'s project (the drawer sits outside every provider: owner 2026-11-05)', () => {
    withStore({ [teamOpenKey('project', 'acme')]: '1' });
    const html = render([member('pho', { hasPhoto: true }), member('fig', { face: { shape: 4, color: 3 } })]);
    // Every <img> of the row (the faces in the header and the list) names the project.
    const srcs = [...html.matchAll(/src="([^"]+)"/g)].map((x) => x[1].replace(/&amp;/g, '&'));
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) expect(src).toBe('/api/agents/pho/photo?vault=acme');
    // A member with no photo wears its picked figure, not the bare hash of its slug.
    expect(html).toMatch(/data-shape="4" data-tone="sky"/);
  });

  it('"Super için" sits on the face, never at the row\'s end beside the name', () => {
    withStore({ [teamOpenKey('project', 'acme')]: '1' });
    const html = render([member('sup', { title: 'Pacioli', superOnly: true })]);
    expect(html).toMatch(/class="ns-team-mface"><span class="agent-av[^]*?data-testid="team-mark-super"[^]*?<\/span><\/span><span class="ns-team-mname">Pacioli<\/span><\/button>/);
    expect(html).toContain('aria-label="For Super"');
    expect(html).not.toContain('ns-team-tag');
  });

  it('folded: news pops out (max 3, then +N daha); working alone does not', () => {
    const html = render([
      member('a', { unread: 1 }), member('b', { asking: true }), member('c', { approval: true }), member('d', { unread: 2 }),
      member('w', { ownerWorking: 1 }),
    ]);
    expect(countOf(html, 'data-testid="team-popout"')).toBe(3);
    expect(html).toContain('data-testid="team-popout-more"');
    expect(html).not.toMatch(/team-popout"[^>]*data-slug="w"/);
  });

  it('folded row: a ring when a member works for the owner, else the count; question colour when one asks', () => {
    const ring = render([member('w', { ownerWorking: 1 }), member('r', { unread: 2 })]);
    expect(ring).toContain('data-testid="team-row-ring"');
    expect(ring).not.toContain('data-testid="team-row-count"');
    const count = render([member('r', { unread: 2 }), member('q', { asking: true })]);
    expect(count).toContain('data-testid="team-row-count"');
    expect(count).toMatch(/data-testid="drawer-team-row"[^>]*data-asking="true"/);
  });

  it('search filters by name in Turkish case', () => {
    const list = [member('icerik', { title: 'İçerik Yazarı' }), member('ua', { title: 'UA Manager' })];
    expect(filterMembers(list, 'içerik').map((m) => m.slug)).toEqual(['icerik']);
    expect(filterMembers(list, 'manager').map((m) => m.slug)).toEqual(['ua']);
    expect(filterMembers(list, '  ')).toHaveLength(2);
  });
});

describe('a member\'s notification opens its stage (plan r4 D6b)', () => {
  it('a session link matches every super of the vault, not only the active one', async () => {
    const { superStageOfLink } = await import('../../dashboard/src/components/sleepy/super/superHandover.js');
    const records = [
      { superId: 'main', record: { enabled: true, session: 'sess-main' } },
      { superId: 'm:rota', record: { enabled: true, session: 'sess-rota' } },
      { superId: 'm:off', record: { enabled: false, session: 'sess-off' } },
    ];
    expect(superStageOfLink('sess-rota', records)).toBe('m:rota');
    expect(superStageOfLink('sess-main', records)).toBe('main');
    expect(superStageOfLink('sess-off', records)).toBeNull();
    expect(superStageOfLink('ordinary', records)).toBeNull();
  });
});

describe('a project with no member yet (owner 2026-11-03)', () => {
  it('draws the Team row with an empty slot, opens the members flow, never an empty list', () => {
    withStore({ 'dc.drawer.team.acme': '1' });
    const html = render([]);
    expect(html).toMatch(/data-testid="drawer-team-row"[^>]*data-empty="true"/);
    expect(html).toContain('data-testid="team-empty-slot"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('data-testid="team-list"');
    expect(html).not.toContain('aria-expanded');
    const src = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/layout/newshell/TeamSection.tsx', import.meta.url)), 'utf-8');
    expect(src).toContain('onClick={() => (empty ? p.onManage?.() : toggle())}');
  });
  it('without a members flow to open, an empty section stays a plain row', () => {
    expect(render([], { onManage: undefined })).not.toContain('data-empty');
  });
});

describe('the open member is the selected row (owner 2026-11-04)', () => {
  it('open list: only the open member row is selected, the Team row never is', () => {
    withStore({ [teamOpenKey('project', 'acme')]: '1' });
    const html = render(many(4), { openSlug: 'm2' });
    expect(countOf(html, 'ns-team-mrow is-sel')).toBe(1);
    expect(html).toMatch(/data-slug="m2"[^>]*>/);
    expect(html).toMatch(/ns-team-mrow is-sel"[^>]*aria-current="page"[^>]*data-testid="team-list-member" data-slug="m2"/);
    expect(html).not.toMatch(/ns-team-row ns-team-sec-row is-sel/);
  });
  it('folded: the open member still shows under the row, selected, once', () => {
    const html = render([member('a', { unread: 2 }), member('b')], { openSlug: 'a' });
    expect(countOf(html, 'ns-team-mrow is-sel')).toBe(1);
    expect(countOf(html, 'data-slug="a"')).toBe(1);
  });
  it('no open member: nothing is selected', () => {
    withStore({ [teamOpenKey('project', 'acme')]: '1' });
    expect(render(many(3))).not.toContain('is-sel');
  });
});
