/**
 * The remote Super stage on the client (hands-free sekmeler W2, AC9/AC10/AC13/AC19):
 *
 *  - the server's allowlisted view becomes the stage's own state (`remoteStageState`): a card the
 *    remote cannot show keeps no address, waiting rows become the queue the agenda reads;
 *  - a stage gesture is filtered to what the remote door takes (`remoteLayoutPatch`), and EVERY
 *    filtered patch passes the server's allowlist (`checkRemoteLayout`): the two cannot drift;
 *  - a touch remote's narrow line: a 1024×768 landscape tablet (968 px stage, rail folded) floats
 *    its cards like the Mac, where the Mac's own 1040 line would put them all in Others.
 */
import { describe, it, expect } from 'vitest';
import { remoteLayoutPatch, remoteStageState } from '../../dashboard/src/components/sleepy/super/remoteStage.js';
import { NARROW_STAGE_PX, TOUCH_REMOTE_CENTRE_MIN, TOUCH_REMOTE_NARROW_STAGE_PX, planStage, stageItems } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import type { LayoutPatch } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import { checkRemoteLayout } from '../../src/server/routes/super-remote.js';
import type { SuperRemoteView } from '../../dashboard/src/components/handsfree/macContract.js';

const VIEW: SuperRemoteView = {
  vault: 'acme', session: 'sess-1', enabled: true,
  containers: [
    { id: 'chat-a', kind: 'chat', ref: 'kid-a', shape: 'tall', place: 'float', title: 'Fix login' },
    { id: 'web-lo', kind: 'web', shape: 'square', place: 'float', title: 'Dev server', blocked: 'mac_only' },
    { id: 'browser-1', kind: 'browser', shape: 'square', place: 'float', blocked: 'mac_only' },
    { id: 'img-1', kind: 'image', ref: 'docs/a.png', shape: 'square', place: 'others' },
    { id: 'task-1', kind: 'task', ref: 'my-task', shape: 'square', place: 'float' },
  ],
  groups: [],
  view: { mode: 'float' },
  children: { 'kid-a': { sessionId: 'kid-a', row: 'working', startedAt: 5 } },
  pad: [{ id: 'n1', section: 'now', text: 'Ship it', at: 1 }],
  waiting: [{ id: 'q-1', kind: 'question', state: 'escalated', createdAt: 3, sessionId: 'kid-a', text: 'Which port?' }],
  ownerBatches: [],
  names: { 'kid-a': 'Fix login' },
  head: { item: 'q-1', kind: 'question', text: 'Which port?' },
};

describe('remoteStageState', () => {
  it('draws the stage from the view: blocked cards keep no address, waiting rows are the queue, no brief', () => {
    const st = remoteStageState(VIEW);
    expect(st).not.toBeNull();
    expect(st!.enabled).toBe(true);
    expect(st!.containers.map((c) => [c.id, c.ref])).toEqual([['chat-a', 'kid-a'], ['web-lo', ''], ['browser-1', ''], ['img-1', 'docs/a.png'], ['task-1', 'my-task']]);
    expect(st!.queue).toEqual([expect.objectContaining({ id: 'q-1', kind: 'question', state: 'escalated', ownerText: 'Which port?' })]);
    expect(st!.children['kid-a']).toMatchObject({ row: 'working', brief: '', adopted: false });
    expect(st!.pool).toEqual([]);
    expect(st!.team).toEqual([]);
  });

  it('not a view: null (the stage keeps what it had)', () => {
    expect(remoteStageState(null)).toBeNull();
    expect(remoteStageState({ vault: 'x' })).toBeNull();
  });
});

describe('remoteLayoutPatch and the server allowlist agree', () => {
  const STAGE_GESTURES: LayoutPatch[] = [
    { cards: [{ id: 'chat-a', pos: { x: 0.2, y: 0.3 } }] },
    { cards: [{ id: 'img-1', place: 'float' }], view: { mode: 'half', card: 'img-1' } },
    { cards: [{ id: 'task-1', size: 'large', pos: { x: 0.1, y: 0.1 } }] },
    { cards: [{ id: 'task-1', order: 'last' }] },
    { view: { mode: 'present', cards: ['chat-a', 'task-1'] } },
    { presentLayout: { layout: 'compare', cards: ['chat-a', 'task-1'] } },
    { chat: { value: 'bar', cards: ['chat-a', 'task-1'] } },
    { exit: { cards: ['chat-a', 'task-1'], closing: ['task-1'] } },
    { agenda: 'open' },
    { agenda: 'min' },
    // What a remote screen may NOT do: filtered to nothing (or to its allowed part).
    { closed: ['task-1'] },
    { cards: [{ id: 'task-1', place: 'others' }] },
    { group: { id: 'grp-new', cards: ['chat-a', 'task-1'], name: 'G' } },
    { leave: ['task-1'] },
    { ungroup: ['grp-a'] },
    { touch: ['task-1'] },
    { view: { mode: 'float', auto: true } },
  ];

  it('every filtered gesture passes the server\'s allowlist', () => {
    for (const g of STAGE_GESTURES) {
      const out = remoteLayoutPatch(g);
      if (out) expect(() => checkRemoteLayout(out), JSON.stringify(g)).not.toThrow();
    }
  });

  it('the refused gestures leave nothing to send', () => {
    for (const g of [{ closed: ['task-1'] }, { cards: [{ id: 'task-1', place: 'others' as const }] }, { group: { id: 'grp-new', cards: ['a', 'b'] } }, { leave: ['a'] }, { ungroup: ['grp-a'] }, { touch: ['a'] }]) {
      expect(remoteLayoutPatch(g as LayoutPatch), JSON.stringify(g)).toBeNull();
    }
    // A minimise during a presentation never carries a close in flight.
    expect(remoteLayoutPatch({ exit: { cards: ['a'], closing: ['a'] } })).toEqual({ exit: { cards: ['a'], closing: [] } });
    // The view travels rebuilt, in a checked shape.
    expect(remoteLayoutPatch({ view: { mode: 'float', auto: true } })).toEqual({ view: { mode: 'float' } });
  });
});

describe('the touch remote\'s narrow line (AC19: 1024×768 floats its cards)', () => {
  const st = remoteStageState(VIEW)!;
  const items = stageItems(st.containers, st.groups, st.view, () => false);
  const stage = { width: 1024 - 56, height: 768 - 56 - 52 };

  it('a 968 px stage floats cards on a touch remote, and would not on the Mac\'s line', () => {
    expect(TOUCH_REMOTE_NARROW_STAGE_PX).toBeLessThan(stage.width);
    expect(NARROW_STAGE_PX).toBeGreaterThan(stage.width);
    const remote = planStage(items, st.view, stage, { narrowPx: TOUCH_REMOTE_NARROW_STAGE_PX, centreMin: TOUCH_REMOTE_CENTRE_MIN });
    const mac = planStage(items, st.view, stage);
    expect(remote.narrow).toBe(false);
    expect(Object.values(remote.cards).some((c) => c.where === 'float')).toBe(true);
    expect(mac.narrow).toBe(true);
  });
});
