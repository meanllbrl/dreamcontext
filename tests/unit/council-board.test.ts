import { describe, it, expect } from 'vitest';
import {
  renderChamberBoard,
  convictionBar,
  shiftMarker,
  ChamberBoardInput,
} from '../../src/lib/council-board.js';
import { Verdict } from '../../src/lib/council.js';

function v(stance: string, conviction: number, headline = 'h'): Verdict {
  return { stance, conviction, headline, at: '2026-07-23T00:00:00.000Z' };
}

const ANSI = /\[/;

function baseInput(overrides: Partial<ChamberBoardInput> = {}): ChamberBoardInput {
  return {
    debateId: 'council_x',
    topic: 'Should we drop ClickUp sync?',
    round: 2,
    roundsPlanned: 3,
    phase: 'round_2_running',
    options: [
      { key: 'A', label: 'Keep sync' },
      { key: 'B', label: 'Drop it' },
    ],
    roster: ['migration-risk-auditor', 'growth-cfo', 'user-advocate', 'platform-architect'],
    current: {
      'migration-risk-auditor': v('B', 82, 'sync debt compounds weekly'),
      'growth-cfo': v('B', 71, 'cost cut pays for itself'),
      'user-advocate': v('A', 45, 'users still rely on it'),
    },
    previous: {
      'migration-risk-auditor': v('A', 64),
      'growth-cfo': v('B', 66),
      'user-advocate': v('A', 78),
    },
    ...overrides,
  };
}

describe('convictionBar', () => {
  it('renders 10 cells', () => {
    expect(convictionBar(0)).toBe('░░░░░░░░░░');
    expect(convictionBar(100)).toBe('▓▓▓▓▓▓▓▓▓▓');
    expect(convictionBar(82)).toBe('▓▓▓▓▓▓▓▓░░');
    expect(convictionBar(45)).toBe('▓▓▓▓▓░░░░░'); // 4.5 rounds to 5
  });

  it('clamps out-of-range values', () => {
    expect(convictionBar(-5)).toBe('░░░░░░░░░░');
    expect(convictionBar(140)).toBe('▓▓▓▓▓▓▓▓▓▓');
  });
});

describe('shiftMarker', () => {
  it('is · without a prior round', () => {
    expect(shiftMarker(undefined, v('A', 50))).toBe('·');
    expect(shiftMarker(null, v('A', 50))).toBe('·');
  });

  it('marks stance changes as ↑ from→to', () => {
    expect(shiftMarker(v('A', 64), v('B', 82))).toBe('↑ A→B');
  });

  it('marks conviction drops ≥10 as ↓ prev→cur', () => {
    expect(shiftMarker(v('A', 78), v('A', 45))).toBe('↓ 78→45');
  });

  it('is = for stable positions (same stance, drop <10, any rise)', () => {
    expect(shiftMarker(v('B', 66), v('B', 71))).toBe('=');
    expect(shiftMarker(v('B', 71), v('B', 65))).toBe('=');
  });
});

describe('renderChamberBoard --plain', () => {
  it('contains persona rows, bars, shift markers, and the options tally', () => {
    const out = renderChamberBoard(baseInput(), { plain: true });

    // Persona rows
    expect(out).toContain('migration-risk-auditor');
    expect(out).toContain('growth-cfo');
    expect(out).toContain('user-advocate');

    // Conviction bars
    expect(out).toContain('▓▓▓▓▓▓▓▓░░  82');
    expect(out).toContain('▓▓▓▓▓░░░░░  45');

    // Shift markers
    expect(out).toContain('↑ A→B');
    expect(out).toContain('↓ 78→45');
    expect(out).toMatch(/=/);

    // Roster persona without a verdict degrades to a placeholder row
    expect(out).toContain('platform-architect');
    expect(out).toContain('(no verdict yet)');

    // Options tally: count · summed conviction
    expect(out).toContain('OPTIONS');
    expect(out).toContain('A Keep sync (1 · 45)');
    expect(out).toContain('B Drop it (2 · 153)');

    // Convergence header: B 153 of 198 → 77%
    expect(out).toContain('CONVERGENCE');
    expect(out).toContain('77%');
    expect(out).toContain('→ B (Drop it)');

    // Frame + round/phase
    expect(out).toContain('COUNCIL');
    expect(out).toContain('round 2/3');
    expect(out.startsWith('╭')).toBe(true);
    expect(out.trimEnd().endsWith('╯')).toBe(true);
  });

  it('emits zero ANSI codes in plain mode', () => {
    const out = renderChamberBoard(baseInput(), { plain: true });
    expect(out).not.toMatch(ANSI);
  });

  it('shows the convergence delta vs the previous round', () => {
    const out = renderChamberBoard(baseInput(), { plain: true });
    // prev: A 64+78=142, B 66 → total 208 → 68%; cur 77% → Δ +9
    expect(out).toContain('Δ +9');
  });

  it('marks every persona · when there is no prior round', () => {
    const out = renderChamberBoard(baseInput({ round: 1, previous: null }), { plain: true });
    expect(out).toContain('·');
    expect(out).not.toContain('↑');
    expect(out).not.toContain('Δ');
  });

  it('degrades gracefully with no verdicts at all', () => {
    const out = renderChamberBoard(
      baseInput({ current: {}, previous: null, roster: ['solo'] }),
      { plain: true },
    );
    expect(out).toContain('(no verdicts yet for this round)');
    expect(out).toContain('solo');
    expect(out).not.toMatch(ANSI);
  });

  it('handles a single persona with no options registered (free-form)', () => {
    const out = renderChamberBoard(
      baseInput({
        options: [],
        roster: ['solo'],
        current: { solo: v('keep-sync', 60, 'fine as is') },
        previous: null,
      }),
      { plain: true },
    );
    expect(out).toContain('solo');
    expect(out).toContain('keep-sync');
    expect(out).toContain('keep-sync (1 · 60)');
  });

  it('truncates over-long headlines and keeps every line within 100 columns', () => {
    const out = renderChamberBoard(
      baseInput({
        current: {
          'migration-risk-auditor': v('B', 82, 'x'.repeat(300)),
          'growth-cfo': v('B', 71, 'short'),
        },
      }),
      { plain: true },
    );
    expect(out).toContain('…');
    for (const line of out.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it('renders a uniform box (all lines equal width)', () => {
    const lines = renderChamberBoard(baseInput(), { plain: true }).split('\n');
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
  });
});
