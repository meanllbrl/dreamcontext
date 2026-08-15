/**
 * Unit tests for rollupProject — the project-level counterpart to rollupKind. A background
 * project's chip in the tab strip needs three things at once: what colour to draw (worst-of
 * urgency), what number to badge (how many chats are actually live), and whether to bounce
 * (anything waiting on the user). Each is a distinct rule with its own failure mode, so each
 * gets its own coverage rather than one blended assertion.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  deriveSessionStatus, rollupProject, KIND_RANK, BUCKET_BY_KIND, wantsALook,
  type SessionRow, type SessionStatusKind,
} from '../../dashboard/src/components/sleepy/agentStatus.js';

/** Minimal row factory — mirrors tests/unit/agent-status.test.ts's `row()` plus an
 *  `attention` override, since rollupProject's `waiting` count reads that field too. */
function row(
  id: string,
  kind: SessionStatusKind,
  opts: { sessionKind?: SessionRow['kind']; attention?: boolean } = {},
): SessionRow {
  const infoByKind: Record<SessionStatusKind, () => SessionRow['info']> = {
    saved: () => deriveSessionStatus({ dormant: true }),
    starting: () => deriveSessionStatus({ status: 'connecting' }),
    working: () => deriveSessionStatus({ status: 'open', busy: true }),
    asking: () => deriveSessionStatus({ status: 'open', asking: true }),
    ready: () => deriveSessionStatus({ status: 'open' }),
    ended: () => deriveSessionStatus({ status: 'closed' }),
  };
  return {
    id,
    title: id,
    kind: opts.sessionKind ?? 'agent',
    info: infoByKind[kind](),
    attention: opts.attention ?? false,
  };
}

describe('rollupProject', () => {
  it('worst is the KIND_RANK worst-of, same as rollupKind — asking beats working beats ready', () => {
    expect(rollupProject([row('a', 'ready'), row('b', 'working')]).worst).toBe('working');
    expect(rollupProject([row('a', 'working'), row('b', 'asking'), row('c', 'ended')]).worst).toBe('asking');
    // Cross-check directly against KIND_RANK so this doesn't silently drift from the
    // urgency order rollupKind is defined by.
    const rows = [row('a', 'saved'), row('b', 'ready'), row('c', 'starting')];
    const expectedWorst = rows.reduce<SessionStatusKind>(
      (worst, r) => (KIND_RANK[r.info.kind] > KIND_RANK[worst] ? r.info.kind : worst),
      'ended',
    );
    expect(rollupProject(rows).worst).toBe(expectedWorst);
  });

  it('excludes saved rows from live', () => {
    const r = rollupProject([row('a', 'saved'), row('b', 'working')]);
    expect(r.live).toBe(1);
  });

  it('excludes ended rows from live', () => {
    const r = rollupProject([row('a', 'ended'), row('b', 'asking')]);
    expect(r.live).toBe(1);
  });

  it('excludes shell rows from live even when the session is otherwise open/ready', () => {
    const r = rollupProject([
      row('a', 'ready', { sessionKind: 'shell' }),
      row('b', 'working', { sessionKind: 'shell' }),
      row('c', 'ready'),
    ]);
    expect(r.live).toBe(1);
  });

  it('REGRESSION LOCK — a project whose only row is a live shell reports live:0 (badge quiet) but alive:1 (must not be evicted)', () => {
    const r = rollupProject([row('a', 'ready', { sessionKind: 'shell' })]);
    expect(r.live).toBe(0);
    expect(r.alive).toBe(1);
  });

  it('excludes saved and ended rows from alive too', () => {
    const r = rollupProject([row('a', 'saved'), row('b', 'ended'), row('c', 'ready')]);
    expect(r.alive).toBe(1);
  });

  it('a mixed project (one live chat + one live shell) reports live:1, alive:2', () => {
    const r = rollupProject([row('a', 'working'), row('b', 'ready', { sessionKind: 'shell' })]);
    expect(r.live).toBe(1);
    expect(r.alive).toBe(2);
  });

  it('a row that is both asking and attention-flagged counts once in waiting', () => {
    const r = rollupProject([row('a', 'asking', { attention: true })]);
    expect(r.waiting).toBe(1);
  });

  it('attention alone (without asking) still counts toward waiting', () => {
    const r = rollupProject([row('a', 'ready', { attention: true })]);
    expect(r.waiting).toBe(1);
  });

  it('empty input reads as all-zero with worst "ended", matching rollupKind', () => {
    expect(rollupProject([])).toEqual({
      worst: 'ended', live: 0, waiting: 0, alive: 0, asking: 0, working: 0, idle: 0, flagged: 0,
    });
  });

  it('a project of only dormant (saved) rows has live: 0 and alive: 0 — no badge, safely evictable', () => {
    const r = rollupProject([row('a', 'saved'), row('b', 'saved')]);
    expect(r.live).toBe(0);
    expect(r.alive).toBe(0);
    expect(r.worst).toBe('saved');
  });
});

/*
 * The chip's three status bubbles. These counts replaced a single dot-plus-badge that could
 * only say HOW MANY chats a project held — never how many were working, how many were blocked
 * on an answer, or that anything was loading. Each rule below is one of those questions, and
 * the partition invariant at the end is what keeps the three of them honest together.
 */
describe('rollupProject — status bubble counts', () => {
  it('splits live rows across the three buckets', () => {
    const r = rollupProject([
      row('a', 'asking'), row('b', 'working'), row('c', 'working'), row('d', 'ready'),
    ]);
    expect(r).toMatchObject({ asking: 1, working: 2, idle: 1 });
  });

  it('starting folds into working — a session attaching its PTY is a session doing something', () => {
    const r = rollupProject([row('a', 'starting'), row('b', 'working')]);
    expect(r.working).toBe(2);
    expect(r.idle).toBe(0);
  });

  /*
   * ── The bug these two used to lock IN ────────────────────────────────────────────────
   *
   * They previously asserted that `attention` moved a row into the `asking` bucket, on the
   * reading that a chat which rang its bell "wants you". It does — but `attention` is STICKY
   * until the user actually looks at that session, while the bucket is what paints the chip's
   * colour from one second to the next. So a chat that finished a turn unseen went magenta and
   * STAYED magenta: through the next prompt, through the whole next turn, until it was clicked.
   * The user's report was exactly that shape — "the ones that aren't asking anything but are
   * working show pink, and it doesn't update when they start working" — with the dock tile
   * three inches below simultaneously, correctly, reading WORKING.
   *
   * The fix is that `attention` no longer votes on the bucket at all: it is counted beside it,
   * in `flagged`, which is the same predicate (`wantsALook`) the dock tile draws its badge dot
   * from. The two assertions below are the inverted form of the two that used to be here.
   */
  it('attention does NOT move an idle row into asking — it stays idle and raises `flagged`', () => {
    const r = rollupProject([row('a', 'ready', { attention: true })]);
    expect(r).toMatchObject({ asking: 0, working: 0, idle: 1, flagged: 1 });
  });

  it('REGRESSION LOCK — a WORKING row that rang its bell counts as WORKING, with the dot beside it', () => {
    // The reported bug, in one row: this chat is mid-turn. The chip must say so (green bubble,
    // which is what carries the loading ring) and must not claim it is blocked on the user.
    const r = rollupProject([row('a', 'working', { attention: true })]);
    expect(r).toMatchObject({ asking: 0, working: 1, idle: 0, flagged: 1 });
    expect(r.live).toBe(1);
  });

  it('REGRESSION LOCK — the full ready→working transition of an unseen chat moves the bubble', () => {
    // The second half of the report ("it doesn't update once it starts working"). The flag is
    // sticky across the transition ON PURPOSE — nothing has been seen yet — so the ONLY thing
    // that may hold still here is `flagged`. Asserted as a real before/after, because the old
    // behaviour's signature was two identical rollups.
    const before = rollupProject([row('a', 'ready', { attention: true })]);
    const after = rollupProject([row('a', 'working', { attention: true })]);
    expect(before).toMatchObject({ idle: 1, working: 0 });
    expect(after).toMatchObject({ idle: 0, working: 1 });
    expect(after.flagged).toBe(before.flagged);
    expect(after.worst).toBe('working');
  });

  it('an ASKING row raises no dot — one interruption is drawn once', () => {
    // `wantsALook` excludes asking, so the magenta bubble and the magenta dot can never both
    // fire for the same session. `waiting` still counts it: the chip must still bounce.
    const r = rollupProject([row('a', 'asking', { attention: true })]);
    expect(r).toMatchObject({ asking: 1, flagged: 0, waiting: 1 });
  });

  it('a flagged SHELL raises no dot — the dot counts chats, like every other bubble', () => {
    const r = rollupProject([row('a', 'ready', { sessionKind: 'shell', attention: true })]);
    expect(r).toMatchObject({ flagged: 0, live: 0, waiting: 1 });
  });

  it('saved and ended rows are counted in NO bucket — they are not chats you have', () => {
    const r = rollupProject([row('a', 'saved'), row('b', 'ended'), row('c', 'ready')]);
    expect(r).toMatchObject({ asking: 0, working: 0, idle: 1 });
  });

  it('shells are excluded from every bucket, so a lone dev-server terminal draws no bubble', () => {
    const r = rollupProject([
      row('a', 'working', { sessionKind: 'shell' }),
      row('b', 'ready', { sessionKind: 'shell' }),
    ]);
    expect(r).toMatchObject({ asking: 0, working: 0, idle: 0, live: 0 });
    expect(r.alive).toBe(2); // still holds real PTYs — the ceiling must not evict it
  });

  it('REGRESSION LOCK — a shell ringing its bell moves `waiting` (the bounce) but no bubble', () => {
    // `waiting` and `asking` look redundant and are not: waiting counts every kind so the
    // chip still jumps for a finished build, while the bubbles stay a chat-only partition of
    // `live`. Collapsing the two would either stop the bounce or break the invariant below.
    const r = rollupProject([row('a', 'ready', { sessionKind: 'shell', attention: true })]);
    expect(r.waiting).toBe(1);
    expect(r.asking).toBe(0);
  });

  it('INVARIANT — asking + working + idle === live, across every mix', () => {
    const mixes: SessionRow[][] = [
      [],
      [row('a', 'ready')],
      [row('a', 'asking'), row('b', 'working'), row('c', 'starting'), row('d', 'ready')],
      [row('a', 'saved'), row('b', 'ended'), row('c', 'ready', { attention: true })],
      [row('a', 'working', { sessionKind: 'shell' }), row('b', 'asking'), row('c', 'ready')],
      [row('a', 'asking', { attention: true }), row('b', 'working', { attention: true })],
    ];
    for (const rows of mixes) {
      const r = rollupProject(rows);
      expect(r.asking + r.working + r.idle).toBe(r.live);
      // The dot is NOT a fourth member of the partition — it overlaps them. What bounds it is
      // that it can only ever mark chats the partition already counted.
      expect(r.flagged).toBeLessThanOrEqual(r.live);
    }
  });
});

/*
 * ── The atomic layer ────────────────────────────────────────────────────────────────────
 *
 * `rollupProject` used to answer "does this row hold a session?" and "which bubble is it?" in
 * two separately-written places, and the second one drifted from the first. Both now come from
 * one table, and the "have you seen this?" flag from one predicate shared with the dock. These
 * tests are about those two pieces rather than about any one rollup result.
 */
describe('BUCKET_BY_KIND — the one status → bubble table', () => {
  it('maps every SessionStatusKind, including the two that hold no session', () => {
    // Read off KIND_RANK rather than re-listing the union by hand: that record is the other
    // exhaustive-by-construction map of the same type, so a seventh kind lands here as a
    // failure instead of as a row that silently stops being counted.
    for (const kind of Object.keys(KIND_RANK) as SessionStatusKind[]) {
      expect(BUCKET_BY_KIND, `kind "${kind}" has no bucket entry`).toHaveProperty(kind);
    }
    expect(BUCKET_BY_KIND).toEqual({
      asking: 'asking', working: 'working', starting: 'working',
      ready: 'idle', saved: null, ended: null,
    });
  });

  it('the `null` entries are exactly the kinds excluded from live/alive', () => {
    // `alive` is the ceiling rule's input, and the table is now what decides it — so the two
    // must agree by construction, not by two hand-written kind lists.
    for (const kind of Object.keys(KIND_RANK) as SessionStatusKind[]) {
      const r = rollupProject([row('a', kind)]);
      expect(r.alive, `alive for kind "${kind}"`).toBe(BUCKET_BY_KIND[kind] === null ? 0 : 1);
    }
  });
});

describe('wantsALook — the unseen flag, shared by the dock tile and the chip dot', () => {
  it('is true only for an unseen row that is not already asking', () => {
    expect(wantsALook(row('a', 'ready', { attention: true }))).toBe(true);
    expect(wantsALook(row('a', 'working', { attention: true }))).toBe(true);
    expect(wantsALook(row('a', 'asking', { attention: true }))).toBe(false);
    expect(wantsALook(row('a', 'working'))).toBe(false);
  });

  it('PARITY — AgentDock draws its badge from this exact call, not its own copy of the rule', () => {
    // No jsdom in this suite (see automations-card-status-parity.test.ts for the same
    // constraint), so the honest check is a source scan: the tile's badge and the chip's
    // `flagged` count must go through one function. The inline `row.attention && kind !==
    // 'asking'` this replaced is precisely the duplicate that drifted from the rollup.
    const dock = readFileSync(
      fileURLToPath(new URL('../../dashboard/src/components/sleepy/AgentDock.tsx', import.meta.url)),
      'utf8',
    );
    expect(dock).toMatch(/\{wantsALook\(row\)\s*&&\s*<span className="agent-dock-chip-badge"/);
    expect(dock).toMatch(/import \{[^}]*wantsALook[^}]*\} from '\.\/agentStatus'/);
    // And no hand-rolled second copy of the predicate anywhere in the file.
    expect(dock).not.toMatch(/attention\s*&&\s*row\.info\.kind\s*!==\s*'asking'/);
  });
});
