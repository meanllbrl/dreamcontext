import { describe, it, expect } from 'vitest';
import {
  clipboardStrategyOrder,
  TURKISH_COPY_FIXTURE,
} from '../../dashboard/src/lib/clipboard.js';

/**
 * Regression guard for issue #171 — Turkish/UTF-8 text copied from the in-app agent terminal
 * arrived as Mac-Roman mojibake (Ş `C5 9E` → "≈û", ü `C3 BC` → "√º", ı → "ƒ±"). Root cause: the
 * copy path's `execCommand` primary degraded in a newer WKWebView and silently fell through to
 * `navigator.clipboard.writeText`, which mangles non-ASCII in that WKWebView. The durable fix is
 * to write via the native OS clipboard (Tauri plugin) FIRST on the desktop shell, so the mangling
 * `navigator` path is never the effective writer where the bug exists.
 *
 * The clipboard plumbing itself needs a live WKWebView, so these tests lock the two things a pure
 * unit test can guarantee: (1) the strategy ORDER — desktop must prefer the encoding-safe native
 * path and never reach `navigator` before it; (2) the corruption MODEL — a UTF-8 string decoded
 * under a legacy single-byte codepage corrupts, while a UTF-8 round-trip is byte-identical.
 */
describe('clipboard strategy order (issue #171)', () => {
  it('desktop prefers the native OS clipboard first', () => {
    expect(clipboardStrategyOrder(true)[0]).toBe('tauri');
  });

  it('desktop never reaches the mangling navigator path before an encoding-safe one', () => {
    const order = clipboardStrategyOrder(true);
    const navigatorIdx = order.indexOf('navigator');
    const firstSafeIdx = Math.min(
      order.indexOf('tauri'),
      order.indexOf('exec-command'),
    );
    // navigator is present only as a last resort, strictly after an encoding-safe strategy.
    expect(navigatorIdx).toBeGreaterThan(firstSafeIdx);
    expect(navigatorIdx).toBe(order.length - 1);
  });

  it('web (no WKWebView bug) uses the OS pipeline then the async API — never the native plugin', () => {
    const order = clipboardStrategyOrder(false);
    expect(order).toEqual(['exec-command', 'navigator']);
    expect(order).not.toContain('tauri');
  });
});

describe('UTF-8 copy fixture round-trip (issue #171)', () => {
  it("'Ş' encodes to the exact bytes named in the issue (C5 9E)", () => {
    expect([...Buffer.from('Ş', 'utf8')]).toEqual([0xc5, 0x9e]);
  });

  it('a UTF-8 round-trip of the Turkish fixture is byte-identical (the native clipboard guarantee)', () => {
    const roundTripped = Buffer.from(TURKISH_COPY_FIXTURE, 'utf8').toString('utf8');
    expect(roundTripped).toBe(TURKISH_COPY_FIXTURE);
  });

  it('decoding the fixture bytes under a legacy single-byte codepage corrupts it (the bug it regressed to)', () => {
    // This is what a non-UTF-8 clipboard write does: keep the UTF-8 bytes, mislabel the encoding.
    const corrupted = Buffer.from(TURKISH_COPY_FIXTURE, 'utf8').toString('latin1');
    expect(corrupted).not.toBe(TURKISH_COPY_FIXTURE);
    // Every Turkish letter must have been mangled — none of them survive a single-byte decode.
    for (const ch of 'Şüışçğ') {
      expect(corrupted).not.toContain(ch);
    }
  });
});
