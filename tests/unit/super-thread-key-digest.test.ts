/**
 * Which agenda rows press into a thread, and the phone decides it exactly as the desktop does
 * (task ajanda-gunluk, plan ajanda-filtre C5, criterion 9):
 *  - `rowActions` press 'thread' only for rows with a thread key; every other row keeps its press;
 *  - the key's `child` is unset for the Super's ask, an approval, an own item and a team question;
 *  - the same queue built as `SuperQueueItem`s and through `superDigest` → `readSuperDigest` →
 *    `digestToNotepadInput` gives identical key sources, keys and presses (no delivered card
 *    items, under the digest caps);
 *  - DRIFT: the digest's waiting rows carry every field of THREAD_KEY_FIELDS.
 * Fictional words throughout.
 */
import { describe, it, expect, vi } from 'vitest';
import { superDigest } from '../../src/lib/super/phone-mirror.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import { readSuperDigest, type SuperPadItem, type SuperQueueItem } from '../../dashboard/src/lib/superTypes.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({}), useVaultId: () => ({ vault: 'acme' }) }));

const H = await import('../../dashboard/src/components/sleepy/super/superHandover.js');
const G = await import('../../dashboard/src/components/sleepy/super/agendaGroups.js');
const { digestToNotepadInput } = await import('../../dashboard/src/components/sleepy/super/PhoneAgenda.js');

const SUPER = 'sup-1';
const C1 = 'child-orbit';
const C2 = 'child-atlas';
const NOW = new Date(2026, 10, 14, 15, 0).getTime();
const at = (h: number, m = 0) => new Date(2026, 10, 14, h, m).getTime();

const queue: SuperQueueItem[] = [
  { id: 'qChild', sessionId: C1, kind: 'question', state: 'escalated', createdAt: at(9), ownerText: 'Which inbox?' },
  { id: 'qQueued', sessionId: C2, kind: 'question', state: 'pending', createdAt: at(9, 5) },
  { id: 'qDirect', sessionId: C2, kind: 'question', state: 'pending', createdAt: at(9, 10), direct: true },
  { id: 'qAsk', sessionId: SUPER, kind: 'ask', state: 'escalated', createdAt: at(9, 15), ownerText: 'Ship it?' },
  { id: 'qTeam', sessionId: SUPER, kind: 'question', state: 'escalated', createdAt: at(9, 20), team: 'tj-1', ownerText: 'Which tone?' },
  { id: 'qCard', sessionId: C1, kind: 'owner', state: 'pending', createdAt: at(9, 25), ownerText: 'Run the login', wait: { kind: 'run', id: 'w0' } as never, card: { kind: 'run', id: 'r1' } as never },
  { id: 'qNoCard', sessionId: C1, kind: 'owner', state: 'pending', createdAt: at(9, 30), ownerText: 'Something' },
  { id: 'qRefusal', sessionId: C1, kind: 'owner', state: 'pending', createdAt: at(9, 35), wait: { kind: 'refusal', id: 'w1' } as never },
  { id: 'qRefusalCard', sessionId: C1, kind: 'owner', state: 'pending', createdAt: at(9, 36), wait: { kind: 'refusal', id: 'w2' } as never, card: { kind: 'run', id: 'r2' } as never },
  { id: 'qStalled', sessionId: SUPER, kind: 'owner', state: 'pending', createdAt: at(9, 40), wait: { kind: 'stalled', id: 'w3' } as never, own: true },
  { id: 'qStalledCard', sessionId: SUPER, kind: 'owner', state: 'pending', createdAt: at(9, 41), wait: { kind: 'stalled', id: 'w4' } as never, card: { kind: 'run', id: 'r3' } as never, own: true },
  { id: 'qOwn', sessionId: SUPER, kind: 'question', state: 'pending', createdAt: at(9, 45), own: true, ownerText: 'Own question' },
  { id: 'qPerm', sessionId: C1, kind: 'permission', state: 'pending', createdAt: at(9, 50) },
  { id: 'qMember', sessionId: SUPER, kind: 'member', state: 'pending', createdAt: at(9, 55), member: 'desk', of: 'question', ownerText: 'Desk asks' },
  { id: 'qRoutine', sessionId: SUPER, kind: 'routine', state: 'pending', createdAt: at(10), routine: 'daily' },
  { id: 'qApproval', sessionId: SUPER, kind: 'approval', state: 'escalated', createdAt: at(10, 5), member: 'desk' },
];
const pad: SuperPadItem[] = [
  { id: 'n1', section: 'now', text: 'Orbit inbox', at: at(10), bornAt: at(8), for: C1, refs: [{ ref: 'abc123', at: at(8) }] },
  { id: 'n2', section: 'done', text: 'Atlas shipped', at: at(11), bornAt: at(8), for: C2 },
  { id: 'n3', section: 'waiting', text: 'Waits on you', at: at(12), bornAt: at(8) },
];
const owed = [{ id: 'o1', kind: 'result' as const, ref: 'abc124', seq: 1, at: at(7), gist: 'Orbit result', nudges: 2, child: C1 }];
const look = { live: () => null, titleFor: (s: string) => `job ${s}`, nameFor: (s: string) => `job ${s}`, superTitle: 'Super' };
const state = { ...emptySuperState(), session: SUPER, queue, pad, owed } as unknown as SuperState;

function rowsBy(input: { queue: SuperQueueItem[]; pad?: SuperPadItem[]; owed?: typeof owed }, lk: typeof look) {
  const np = H.superNotepad({ queue: input.queue, pad: input.pad }, lk, NOW);
  const un = H.superUnanswered({ owed: input.owed } as never, NOW);
  const groups = G.todayGroups({ notepad: np, unanswered: un, pad: input.pad ?? [], now: NOW });
  return G.TODAY_GROUPS.flatMap((g) => groups[g]);
}

describe('rowActions: press thread exactly for rows with a key (criterion 9)', () => {
  const entries = rowsBy({ queue, pad, owed }, look);
  const by = (k: string) => entries.find((e) => e.key === k)!;
  const press = (k: string, ro = false) => G.rowActions(by(k), { readOnly: ro }).press;

  it('thread: live Now/Waiting lines, a Done line, owed, a child\'s question, the Super\'s ask, an owner card', () => {
    for (const k of ['n:n1', 'n:n3', 'n:n2', 'o:o1', 'q:qChild', 'q:qAsk', 'q:qCard', 'q:qTeam', 'q:qOwn']) {
      expect(press(k), k).toBe('thread');
      expect(press(k, true), `${k} phone`).toBe('thread');
    }
  });

  it('today\'s press: no card, direct, member, routine, permission, refusal and stalled (with and without a card), queued, approval', () => {
    for (const k of ['q:qNoCard', 'q:qDirect', 'q:qMember', 'q:qRoutine', 'q:qPerm', 'q:qRefusal', 'q:qRefusalCard', 'q:qStalled', 'q:qStalledCard', 'q:qQueued', 'q:qApproval']) {
      expect(by(k), k).toBeDefined();
      expect(by(k).row?.thread, k).toBeUndefined();
      expect(press(k), k).toBe('legacy');
    }
  });

  it('an archived line presses into its thread on both shells', () => {
    const day = G.dayGroups('2026-11-13', [], [{ id: 'n7', section: 'done', text: 'Old', at: at(10) - 86_400_000 }]);
    const e = day.dayDone[0];
    expect(G.rowActions(e).press).toBe('thread');
    expect(G.rowActions(e, { readOnly: true }).press).toBe('thread');
    expect(e.row?.thread).toMatchObject({ note: 'n7' });
  });

  it('the key\'s child: unset for the Super\'s ask, an own item and a team question; the job for a child\'s question and an owner card', () => {
    expect(by('q:qAsk').row?.thread?.child).toBeUndefined();
    expect(by('q:qOwn').row?.thread?.child).toBeUndefined();
    expect(by('q:qTeam').row?.thread?.child).toBeUndefined();
    expect(by('q:qChild').row?.thread).toMatchObject({ item: 'qChild', child: C1, refs: [{ ref: 'abc123', at: at(8) }] });
    expect(by('q:qCard').row?.thread).toMatchObject({ item: 'qCard', child: C1 });
    expect(by('o:o1').row?.thread).toMatchObject({ owed: 'o1', child: C1, refs: [{ ref: 'abc124', at: at(7) }] });
    expect(by('n:n1').row?.thread).toMatchObject({ note: 'n1', child: C1 });
  });
});

describe('the phone decides it as the desktop does (criterion 9)', () => {
  const wire = readSuperDigest(JSON.parse(JSON.stringify(superDigest(state))))!;
  const phone = digestToNotepadInput(wire, 'Super');

  it('every queue item gives the same key source', () => {
    for (const q of queue) {
      const p = phone.state.queue.find((x) => x.id === q.id);
      expect(p, q.id).toBeDefined();
      expect(H.threadKeySourceOf(p!), q.id).toEqual(H.threadKeySourceOf(q));
    }
  });

  it('the same rows, keys and presses', () => {
    const desk = rowsBy({ queue, pad, owed }, look);
    const tel = rowsBy({ queue: phone.state.queue, pad: phone.state.pad, owed: phone.state.owed as never }, { ...look, ...phone.look, superTitle: 'Super' });
    const view = (es: typeof desk, ro: boolean) => es.map((e) => ({ key: e.key, thread: e.row?.thread ? { ...e.row.thread, label: undefined } : null, press: G.rowActions(e, { readOnly: ro }).press }));
    expect(view(tel, true)).toEqual(view(desk, true));
  });

  it('DRIFT: the digest\'s waiting rows carry every THREAD_KEY_FIELDS field', () => {
    const fieldOf: Record<string, string> = { id: 'id', kind: 'kind', team: 'team', routine: 'routine', member: 'member', direct: 'direct', hasCard: 'hasCard', wait: 'wait' };
    const seen = new Set(wire.waiting.flatMap((w) => Object.keys(w)));
    for (const f of H.THREAD_KEY_FIELDS) expect(seen.has(fieldOf[f]), f).toBe(true);
    expect(Object.keys(fieldOf).sort()).toEqual([...H.THREAD_KEY_FIELDS].sort());
  });
});
