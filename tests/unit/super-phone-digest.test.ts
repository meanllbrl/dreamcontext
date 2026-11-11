/**
 * The agenda digest a phone mirror is told (task hands-free-telefonda-super-agent-sohbeti-
 * ajandayi…, AC1-AC3): a whitelist of the record, capped, and a child's name is the Mac's job
 * card title, never its prompt.
 */
import { describe, it, expect } from 'vitest';
import {
  DIGEST_MAX_NAMES, DIGEST_MAX_PAD, DIGEST_MAX_PAD_TEXT, DIGEST_MAX_OWNER_TEXT, SUPER_DIGEST_FIELDS, superDigest, superDigestFor, superDigestFrame,
} from '../../src/lib/super/phone-mirror.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import { readSuperDigest } from '../../dashboard/src/lib/superTypes.js';

const PROMPT = 'Rebuild the paywall pricing card with the new annual plan and a trial toggle, then run the e2e suite and report every failing step in detail';

function state(over: Partial<SuperState> = {}): SuperState {
  return {
    ...emptySuperState(), session: 'super-1', enabled: true,
    children: {
      c1: { sessionId: 'c1', brief: '', adopted: false, startedAt: 1, worktree: '/Users/x/.claude-worktrees/secret', branch: 'super/secret', task: 'secret-task' },
      c2: { sessionId: 'c2', brief: 'Fix the login copy', adopted: false, startedAt: 2 },
    },
    containers: [{ id: 'chat-c1', kind: 'chat', ref: 'c1', shape: 'tall', place: 'float', title: PROMPT.slice(0, 60) }],
    queue: [
      { id: 'q1', sessionId: 'c1', kind: 'permission', state: 'pending', createdAt: 10, requestId: 'req-secret', ownerText: 'should never show' },
      { id: 'q2', sessionId: 'super-1', kind: 'ask', state: 'escalated', createdAt: 11, ownerText: 'Which design?', options: ['A', 'B'], ask: { questions: [] } as never, batch: 'b1' },
      { id: 'q3', sessionId: 'c2', kind: 'question', state: 'pending', createdAt: 12, requestId: 'req-2' },
      { id: 'q4', sessionId: 'c2', kind: 'done', state: 'pending', createdAt: 13 },
      { id: 'q5', sessionId: 'c2', kind: 'owner', state: 'escalated', createdAt: 14, ownerText: 'Run\u0007 <b>this</b>\ncommand' },
    ],
    ownerBatches: ['b1'],
    pad: [{ id: 'n1', section: 'now', text: 'Fixing the paywall', at: 5 }, { id: 'n2', section: 'done', text: 'Shipped login', at: 6 }],
    ...over,
  } as SuperState;
}

describe('superDigest', () => {
  it('carries only the contract fields, at every level', () => {
    const d = superDigest(state());
    expect(Object.keys(d).sort()).toEqual([...SUPER_DIGEST_FIELDS].sort());
    for (const w of d.waiting) expect(Object.keys(w).sort()).toEqual(['createdAt', 'id', 'kind', 'sessionId', 'state', 'text']);
    for (const p of d.pad) expect(Object.keys(p).sort()).toEqual(['at', 'id', 'section', 'text']);
    const wire = superDigestFrame(d);
    for (const leak of ['req-secret', 'req-2', 'should never show', 'options', '"ask":', 'requestId', 'claude-worktrees', 'super/secret', 'secret-task', PROMPT.slice(60)]) {
      expect(wire).not.toContain(leak);
    }
    expect(JSON.parse(wire)).toMatchObject({ type: '_meta', subtype: 'super_digest' });
  });

  it('waiting: what is open with the owner and the questions queued, never a done event; a permission has no text', () => {
    const d = superDigest(state());
    expect(d.waiting.map((w) => w.id)).toEqual(['q1', 'q2', 'q3', 'q5']);
    expect(d.waiting.find((w) => w.id === 'q1')!.text).toBe('');
    expect(d.waiting.find((w) => w.id === 'q2')!.text).toBe('Which design?');
    // An owner item's line is a child's card: one plain line, no control characters.
    expect(d.waiting.find((w) => w.id === 'q5')!.text).toBe('Run <b>this</b> command');
  });

  it('a name is the Mac card title, else the brief; a brief-less child with a long prompt shows at most its first 60 characters', () => {
    const d = superDigest(state());
    expect(d.names).toEqual({ c1: PROMPT.slice(0, 60), c2: 'Fix the login copy' });
    // No card and no brief: no name at all (never the chat registry's title).
    const bare = superDigest(state({ containers: [] }));
    expect(bare.names).toEqual({ c2: 'Fix the login copy' });
  });

  it('caps pad, names and every text', () => {
    const children: SuperState['children'] = {};
    for (let i = 0; i < 60; i++) children[`k${i}`] = { sessionId: `k${i}`, brief: 'b'.repeat(200), adopted: false, startedAt: i };
    const pad = Array.from({ length: 60 }, (_, i) => ({ id: `n${i + 1}`, section: 'now' as const, text: 'p'.repeat(300), at: i }));
    const d = superDigest(state({
      children, pad, containers: [],
      queue: [{ id: 'q9', sessionId: 'k1', kind: 'owner', state: 'escalated', createdAt: 1, ownerText: 'o'.repeat(900) }],
    }));
    expect(d.pad).toHaveLength(DIGEST_MAX_PAD);
    expect(d.pad[0].id).toBe('n21');
    expect(Math.max(...d.pad.map((p) => p.text.length))).toBe(DIGEST_MAX_PAD_TEXT);
    expect(Object.keys(d.names)).toHaveLength(DIGEST_MAX_NAMES);
    expect(d.names.k1).toBeDefined(); // the child the owner waits on is named first
    expect(Math.max(...Object.values(d.names).map((n) => n.length))).toBe(80);
    expect(d.waiting[0].text).toHaveLength(DIGEST_MAX_OWNER_TEXT);
  });

  it('the key moves with the digest, not with the rest of the record', () => {
    const a = superDigest(state());
    expect(superDigest(state({ away: { since: 99, events: 3 }, notes: {} })).key).toBe(a.key);
    expect(superDigest(state({ pad: [{ id: 'n1', section: 'done', text: 'Fixing the paywall', at: 7 }] })).key).not.toBe(a.key);
  });

  it('the phone reads back what the server wrote', () => {
    const d = superDigest(state());
    expect(readSuperDigest(JSON.parse(superDigestFrame(d)))).toEqual(d);
    expect(readSuperDigest({ pad: [] })).toBeNull();
  });
});

// ─── Who waits, by title (uye-bildirim K8: the phone names a member or a routine by its title) ───

describe('superDigest: member and routine rows by title, refusals told from sign-in cards', () => {
  const ROWS = [
    { id: 'm1', sessionId: 'super-1', kind: 'member', state: 'escalated', createdAt: 20, member: 'rota', of: 'ask', answers: 'a1', ownerText: 'Which plan?' },
    { id: 'm2', sessionId: 'super-1', kind: 'member', state: 'escalated', createdAt: 21, member: 'rota', of: 'owner', answers: 'a2', ownerText: 'Run node x.mjs', wait: { kind: 'refusal', id: 'rf-0123456789abcdef', key: 'Bash' } },
    { id: 'r1', sessionId: 'super-1', kind: 'routine', state: 'escalated', createdAt: 22, routine: 'daily-digest', fact: 'q:abc', ownerText: 'Daily digest asks a question' },
    { id: 'o1', sessionId: 'c2', kind: 'owner', state: 'escalated', createdAt: 23, ownerText: 'Sign in to gcloud', wait: { kind: 'run', id: 'gcloud-login' } },
    { id: 'o2', sessionId: 'super-1', kind: 'owner', state: 'escalated', createdAt: 24, ownerText: 'Run rm -rf build', own: true, wait: { kind: 'refusal', id: 'rf-fedcba9876543210', key: 'Bash' } },
    { id: 'p1', sessionId: 'super-1', kind: 'question', state: 'delivered', createdAt: 25, own: true, ownerText: 'Ship it?' },
    { id: 'n1', sessionId: 'super-1', kind: 'nudge', state: 'pending', createdAt: 26 },
  ];
  const titles = { members: { rota: 'Rota\nPlanner' }, routines: { 'daily-digest': 'Daily digest' } };
  const rowsState = () => state({ queue: ROWS as never });
  const row = (d: ReturnType<typeof superDigest>, id: string) => d.waiting.find((w) => w.id === id)!;

  it('a member mirror row carries the member\'s title, flattened', () => {
    const d = superDigest(rowsState(), { titles });
    expect(row(d, 'm1')).toMatchObject({ member: 'rota', of: 'ask', title: 'Rota Planner' });
  });

  it('a routine row carries its routine slug and title', () => {
    const d = superDigest(rowsState(), { titles });
    expect(row(d, 'r1')).toMatchObject({ kind: 'routine', routine: 'daily-digest', title: 'Daily digest' });
    // A routine row never names a member or a wait.
    expect(row(d, 'r1').member).toBeUndefined();
    expect(row(d, 'r1').wait).toBeUndefined();
  });

  it('an owner item row carries its wait kind (a refusal is not a sign-in card), a mirror of one too', () => {
    const d = superDigest(rowsState(), { titles });
    expect(row(d, 'o1').wait).toBe('run');
    expect(row(d, 'o2').wait).toBe('refusal');
    expect(row(d, 'm2')).toMatchObject({ of: 'owner', wait: 'refusal' });
    // Only the kind travels: never the refusal's id, key or input.
    expect(superDigestFrame(d)).not.toContain('rf-0123456789abcdef');
    // A wait on a mirror of anything but an owner item is not carried.
    const odd = superDigest(state({ queue: [{ ...ROWS[0], wait: { kind: 'refusal', id: 'x' } }] as never }));
    expect(odd.waiting[0].wait).toBeUndefined();
  });

  it('an own item carries own and waits on him from birth; a nudge never reaches the phone', () => {
    const d = superDigest(rowsState(), { titles });
    expect(row(d, 'o2').own).toBe(true);
    expect(row(d, 'p1')).toMatchObject({ own: true, text: 'Ship it?' });
    expect(d.waiting.map((w) => w.id)).not.toContain('n1');
    expect(row(d, 'o1').own).toBeUndefined();
  });

  it('a missing title is just absent, never the slug or an empty string', () => {
    const d = superDigest(rowsState());
    expect('title' in row(d, 'm1')).toBe(false);
    expect('title' in row(d, 'r1')).toBe(false);
    const blank = superDigest(rowsState(), { titles: { members: { rota: '   ' }, routines: {} } });
    expect('title' in row(blank, 'm1')).toBe(false);
  });

  it('caps a title', () => {
    const d = superDigest(rowsState(), { titles: { members: { rota: 't'.repeat(300) } } });
    expect(row(d, 'm1').title).toHaveLength(80);
  });

  it('the digest key changes when a title changes', () => {
    const a = superDigest(rowsState(), { titles });
    expect(superDigest(rowsState(), { titles }).key).toBe(a.key);
    expect(superDigest(rowsState(), { titles: { ...titles, members: { rota: 'Rota' } } }).key).not.toBe(a.key);
    expect(superDigest(rowsState(), { titles: { ...titles, routines: { 'daily-digest': 'Morning digest' } } }).key).not.toBe(a.key);
  });

  it('the phone reads the new fields back', () => {
    const d = superDigest(rowsState(), { titles });
    expect(readSuperDigest(JSON.parse(superDigestFrame(d)))).toEqual(d);
  });
});

describe('superDigestFor: titles read from this machine, never a throw', () => {
  const q = [
    { id: 'm1', sessionId: 'super-1', kind: 'member', state: 'escalated', createdAt: 20, member: 'rota', of: 'ask', answers: 'a1', ownerText: 'Which plan?' },
    { id: 'm2', sessionId: 'super-1', kind: 'member', state: 'escalated', createdAt: 21, member: 'rota', of: 'question', answers: 'a2', ownerText: 'Another' },
    { id: 'm3', sessionId: 'super-1', kind: 'member', state: 'escalated', createdAt: 22, member: 'gone', of: 'ask', answers: 'a3', ownerText: 'Left' },
    { id: 'm4', sessionId: 'super-1', kind: 'member', state: 'done', createdAt: 23, member: 'closed', of: 'ask', answers: 'a4' },
    { id: 'r1', sessionId: 'super-1', kind: 'routine', state: 'escalated', createdAt: 24, routine: 'daily-digest', fact: 'q:abc', ownerText: 'Daily digest' },
    { id: 'r2', sessionId: 'super-1', kind: 'routine', state: 'escalated', createdAt: 25, routine: 'broken', fact: 'q:def', ownerText: 'Broken' },
  ];

  it('reads each open slug once, through the readers it is given', () => {
    const asked: string[] = [];
    const d = superDigestFor('/ctx', state({ queue: q as never }), {
      member: (root, slug) => { asked.push(`m:${root}:${slug}`); return slug === 'rota' ? 'Rota Planner' : null; },
      routine: (root, slug) => { asked.push(`r:${root}:${slug}`); if (slug === 'broken') throw new Error('unreadable'); return 'Daily digest'; },
    });
    expect(asked).toEqual(['m:/ctx:rota', 'm:/ctx:gone', 'r:/ctx:daily-digest', 'r:/ctx:broken']);
    expect(d.waiting.find((w) => w.id === 'm1')!.title).toBe('Rota Planner');
    expect(d.waiting.find((w) => w.id === 'm2')!.title).toBe('Rota Planner');
    expect('title' in d.waiting.find((w) => w.id === 'm3')!).toBe(false);
    expect(d.waiting.find((w) => w.id === 'r1')!.title).toBe('Daily digest');
    expect('title' in d.waiting.find((w) => w.id === 'r2')!).toBe(false);
  });

  it('with the real stores, a context root holding no such member or routine names nothing and does not throw', () => {
    const d = superDigestFor('/nonexistent/acme/_dream_context', state({ queue: q as never }));
    for (const w of d.waiting) expect(w.title).toBeUndefined();
    expect(d.key).toBe(superDigest(state({ queue: q as never })).key);
  });
});
