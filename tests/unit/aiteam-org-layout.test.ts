/**
 * AI Team, the Org chart (task ai-team-uyeleri-bir-hiyerarside-durur…, AC6): where every card,
 * team frame and line goes (`dashboard/src/components/aiteam/orgLayout.ts`, pure).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPageView, teamCount, writePageView } from '../../dashboard/src/components/aiteam/teamTree';
import { buildTree, type TreeMember } from '../../src/lib/agents/tree.js';
import { edgePath, isTeamFrame, layoutOrgChart, ORG } from '../../dashboard/src/components/aiteam/orgLayout';
import { fileURLToPath } from 'node:url';

const m = (slug: string, reportsTo: string | null = null, team: string | null = null): TreeMember => ({ slug, reportsTo, team });

// The mockup's team: three roots, a lead of four, three of them leading teams of leaves.
const TEAM = buildTree([
  m('research'),
  m('ops', null, 'Operasyon'),
  m('code'),
  m('growth', 'ops', 'Büyüme'), m('ads', 'growth'), m('reviews', 'growth'),
  m('content', 'ops', 'İçerik'), m('newsletter', 'content'), m('social', 'content'),
  m('support', 'ops', 'Destek'), m('bugs', 'support'),
  m('briefing', 'ops'),
]);

function overlaps(a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('layoutOrgChart', () => {
  const L = layoutOrgChart(TEAM, { selected: 'ads', titleOf: (s) => s });

  it('every teammate gets exactly one card, and no two cards overlap', () => {
    expect(L.cards.map((c) => c.slug).sort()).toEqual([...TEAM.nodes.keys()].sort());
    for (let i = 0; i < L.cards.length; i++) {
      for (let j = i + 1; j < L.cards.length; j++) expect(overlaps(L.cards[i], L.cards[j]), `${L.cards[i].slug}/${L.cards[j].slug}`).toBe(false);
    }
  });

  it('no card overlaps a team frame it is not in', () => {
    for (const f of L.frames) {
      const members = new Set([f.lead, ...[...TEAM.nodes.values()].filter((n) => n.parent === f.lead).map((n) => n.slug)]);
      for (const c of L.cards) if (!members.has(c.slug)) expect(overlaps(c, f), `${c.slug} in ${f.lead}`).toBe(false);
    }
  });

  it('a row is packed: lone roots sit over the wide team instead of beside it', () => {
    const opsBlock = Math.max(...L.cards.map((c) => c.x + c.w)) - Math.min(...L.cards.map((c) => c.x));
    const unpacked = 2 * ORG.cardW + 2 * ORG.gapX + opsBlock;
    expect(L.width).toBeLessThan(unpacked);
    expect(L.width).toBe(opsBlock);
  });

  it('a lead of leaves is a team frame (label, count); a lead of leads spreads its reports', () => {
    expect(isTeamFrame(TEAM, 'growth')).toBe(true);
    expect(isTeamFrame(TEAM, 'ops')).toBe(false);
    expect(L.frames.map((f) => [f.lead, f.label, f.count])).toEqual([
      ['growth', 'Büyüme', 3], ['content', 'İçerik', 3], ['support', 'Destek', 2],
    ]);
    // A frame's reports stack under its lead, inside the frame.
    const frame = L.frames.find((f) => f.lead === 'growth')!;
    const lead = L.cards.find((c) => c.slug === 'growth')!;
    const ads = L.cards.find((c) => c.slug === 'ads')!;
    expect(ads.y).toBeGreaterThan(lead.y);
    expect(ads.x).toBeGreaterThan(lead.x);
    expect(ads.y + ads.h).toBeLessThanOrEqual(frame.y + frame.h);
  });

  it('roots sit side by side under You; children sit a row below their parent', () => {
    const y = (s: string) => L.cards.find((c) => c.slug === s)!.y;
    expect(new Set(['research', 'ops', 'code'].map(y)).size).toBe(1);
    expect(y('briefing')).toBeGreaterThan(y('ops'));
    expect(L.you.y).toBe(0);
    expect(L.width).toBeGreaterThanOrEqual(Math.max(...L.cards.map((c) => c.x + c.w)));
  });

  it("the selected teammate's line to you, and only that, is on the path", () => {
    const path = L.edges.filter((e) => e.onPath).map((e) => `${e.from}>${e.to}`);
    expect(path.sort()).toEqual(['>ops', 'growth>ads', 'ops>growth'].sort());
    expect(L.frames.find((f) => f.lead === 'growth')!.onPath).toBe(true);
    expect(L.frames.find((f) => f.lead === 'content')!.onPath).toBe(false);
  });

  it('nobody placed: a row of cards under You, nothing framed', () => {
    const flat = layoutOrgChart(buildTree([m('a'), m('b'), m('c')]));
    expect(flat.frames).toEqual([]);
    expect(flat.cards).toHaveLength(3);
    expect(flat.width).toBe(3 * ORG.cardW + 2 * ORG.gapX);
  });

  it('edgePath draws a straight run with rounded corners', () => {
    expect(edgePath([[0, 0], [0, 10]])).toBe('M 0 0 L 0 10');
    expect(edgePath([[0, 0], [0, 20], [20, 20]])).toContain('Q 0 20');
  });
});

describe('the Org chart in the page', () => {
  const src = (p: string) => readFileSync(join(fileURLToPath(new URL('../../', import.meta.url)), p), 'utf8');
  it('Conversations | Org chart switches the page, remembered on this machine', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    expect(readPageView(storage)).toBe('conversations');
    writePageView(storage, 'org');
    expect(readPageView(storage)).toBe('org');
    const page = src('dashboard/src/pages/AiTeamPage.tsx');
    expect(page).toContain('<OrgView');
    expect(page).toContain("team={{ rows, tree, onTalk: talkTo }}");
  });
  it('the side panel has a Team tab; a card click selects, a double-click talks', () => {
    expect(src('dashboard/src/components/aiteam/TeamPanel.tsx')).toContain("tab === 'team' && team");
    const chart = src('dashboard/src/components/aiteam/OrgChart.tsx');
    expect(chart).toContain('onDoubleClick={() => onTalk(row.slug)}');
    expect(teamCount(TEAM)).toBe(4);
  });
});
