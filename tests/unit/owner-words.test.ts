import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendOwnerTurn,
  conversationKeysFromEnv,
  findQuoteTurn,
  newOwnerTurnId,
  occasion,
  ownerWordsDir,
  pruneOwnerWords,
  quoteCovers,
  readOwnerTurns,
  sameConversation,
  type OwnerTurnLine,
} from '../../src/lib/owner-words.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-owner-words-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

function line(over: Partial<OwnerTurnLine> = {}): OwnerTurnLine {
  return {
    at: '2026-11-03T10:00:00.000Z',
    turn: newOwnerTurnId(),
    vault: '/tmp/orchard',
    surface: 'plain',
    via: 'composer',
    keys: ['sess-a', 'tab-a'],
    session: 'sess-a',
    own: 'Always label the Orchard charts in Turkish, every chart.',
    ...over,
  };
}

describe('owner-words ledger (C3)', () => {
  it('appends one line per turn into the month file, 0600 in a 0700 dir', () => {
    appendOwnerTurn(line(), { home });
    appendOwnerTurn(line({ at: '2026-11-04T10:00:00.000Z' }), { home });
    const dir = ownerWordsDir(home);
    expect(readdirSync(dir)).toEqual(['2026-11.jsonl']);
    expect(readFileSync(join(dir, '2026-11.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(2);
    expect(statSync(join(dir, '2026-11.jsonl')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('dedupes keys, drops empty ones, and never throws on a bad line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    appendOwnerTurn(line({ keys: ['a', 'a', ' ', 'b'] }), { home });
    expect(readOwnerTurns({ home })[0]!.keys).toEqual(['a', 'b']);
    expect(() => appendOwnerTurn({ ...line(), via: 'terminal' as never }, { home })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(readOwnerTurns({ home })).toHaveLength(1);
  });

  it('a symlinked ledger dir is refused, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const elsewhere = mkdtempSync(join(tmpdir(), 'dc-owner-words-elsewhere-'));
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    symlinkSync(elsewhere, ownerWordsDir(home));
    appendOwnerTurn(line(), { home });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readOwnerTurns({ home })).toEqual([]);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('skips a torn last line and reads across the month boundary, oldest first', () => {
    appendOwnerTurn(line({ at: '2026-10-31T23:00:00.000Z', turn: 'oct' }), { home });
    appendOwnerTurn(line({ at: '2026-11-01T01:00:00.000Z', turn: 'nov' }), { home });
    appendFileSync(join(ownerWordsDir(home), '2026-11.jsonl'), '{"at":"2026-11-01T02:00:00.000Z","tu');
    expect(readOwnerTurns({ home }).map((t) => t.turn)).toEqual(['oct', 'nov']);
    expect(readOwnerTurns({ home, since: '2026-11-01T00:00:00.000Z' }).map((t) => t.turn)).toEqual(['nov']);
  });

  it('filters by vault', () => {
    appendOwnerTurn(line({ turn: 'a', vault: '/tmp/orchard' }), { home });
    appendOwnerTurn(line({ turn: 'b', vault: '/tmp/meadow' }), { home });
    expect(readOwnerTurns({ home, vault: '/tmp/meadow' }).map((t) => t.turn)).toEqual(['b']);
  });

  it('prunes whole month files that ended more than 45 days ago, never the current one', () => {
    const dir = ownerWordsDir(home);
    mkdirSync(dir, { recursive: true });
    for (const m of ['2026-08', '2026-09', '2026-10', '2026-11']) writeFileSync(join(dir, `${m}.jsonl`), '');
    const removed = pruneOwnerWords({ home, now: new Date('2026-11-20T00:00:00Z') });
    // September ended 2026-10-01: 50 days before. October ended 2026-11-01: 19 days.
    expect(removed.sort()).toEqual(['2026-08.jsonl', '2026-09.jsonl']);
    expect(readdirSync(dir).sort()).toEqual(['2026-10.jsonl', '2026-11.jsonl']);
  });

  it('turn ids are unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newOwnerTurnId()));
    expect(ids.size).toBe(200);
  });
});

describe('sameConversation and occasion (C3: two questions, two functions)', () => {
  it('one shared id is the same conversation', () => {
    expect(sameConversation(['pin', 'tab'], ['tab'])).toBe(true);
    expect(sameConversation(['pin'], ['other'])).toBe(false);
    expect(sameConversation([], ['x'])).toBe(false);
  });

  it('the occasion is the live session, not the pin or the tab', () => {
    const a = line({ keys: ['pin', 'tab'], session: 'live-1' });
    const b = line({ keys: ['pin', 'tab'], session: 'live-2' });
    expect(sameConversation(a.keys, b.keys)).toBe(true);
    expect(occasion(a)).not.toBe(occasion(b));
  });

  it('learn collects the same kinds of ids from its environment', () => {
    expect(conversationKeysFromEnv({ CLAUDE_CODE_SESSION_ID: 's1', DREAMCONTEXT_TAB_SESSION: 't1' })).toEqual(['s1', 't1']);
    // Under a bridge tool the Claude id is the server's parent's: never read.
    expect(conversationKeysFromEnv({ DREAMCONTEXT_AGENT_TOOL: 'codex', CLAUDE_CODE_SESSION_ID: 'x', CODEX_THREAD_ID: 'th', DREAMCONTEXT_TAB_SESSION: 't' })).toEqual(['t', 'th']);
    expect(conversationKeysFromEnv({})).toEqual([]);
  });
});

describe('the quote test (G1)', () => {
  const own = 'Ok so, one thing: always label the Orchard charts in Turkish, every chart, please.';

  it('a quote of his words covers them', () => {
    expect(quoteCovers('always label the Orchard charts in Turkish', own)).toBe(true);
  });

  it('words out of order or not his do not', () => {
    expect(quoteCovers('Turkish charts Orchard label always', own)).toBe(false);
    expect(quoteCovers('never deploy on a Friday afternoon', own)).toBe(false);
  });

  it('a quote with fewer than two content terms proves nothing', () => {
    expect(quoteCovers('charts', own)).toBe(false);
  });

  it('prefers the earliest turn of this conversation, else the earliest anywhere', () => {
    const other = line({ turn: 'other', at: '2026-11-01T00:00:00Z', keys: ['super'], own });
    const mine = line({ turn: 'mine', at: '2026-11-02T00:00:00Z', keys: ['me'], own });
    const here = findQuoteTurn('label the Orchard charts in Turkish', [other, mine], ['me']);
    expect(here.turn?.turn).toBe('mine');
    expect(here.here).toBe(true);
    const away = findQuoteTurn('label the Orchard charts in Turkish', [other, mine], ['nobody']);
    expect(away.turn?.turn).toBe('other');
    expect(away.here).toBe(false);
  });
});
