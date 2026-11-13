/**
 * AC9 (plan-r10 2.4): the phone mirrors a member's LIVE Super chat exactly as it mirrors main's.
 * `phoneSuperOpen` knows every member record's session of the vault: a live, enabled, ready
 * member's session is mirrored; any other open of it (resume, spawn, reattach) is refused, like
 * main's; an off, unapproved or not-live member stays refused; another project's member is
 * refused before the decision; main's mirror is unchanged.
 *
 * Pure decisions plus the shape of the upgrade handler (agent-chat.ts). No HOME is touched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { opensSession, phoneSuperOpen, phoneSuperTarget, superDigestFor, type PhoneMemberSuper } from '../../src/lib/super/phone-mirror.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';

const MAIN = '11111111-2222-4333-8444-555555555555';
const ROTA = '99999999-8888-4777-8666-555555555555';
const MIRA = '66666666-5555-4444-8333-222222222222';

const member = (o: Partial<PhoneMemberSuper> = {}): PhoneMemberSuper => ({ slug: 'rota', session: ROTA, enabled: true, live: true, ready: () => true, ...o });
const ask = (o: Partial<Parameters<typeof phoneSuperOpen>[0]> = {}) => ({
  mode: 'basic', resumeId: '', sessionId: '', index: { session: MAIN, enabled: true }, liveSuper: true, members: [member()], ...o,
});

describe('a phone and a member\'s Super (plan-r10 2.4)', () => {
  it('mirrors a live, enabled, ready member Super, by pin or resume id, case-blind', () => {
    expect(phoneSuperOpen(ask({ sessionId: ROTA }))).toBe('mirror');
    expect(phoneSuperOpen(ask({ resumeId: ROTA }))).toBe('mirror');
    expect(phoneSuperOpen(ask({ resumeId: ROTA.toUpperCase() }))).toBe('mirror');
    expect(phoneSuperTarget(ask({ sessionId: ROTA }))).toEqual({ decision: 'mirror', slug: 'rota' });
    // Whatever the mode the phone asked for: a mirror, never a spawn of its own.
    expect(phoneSuperOpen(ask({ mode: 'super', sessionId: ROTA }))).toBe('mirror');
  });

  it('refuses a resume or spawn of the member\'s session when there is nothing live to mirror', () => {
    expect(phoneSuperOpen(ask({ resumeId: ROTA, members: [member({ live: false })] }))).toBe('refuse');
    expect(phoneSuperOpen(ask({ sessionId: ROTA, mode: 'super', members: [member({ live: false })] }))).toBe('refuse');
    expect(phoneSuperOpen(ask({ sessionId: ROTA, mode: 'develop', members: [member({ live: false })] }))).toBe('refuse');
  });

  it('refuses an off, unapproved or unreadable member, and an off record, even when live', () => {
    expect(phoneSuperOpen(ask({ sessionId: ROTA, members: [member({ enabled: false })] }))).toBe('refuse');
    expect(phoneSuperOpen(ask({ sessionId: ROTA, members: [member({ ready: () => false })] }))).toBe('refuse');
    expect(phoneSuperOpen(ask({ sessionId: ROTA, members: [member({ ready: () => { throw new Error('unreadable'); } })] }))).toBe('refuse');
  });

  it('asks the member\'s state only when its own session is named', () => {
    let asked = 0;
    const counted = member({ ready: () => { asked++; return true; } });
    expect(phoneSuperOpen(ask({ sessionId: 'some-other-chat', members: [counted] }))).toBe('pass');
    expect(phoneSuperOpen(ask({ sessionId: MAIN, members: [counted] }))).toBe('mirror');
    expect(asked).toBe(0);
    expect(phoneSuperOpen(ask({ sessionId: ROTA, members: [counted] }))).toBe('mirror');
    expect(asked).toBe(1);
  });

  it('a session of a member NOT in this vault\'s list is not mirrored here', () => {
    // MIRA is no member Super of this vault: nothing to mirror, and a super open is still refused.
    expect(phoneSuperTarget(ask({ sessionId: MIRA })).decision).toBe('pass');
    expect(phoneSuperOpen(ask({ sessionId: MIRA, mode: 'super' }))).toBe('refuse');
    // Two members: each its own session, never the other's.
    const both = [member(), member({ slug: 'mira', session: MIRA, live: false })];
    expect(phoneSuperTarget(ask({ sessionId: ROTA, members: both }))).toEqual({ decision: 'mirror', slug: 'rota' });
    expect(phoneSuperTarget(ask({ sessionId: MIRA, members: both }))).toEqual({ decision: 'refuse', slug: 'mira' });
  });

  it('main\'s mirror is unchanged, with or without members', () => {
    for (const members of [undefined, [member()]]) {
      expect(phoneSuperOpen(ask({ sessionId: MAIN, members }))).toBe('mirror');
      expect(phoneSuperOpen(ask({ resumeId: MAIN, liveSuper: false, members }))).toBe('refuse');
      expect(phoneSuperOpen(ask({ sessionId: MAIN, index: { session: MAIN, enabled: false }, members }))).toBe('refuse');
      expect(phoneSuperOpen(ask({ mode: 'super', members }))).toBe('refuse');
      expect(phoneSuperOpen(ask({ sessionId: 'plain-chat', members }))).toBe('pass');
      expect(phoneSuperTarget(ask({ sessionId: MAIN, members }))).toEqual({ decision: 'mirror' });
    }
    expect(opensSession({ resumeId: '', sessionId: '' }, null)).toBe(false);
    expect(opensSession({ resumeId: '', sessionId: '' }, '')).toBe(false);
  });
});

describe('the upgrade handler (agent-chat.ts)', () => {
  const src = readFileSync(new URL('../../src/server/routes/agent-chat.ts', import.meta.url), 'utf-8');
  const handler = src.slice(src.indexOf('export function attachAgentChat'), src.indexOf('export function chatOpenDecision'));

  it('refuses another project\'s member Super session before the decision', () => {
    const line = handler.indexOf("return !!ref && ref.superId !== 'main' && resolve(ref.root) !== resolve(superCtx); })) { rejectUpgrade(socket, 403); return; }");
    expect(line).toBeGreaterThan(0);
    expect(line).toBeLessThan(handler.indexOf('phoneSuperOpen('));
    // The old blanket refusal of every member session is gone (AC9: a live one is mirrored).
    expect(handler).not.toContain("return !!ref && ref.superId !== 'main'; })) { rejectUpgrade(socket, 403); return; }");
  });

  it('lists this vault\'s member Supers from the in-memory index, ready only when on and approved', () => {
    expect(handler).toMatch(/const memberSupers: PhoneMemberSuper\[\] = phone \? \[\.\.\.superIndex\(superCtx\)\]/);
    expect(handler).toContain("ready: () => memberCallState(superCtx, slug).state === 'ready'");
    expect(handler).toMatch(/phoneSuperOpen\(\{ mode, resumeId, sessionId, index: superIdx, liveSuper: !!mirrorable\(superIdx\.session\), members: memberSupers \}\)/);
    // Live means a mirror to join, in THIS project.
    expect(handler).toContain('return l?.mirror && l.projectRoot === projectRoot ? l : null;');
  });

  it('the mirror joins the NAMED super\'s live chat (main first), so his words are that chat\'s owner message', () => {
    const branch = handler.slice(handler.indexOf("if (phoneSuper === 'mirror') {"), handler.indexOf('const superRefused = superUpgradeRefusal('));
    expect(branch).toContain('const member = opensSession({ resumeId, sessionId }, superIdx.session) ? null : memberSupers.find((m) => opensSession({ resumeId, sessionId }, m.session));');
    expect(branch).toContain('const liveSuper = mirrorable(member ? member.session : superIdx.session);');
    expect(branch.indexOf('const liveSuper')).toBeLessThan(branch.indexOf('liveSuper.mirror?.('));
    // A mirror frame goes through the holder's own handler: the member Super's `superOwnerSpoke`
    // keyed by its session (origin owner), never a queue item.
    expect(src).toMatch(/const frame = Buffer\.from\(JSON\.stringify\(json\), 'utf-8'\);\s*mirrorFrames\.add\(frame\);/);
    expect(src).toMatch(/onWsMessage\(serverBuiltFrame\(json, 'phone-mirror'\)\);/);
    expect(src).toContain('if (isSuper && wrote && !text.startsWith(\'/\')) superOwnerSpoke(chatRegistryId, Date.now(), held?.items ?? [], abouts, midTurn);');
  });
});

describe('the phone names a waiting member by its title (uye-bildirim K8)', () => {
  const record = (queue: unknown[]): SuperState => ({ ...emptySuperState(), session: MAIN, enabled: true, queue } as unknown as SuperState);
  const readers = { member: (_root: string, slug: string) => (slug === 'rota' ? 'Rota, the planner' : null), routine: () => null };

  it('a member\'s mirror in main\'s digest carries the member\'s title next to its slug', () => {
    const d = superDigestFor('/ctx', record([
      { id: 'mx', sessionId: MAIN, kind: 'member', state: 'escalated', createdAt: 1, member: 'rota', of: 'question', answers: 'qa' },
    ]), readers);
    expect(d.waiting).toEqual([expect.objectContaining({ id: 'mx', member: 'rota', of: 'question', title: 'Rota, the planner' })]);
  });

  it('a member Super\'s own refusal, read in its own record, is an own row with its wait kind and no title', () => {
    const d = superDigestFor('/ctx', record([
      { id: 'ox', sessionId: MAIN, kind: 'owner', state: 'escalated', createdAt: 1, own: true, ownerText: 'Run node x.mjs', wait: { kind: 'refusal', id: 'rf-0123456789abcdef', key: 'Bash' } },
    ]), readers);
    expect(d.waiting[0]).toMatchObject({ id: 'ox', own: true, wait: 'refusal' });
    expect('title' in d.waiting[0]).toBe(false);
  });

  it('a member that is gone has no title: the phone names it by its slug', () => {
    const d = superDigestFor('/ctx', record([
      { id: 'my', sessionId: MAIN, kind: 'member', state: 'escalated', createdAt: 1, member: 'mira', of: 'ask', answers: 'qb' },
    ]), readers);
    expect(d.waiting[0]).toMatchObject({ member: 'mira' });
    expect('title' in d.waiting[0]).toBe(false);
  });
});
