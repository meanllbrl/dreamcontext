import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD_MAX_RETRIES, boardFailure, boardRetryDelay } from '../../dashboard/src/lib/boardFailure.js';

/** `RequestError`'s shape (dashboard/src/api/client.ts): an Error carrying the route's slug. */
const requestError = (message: string, status: number, code: string) =>
  Object.assign(new Error(message), { status, code });

// Owner 2026-10-27: a Super stage `key-metrics` whiteboard card said "couldn't be read" for
// every cause, and never asked again — a board written after the card opened stayed failed.
describe('boardFailure — a board card says why it cannot draw', () => {
  it('a missing board is "not in this project yet" and is asked for again', () => {
    const f = boardFailure(requestError('File not found: _dream_context/whiteboards/key-metrics/key-metrics.excalidraw.md', 404, 'not_found'));
    expect(f).toMatchObject({ note: 'not in this project yet', missing: true });
    expect(f.detail).toContain('key-metrics');
    expect(boardRetryDelay(f, 0)).toBe(3_000);
  });

  it('names the other causes and never retries them', () => {
    const cases: Array<[string, number, string]> = [
      ['too_large', 413, 'too large to draw here'],
      ['needs_grant', 403, 'outside this project'],
      ['invalid_path', 400, 'outside this project'],
      ['desktop_only', 403, 'opens in the desktop app'],
      ['read_failed', 500, "couldn't be read"],
    ];
    for (const [code, status, note] of cases) {
      const f = boardFailure(requestError('x', status, code));
      expect(f.note, code).toBe(note);
      expect(boardRetryDelay(f, 0), code).toBeNull();
    }
    expect(boardFailure(new TypeError('Failed to fetch')).note).toBe("couldn't be read");
  });

  it('backs off to 30 s and rests after its last try', () => {
    const f = boardFailure(requestError('gone', 404, 'not_found'));
    expect([0, 1, 2, 3, 4, 9].map((n) => boardRetryDelay(f, n))).toEqual([3_000, 5_000, 10_000, 20_000, 30_000, 30_000]);
    expect(boardRetryDelay(f, BOARD_MAX_RETRIES - 1)).toBe(30_000);
    expect(boardRetryDelay(f, BOARD_MAX_RETRIES)).toBeNull();
  });

  it('the board card shows the reason and re-asks through it (not a hand-rolled copy)', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'chat', 'BoardEmbed.tsx'), 'utf-8');
    expect(src).toContain("from '../../../lib/boardFailure'");
    expect(src).toMatch(/boardRetryDelay\(failure, tries\+\+\)/);
    expect(src).toContain('{failure?.note ?? "couldn\'t be read"}');
    expect(src).toMatch(/clearTimeout\(timer\)/);
  });
});
