import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STATUSES,
  SHIPPED_STATUS_KEYS,
  KIND_COLORS,
  dcLabelFor,
  doneStatus,
  findStatus,
  isActive,
  isCancelled,
  isDone,
  isKnown,
  isTerminal,
  keyFromDcLabel,
  pickMergedStatus,
  sortByOrder,
  statusColor,
  statusKeys,
  statusRank,
  statusSetFingerprint,
  type StatusDef,
} from '../../src/lib/task-status.js';

/**
 * Task statuses as data with a semantic kind (task_adYgpCxk). Pure predicates
 * over a status set — every derived behaviour in the codebase reads these
 * instead of a string literal.
 */

const DECLARED: StatusDef[] = [
  ...DEFAULT_STATUSES,
  { key: 'planned', label: 'Planned', kind: 'open', order: 5, color: 'c5def5' },
  { key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 99, color: 'cfd3d7', clickup: ['cancelled', "won't do"] },
];

describe('shipped set', () => {
  it('is the four keys, orders spaced by 10, exactly one done-kind keyed completed', () => {
    expect(SHIPPED_STATUS_KEYS).toEqual(['todo', 'in_progress', 'in_review', 'completed']);
    expect(DEFAULT_STATUSES.map((s) => s.order)).toEqual([0, 10, 20, 30]);
    expect(DEFAULT_STATUSES.filter((s) => s.kind === 'done').map((s) => s.key)).toEqual(['completed']);
    expect(doneStatus(DEFAULT_STATUSES).key).toBe('completed');
  });
});

describe('predicates read the KIND, never the literal', () => {
  it('shipped: completed is done+terminal, in_progress is active, todo/in_review are neither', () => {
    expect(isDone(DEFAULT_STATUSES, 'completed')).toBe(true);
    expect(isTerminal(DEFAULT_STATUSES, 'completed')).toBe(true);
    expect(isCancelled(DEFAULT_STATUSES, 'completed')).toBe(false);
    expect(isActive(DEFAULT_STATUSES, 'in_progress')).toBe(true);
    expect(isTerminal(DEFAULT_STATUSES, 'in_progress')).toBe(false);
    expect(isTerminal(DEFAULT_STATUSES, 'todo')).toBe(false);
    expect(isTerminal(DEFAULT_STATUSES, 'in_review')).toBe(false);
  });

  it('a declared cancelled-kind status is terminal but NOT done; planned is open', () => {
    expect(isCancelled(DECLARED, 'cancelled')).toBe(true);
    expect(isTerminal(DECLARED, 'cancelled')).toBe(true);
    expect(isDone(DECLARED, 'cancelled')).toBe(false);
    expect(isActive(DECLARED, 'planned')).toBe(false);
    expect(isTerminal(DECLARED, 'planned')).toBe(false);
  });

  it('an UNKNOWN key fails safe: known=false, not terminal, not active, not done', () => {
    for (const set of [DEFAULT_STATUSES, DECLARED]) {
      expect(isKnown(set, 'on_hold')).toBe(false);
      expect(isTerminal(set, 'on_hold')).toBe(false);
      expect(isActive(set, 'on_hold')).toBe(false);
      expect(isDone(set, 'on_hold')).toBe(false);
    }
    // `cancelled` is unknown to the SHIPPED set — a machine without the override
    // keeps such a task visible rather than hiding it.
    expect(isTerminal(DEFAULT_STATUSES, 'cancelled')).toBe(false);
  });

  it('normalises hyphens and case when looking a status up', () => {
    expect(findStatus(DEFAULT_STATUSES, 'In-Progress')?.key).toBe('in_progress');
    expect(findStatus(DEFAULT_STATUSES, '')).toBeNull();
    expect(findStatus(DEFAULT_STATUSES, undefined)).toBeNull();
  });
});

describe('ordering + colour', () => {
  it('statusKeys / sortByOrder follow `order`, declaration order breaking ties', () => {
    expect(statusKeys(DECLARED)).toEqual(['todo', 'planned', 'in_progress', 'in_review', 'completed', 'cancelled']);
    const tied: StatusDef[] = [
      { key: 'b', label: 'B', kind: 'open', order: 1 },
      { key: 'a', label: 'A', kind: 'open', order: 1 },
    ];
    expect(sortByOrder(tied).map((s) => s.key)).toEqual(['b', 'a']);
  });

  it('statusColor: declared 6-hex first, else the kind default', () => {
    expect(statusColor({ key: 'x', label: 'X', kind: 'open', order: 0, color: 'ABCDEF' })).toBe('abcdef');
    expect(statusColor({ key: 'x', label: 'X', kind: 'cancelled', order: 0 })).toBe(KIND_COLORS.cancelled);
    expect(statusColor({ key: 'x', label: 'X', kind: 'active', order: 0, color: 'nope' })).toBe(KIND_COLORS.active);
  });
});

describe('statusRank (merge ordering)', () => {
  it('non-terminal by order; any terminal beats every non-terminal; done beats cancelled', () => {
    const r = (s: string) => statusRank(DECLARED, s)!;
    expect(r('todo')).toBeLessThan(r('planned'));
    expect(r('planned')).toBeLessThan(r('in_progress'));
    expect(r('in_progress')).toBeLessThan(r('in_review'));
    expect(r('in_review')).toBeLessThan(r('cancelled'));
    expect(r('cancelled')).toBeLessThan(r('completed'));
  });

  it('is null for an unknown key (never -1 — callers must branch)', () => {
    expect(statusRank(DEFAULT_STATUSES, 'cancelled')).toBeNull();
    expect(statusRank(DECLARED, 'zzz')).toBeNull();
  });
});

describe('pickMergedStatus — deterministic in every case', () => {
  const both = (a: string, b: string, set: readonly StatusDef[] = DECLARED) => [
    pickMergedStatus(set, { status: a }, { status: b }).status,
    pickMergedStatus(set, { status: b }, { status: a }).status,
  ];

  it('known vs known: by rank, order-independent', () => {
    expect(both('todo', 'in_progress')).toEqual(['in_progress', 'in_progress']);
    expect(both('cancelled', 'in_progress')).toEqual(['cancelled', 'cancelled']);
    expect(both('cancelled', 'completed')).toEqual(['completed', 'completed']);
  });

  it('known vs unknown: the UNKNOWN side is preserved and named', () => {
    const a = pickMergedStatus(DEFAULT_STATUSES, { status: 'completed' }, { status: 'cancelled' });
    const b = pickMergedStatus(DEFAULT_STATUSES, { status: 'cancelled' }, { status: 'completed' });
    expect(a.status).toBe('cancelled');
    expect(b.status).toBe('cancelled');
    expect(a.unknown).toEqual(['cancelled']);
    expect(b.unknown).toEqual(['cancelled']);
  });

  it('EQUAL RANK breaks symmetrically — two same-kind declared statuses must not depend on which machine merges', () => {
    // parseStatuses itself warns that two same-kind statuses with no explicit
    // `order` share that kind's default, so a rank tie is a real case. Returning
    // the first argument here would make the merge answer depend on which side
    // git handed us as "ours".
    const tied: StatusDef[] = [
      ...DEFAULT_STATUSES,
      { key: 'blocked', label: 'Blocked', kind: 'active', order: 15 },
      { key: 'waiting', label: 'Waiting', kind: 'active', order: 15 },
      { key: 'dropped', label: 'Dropped', kind: 'cancelled', order: 99 },
      { key: 'wontfix', label: "Won't fix", kind: 'cancelled', order: 99 },
    ];
    // Equal updated_at → lexicographically greater key, from either side.
    expect(both('blocked', 'waiting', tied)).toEqual(['waiting', 'waiting']);
    // Two terminals at the same offset resolve symmetrically too.
    expect(both('dropped', 'wontfix', tied)).toEqual(['wontfix', 'wontfix']);
    // A later updated_at wins the tie, from either side.
    const newer = { status: 'blocked', updated_at: '2026-09-03' };
    const older = { status: 'waiting', updated_at: '2026-09-01' };
    expect(pickMergedStatus(tied, newer, older).status).toBe('blocked');
    expect(pickMergedStatus(tied, older, newer).status).toBe('blocked');
  });

  it('both unknown: later updated_at wins, else lexicographically greater key — identical from either side', () => {
    const x = { status: 'frozen', updated_at: '2026-09-01' };
    const y = { status: 'blocked', updated_at: '2026-09-03' };
    expect(pickMergedStatus(DEFAULT_STATUSES, x, y).status).toBe('blocked');
    expect(pickMergedStatus(DEFAULT_STATUSES, y, x).status).toBe('blocked');
    const p = { status: 'frozen', updated_at: '2026-09-01' };
    const q = { status: 'blocked', updated_at: '2026-09-01' };
    expect(pickMergedStatus(DEFAULT_STATUSES, p, q).status).toBe('frozen');
    expect(pickMergedStatus(DEFAULT_STATUSES, q, p).status).toBe('frozen');
    expect(pickMergedStatus(DEFAULT_STATUSES, p, q).unknown.sort()).toEqual(['blocked', 'frozen']);
  });

  it('a missing side yields the other side', () => {
    expect(pickMergedStatus(DEFAULT_STATUSES, { status: undefined }, { status: 'todo' }).status).toBe('todo');
    expect(pickMergedStatus(DEFAULT_STATUSES, { status: 'todo' }, { status: undefined }).status).toBe('todo');
  });
});

describe('dc:* label helpers + fingerprint', () => {
  it('dcLabelFor dashes the key; keyFromDcLabel undoes it; non-dc labels → null', () => {
    expect(dcLabelFor('in_progress')).toBe('dc:in-progress');
    expect(dcLabelFor('cancelled')).toBe('dc:cancelled');
    expect(keyFromDcLabel('dc:in-progress')).toBe('in_progress');
    expect(keyFromDcLabel('DC:Planned')).toBe('planned');
    expect(keyFromDcLabel('priority:high')).toBeNull();
  });

  it('statusSetFingerprint changes when a status, kind or colour changes and is order-free', () => {
    const base = statusSetFingerprint(DEFAULT_STATUSES);
    expect(statusSetFingerprint([...DEFAULT_STATUSES].reverse())).toBe(base);
    expect(statusSetFingerprint(DECLARED)).not.toBe(base);
    const recoloured = DECLARED.map((s) => (s.key === 'planned' ? { ...s, color: '000000' } : s));
    expect(statusSetFingerprint(recoloured)).not.toBe(statusSetFingerprint(DECLARED));
  });
});
