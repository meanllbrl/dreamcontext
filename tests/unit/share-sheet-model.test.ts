// The live-link sheet and pill model (dashboard/src/components/shares/shareSheetModel.ts,
// tunel-paylasim rapor.html sections 2 and 4): which face shows, the stage count, the failure
// line, the password rule and suggestion, the age and the pill.
import { describe, it, expect } from 'vitest';
import {
  errorKey, minutesOpen, passwordOk, pillState, sheetPhase, shareFor, stageStep, suggestPassword, PASSWORD_MIN,
} from '../../dashboard/src/components/shares/shareSheetModel.js';
import type { LiveShare } from '../../dashboard/src/lib/sharesApi.js';

const row = (patch: Partial<LiveShare>): LiveShare => ({
  id: 'a', kind: 'app', vault: 'northwind', slug: 'funnel', name: 'Funnel Masası', state: 'open', stage: null,
  people: 0, password: false, ai: false, openedAt: '2026-11-22T10:00:00.000Z', ...patch,
});

describe('share sheet model', () => {
  it('the face follows the share: none or closing = form, starting, open, broken', () => {
    expect(sheetPhase(null)).toBe('form');
    expect(sheetPhase(row({ state: 'closing' }))).toBe('form');
    expect(sheetPhase(row({ state: 'starting', stage: 'tunnel' }))).toBe('starting');
    expect(sheetPhase(row({ state: 'open' }))).toBe('open');
    expect(sheetPhase(row({ state: 'broken', error: 'tunnel_exited' }))).toBe('broken');
  });

  it('shareFor finds this target only, never a closing one', () => {
    const rows = [row({ id: 'x', kind: 'board', slug: 'funnel' }), row({ id: 'y', vault: 'other' }), row({ id: 'z', state: 'closing' }), row({ id: 'w' })];
    expect(shareFor(rows, 'app', 'northwind', 'funnel')?.id).toBe('w');
    expect(shareFor(rows.slice(0, 3), 'app', 'northwind', 'funnel')).toBeNull();
    expect(shareFor(undefined, 'app', 'northwind', 'funnel')).toBeNull();
  });

  it('the stage reads as n/3; an unknown stage is the first', () => {
    expect(stageStep('download')).toBe(1);
    expect(stageStep('tunnel')).toBe(2);
    expect(stageStep('probe')).toBe(3);
    expect(stageStep(null)).toBe(1);
  });

  it('every failure code has a line; an unknown code the general one', () => {
    expect(errorKey('download_failed')).toBe('liveShare.error.download');
    expect(errorKey('tunnel_failed')).toBe('liveShare.error.tunnel');
    expect(errorKey('probe_failed')).toBe('liveShare.error.probe');
    expect(errorKey('tunnel_exited')).toBe('liveShare.error.exited');
    expect(errorKey('start_failed')).toBe('liveShare.error.other');
    expect(errorKey(undefined)).toBe('liveShare.error.other');
  });

  it('a password needs at least 10 characters (the server rule); the suggestion always passes', () => {
    expect(passwordOk('a'.repeat(PASSWORD_MIN - 1))).toBe(false);
    expect(passwordOk('a'.repeat(PASSWORD_MIN))).toBe(true);
    for (const r of [0, 0.5, 0.999999]) {
      const pw = suggestPassword(() => r);
      expect(passwordOk(pw)).toBe(true);
      expect(pw).toMatch(/^[a-z]+(-[a-z]+){2,}$/);
    }
    // The shortest words still make a valid password.
    const seq = [0.9, 0.9, 0.9, 0.9];
    expect(passwordOk(suggestPassword(() => seq.shift() ?? 0.9))).toBe(true);
  });

  it('minutes open: whole minutes, never negative, unreadable = 0', () => {
    const at = Date.parse('2026-11-22T10:00:00.000Z');
    expect(minutesOpen('2026-11-22T10:00:00.000Z', at + 12 * 60_000 + 59_000)).toBe(12);
    expect(minutesOpen('2026-11-22T10:00:00.000Z', at - 5_000)).toBe(0);
    expect(minutesOpen('nope', at)).toBe(0);
  });

  it('the pill: hidden with no link, counts starting, open and broken, red when one broke', () => {
    expect(pillState([])).toBeNull();
    expect(pillState(undefined)).toBeNull();
    expect(pillState([row({ state: 'closing' })])).toBeNull();
    expect(pillState([row({}), row({ id: 'b', state: 'starting' })])).toEqual({ count: 2, bad: false });
    expect(pillState([row({}), row({ id: 'b', state: 'broken' })])).toEqual({ count: 2, bad: true });
  });
});
