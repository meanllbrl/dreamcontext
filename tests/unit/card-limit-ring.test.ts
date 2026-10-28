/**
 * A chat card's rate-limit ring (dashboard/src/components/sleepy/chat/UsageRings.tsx): the ring
 * at the top-left of every chat card on the Super stage, which used to draw the chat's STATUS
 * and now draws the REAL rate limit of the Claude account that chat runs on.
 *
 * What is pinned here:
 *   1. account → usage → ring: each card asks for ITS chat's account (the spawned one first),
 *      and the ring draws that account's 5-hour window (outer) and weekly window (inner), toned
 *      by the usage popover's own "tight" rule.
 *   2. UNKNOWN is never a number: no live session, no reading, a stale cache or a rolled-over
 *      window all draw neutral empty tracks and say "unknown", never "0%".
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { UsageLimitsResponse } from '../../dashboard/src/lib/agentComposer.js';

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const H = 60 * 60_000;

// The ring's data hook, faked per account. Records who asked, so the test can prove each card
// reads its OWN chat's account.
const byAccount = new Map<string, UsageLimitsResponse>();
const asked: Array<{ enabled: boolean; accountId: string }> = [];
vi.mock('../../dashboard/src/hooks/useAgentCapabilities.js', () => ({
  useUsageLimits: (enabled: boolean, accountId = '') => {
    asked.push({ enabled, accountId });
    return { data: enabled ? byAccount.get(accountId) ?? { limits: [], fetchedAtMs: null } : { limits: [], fetchedAtMs: null } };
  },
}));

const { accountLimitReading, chatAccountOf, CONTEXT_TIGHT_PCT, USAGE_MAX_AGE_MS, USAGE_STALE_MS } =
  await import('../../dashboard/src/lib/agentComposer.js');
const { AccountLimitRing } = await import('../../dashboard/src/components/sleepy/chat/UsageRings.js');

function reading(session: number, weekly: number, fetchedAtMs = NOW - 60_000): UsageLimitsResponse {
  return {
    fetchedAtMs,
    limits: [
      { key: 'weekly', percent: weekly, resetsAt: NOW + 3 * 24 * H },
      { key: 'session', percent: session, resetsAt: NOW + 2 * H + 10 * 60_000 },
    ],
  };
}

describe('accountLimitReading — usage → ring', () => {
  it('low / medium: both windows, session outer, calm, worded with window and reset', () => {
    const r = accountLimitReading(reading(12, 55), NOW);
    expect(r.rings.map((x) => [x.key, x.percent, x.tight])).toEqual([['session', 12, false], ['weekly', 55, false]]);
    expect(r.label).toBe('Rate limits — 5-hour session 12% · resets in 2h 10m · Weekly 55% · resets in 72h');
    expect(r.staleAsOf).toBeNull();
  });

  it('high: tight from the popover\'s own threshold, not a new one', () => {
    const r = accountLimitReading(reading(CONTEXT_TIGHT_PCT, CONTEXT_TIGHT_PCT - 1), NOW);
    expect(r.rings.map((x) => x.tight)).toEqual([true, false]);
  });

  it('unknown: no reading, no fetch stamp, too old, rolled over, out of range — never 0%', () => {
    const cases: Array<UsageLimitsResponse | null> = [
      null,
      { limits: [], fetchedAtMs: null },
      reading(40, 40, NOW - USAGE_MAX_AGE_MS - 1),
      { fetchedAtMs: NOW - 60_000, limits: [{ key: 'session', percent: 40, resetsAt: NOW - 1 }] },
      { fetchedAtMs: NOW - 60_000, limits: [{ key: 'session', percent: 140, resetsAt: NOW + H }] },
    ];
    for (const res of cases) {
      const r = accountLimitReading(res, NOW);
      expect(r.rings).toEqual([]);
      expect(r.label).toMatch(/unknown/i);
      expect(r.label).not.toMatch(/\d+%/);
    }
  });

  it('stale but within range: still drawn, and the label admits when it was read', () => {
    const r = accountLimitReading(reading(30, 10, NOW - USAGE_STALE_MS - 1), NOW);
    expect(r.rings).toHaveLength(2);
    expect(r.staleAsOf).toBe(NOW - USAGE_STALE_MS - 1);
    expect(r.label).toMatch(/\(as of .+\)$/);
  });
});

describe('chatAccountOf — chat → account', () => {
  const sess = (accountId: string, active?: string) => ({ accountId, getModel: () => ({ activeAccountId: active }) });
  it('the account the process REALLY runs on wins over the one it asked for', () => {
    expect(chatAccountOf(sess('', 'acct-b'))).toBe('acct-b');
    expect(chatAccountOf(sess('acct-a', 'acct-b'))).toBe('acct-b');
    expect(chatAccountOf(sess('acct-a'))).toBe('acct-a');
  });
  it('no preference = the default account (\'\'), like the composer; no session = not known', () => {
    expect(chatAccountOf(sess(''))).toBe('');
    expect(chatAccountOf(undefined)).toBeNull();
  });
});

describe('AccountLimitRing — account → usage → ring, rendered', () => {
  const html = (accountId: string | null) => renderToStaticMarkup(createElement(AccountLimitRing as never, { accountId } as never));

  it('each card draws ITS account\'s reading', () => {
    vi.useFakeTimers({ now: NOW });
    byAccount.set('acct-a', reading(20, 5));
    byAccount.set('acct-b', reading(95, 40));
    asked.length = 0;
    const a = html('acct-a');
    const b = html('acct-b');
    expect(asked).toEqual([{ enabled: true, accountId: 'acct-a' }, { enabled: true, accountId: 'acct-b' }]);
    expect(a).toContain('data-known="true"');
    expect(a).toContain('5-hour session 20%');
    expect(a).not.toContain('data-tight');
    expect(a).toContain('aria-valuenow="20"');
    expect(b).toContain('5-hour session 95%');
    expect(b).toContain('data-tight="true"');
    // The outer (session) ring of B is the caution tone; A's stays calm.
    expect(b).toMatch(/chat-cmp-usagering-fill" data-band="caution"/);
    expect(a).not.toMatch(/data-band="caution"/);
    vi.useRealTimers();
  });

  it('unknown draws neutral empty tracks, no arc, no number — and asks nothing without a session', () => {
    asked.length = 0;
    const none = html(null);
    expect(asked).toEqual([{ enabled: false, accountId: '' }]);
    const empty = html('acct-nobody');
    for (const out of [none, empty]) {
      expect(out).toContain('data-known="false"');
      expect(out).not.toContain('chat-cmp-usagering-fill');
      expect(out.match(/data-band="none"/g)).toHaveLength(2);
      expect(out).not.toContain('aria-valuenow');
      expect(out).toMatch(/unknown/i);
    }
  });
});
