/**
 * A member stage's own cards (plan r4 K1-K7, G1, G3, G5): Rutinler, Talimatlar, Üye are real
 * stage cards of one kind `member`:
 *  - seeded by every write of a member record (an off member's too), at their defaults; never on
 *    main's record (the store drops them there);
 *  - no agent verb moves, resizes, groups, ungroups, halves or closes one (403 pinned_card), and
 *    `super open member` is refused; a group close skips them; the owner's close is ignored;
 *  - a missing one comes back at its default; the owner's size and place are kept by later writes;
 *  - counted in the record's cap but never retired; the Others sweep never closes one;
 *  - the phone mirror carries its sub-type.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { readSuperState, resetSuperIndex, superRecordPath, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { _resetSuperInbox, containerIdFor, ensureMemberAgenda, ensureMemberCards, writeSuper } from '../../src/lib/super/inbox.js';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { AGENDA_REF, MAX_CONTAINERS, emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import { retirable } from '../../src/lib/super/room.js';
import { SUPER_OWNER_HANDLERS, SUPER_VERB_HANDLERS, type SuperCaller } from '../../src/server/routes/super.js';

let dir: string;
let root: string;
const M = 'm:rota' as const;
const R = containerIdFor('member', 'routines');
const I = containerIdFor('member', 'instructions');
const U = containerIdFor('member', 'settings');
const A = containerIdFor('agenda', AGENDA_REF);
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}

function makeMember(extra: Partial<SuperState> = {}): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sess-main', enabled: true }));
  writeFileSync(superRecordPath(root, M), JSON.stringify({ ...emptySuperState(), session: 'sess-rota', enabled: true, member: 'rota', ...extra }));
}

async function verb(name: keyof typeof SUPER_VERB_HANDLERS, body: Record<string, unknown>) {
  const r = res();
  const caller = { token: 't', who: { contextRoot: root }, superId: M, state: await readSuperState(root, M) } as unknown as SuperCaller;
  await SUPER_VERB_HANDLERS[name](caller, body, r);
  return r;
}

async function layout(body: Record<string, unknown>) {
  const r = res();
  await SUPER_OWNER_HANDLERS.layout({} as never, r, root, body, M);
  return r;
}

const memberCards = (s: SuperState) => s.containers.filter((c) => c.kind === 'member');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-member-cards-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state', '.super', 'members'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  _resetSuperInbox();
  resetSuperIndex();
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(dir, { recursive: true, force: true });
});

describe('a member stage\'s own cards', () => {
  it('are seeded on a member record at their defaults, an off member\'s too, and never on main\'s', async () => {
    makeMember({ enabled: false });
    const s = await writeSuper(root, M, () => {});
    expect(memberCards(s).map((c) => [c.id, c.ref, c.size ?? 'small', c.place])).toEqual([
      [R, 'routines', 'large', 'float'], [I, 'instructions', 'small', 'float'], [U, 'settings', 'small', 'others'],
    ]);
    const main = await writeSuper(root, () => {});
    expect(memberCards(main)).toEqual([]);
    // A hand-written one on main's record is dropped by the store.
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sess-main', enabled: true, containers: [{ id: R, kind: 'member', ref: 'routines', shape: 'square', place: 'float' }] }));
    resetSuperIndex();
    expect(memberCards(await readSuperState(root))).toEqual([]);
    // An unknown sub-type is dropped on a member record.
    makeMember({ containers: [{ id: 'member-x', kind: 'member', ref: 'secrets', shape: 'square', place: 'float' }] as SuperState['containers'] });
    resetSuperIndex();
    expect(memberCards(await readSuperState(root, M))).toEqual([]);
  });

  it('no agent verb moves, resizes, groups, ungroups, halves or closes one; open is refused', async () => {
    makeMember();
    await writeSuper(root, M, () => {});
    const cases: Array<[keyof typeof SUPER_VERB_HANDLERS, Record<string, unknown>]> = [
      ['shape', { container: R, shape: 'wide' }],
      ['float', { container: U }],
      ['stack', { container: R }],
      ['half', { container: R }],
      ['close', { container: I }],
      ['group', { containers: [R, I] }],
      ['ungroup', { targets: [R] }],
    ];
    for (const [name, body] of cases) {
      const r = await verb(name, body);
      expect([name, r.status, r.json.error]).toEqual([name, 403, 'pinned_card']);
    }
    const open = await verb('open', { kind: 'member', ref: 'routines' });
    expect(open.status).toBe(400);
    const s = await readSuperState(root, M);
    expect(memberCards(s).map((c) => [c.id, c.size ?? 'small', c.place])).toEqual([[R, 'large', 'float'], [I, 'small', 'float'], [U, 'small', 'others']]);
  });

  it('a group close skips them; the owner\'s close is ignored; a missing one comes back at its default', async () => {
    makeMember();
    await writeSuper(root, M, () => {});
    // The owner groups two of them.
    expect((await layout({ group: { id: 'grp-mine', cards: [R, I] } })).status).toBe(200);
    const closeAll = await verb('close', { allGroups: true });
    const out = closeAll.json.result as { closed: string[]; skipped: string[] };
    expect(out.closed).toEqual([]);
    expect(out.skipped).toEqual(expect.arrayContaining([R, I]));
    // The owner's own close is ignored for them.
    await layout({ closed: [U] });
    expect(memberCards(await readSuperState(root, M))).toHaveLength(3);
    // Gone by a hand edit: back at its default with the next write.
    await writeSuper(root, M, (s) => { s.containers = s.containers.filter((c) => c.id !== I); });
    const back = (await readSuperState(root, M)).containers.find((c) => c.id === I);
    expect(back).toMatchObject({ kind: 'member', ref: 'instructions', place: 'float' });
  });

  it('the owner\'s size and place are kept by every later write', async () => {
    makeMember();
    await writeSuper(root, M, () => {});
    await layout({ cards: [{ id: R, size: 'small', pos: { x: 0.5, y: 0.25 } }, { id: U, place: 'float' }] });
    await writeSuper(root, M, () => {});
    resetSuperIndex();
    const s = await readSuperState(root, M);
    const r = s.containers.find((c) => c.id === R)!;
    expect(r.size ?? 'small').toBe('small');
    expect(r.pos).toEqual({ x: 0.5, y: 0.25 });
    expect(s.containers.find((c) => c.id === U)!.place).toBe('float');
  });

  it('count in the cap but are never retired; ensure makes room for a missing one', async () => {
    const s = { ...emptySuperState(), session: 'x', enabled: true } as SuperState;
    ensureMemberCards(s, M);
    for (const c of memberCards(s)) expect(retirable(s, { ...c, place: 'others' }, () => false)).toBe(false);
    // A full record of retirable cards: the missing member card still comes back.
    const full = { ...emptySuperState(), session: 'x', enabled: true } as SuperState;
    full.containers = Array.from({ length: MAX_CONTAINERS }, (_, i) => ({ id: `insight-${i}`, kind: 'insight' as const, ref: `i${i}`, shape: 'square' as const, place: 'others' as const }));
    expect(ensureMemberCards(full, M)).toHaveLength(3);
    expect(full.containers.length).toBeLessThanOrEqual(MAX_CONTAINERS);
    expect(ensureMemberCards({ ...emptySuperState() } as SuperState, 'main')).toEqual([]);
  });
});

// The member's own agenda (plan-r10 AC1, AC18): a member record has no hand-over and the window never
// re-reads it, so every write keeps one agenda card on it; main's record is never touched here.
describe('a member stage\'s own agenda', () => {
  const agendas = (s: SuperState) => s.containers.filter((c) => c.kind === 'agenda');

  it('is on every member record from its first write, first, floating, large; main\'s is untouched', async () => {
    makeMember();
    const s = await writeSuper(root, M, () => {});
    expect(agendas(s)).toHaveLength(1);
    expect(s.containers[0]).toMatchObject({ id: A, kind: 'agenda', ref: AGENDA_REF, place: 'float', size: 'large' });
    expect(s.containers[0].min).toBeUndefined();
    // Main's record, written after it, gets no agenda from this rule (its own comes with the hand-over).
    const main = await writeSuper(root, () => {});
    expect(agendas(main)).toEqual([]);
    expect(ensureMemberAgenda({ ...emptySuperState(), enabled: true } as SuperState, 'main')).toBeNull();
  });

  it('a record born before this (no agenda) gets one on its next write', async () => {
    makeMember({ containers: [{ id: R, kind: 'member', ref: 'routines', shape: 'square', size: 'large', place: 'float' }] as SuperState['containers'] });
    resetSuperIndex();
    expect(agendas(await readSuperState(root, M))).toEqual([]);
    expect(agendas(await writeSuper(root, M, () => {}))).toHaveLength(1);
  });

  it('the owner\'s minimise, move to Others, size and drop stand across later writes', async () => {
    makeMember();
    await writeSuper(root, M, () => {});
    expect((await layout({ agenda: 'min' })).status).toBe(200);
    await writeSuper(root, M, () => {});
    let s = await readSuperState(root, M);
    expect(agendas(s)).toHaveLength(1);
    expect(agendas(s)[0].min).toBe(true);
    await layout({ agenda: 'open' });
    await layout({ cards: [{ id: A, size: 'medium', pos: { x: 0.2, y: 0.3 } }] });
    await writeSuper(root, M, () => {});
    s = await readSuperState(root, M);
    expect(agendas(s)[0]).toMatchObject({ size: 'medium', sizeBy: 'owner', pos: { x: 0.2, y: 0.3 } });
    await layout({ cards: [{ id: A, place: 'others' }] });
    await writeSuper(root, M, () => {});
    expect(agendas(await readSuperState(root, M))[0].place).toBe('others');
  });

  it('the member\'s `super note` lands in its own record, never in main\'s', async () => {
    makeMember();
    await writeSuper(root, M, () => {});
    const r = await verb('note-add', { section: 'now', text: 'Kampanya taslağını yazıyorum' });
    expect(r.status).toBe(200);
    expect((await readSuperState(root, M)).pad?.map((p) => p.text)).toEqual(['Kampanya taslağını yazıyorum']);
    expect((await readSuperState(root)).pad ?? []).toEqual([]);
  });

  it('a full record makes room for it', () => {
    const full = { ...emptySuperState(), session: 'x', enabled: true } as SuperState;
    full.containers = Array.from({ length: MAX_CONTAINERS }, (_, i) => ({ id: `insight-${i}`, kind: 'insight' as const, ref: `i${i}`, shape: 'square' as const, place: 'others' as const }));
    expect(ensureMemberAgenda(full, M)).toBe(A);
    expect(full.containers.length).toBeLessThanOrEqual(MAX_CONTAINERS);
    expect(agendas(full)).toHaveLength(1);
  });
});
