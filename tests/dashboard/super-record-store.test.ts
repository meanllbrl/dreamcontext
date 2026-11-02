import { afterEach, describe, expect, it } from 'vitest';
import {
  MAIN_SUPER,
  _superRecordSize,
  dropSuperRecords,
  readSuperRecord,
  subscribeSuperRecords,
  superIdOf,
  writeSuperRecord,
} from '../../dashboard/src/components/sleepy/super/superRecordStore.js';
import { forSuper, superRoute } from '../../dashboard/src/components/sleepy/super/superApi.js';
import type { ApiClient } from '../../dashboard/src/api/client.js';
import type { SuperStateView } from '../../dashboard/src/lib/superTypes.js';

// The store only holds and compares references: a minimal record is enough.
const rec = (session: string): SuperStateView => ({ session, enabled: true } as unknown as SuperStateView);

const panes: object[] = [];
const pane = (): object => { const p = {}; panes.push(p); return p; };

afterEach(() => {
  // Every key dies with its pane: the store is empty between tests.
  for (const p of panes.splice(0)) for (const v of ['acme-app', 'beta-app', 'gamma-app']) dropSuperRecords(v, p);
  expect(_superRecordSize()).toBe(0);
});

describe('superRecordStore', () => {
  it('a key is born with its first write and read back by vault + superId', () => {
    const p = pane();
    expect(readSuperRecord('acme-app', 'main')).toBeNull();
    const a = rec('s-main');
    expect(writeSuperRecord('acme-app', 'main', a, p)).toBe(a);
    expect(readSuperRecord('acme-app', 'main')).toBe(a);
    expect(_superRecordSize()).toBe(1);
  });

  it('reads main when the superId is absent', () => {
    const p = pane();
    const a = rec('s-main');
    writeSuperRecord('acme-app', MAIN_SUPER, a, p);
    expect(readSuperRecord('acme-app')).toBe(a);
  });

  it('an updater sees the record held now; null is a death', () => {
    const p = pane();
    writeSuperRecord('acme-app', 'main', rec('one'), p);
    const next = writeSuperRecord('acme-app', 'main', (prev) => (prev ? { ...prev, enabled: false } : prev), p);
    expect(next?.enabled).toBe(false);
    expect(next?.session).toBe('one');
    writeSuperRecord('acme-app', 'main', null, p);
    expect(readSuperRecord('acme-app', 'main')).toBeNull();
    expect(_superRecordSize()).toBe(0);
  });

  it('two supers of one vault are separate', () => {
    const p = pane();
    const main = rec('s-main');
    const doc = rec('s-doc');
    writeSuperRecord('acme-app', 'main', main, p);
    writeSuperRecord('acme-app', 'm:doctor', doc, p);
    expect(readSuperRecord('acme-app', 'main')).toBe(main);
    expect(readSuperRecord('acme-app', 'm:doctor')).toBe(doc);
    writeSuperRecord('acme-app', 'm:doctor', null, p);
    expect(readSuperRecord('acme-app', 'main')).toBe(main);
    expect(readSuperRecord('acme-app', 'm:doctor')).toBeNull();
  });

  it('two vaults are separate', () => {
    const p = pane();
    const q = pane();
    const a = rec('a');
    const b = rec('b');
    writeSuperRecord('acme-app', 'main', a, p);
    writeSuperRecord('beta-app', 'main', b, q);
    expect(readSuperRecord('acme-app', 'main')).toBe(a);
    expect(readSuperRecord('beta-app', 'main')).toBe(b);
    dropSuperRecords('acme-app', p);
    expect(readSuperRecord('acme-app', 'main')).toBeNull();
    expect(readSuperRecord('beta-app', 'main')).toBe(b);
  });

  it('the owning pane dropping it is its death, every super of that vault it wrote', () => {
    const p = pane();
    writeSuperRecord('acme-app', 'main', rec('m'), p);
    writeSuperRecord('acme-app', 'm:doctor', rec('d'), p);
    dropSuperRecords('acme-app', p);
    expect(readSuperRecord('acme-app', 'main')).toBeNull();
    expect(readSuperRecord('acme-app', 'm:doctor')).toBeNull();
    expect(_superRecordSize()).toBe(0);
  });

  it('a replaced pane does not wipe the new pane\'s record', () => {
    const old = pane();
    const fresh = pane();
    writeSuperRecord('acme-app', 'main', rec('old'), old);
    const mine = rec('new');
    writeSuperRecord('acme-app', 'main', mine, fresh);
    dropSuperRecords('acme-app', old);
    expect(readSuperRecord('acme-app', 'main')).toBe(mine);
    dropSuperRecords('acme-app', fresh, 'main');
    expect(readSuperRecord('acme-app', 'main')).toBeNull();
  });

  it('subscribers hear a change, a death and nothing else', () => {
    const p = pane();
    let calls = 0;
    const off = subscribeSuperRecords(() => { calls += 1; });
    const a = rec('a');
    writeSuperRecord('acme-app', 'main', a, p);
    expect(calls).toBe(1);
    writeSuperRecord('acme-app', 'main', a, p);
    expect(calls).toBe(1);
    writeSuperRecord('acme-app', 'main', (prev) => prev, p);
    expect(calls).toBe(1);
    writeSuperRecord('acme-app', 'main', rec('b'), p);
    expect(calls).toBe(2);
    dropSuperRecords('acme-app', pane());
    expect(calls).toBe(2);
    dropSuperRecords('acme-app', p);
    expect(calls).toBe(3);
    writeSuperRecord('acme-app', 'main', null, p);
    expect(calls).toBe(3);
    off();
    writeSuperRecord('acme-app', 'main', rec('c'), p);
    expect(calls).toBe(3);
  });

  it('a frame\'s superId: absent, unknown or malformed reads as main', () => {
    expect(superIdOf(undefined)).toBe('main');
    expect(superIdOf('main')).toBe('main');
    expect(superIdOf('m:doctor')).toBe('m:doctor');
    expect(superIdOf('m:code-reviewer-2')).toBe('m:code-reviewer-2');
    for (const bad of ['', 'm:', 'm:../x', 'm:a/b', 'm:Doctor', 'doctor', 42, null, {}]) expect(superIdOf(bad)).toBe('main');
  });

  it('a route for main is unchanged; a member route names its super', () => {
    expect(superRoute('/super/state')).toBe('/super/state');
    expect(superRoute('/super/state', 'main')).toBe('/super/state');
    expect(superRoute('/super/state', 'm:doctor')).toBe('/super/state?superId=m%3Adoctor');
    expect(superRoute('/x?a=1', 'm:doctor')).toBe('/x?a=1&superId=m%3Adoctor');
  });

  it('main\'s client is the client itself; a member\'s names its super on every path', async () => {
    const calls: string[] = [];
    const api = {
      get: async (path: string) => { calls.push(`GET ${path}`); return null; },
      post: async (path: string) => { calls.push(`POST ${path}`); return null; },
    } as unknown as ApiClient;
    expect(forSuper(api)).toBe(api);
    expect(forSuper(api, 'main')).toBe(api);
    const member = forSuper(api, 'm:doctor');
    await member.get('/super/state');
    await member.post('/super/layout', {});
    expect(calls).toEqual(['GET /super/state?superId=m%3Adoctor', 'POST /super/layout?superId=m%3Adoctor']);
  });
});
