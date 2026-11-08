import { describe, expect, it } from 'vitest';
import {
  bringPatch, cardName, cardsOfCall, jsonObjectsIn, sameTurnCards, turnCardsByAnswer, turnTiles,
  type StageNow, type TurnItem,
} from '../../dashboard/src/lib/turnCards.js';

/** A finished Bash call with the CLI's pretty JSON as its result (fictional project). */
const bash = (id: string, command: string, out: unknown, status = 'done'): TurnItem => ({
  kind: 'tool', id, name: 'Bash', input: { command }, status,
  result: typeof out === 'string' ? out : JSON.stringify(out, null, 2),
});
const owner = (id: string, text = 'show me the plan'): TurnItem => ({ kind: 'user', id, text });
const text = (id: string, t: string): TurnItem => ({ kind: 'text', id, text: t });

const openPage = {
  container: { id: 'web-a1', kind: 'web', ref: 'reports/plan.html', title: 'Routing plan', place: 'float' },
  containers: [{ id: 'web-a1', kind: 'web', ref: 'reports/plan.html', title: 'Routing plan', place: 'float' }],
  view: { mode: 'half', card: 'web-a1' },
};
const openPictures = {
  container: { id: 'image-b1', kind: 'image', ref: 'shots/one.png', place: 'float' },
  containers: [
    { id: 'image-b1', kind: 'image', ref: 'shots/one.png', place: 'float' },
    { id: 'image-b2', kind: 'image', ref: 'shots/two.png', title: 'Second', place: 'float' },
  ],
  group: { id: 'grp-shots', name: 'shots', cards: ['image-b1', 'image-b2'], place: 'float' },
  autoGroup: true,
  view: { mode: 'float' },
};

describe('turnCards: the record a turn keeps of what it showed', () => {
  it('reads every top-level JSON object, braces inside strings included', () => {
    const out = `${JSON.stringify({ a: 1, t: 'a } brace' }, null, 2)}\n${JSON.stringify({ b: '{x' })}\nnoise {not json}`;
    expect(jsonObjectsIn(out)).toEqual([{ a: 1, t: 'a } brace' }, { b: '{x' }]);
  });

  it('an open names its cards whole and the group they went into', () => {
    const turn = cardsOfCall(bash('t1', 'dreamcontext super open image shots/one.png shots/two.png', openPictures) as never)!;
    expect(turn.ids).toEqual(['image-b1', 'image-b2']);
    expect(turn.known['image-b2']).toEqual({ id: 'image-b2', kind: 'image', ref: 'shots/two.png', title: 'Second' });
    expect(turn.groupOf).toEqual({ 'image-b1': 'grp-shots', 'image-b2': 'grp-shots' });
  });

  it('present and ask --show name card ids; other verbs and failed calls name nothing', () => {
    expect(cardsOfCall(bash('t', 'dreamcontext super present web-a1 image-b1', { view: { mode: 'present', cards: ['web-a1', 'image-b1'] } }) as never)!.ids)
      .toEqual(['web-a1', 'image-b1']);
    expect(cardsOfCall(bash('t', 'dreamcontext super ask "Ship?" --show web-a1', { item: 'q1', asked: true, show: { cards: ['web-a1'], state: 'presented' } }) as never)!.ids)
      .toEqual(['web-a1']);
    expect(cardsOfCall(bash('t', 'dreamcontext super half web-a1', { view: { mode: 'half', card: 'web-a1' } }) as never)).toBeNull();
    expect(cardsOfCall(bash('t', 'dreamcontext super open web reports/plan.html', openPage, 'error') as never)).toBeNull();
    expect(cardsOfCall(bash('t', 'cat reports/out.json', openPage) as never)).toBeNull();
  });

  it('two verbs chained with && in one call both count', () => {
    const out = `${JSON.stringify(openPage, null, 2)}\n${JSON.stringify({ view: { mode: 'present', cards: ['web-a1'] } }, null, 2)}`;
    expect(cardsOfCall(bash('t', 'dreamcontext super open web reports/plan.html && dreamcontext super present web-a1', out) as never)!.ids).toEqual(['web-a1']);
  });

  it('a turn\'s cards go under its LAST answer text, and a turn that showed nothing has none', () => {
    const items: TurnItem[] = [
      owner('u1'),
      text('x0', 'Opening it.'),
      bash('t1', 'dreamcontext super open web reports/plan.html', openPage),
      bash('t2', 'dreamcontext super open image shots/one.png shots/two.png', openPictures),
      text('x1', 'The plan is ready, the report is open on the stage.'),
      owner('u2', 'thanks'),
      text('x2', 'You are welcome.'),
    ];
    const map = turnCardsByAnswer(items);
    expect([...map.keys()]).toEqual(['x1']);
    expect(map.get('x1')!.ids).toEqual(['web-a1', 'image-b1', 'image-b2']);
  });

  it('a later present of a card an earlier turn opened still knows its name', () => {
    const items: TurnItem[] = [
      owner('u1'), bash('t1', 'dreamcontext super open web reports/plan.html', openPage), text('x1', 'Opened.'),
      owner('u2', 'show it again'), bash('t2', 'dreamcontext super present web-a1', { view: { mode: 'present', cards: ['web-a1'] } }), text('x2', 'On the stage.'),
    ];
    expect(turnCardsByAnswer(items).get('x2')!.known['web-a1'].title).toBe('Routing plan');
  });

  it('a stage strip is not a turn boundary; a turn with no answer text draws nothing', () => {
    const items: TurnItem[] = [
      owner('u1'), bash('t1', 'dreamcontext super open web reports/plan.html', openPage),
      { kind: 'user', id: 's1', text: '', stageMedia: [{ ref: 'shots/one.png' }] },
      text('x1', 'Here.'),
      owner('u2'), bash('t2', 'dreamcontext super open image shots/one.png shots/two.png', openPictures),
    ];
    const map = turnCardsByAnswer(items);
    expect(map.get('x1')!.ids).toEqual(['web-a1']);
    expect(map.size).toBe(1);
  });
});

describe('turnCards: review findings (steer, chained state, a cut replay)', () => {
  it('a steer mid-turn is part of the turn: the page opened before it lands under the answer', () => {
    const items: TurnItem[] = [
      owner('u1'),
      bash('t1', 'dreamcontext super open web reports/plan.html', openPage),
      { kind: 'user', id: 's1', text: 'and the screenshots too', steered: true } as TurnItem,
      bash('t2', 'dreamcontext super open image shots/one.png shots/two.png', openPictures),
      text('x1', 'Both are up.'),
    ];
    expect(turnCardsByAnswer(items).get('x1')!.ids).toEqual(['web-a1', 'image-b1', 'image-b2']);
  });

  it('a stretch with no answer (a steer replayed as a plain message) carries its cards forward', () => {
    const items: TurnItem[] = [
      owner('u1'),
      bash('t1', 'dreamcontext super open web reports/plan.html', openPage),
      owner('u2', 'and the screenshots too'),
      bash('t2', 'dreamcontext super open image shots/one.png shots/two.png', openPictures),
      text('x1', 'Both are up.'),
    ];
    expect(turnCardsByAnswer(items).get('x1')!.ids).toEqual(['web-a1', 'image-b1', 'image-b2']);
  });

  it('a super state chained after an open adds none of the stage\'s other cards', () => {
    const state = {
      enabled: true, session: 'abc', queue: [], children: {},
      containers: [{ id: 'task-zz', kind: 'task', ref: 'old-task', place: 'others' }, ...openPage.containers],
      groups: [], view: { mode: 'present', cards: ['task-zz'] },
    };
    const out = `${JSON.stringify(openPage, null, 2)}\n${JSON.stringify(state, null, 2)}`;
    expect(cardsOfCall(bash('t', 'dreamcontext super open web reports/plan.html && dreamcontext super state', out) as never)!.ids).toEqual(['web-a1']);
  });

  it('an open result cut at 4000 characters on replay keeps its complete cards and their group', () => {
    const big = {
      container: { id: 'image-c0', kind: 'image', ref: 'shots/c0.png', place: 'float' },
      containers: Array.from({ length: 12 }, (_, i) => ({ id: `image-c${i}`, kind: 'image', ref: `shots/long-folder-name/c${i}.png`, title: `Screen ${i}`, place: 'float', shape: 'square' })),
      group: { id: 'grp-long', name: 'long', cards: Array.from({ length: 12 }, (_, i) => `image-c${i}`), place: 'float' },
      view: { mode: 'present', cards: ['image-c0'] },
    };
    const full = JSON.stringify(big, null, 2);
    const cut = `${full.slice(0, Math.floor(full.length * 0.6))}\n… [truncated]`;
    const turn = cardsOfCall(bash('t', 'dreamcontext super open image shots/long-folder-name/*.png --present', cut) as never)!;
    expect(turn).not.toBeNull();
    expect(turn.ids.length).toBeGreaterThan(3);
    expect(turn.ids[0]).toBe('image-c0');
    expect(turn.known['image-c1'].title).toBe('Screen 1');
    // The group line comes after the cards and was cut away: no group is guessed.
    expect(Object.keys(turn.groupOf)).toEqual([]);
  });
});

describe('turnTiles: the turn against the stage as it is now', () => {
  const turn = turnCardsByAnswer([
    owner('u1'),
    bash('t1', 'dreamcontext super open web reports/plan.html', openPage),
    bash('t2', 'dreamcontext super open image shots/one.png shots/two.png', openPictures),
    text('x1', 'Ready.'),
  ]).get('x1')!;
  const stage = (over: Partial<StageNow> = {}): StageNow => ({
    containers: [
      { id: 'web-a1', kind: 'web', ref: 'reports/plan.html', title: 'Routing plan', place: 'others' },
      { id: 'image-b1', kind: 'image', ref: 'shots/one.png', place: 'float' },
      { id: 'image-b2', kind: 'image', ref: 'shots/two.png', title: 'Second', place: 'float' },
    ],
    groups: [{ id: 'grp-shots', name: 'shots', cards: ['image-b1', 'image-b2'], place: 'others' }],
    ...over,
  });

  it('a page is its own tile (in Others still), two pictures of one group are one group tile', () => {
    const tiles = turnTiles(turn, stage());
    expect(tiles.map((t) => t.kind)).toEqual(['card', 'group']);
    expect(tiles[0]).toMatchObject({ kind: 'card', card: { id: 'web-a1', title: 'Routing plan' }, place: 'others' });
    expect(tiles[1]).toMatchObject({ kind: 'group', group: { id: 'grp-shots', place: 'others' } });
    expect((tiles[1] as { cards: unknown[] }).cards).toHaveLength(2);
  });

  it('a card the stage no longer holds is a closed tile; a group broken to one card is that card', () => {
    const now = stage({
      containers: [{ id: 'image-b2', kind: 'image', ref: 'shots/two.png', title: 'Second', place: 'float' }],
      groups: [],
    });
    const tiles = turnTiles(turn, now);
    expect(tiles.map((t) => t.kind)).toEqual(['closed', 'closed', 'card']);
    expect(tiles[0]).toMatchObject({ title: 'Routing plan', cardKind: 'web' });
    expect(tiles[1]).toMatchObject({ title: 'one.png' });
  });

  it('with no stage record (a fresh session, the phone) every known card is drawn from the turn', () => {
    const tiles = turnTiles(turn, null);
    expect(tiles.map((t) => t.kind)).toEqual(['card', 'card', 'card']);
    expect(cardName((tiles[1] as { card: { id: string; kind: string; ref: string } }).card)).toBe('one.png');
  });

  it('the click: a card comes out of Others side by side, a group out of Others presented', () => {
    const now = stage();
    const present = (g: StageNow['groups'][number]) => [...g.cards];
    expect(bringPatch({ card: 'web-a1' }, now, present)).toEqual({ cards: [{ id: 'web-a1', place: 'float' }], view: { mode: 'half', card: 'web-a1' } });
    expect(bringPatch({ card: 'image-b1' }, now, present)).toEqual({ view: { mode: 'half', card: 'image-b1' } });
    expect(bringPatch({ group: 'grp-shots' }, now, present)).toEqual({ cards: [{ id: 'grp-shots', place: 'float' }], view: { mode: 'present', cards: ['image-b1', 'image-b2'] } });
    // Gone for good: no move at all, never a dead write.
    expect(bringPatch({ card: 'web-zz' }, now, present)).toBeNull();
    expect(bringPatch({ group: 'grp-gone' }, now, present)).toBeNull();
  });

  it('the same cards compare equal, so an answer keeps its object', () => {
    const again = turnCardsByAnswer([
      owner('u1'),
      bash('t1', 'dreamcontext super open web reports/plan.html', openPage),
      bash('t2', 'dreamcontext super open image shots/one.png shots/two.png', openPictures),
      text('x1', 'Ready.'),
    ]).get('x1')!;
    expect(sameTurnCards(turn, again)).toBe(true);
  });
});
