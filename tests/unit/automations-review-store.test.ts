/**
 * Review cards — the store layer.
 *
 * What these tests are actually protecting, in order of how badly it fails:
 *   1. a corrupt or planted card must be INERT, never lethal — it gates a
 *      spawn, so "throws" and "reads as a valid pending card" are both worse
 *      than "ignored";
 *   2. a session id read off disk must never reach a path unwhitelisted;
 *   3. a steer must leave the card PENDING (the Tilki incident in one line:
 *      correcting a proposal is not approving it);
 *   4. a verdict must be recorded before anything acts on it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allPendingReviewCards,
  backfillCardSession,
  canResume,
  claimReviewCard,
  createReviewCard,
  listReviewCards,
  pendingReviewCard,
  readReviewCard,
  recordSteer,
  refreshReviewCard,
  resolveReviewCard,
  reviewCardPath,
  reviewSlugDir,
  setChannelRef,
} from '../../src/lib/automations/review.js';
import { REVIEW_BODY_MAX_CHARS, REVIEW_STEER_LIMIT } from '../../src/lib/automations/types.js';
import { RESOLVED_CARD_KEEP } from '../../src/lib/automations/review.js';

let root: string;
const NOW = '2026-08-03T18:00:00.000Z';

function makeCard(overrides: Partial<Parameters<typeof createReviewCard>[1]> = {}) {
  return createReviewCard(root, {
    slug: 'eod-digest',
    runFiredAt: '2026-08-03T18:00:00.000Z',
    sessionId: 'abc-123',
    kind: 'agent',
    title: 'Publish the daily digest',
    body: 'I am about to write today\'s digest covering 4 commits.',
    nowISO: NOW,
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-review-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('create + read', () => {
  it('writes a pending card that reads back identically', () => {
    const card = makeCard();
    expect(card.state).toBe('pending');
    expect(card.steers).toEqual([]);
    expect(card.resolvedAt).toBeNull();
    const back = readReviewCard(reviewCardPath(root, 'eod-digest', card.id));
    expect(back).toEqual(card);
  });

  it('derives a summary from the first non-heading line when none is given', () => {
    const card = makeCard({ body: '# Digest\n\nFour commits landed today.' });
    expect(card.summary).toBe('Four commits landed today.');
  });

  it('stages a document beside its card for a kind:output proposal', () => {
    const card = makeCard({ kind: 'output', stagedBody: '# Today\n\nthe report' });
    expect(card.stagedPath).not.toBeNull();
    expect(readFileSync(card.stagedPath as string, 'utf-8')).toBe('# Today\n\nthe report');
    // and it is staged, NOT published — the move into the output dir IS approval
    expect(card.stagedPath as string).toContain(join('automations', 'review'));
  });

  it('truncates an over-long body rather than storing a proposal nobody will read', () => {
    const card = makeCard({ body: 'x'.repeat(REVIEW_BODY_MAX_CHARS + 500) });
    expect(card.body.length).toBeLessThanOrEqual(REVIEW_BODY_MAX_CHARS);
    expect(card.body.endsWith('…')).toBe(true);
  });

  it('writes atomically — no .tmp survives a completed write', () => {
    makeCard();
    expect(readdirSync(reviewSlugDir(root, 'eod-digest')).some((n) => n.endsWith('.tmp'))).toBe(false);
  });
});

describe('a bad card is inert, never lethal', () => {
  it('returns null for unparseable JSON instead of throwing', () => {
    mkdirSync(reviewSlugDir(root, 'eod-digest'), { recursive: true });
    const p = join(reviewSlugDir(root, 'eod-digest'), 'broken.json');
    writeFileSync(p, '{ not json', 'utf-8');
    expect(readReviewCard(p)).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(readReviewCard(join(root, 'nope.json'))).toBeNull();
  });

  it('drops a corrupt card from the listing rather than failing the whole read', () => {
    const good = makeCard();
    writeFileSync(join(reviewSlugDir(root, 'eod-digest'), 'broken.json'), 'nope', 'utf-8');
    const cards = listReviewCards(root, 'eod-digest');
    expect(cards.map((c) => c.id)).toEqual([good.id]);
  });

  it('a card with no id or slug is not a card', () => {
    mkdirSync(reviewSlugDir(root, 'eod-digest'), { recursive: true });
    const p = join(reviewSlugDir(root, 'eod-digest'), 'x.json');
    writeFileSync(p, JSON.stringify({ title: 'looks real', state: 'pending' }), 'utf-8');
    expect(readReviewCard(p)).toBeNull();
  });

  it('an unrecognised state degrades to pending, never to approved', () => {
    // Fail-safe direction: an unreadable state must never read as a verdict that
    // was never given. Pending is the state that costs a human a look.
    const card = makeCard();
    const p = reviewCardPath(root, 'eod-digest', card.id);
    writeFileSync(p, JSON.stringify({ ...card, state: 'YOLO' }), 'utf-8');
    expect(readReviewCard(p)?.state).toBe('pending');
  });

  it('a missing directory lists as empty, not as a throw', () => {
    expect(listReviewCards(root, 'never-existed')).toEqual([]);
    expect(allPendingReviewCards(root)).toEqual([]);
  });
});

describe('sessionId is whitelisted on the way IN', () => {
  it('a traversal-shaped session id is nulled at read time, not at use time', () => {
    const card = makeCard();
    const p = reviewCardPath(root, 'eod-digest', card.id);
    writeFileSync(p, JSON.stringify({ ...card, sessionId: '../../../etc/passwd' }), 'utf-8');
    const back = readReviewCard(p);
    expect(back?.sessionId).toBeNull();
    // still readable and still discardable — a card you did not expect is
    // exactly the one you want to be able to throw away
    expect(back?.state).toBe('pending');
    expect(canResume(back!)).toBe(false);
  });

  it.each(['a/b', 'a.b', 'a b', '', 'x'.repeat(129)])('rejects %j', (bad) => {
    const card = createReviewCard(root, {
      slug: 's',
      runFiredAt: NOW,
      sessionId: bad,
      kind: 'agent',
      title: 't',
      body: 'b',
      nowISO: NOW,
    });
    expect(card.sessionId).toBeNull();
  });

  it('accepts the real shape claude produces', () => {
    const card = makeCard({ sessionId: '0f5c1a2b-9d3e-4f60-8a71-2c3d4e5f6071' });
    expect(canResume(card)).toBe(true);
  });
});

describe('the serial gate reads from here', () => {
  it('pendingReviewCard finds the open card', () => {
    const card = makeCard();
    expect(pendingReviewCard(root, 'eod-digest')?.id).toBe(card.id);
  });

  it('a resolved card no longer gates', () => {
    const card = makeCard();
    resolveReviewCard(root, card, 'approve', 'cli', NOW);
    expect(pendingReviewCard(root, 'eod-digest')).toBeNull();
  });

  it('the OLDEST pending card wins when more than one is somehow open', () => {
    const first = makeCard({ nowISO: '2026-08-01T10:00:00.000Z' });
    makeCard({ nowISO: '2026-08-03T10:00:00.000Z' });
    expect(pendingReviewCard(root, 'eod-digest')?.id).toBe(first.id);
  });

  it('allPendingReviewCards spans slugs, oldest first, pending only', () => {
    const a = makeCard({ slug: 'a', nowISO: '2026-08-01T10:00:00.000Z' });
    const b = makeCard({ slug: 'b', nowISO: '2026-08-02T10:00:00.000Z' });
    const c = makeCard({ slug: 'c', nowISO: '2026-08-03T10:00:00.000Z' });
    resolveReviewCard(root, b, 'discard', 'telegram', NOW);
    expect(allPendingReviewCards(root).map((x) => x.slug)).toEqual([a.slug, c.slug]);
  });
});

describe('a steer corrects, it does not approve', () => {
  it('leaves the card PENDING and replaces the body in place', () => {
    // The Tilki 2026-07-12 incident in one assertion: free text re-drafts, it
    // never ships. If this ever flips, a correction meant for the agent becomes
    // the thing that goes out.
    const card = makeCard();
    const next = recordSteer(root, card, {
      text: 'too long, cut the preamble',
      via: 'telegram',
      newBody: 'Four commits landed today.',
    });
    expect(next.state).toBe('pending');
    expect(next.resolvedAt).toBeNull();
    expect(next.body).toBe('Four commits landed today.');
    expect(readReviewCard(reviewCardPath(root, 'eod-digest', card.id))?.state).toBe('pending');
  });

  it('keeps the trail oldest-first with the distilled lesson attached', () => {
    const card = makeCard();
    const next = recordSteer(root, card, {
      text: 'no emoji',
      via: 'dashboard',
      newBody: 'b2',
      lesson: 'Never use emoji in a digest.',
      nowISO: NOW,
    });
    expect(next.steers).toEqual([
      { at: NOW, via: 'dashboard', text: 'no emoji', lesson: 'Never use emoji in a digest.' },
    ]);
  });

  it('a steer that taught nothing durable still records the correction', () => {
    const card = makeCard();
    expect(recordSteer(root, card, { text: 'shorter', via: 'cli', newBody: 'b' }).steers[0].lesson).toBeNull();
  });

  it('bounds the trail — it is prepended to a resumed session, so it cannot grow forever', () => {
    let card = makeCard();
    for (let i = 0; i < REVIEW_STEER_LIMIT + 4; i++) {
      card = recordSteer(root, card, { text: `steer ${i}`, via: 'cli', newBody: `b${i}` });
    }
    expect(card.steers).toHaveLength(REVIEW_STEER_LIMIT);
    // the OLDEST fall off, so the most recent corrections are the ones that survive
    expect(card.steers[card.steers.length - 1].text).toBe(`steer ${REVIEW_STEER_LIMIT + 3}`);
  });
});

describe('resolving', () => {
  it.each([
    ['approve', 'approved'],
    ['discard', 'discarded'],
    ['drop', 'dropped'],
  ] as const)('%s → %s, stamped with the channel that answered', (verdict, state) => {
    const card = makeCard();
    const next = resolveReviewCard(root, card, verdict, 'telegram', NOW);
    expect(next.state).toBe(state);
    expect(next.resolvedVia).toBe('telegram');
    expect(next.resolvedAt).toBe(NOW);
    // persisted, not just returned — the whole point of resolving BEFORE the
    // resuming child spawns is that a crash in that window cannot replay it
    expect(readReviewCard(reviewCardPath(root, 'eod-digest', card.id))?.state).toBe(state);
  });
});

describe('claiming — disk is the authority, not the caller copy', () => {
  it('a STALE in-memory card cannot be answered twice', () => {
    // The bug this exists for: the dashboard, the Telegram poller and the CLI
    // can each be holding the same card, all believing it is pending. Trusting
    // the in-memory copy means two taps both resume the session and the
    // approved work happens twice — the worst outcome this feature can produce.
    const card = makeCard();
    const first = claimReviewCard(root, card, 'approve', 'dashboard', NOW);
    expect(first.claimed).toBe(true);

    const second = claimReviewCard(root, card, 'approve', 'telegram', NOW);
    expect(second.claimed).toBe(false);
    if (!second.claimed) {
      expect(second.reason).toMatch(/already approved/);
      // the loser is told what actually became of it, not just "no"
      expect(second.card?.resolvedVia).toBe('dashboard');
    }
  });

  it('refuses when a concurrent claim holds the lock', () => {
    const card = makeCard();
    mkdirSync(reviewSlugDir(root, 'eod-digest'), { recursive: true });
    // simulate the other surface mid-claim
    writeFileSync(join(reviewSlugDir(root, 'eod-digest'), `${card.id}.claim`), '{"pid":1,"at":' + Date.now() + '}', 'utf-8');
    const r = claimReviewCard(root, card, 'approve', 'cli', NOW);
    expect(r.claimed).toBe(false);
    if (!r.claimed) expect(r.reason).toMatch(/right now/);
    // and the card is untouched
    expect(readReviewCard(reviewCardPath(root, 'eod-digest', card.id))?.state).toBe('pending');
  });

  it('releases the lock so the next legitimate claim can proceed', () => {
    const a = makeCard();
    claimReviewCard(root, a, 'discard', 'cli', NOW);
    const b = makeCard({ nowISO: '2026-08-04T10:00:00.000Z' });
    expect(claimReviewCard(root, b, 'approve', 'cli', NOW).claimed).toBe(true);
  });

  it('refuses a card that vanished from disk', () => {
    const card = makeCard();
    rmSync(reviewCardPath(root, 'eod-digest', card.id));
    const r = claimReviewCard(root, card, 'approve', 'cli', NOW);
    expect(r.claimed).toBe(false);
    if (!r.claimed) expect(r.reason).toMatch(/no longer exists/);
  });

  it('refreshReviewCard returns what disk says, not what the caller remembers', () => {
    const card = makeCard();
    recordSteer(root, card, { text: 'shorter', via: 'cli', newBody: 'rewritten' });
    expect(card.body).toBe("I am about to write today's digest covering 4 commits.");
    expect(refreshReviewCard(root, card)?.body).toBe('rewritten');
  });
});

describe('backfilling the session id', () => {
  it('fills a null session on the card the run proposed', () => {
    // A run does not know its own conversation id while it is running — the
    // value only exists in the JSON envelope the runner parses after exit.
    const card = makeCard({ sessionId: null });
    const updated = backfillCardSession(root, 'eod-digest', card.runFiredAt, 'sess-real');
    expect(updated).toHaveLength(1);
    expect(readReviewCard(reviewCardPath(root, 'eod-digest', card.id))?.sessionId).toBe('sess-real');
  });

  it('never REPOINTS a card that already names a session', () => {
    const card = makeCard({ sessionId: 'sess-original' });
    expect(backfillCardSession(root, 'eod-digest', card.runFiredAt, 'sess-other')).toEqual([]);
    expect(readReviewCard(reviewCardPath(root, 'eod-digest', card.id))?.sessionId).toBe('sess-original');
  });

  it('only touches cards from THAT fire', () => {
    const mine = makeCard({ sessionId: null, runFiredAt: '2026-08-03T18:00:00.000Z' });
    const other = makeCard({ sessionId: null, runFiredAt: '2026-08-02T18:00:00.000Z' });
    backfillCardSession(root, 'eod-digest', '2026-08-03T18:00:00.000Z', 'sess-new');
    expect(readReviewCard(reviewCardPath(root, 'eod-digest', mine.id))?.sessionId).toBe('sess-new');
    expect(readReviewCard(reviewCardPath(root, 'eod-digest', other.id))?.sessionId).toBeNull();
  });

  it('refuses an unsafe session id rather than writing a path into a card', () => {
    const card = makeCard({ sessionId: null });
    expect(backfillCardSession(root, 'eod-digest', card.runFiredAt, '../../etc/passwd')).toEqual([]);
    expect(backfillCardSession(root, 'eod-digest', card.runFiredAt, null)).toEqual([]);
    expect(readReviewCard(reviewCardPath(root, 'eod-digest', card.id))?.sessionId).toBeNull();
  });
});

describe('pruning answered cards', () => {
  it('keeps a bounded trail of answered cards and deletes their staged documents', () => {
    const staged: string[] = [];
    for (let i = 0; i < RESOLVED_CARD_KEEP + 5; i++) {
      const c = makeCard({
        kind: 'output',
        stagedBody: `doc ${i}`,
        nowISO: `2026-08-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`,
      });
      staged.push(c.stagedPath as string);
      resolveReviewCard(root, c, 'discard', 'cli', NOW);
    }
    // creating one more triggers the prune
    makeCard({ nowISO: '2026-09-01T10:00:00.000Z' });

    const answered = listReviewCards(root, 'eod-digest').filter((c) => c.state !== 'pending');
    expect(answered.length).toBeLessThanOrEqual(RESOLVED_CARD_KEEP);
    // the oldest staged documents went with their cards
    expect(existsSync(staged[0])).toBe(false);
    expect(existsSync(staged[staged.length - 1])).toBe(true);
  });

  it('NEVER prunes a pending card, however many there are', () => {
    // A card is the only record that an automation is waiting on you; deleting
    // one would silently unwedge the automation and lose the proposal.
    for (let i = 0; i < RESOLVED_CARD_KEEP + 5; i++) {
      makeCard({ nowISO: `2026-08-${String(i + 1).padStart(2, '0')}T10:00:00.000Z` });
    }
    const pending = listReviewCards(root, 'eod-digest').filter((c) => c.state === 'pending');
    expect(pending.length).toBe(RESOLVED_CARD_KEEP + 5);
  });
});

describe('channel refs', () => {
  it('records a handle so a steer edits the existing card instead of posting a second copy', () => {
    const card = makeCard();
    const next = setChannelRef(root, card, 'telegram', '4821');
    expect(next.channelRefs).toEqual({ telegram: '4821' });
    expect(readReviewCard(reviewCardPath(root, 'eod-digest', card.id))?.channelRefs.telegram).toBe('4821');
  });

  it('drops non-string refs on read rather than handing a channel garbage', () => {
    const card = makeCard();
    const p = reviewCardPath(root, 'eod-digest', card.id);
    writeFileSync(p, JSON.stringify({ ...card, channelRefs: { telegram: 42, dashboard: 'ok' } }), 'utf-8');
    expect(readReviewCard(p)?.channelRefs).toEqual({ dashboard: 'ok' });
  });
});
