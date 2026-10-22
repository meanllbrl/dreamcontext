/**
 * The AI Team's hierarchy (task ai-team-uyeleri-bir-hiyerarside-durur…).
 *
 * AC1/AC2: `reports_to` and `team` are read and written on the agent file, OUTSIDE the
 *   approval hash (an approved agent stays approved after a placement), with loops,
 *   self-reports, unknown managers and unsplit legacy agents refused; a deleted lead's reports
 *   move up to its manager.
 * AC3: the one reading of the tree (`src/lib/agents/tree.ts`) never loses an agent: a missing
 *   manager or a loop makes a root; a team is read on a lead and inherited below it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildTree, chainOf, descendantsOf, flattenTree, normalizeTeamLabel, peersOf, wouldCycle,
  type TreeMember,
} from '../../src/lib/agents/tree.js';
import { createAgent, getAgent, listAgents, removeAgent, setAgentPlacement } from '../../src/lib/agents/store.js';
import { createAutomation, getRunTarget } from '../../src/lib/automations/store.js';
import { approveAutomation, checkApproval, manifestHash } from '../../src/lib/automations/registry.js';

const m = (slug: string, reportsTo: string | null = null, team: string | null = null): TreeMember => ({ slug, reportsTo, team });

/** The synthetic team the mockups draw: 12 members, three teams, two lone roots. */
const TWELVE: TreeMember[] = [
  m('ops-lead', null, 'Operasyon'),
  m('growth', 'ops-lead', 'Büyüme'),
  m('ads', 'growth'),
  m('reviews', 'growth'),
  m('content', 'ops-lead', 'İçerik'),
  m('newsletter', 'content'),
  m('social', 'content'),
  m('support', 'ops-lead', 'Destek'),
  m('bugs', 'support'),
  m('briefing', 'ops-lead'),
  m('researcher'),
  m('code-watch', null, 'Ignored: no reports'),
];

describe('buildTree: the reading of the tree', () => {
  it('a 12-member team: roots, depth, children in the given order, descendant counts', () => {
    const t = buildTree(TWELVE);
    expect(t.roots).toEqual(['ops-lead', 'researcher', 'code-watch']);
    expect(t.nodes.get('ops-lead')!.children).toEqual(['growth', 'content', 'support', 'briefing']);
    expect(t.nodes.get('ops-lead')!.descendants).toBe(9);
    expect(t.nodes.get('growth')!.descendants).toBe(2);
    expect(t.nodes.get('ads')!.depth).toBe(2);
    expect(t.nodes.size).toBe(12);
  });

  it('a team is read on a lead only and inherited below, the nearest lead winning', () => {
    const t = buildTree(TWELVE);
    expect(t.nodes.get('ops-lead')!.ownTeam).toBe('Operasyon');
    expect(t.nodes.get('ads')!.team).toBe('Büyüme');
    expect(t.nodes.get('ads')!.teamLead).toBe('growth');
    expect(t.nodes.get('briefing')!.team).toBe('Operasyon');
    // A label on an agent nobody reports to is not a team.
    expect(t.nodes.get('code-watch')!.ownTeam).toBeNull();
    expect(t.nodes.get('code-watch')!.team).toBeNull();
  });

  it('a manager not on this machine (deleted, private, never arrived) makes a root with a note', () => {
    const t = buildTree([m('a', 'ghost'), m('b', 'a')]);
    expect(t.roots).toEqual(['a']);
    expect(t.nodes.get('a')!.missingManager).toBe('ghost');
    expect(t.nodes.get('b')!.parent).toBe('a');
  });

  it('reporting to itself makes a plain root', () => {
    const t = buildTree([m('a', 'a')]);
    expect(t.roots).toEqual(['a']);
    expect(t.nodes.get('a')!.missingManager).toBeNull();
  });

  it('a loop is broken at its smallest slug; nobody is lost', () => {
    const t = buildTree([m('c', 'a'), m('a', 'b'), m('b', 'c'), m('d', 'b')]);
    expect(t.roots).toEqual(['a']);
    expect(t.nodes.get('a')!.cycle).toBe(true);
    expect(t.nodes.size).toBe(4);
    expect(flattenTree(t, new Set()).map((l) => l.slug).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(chainOf(t, 'c')).toEqual(['a', 'c']);
    expect(chainOf(t, 'd')).toEqual(['a', 'c', 'b', 'd']);
  });

  it('chain, descendants and peers', () => {
    const t = buildTree(TWELVE);
    expect(chainOf(t, 'ads')).toEqual(['ops-lead', 'growth', 'ads']);
    expect(descendantsOf(t, 'growth')).toEqual(['ads', 'reviews']);
    expect(peersOf(t, 'ads')).toEqual(['reviews']);
    expect(peersOf(t, 'researcher')).toEqual([]);
  });

  it('flattenTree: guides continue past a non-last ancestor; a collapsed lead hides its subtree', () => {
    const t = buildTree(TWELVE);
    const lines = flattenTree(t, new Set(['content']));
    const ads = lines.find((l) => l.slug === 'ads')!;
    expect(ads.depth).toBe(2);
    expect(ads.guides).toEqual([true]); // growth is not ops-lead's last report
    expect(lines.find((l) => l.slug === 'content')!.collapsed).toBe(true);
    expect(lines.some((l) => l.slug === 'newsletter')).toBe(false);
    expect(lines.find((l) => l.slug === 'briefing')!.last).toBe(true);
  });

  it('wouldCycle reads the tree as written', () => {
    expect(wouldCycle(TWELVE, 'ops-lead', 'ads')).toBe(true);
    expect(wouldCycle(TWELVE, 'ads', 'ads')).toBe(true);
    expect(wouldCycle(TWELVE, 'ads', 'support')).toBe(false);
  });

  it('a team name is one short line', () => {
    expect(normalizeTeamLabel('  Büyüme ')).toBe('Büyüme');
    expect(normalizeTeamLabel('')).toBeNull();
    expect(normalizeTeamLabel('none')).toBeNull();
    expect(() => normalizeTeamLabel('a\nb')).toThrow();
    expect(() => normalizeTeamLabel('x'.repeat(41))).toThrow();
  });
});

describe('setAgentPlacement: the write, outside the approval hash', () => {
  let proj: string;
  let ctx: string;
  let home: string;
  const NOW = new Date('2026-10-22T10:00:00Z');

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'dc-agents-tree-'));
    ctx = join(proj, '_dream_context');
    mkdirSync(join(ctx, 'automations'), { recursive: true });
    home = mkdtempSync(join(tmpdir(), 'dc-agents-tree-home-'));
  });
  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const make = (slug: string) => createAgent(ctx, { slug, title: slug, prompt: `${slug} does the work.` });

  it('an approved agent (and its routine) stays approved after reports_to and team are written', () => {
    make('lead');
    make('worker');
    createAutomation(ctx, { slug: 'daily', title: 'Daily', agent: 'worker', days: 'daily', at: '09:00', job: 'Do it.' });
    const call = getRunTarget(ctx, 'worker', 'agent')!;
    const job = getRunTarget(ctx, 'daily', 'automation')!;
    approveAutomation(proj, call, NOW, home);
    approveAutomation(proj, job, NOW, home);
    const before = [manifestHash(call), manifestHash(job)];

    setAgentPlacement(ctx, 'worker', { reportsTo: 'lead' });
    setAgentPlacement(ctx, 'lead', { team: 'Büyüme' });

    const callAfter = getRunTarget(ctx, 'worker', 'agent')!;
    const jobAfter = getRunTarget(ctx, 'daily', 'automation')!;
    expect([manifestHash(callAfter), manifestHash(jobAfter)]).toEqual(before);
    expect(checkApproval(proj, callAfter, home, 'run').approved).toBe(true);
    expect(checkApproval(proj, callAfter, home, 'identity').approved).toBe(true);
    expect(checkApproval(proj, jobAfter, home, 'run').approved).toBe(true);
    expect(getAgent(ctx, 'worker')!.reportsTo).toBe('lead');
    expect(getAgent(ctx, 'lead')!.team).toBe('Büyüme');
    const raw = readFileSync(join(ctx, 'agents', 'worker.md'), 'utf-8');
    expect(raw).toMatch(/^reports_to: lead$/m);
    expect(raw).toContain('## Prompt');
  });

  it('null removes a key: the file never carries an empty one', () => {
    make('lead');
    make('worker');
    setAgentPlacement(ctx, 'worker', { reportsTo: 'lead', team: 'X' });
    setAgentPlacement(ctx, 'worker', { reportsTo: null, team: null });
    const raw = readFileSync(join(ctx, 'agents', 'worker.md'), 'utf-8');
    expect(raw).not.toMatch(/reports_to|team:/);
    expect(getAgent(ctx, 'worker')!.reportsTo).toBeNull();
  });

  it('refuses itself, an unknown manager, a loop, a bad team name and an unsplit legacy agent', () => {
    make('a');
    make('b');
    make('c');
    setAgentPlacement(ctx, 'b', { reportsTo: 'a' });
    setAgentPlacement(ctx, 'c', { reportsTo: 'b' });
    expect(() => setAgentPlacement(ctx, 'a', { reportsTo: 'a' })).toThrow(/itself/);
    expect(() => setAgentPlacement(ctx, 'a', { reportsTo: 'nobody' })).toThrow(/No agent named/);
    expect(() => setAgentPlacement(ctx, 'a', { reportsTo: 'c' })).toThrow(/loop/);
    expect(() => setAgentPlacement(ctx, 'a', { reportsTo: '../x' })).toThrow(/not an agent name/);
    expect(() => setAgentPlacement(ctx, 'a', { team: 'two\nlines' })).toThrow(/one line/);
    writeFileSync(join(ctx, 'automations', 'legacy.md'), '---\nid: auto_l\ntitle: Legacy\nmode: call\n---\n\n## Prompt\nOld.\n');
    expect(getAgent(ctx, 'legacy')!.implicit).toBe(true);
    expect(() => setAgentPlacement(ctx, 'legacy', { reportsTo: 'a' })).toThrow(/dreamcontext update/);
    // Nothing changed on a refusal.
    expect(getAgent(ctx, 'a')!.reportsTo).toBeNull();
  });

  it('a hand-written loop or dangling link still reads (the tree draws roots)', () => {
    mkdirSync(join(ctx, 'agents'), { recursive: true });
    const file = (slug: string, to: string) => `---\nid: agt_${slug}\ntitle: ${slug}\nreports_to: ${to}\nshared: false\n---\n\n## Prompt\nWork.\n`;
    writeFileSync(join(ctx, 'agents', 'x.md'), file('x', 'y'));
    writeFileSync(join(ctx, 'agents', 'y.md'), file('y', 'x'));
    writeFileSync(join(ctx, 'agents', 'z.md'), file('z', 'gone'));
    const t = buildTree(listAgents(ctx));
    expect(t.nodes.size).toBe(3);
    expect(t.roots.sort()).toEqual(['x', 'z']);
    expect(t.nodes.get('z')!.missingManager).toBe('gone');
  });

  it("deleting a lead moves its reports to the lead's manager, or to the owner", () => {
    make('top');
    make('mid');
    make('leaf1');
    make('leaf2');
    setAgentPlacement(ctx, 'mid', { reportsTo: 'top' });
    setAgentPlacement(ctx, 'leaf1', { reportsTo: 'mid' });
    setAgentPlacement(ctx, 'leaf2', { reportsTo: 'mid' });
    expect(removeAgent(ctx, 'mid', { home })).toEqual({ removed: true });
    expect(getAgent(ctx, 'leaf1')!.reportsTo).toBe('top');
    expect(getAgent(ctx, 'leaf2')!.reportsTo).toBe('top');
    expect(removeAgent(ctx, 'top', { home })).toEqual({ removed: true });
    expect(getAgent(ctx, 'leaf1')!.reportsTo).toBeNull();
    expect(readFileSync(join(ctx, 'agents', 'leaf1.md'), 'utf-8')).not.toContain('reports_to');
  });
});
