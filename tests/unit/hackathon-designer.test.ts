/**
 * Hackathon criteria 2 and 4 (design half): the designer derives its defaults from past results
 * with n per row and "az veri" under 3; the control team is always a Claude team; a mutating MCP
 * tool name is dropped at validation; Codex falls back to Claude when it cannot run.
 */
import { describe, expect, it } from 'vitest';
import { proposeDesign, validateDesign, wholeDiskTeams } from '../../src/lib/hackathon/designer.js';
import { computeStats, formatStats, personaStyle, type ResultRecord, type TeamResult } from '../../src/lib/hackathon/stats.js';

const team = (id: string, tool: 'claude' | 'codex', inner: 'trio' | 'solo', persona = id): TeamResult => ({
  id, tool, model: tool === 'claude' ? 'opus' : '', inner, persona, control: false, juryScore: 7, borrowed: false,
  firstOutputMinute: null, usageShare: 2, hours: 2, readIsolated: tool === 'claude',
});
const result = (run: string, pick: string | null, teams: TeamResult[], controlDelta: number | null = null): ResultRecord => ({
  version: 1, run, kind: 'screen', designHash: 'h', design: {}, teams, pick, juryRanking: teams.map((t) => t.id),
  juryOwnerAgree: true, controlDelta, pr: 'none', writtenAt: '2026-11-17T00:00:00Z',
});

const fixtures: ResultRecord[] = [
  result('20261101-a', 'k', [team('k', 'codex', 'trio', 'Kanıtçı, sayılar'), team('c', 'claude', 'solo', 'Cesur')], 0.5),
  result('20261102-b', 'c', [team('k', 'codex', 'trio', 'Kanıtçı'), team('c', 'claude', 'trio', 'Cesur')], 1.5),
  result('20261103-c', 'x', [team('x', 'claude', 'trio', 'Sade'), team('y', 'claude', 'solo', 'Cesur'), team('z', 'codex', 'trio', 'Kanıtçı')]),
  result('20261104-d', null, [team('p', 'claude', 'trio'), team('q', 'claude', 'trio')]),
];

describe('stats', () => {
  const s = computeStats(fixtures);
  it('counts runs, and wins per inner layout, tool and team count with n', () => {
    expect(s.runs).toBe(4);
    const trio = s.byInner.find((r) => r.label === 'trio')!;
    expect(trio).toMatchObject({ n: 5, wins: 3 });
    const codex = s.byTool.find((r) => r.label === 'codex')!;
    expect(codex).toMatchObject({ n: 3, wins: 1 });
    const two = s.byTeamCount.find((r) => r.label === '2')!;
    expect(two.n).toBe(2);
    expect(s.peekVsControl).toEqual({ delta: 1, n: 2 });
  });
  it('formats every row with n and az veri under 3', () => {
    const out = formatStats(s);
    expect(out).toMatch(/n=5/);
    expect(out).toMatch(/n=2 {2}az veri/);
  });
  it('takes a persona style from its first word', () => {
    expect(personaStyle('Kanıtçı, sayılar')).toBe('kanıtçı');
  });
});

describe('proposeDesign', () => {
  const env = { codexUsable: true };
  it('cites a stats row and n for every derived line, az veri when n < 3', () => {
    const p = proposeDesign({ problem: 'Ana sayfa', kind: 'screen', target: '/repo', stats: computeStats(fixtures), env });
    const inner = p.reasons.find((r) => r.field === 'inner')!;
    expect(inner.row).toBe('inner:trio');
    expect(inner.n).toBe(5);
    const count = p.reasons.find((r) => r.field === 'teams')!;
    expect(count.text).toMatch(/az veri/);
    expect(p.reasons.some((r) => r.field === 'experiment')).toBe(true);
  });
  it('says az veri with no history', () => {
    const p = proposeDesign({ problem: 'x', kind: 'plan', target: '/repo', stats: computeStats([]), env });
    expect(p.reasons.filter((r) => r.n === 0).every((r) => /az veri/.test(r.text) || r.field === 'experiment')).toBe(true);
    expect(p.design.rounds).toBe(2);
  });
  it('with four teams the control team is a Claude team', () => {
    const many = [1, 2, 3].map((i) => result(`2026110${i}-m`, 't1', [team('t1', 'claude', 'trio'), team('t2', 'claude', 'trio'), team('t3', 'codex', 'trio'), team('t4', 'claude', 'trio')]));
    const p = proposeDesign({ problem: 'x', kind: 'screen', target: '/repo', stats: computeStats(many), env });
    expect(p.design.teams).toHaveLength(4);
    const ct = p.design.teams.find((t) => t.id === p.design.controlTeam)!;
    expect(ct.tool).toBe('claude');
  });
});

describe('validateDesign', () => {
  const base = {
    kind: 'screen', problem: 'Ana sayfa', target: '/repo',
    teams: [
      { id: 'kanitci', name: 'Kanıtçı', tool: 'codex' },
      { id: 'cesur', tool: 'claude', model: 'opus' },
      { id: 'sade', tool: 'claude' },
      { id: 'kontrol', tool: 'codex' },
    ],
    controlTeam: 'kontrol',
    mcpTools: ['mcp__posthog__insights-get', 'mcp__posthog__delete-insight', 'mcp__x__*'],
  };
  it('moves the control team to a Claude team and notes why', () => {
    const v = validateDesign(base, { codexUsable: true });
    const ct = v.design.teams.find((t) => t.id === v.design.controlTeam)!;
    expect(ct.tool).toBe('claude');
    expect(v.notes.join('\n')).toMatch(/kontrol ekibi Claude olmalı/);
  });
  it('drops a mutating or wildcard MCP tool name', () => {
    const v = validateDesign(base, { codexUsable: true });
    expect(v.design.mcpTools).not.toContain('mcp__posthog__delete-insight');
    expect(v.design.mcpTools).not.toContain('mcp__x__*');
    expect(v.design.mcpTools).toEqual(['mcp__posthog__insights-get']);
  });
  it('falls back to Claude when Codex cannot run', () => {
    const v = validateDesign(base, { codexUsable: false, codexWhy: 'yok' });
    expect(v.design.teams.every((t) => t.tool === 'claude')).toBe(true);
    expect(wholeDiskTeams(v.design)).toEqual([]);
  });
  it('lists Codex teams as whole-disk readers', () => {
    const v = validateDesign(base, { codexUsable: true });
    expect(wholeDiskTeams(v.design)).toEqual(['kanitci', 'kontrol']);
  });
  it('throws on a malformed design', () => {
    expect(() => validateDesign({ ...base, teams: [{ id: 'a' }] }, { codexUsable: true })).toThrow();
    expect(() => validateDesign({ ...base, target: 'relative' }, { codexUsable: true })).toThrow();
    expect(() => validateDesign({ ...base, teams: [{ id: 'A B' }, { id: 'b' }] }, { codexUsable: true })).toThrow();
  });
  it('removes a control team below four teams', () => {
    const v = validateDesign({ ...base, teams: base.teams.slice(1, 4), controlTeam: 'cesur' }, { codexUsable: true });
    expect(v.design.controlTeam).toBeNull();
  });
});
