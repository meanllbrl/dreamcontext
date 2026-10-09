/**
 * The start-intent filter: the one gate between "something asked this window to start a chat"
 * and an agent actually starting. Only the closed intent, only for a project this window holds,
 * and never twice for the same nonce.
 */
import { describe, it, expect } from 'vitest';
import { acceptStartIntent } from '../../dashboard/src/lib/startChatIntent.js';

const OWN = ['acme-storefront', 'Öğretmen Notları'];

describe('acceptStartIntent', () => {
  it('accepts the initializer intent for a held project, once', () => {
    const seen = new Set<string>();
    const p = { vault: 'acme-storefront', intent: 'initializer', nonce: 'n-1' };
    expect(acceptStartIntent(p, OWN, seen)).toEqual({ vault: 'acme-storefront', intent: 'initializer' });
    expect(seen.has('n-1')).toBe(true);
    // The same broadcast delivered again starts nothing.
    expect(acceptStartIntent(p, OWN, seen)).toBeNull();
  });

  it('keeps a Turkish project name intact', () => {
    const seen = new Set<string>();
    const p = { vault: 'Öğretmen Notları', intent: 'initializer', nonce: 'n-tr' };
    expect(acceptStartIntent(p, OWN, seen)?.vault).toBe('Öğretmen Notları');
  });

  it('drops any intent other than initializer', () => {
    const seen = new Set<string>();
    for (const intent of ['develop', 'INITIALIZER', '', 1, null, undefined]) {
      expect(acceptStartIntent({ vault: 'acme-storefront', intent, nonce: `n-${String(intent)}` }, OWN, seen)).toBeNull();
    }
    expect(seen.size).toBe(0);
  });

  it('drops a project this window does not hold', () => {
    const seen = new Set<string>();
    expect(acceptStartIntent({ vault: 'other-project', intent: 'initializer', nonce: 'n-2' }, OWN, seen)).toBeNull();
    expect(seen.has('n-2')).toBe(false);
  });

  it('drops malformed payloads', () => {
    const seen = new Set<string>();
    const bad: unknown[] = [
      null,
      undefined,
      'initializer',
      42,
      [],
      {},
      { vault: 'acme-storefront', intent: 'initializer' },
      { vault: 'acme-storefront', intent: 'initializer', nonce: '' },
      { vault: 'acme-storefront', intent: 'initializer', nonce: 7 },
      { vault: 7, intent: 'initializer', nonce: 'n-3' },
      { vault: '', intent: 'initializer', nonce: 'n-4' },
    ];
    for (const p of bad) expect(acceptStartIntent(p, OWN, seen)).toBeNull();
    expect(seen.size).toBe(0);
  });

  it('with no held projects, accepts nothing', () => {
    expect(acceptStartIntent({ vault: 'acme-storefront', intent: 'initializer', nonce: 'n-5' }, [], new Set())).toBeNull();
  });
});
