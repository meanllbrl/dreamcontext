/**
 * The stage comes back the way it was left (owner 2026-11-11, "burada agenda doğru düzgün
 * gözükmüyor ... özellikle window'a git gel yaptığında"). His agenda, sized Large by him and
 * dropped at the top left, beside a small chat card he dropped under it: the plan drew it Large
 * only while it was the card he dropped last THIS mount (`recent`, window state); a fresh mount
 * (a chat window or another project, then back) seated the later chat first, the agenda could not
 * stand at its spot and was drawn as the 1x1 counts. With no drop between them this session, the
 * bigger card keeps its place and the small tile moves.
 */
import { describe, it, expect } from 'vitest';
import { planStage, stageItems } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import type { SuperContainer } from '../../dashboard/src/lib/superTypes.js';

const FLOAT = { mode: 'float' as const };
// His record, trimmed (Tilki, 2026-11-11): the agenda first, a dropped chat later, two auto chats.
const RECORD: SuperContainer[] = [
  { id: 'agenda-1', kind: 'agenda', ref: 'agenda', shape: 'square', size: 'large', sizeBy: 'owner', place: 'float', by: 'super', pos: { x: 0, y: 0 } },
  { id: 'chat-a', kind: 'chat', ref: 'a', shape: 'portrait', place: 'float', by: 'super', pos: { x: 0.0235, y: 0.5028 } },
  { id: 'chat-b', kind: 'chat', ref: 'b', shape: 'portrait', place: 'float', by: 'super' },
  { id: 'chat-c', kind: 'chat', ref: 'c', shape: 'portrait', place: 'float', by: 'super' },
] as SuperContainer[];
const STAGE_PX = { width: 1602, height: 926 };
const plan = (recent?: string[]) => planStage(stageItems(RECORD, [], FLOAT), FLOAT, STAGE_PX, recent ? { recent } : {});

describe('the stage after a remount', () => {
  it('draws his Large agenda Large with nothing dropped this session', () => {
    const p = plan();
    expect(p.cards['agenda-1']).toMatchObject({ where: 'float', size: 'large' });
    // The small tile he dropped under it moved down, still on the stage, still his.
    expect(p.cards['chat-a']).toMatchObject({ where: 'float', owner: true });
  });

  it('is the same stage as right after he dropped the agenda', () => {
    const fresh = plan();
    const after = plan(['agenda-1']);
    expect(fresh.cards['agenda-1'].rect).toEqual(after.cards['agenda-1'].rect);
    expect(fresh.cards['chat-a'].rect).toEqual(after.cards['chat-a'].rect);
    expect(fresh.centre).toEqual(after.centre);
  });

  it('keeps it while he drags another card and a push arrives (the drag replays the same seats)', () => {
    const free = plan();
    for (const id of ['chat-b', 'chat-c']) {
      const held = planStage(stageItems(RECORD, [], FLOAT), FLOAT, STAGE_PX, { dragging: { id, rect: free.cards[id].rect } });
      expect(held.cards['agenda-1']).toMatchObject({ where: 'float', size: 'large' });
      expect(held.cards['agenda-1'].rect).toEqual(free.cards['agenda-1'].rect);
      expect(held.cards['chat-a'].rect).toEqual(free.cards['chat-a'].rect);
    }
  });

  it('still lets the card he dropped last keep its spot', () => {
    const p = plan(['chat-a']);
    const a = p.cards['chat-a'].rect;
    const fresh = plan().cards['chat-a'].rect;
    expect(a.y).toBeLessThan(fresh.y);
  });
});
