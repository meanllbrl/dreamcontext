/**
 * AI Team as a tree (task ai-team-uyeleri-bir-hiyerarside-durur…), the page's half:
 * `dashboard/src/components/aiteam/teamTree.ts` on top of the shared `src/lib/agents/tree.ts`.
 *
 * AC5: the roster's Tree view — one section per lead's team plus "Reports to you", siblings in
 *      the roster's own order, a folded lead saying what its team holds, a search that keeps a
 *      match's managers in view, and the List | Tree choice remembered on this machine.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readRosterView, rollupOf, teamTreeOf, treeSections, visibleTreeLines, writeRosterView, type TeamPlacement,
} from '../../dashboard/src/components/aiteam/teamTree';
import type { TeamRow, TeamStatus } from '../../dashboard/src/components/aiteam/teamModel';

const ROOT = join(new URL('../../', import.meta.url).pathname);

function row(slug: string, title: string, status: TeamStatus = 'idle'): TeamRow {
  return {
    slug, title, hasPhoto: false, role: `${title} role`, routines: [], status, workingSince: null,
    preview: null, lastAt: null, unread: 0, section: status === 'needs' ? 'needs' : 'team',
  };
}
const place = (slug: string, reportsTo: string | null = null, team: string | null = null): TeamPlacement => ({ slug, reportsTo, team });

// The mockup's 12 teammates, in roster order (needs-you first).
const ROWS: TeamRow[] = [
  row('growth', 'Büyüme Analisti', 'needs'),
  row('ads', 'Reklam İzleyici', 'working'),
  row('ops', 'Operasyon Şefi'),
  row('reviews', 'Mağaza Yorumcusu'),
  row('content', 'İçerik Editörü'),
  row('newsletter', 'Bülten Yazarı', 'paused'),
  row('social', 'Sosyal Taslakçı'),
  row('support', 'Destek Özeti'),
  row('bugs', 'Hata Avcısı', 'approval'),
  row('briefing', 'Sabah Brifingi'),
  row('research', 'Araştırmacı'),
  row('code', 'Kod Gözcüsü'),
];
const PLACES: TeamPlacement[] = [
  place('ops', null, 'Operasyon'),
  place('growth', 'ops', 'Büyüme'), place('ads', 'growth'), place('reviews', 'growth'),
  place('content', 'ops', 'İçerik'), place('newsletter', 'content'), place('social', 'content'),
  place('support', 'ops', 'Destek'), place('bugs', 'support'),
  place('briefing', 'ops'), place('research'), place('code'),
];

describe('teamTreeOf / treeSections', () => {
  const tree = teamTreeOf(ROWS, PLACES);
  const title = (s: string) => ROWS.find((r) => r.slug === s)!.title;

  it('siblings keep the roster order (needs-you first)', () => {
    expect(tree.nodes.get('ops')!.children).toEqual(['growth', 'content', 'support', 'briefing']);
  });

  it("one section per lead's team, then the lone teammates as 'Reports to you'", () => {
    expect(treeSections(tree, title)).toEqual([
      { key: 'team:ops', label: 'Operasyon', count: 10, roots: ['ops'] },
      { key: 'you', label: null, count: 2, roots: ['research', 'code'] },
    ]);
  });

  it('a lead with no team name is headed by its own name', () => {
    const t = teamTreeOf(ROWS, PLACES.map((p) => (p.slug === 'ops' ? { ...p, team: null } : p)));
    expect(treeSections(t, title)[0].label).toBe('Operasyon Şefi');
  });

  it('nobody placed: everyone is "Reports to you", exactly the old list', () => {
    const flat = teamTreeOf(ROWS, ROWS.map((r) => place(r.slug)));
    expect(treeSections(flat, title)).toEqual([{ key: 'you', label: null, count: 12, roots: ROWS.map((r) => r.slug) }]);
  });
});

describe('rollupOf: what a folded lead says', () => {
  const tree = teamTreeOf(ROWS, PLACES);
  const byslug = new Map(ROWS.map((r) => [r.slug, r]));
  it('counts reports at any depth and lifts who needs you or waits for approval', () => {
    expect(rollupOf(tree, (s) => byslug.get(s), 'ops')).toEqual({ reports: 9, needs: 1, approval: 1, working: 1, paused: 1 });
    expect(rollupOf(tree, (s) => byslug.get(s), 'support')).toEqual({ reports: 1, needs: 0, approval: 1, working: 0, paused: 0 });
  });
});

describe('visibleTreeLines', () => {
  const tree = teamTreeOf(ROWS, PLACES);
  it('a folded lead hides its team', () => {
    const lines = visibleTreeLines(tree, ROWS, new Set(['content']), ['ops'], '');
    expect(lines.map((l) => l.slug)).not.toContain('newsletter');
    expect(lines.find((l) => l.slug === 'content')!.collapsed).toBe(true);
  });
  it('a search keeps each match with its managers, every fold opened', () => {
    const lines = visibleTreeLines(tree, ROWS, new Set(['content', 'ops']), ['ops'], 'bülten');
    expect(lines.map((l) => l.slug)).toEqual(['ops', 'content', 'newsletter']);
  });
});

describe('the List | Tree choice', () => {
  it('is remembered, and anything unknown reads as the list', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    expect(readRosterView(storage)).toBe('list');
    writeRosterView(storage, 'tree');
    expect(readRosterView(storage)).toBe('tree');
    mem.set('dreamcontext.aiteam.rosterView', 'bogus');
    expect(readRosterView(storage)).toBe('list');
    expect(readRosterView(null)).toBe('list');
  });
});

describe('the page wiring', () => {
  const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  it('the roster offers List | Tree and draws folds; the head shows the manager path', () => {
    const roster = src('dashboard/src/components/aiteam/TeamRoster.tsx');
    expect(roster).toContain('data-roster-view');
    expect(roster).toContain('aria-expanded={!line.collapsed}');
    expect(src('dashboard/src/components/aiteam/TeamConversation.tsx')).toContain('data-convo-path');
  });
  it('Profile hosts "Place in team", writing through the unhashed place route', () => {
    expect(src('dashboard/src/components/aiteam/TeamPanel.tsx')).toContain('<PlaceInTeam');
    expect(src('dashboard/src/hooks/useAgents.ts')).toContain('/place`');
    expect(src('src/server/index.ts')).toContain("router.post('/api/agents/:slug/place', handleAgentsPlace)");
  });
});
