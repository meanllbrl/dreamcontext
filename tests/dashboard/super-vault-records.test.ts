import { afterEach, describe, expect, it } from 'vitest';
import {
  _superRecordSize,
  dropSuperRecords,
  readVaultSuperRecords,
  superIdOfChild,
  superIdOfSession,
  writeSuperRecord,
} from '../../dashboard/src/components/sleepy/super/superRecordStore.js';
import type { SuperStateView } from '../../dashboard/src/lib/superTypes.js';

// Wave 3 lane B: every super of a project at once (main + members), for what must see them all.
const rec = (session: string, children: Record<string, object> = {}): SuperStateView => ({ session, enabled: true, children } as unknown as SuperStateView);

const panes: object[] = [];
const pane = (): object => { const p = {}; panes.push(p); return p; };

afterEach(() => {
  for (const p of panes.splice(0)) for (const v of ['vr-acme', 'vr-beta']) dropSuperRecords(v, p);
  expect(_superRecordSize()).toBe(0);
});

describe('readVaultSuperRecords', () => {
  it('main first, then the members by id; another vault is not here', () => {
    const p = pane();
    writeSuperRecord('vr-acme', 'm:rota', rec('r'), p);
    writeSuperRecord('vr-acme', 'main', rec('m'), p);
    writeSuperRecord('vr-acme', 'm:gantt', rec('g'), p);
    writeSuperRecord('vr-beta', 'main', rec('b'), p);
    expect(readVaultSuperRecords('vr-acme').map((r) => r.superId)).toEqual(['main', 'm:gantt', 'm:rota']);
    expect(readVaultSuperRecords('vr-beta').map((r) => r.superId)).toEqual(['main']);
  });

  it('the same array until a record of THIS vault changes', () => {
    const p = pane();
    writeSuperRecord('vr-acme', 'main', rec('m'), p);
    const a = readVaultSuperRecords('vr-acme');
    expect(readVaultSuperRecords('vr-acme')).toBe(a);
    writeSuperRecord('vr-beta', 'main', rec('b'), p);
    expect(readVaultSuperRecords('vr-acme')).toBe(a);
    writeSuperRecord('vr-acme', 'm:rota', rec('r'), p);
    expect(readVaultSuperRecords('vr-acme')).not.toBe(a);
  });

  it('empty is one frozen array', () => {
    expect(readVaultSuperRecords('vr-nowhere')).toBe(readVaultSuperRecords('vr-elsewhere'));
    expect(readVaultSuperRecords('vr-nowhere')).toEqual([]);
  });

  it('whose own session, whose child', () => {
    const p = pane();
    writeSuperRecord('vr-acme', 'main', rec('main-s', { c1: {} }), p);
    writeSuperRecord('vr-acme', 'm:rota', rec('rota-s', { c2: {} }), p);
    expect(superIdOfSession('vr-acme', 'rota-s')).toBe('m:rota');
    expect(superIdOfSession('vr-acme', 'main-s')).toBe('main');
    expect(superIdOfSession('vr-acme', 'nobody')).toBeNull();
    expect(superIdOfChild('vr-acme', 'c2')).toBe('m:rota');
    expect(superIdOfChild('vr-acme', 'c1')).toBe('main');
    expect(superIdOfChild('vr-beta', 'c1')).toBeNull();
  });

  it("a member's record survives main's being replaced, and dies with its pane", () => {
    const p = pane();
    writeSuperRecord('vr-acme', 'main', rec('m'), p);
    writeSuperRecord('vr-acme', 'm:rota', rec('r'), p);
    writeSuperRecord('vr-acme', 'main', rec('m2'), p);
    expect(readVaultSuperRecords('vr-acme').find((r) => r.superId === 'm:rota')?.record.session).toBe('r');
    dropSuperRecords('vr-acme', p);
    expect(readVaultSuperRecords('vr-acme')).toEqual([]);
  });
});
