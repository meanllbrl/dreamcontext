/**
 * ⌘P switcher focus handoff (task cmdp-odak): while it is open, keys aimed at the page behind it
 * (a Super/Chat/member composer, the whiteboard) belong to the switcher and never reach that page.
 */
import { describe, expect, it } from 'vitest';
import { routeSwitcherKey, type SwitcherKeyInput } from '../../dashboard/src/lib/switcherKeys.js';

const k = (key: string, o: Partial<SwitcherKeyInput> = {}): SwitcherKeyInput =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, inside: false, ...o });

/** A tiny model of the switcher: the filter box + the rows, driven only by routeSwitcherKey. */
function drive(keys: string[], vaults: string[]) {
  let q = '';
  let opened: string | null = null;
  let composer = '';
  for (const key of keys) {
    const r = routeSwitcherKey(k(key));
    if (r.kind === 'type') q += r.text;
    else if (r.kind === 'backspace') q = q.slice(0, -1);
    else if (r.kind === 'enter') opened = vaults.filter((v) => v.includes(q.toLowerCase()))[0] ?? null;
    else if (r.kind === 'pass') composer += key.length === 1 ? key : ''; // would reach the page
  }
  return { q, opened, composer };
}

describe('routeSwitcherKey', () => {
  const vaults = ['acme', 'northwind', 'pocket-ledger'];
  it('"po" + Enter aimed at a composer behind the switcher opens pocket-ledger and leaves the composer empty', () => {
    expect(drive(['p', 'o', 'Enter'], vaults)).toEqual({ q: 'po', opened: 'pocket-ledger', composer: '' });
  });
  it('backspace edits the filter, arrows move, other keys are swallowed', () => {
    expect(routeSwitcherKey(k('Backspace'))).toEqual({ kind: 'backspace' });
    expect(routeSwitcherKey(k('ArrowDown'))).toEqual({ kind: 'move', dir: 1 });
    expect(routeSwitcherKey(k('F5'))).toEqual({ kind: 'swallow' });
  });
  it('keys inside the switcher, chords, Esc, Tab and IME composition pass untouched', () => {
    expect(routeSwitcherKey(k('p', { inside: true })).kind).toBe('pass');
    expect(routeSwitcherKey(k('p', { metaKey: true })).kind).toBe('pass');
    expect(routeSwitcherKey(k('3', { ctrlKey: true })).kind).toBe('pass');
    expect(routeSwitcherKey(k('Escape')).kind).toBe('pass');
    expect(routeSwitcherKey(k('Tab')).kind).toBe('pass');
    expect(routeSwitcherKey({ ...k('p'), composing: true }).kind).toBe('pass');
  });
});

describe('another modal on top', () => {
  it('keys aimed at the ⌘K palette (or any modal) are left alone', () => {
    expect(routeSwitcherKey({ ...k('a'), otherModal: true }).kind).toBe('pass');
    expect(routeSwitcherKey({ ...k('Enter'), otherModal: true }).kind).toBe('pass');
  });
});
