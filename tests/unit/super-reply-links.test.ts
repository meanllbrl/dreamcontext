/**
 * Which Super answer is to which owner message (owner 2026-10-23, picks 1A and 2A): the pure
 * map ChatPane draws its strips and group lines from. Every case runs on the live shape (an
 * event turn carries `superEvent`) and the replayed one (only its `[super …]` text). Fictional
 * words throughout.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { msgRef, partRefs } from '../../dashboard/src/lib/superTypes.js';
import { isOwnerMessage, messagePart, replyGroups, replyHeadsById, sectionHeads } from '../../dashboard/src/components/sleepy/chat/replyLinks.js';
import { splitReplyMark } from '../../dashboard/src/lib/replyMark.js';
import type { ChatItem } from '../../dashboard/src/components/sleepy/chatSession.js';
import { replyGroups0345 } from '../fixtures/super-reply-sections/replyGroups-0345.js';
import { fileURLToPath } from 'node:url';

let seq = 0;
const owner = (text: string, id = `u${++seq}`): ChatItem => ({ kind: 'user', id, text, ts: 1 });
const event = (text = '[super events] batch=b-1 items=1', live = true, id = `e${++seq}`): ChatItem => (
  { kind: 'user', id, text, ts: 1, ...(live ? { superEvent: 'batch' } : {}) }
);
const text = (body: string, re?: string[], id = `t${++seq}`): ChatItem => (
  { kind: 'text', id, index: 0, text: body, done: true, ts: 1, ...(re ? { replyTo: re } : {}) }
);
const tool = (id = `k${++seq}`): ChatItem => ({ kind: 'tool', id, toolUseId: id, name: 'Bash', input: {}, status: 'done', startedAt: 1 });
const thinking = (body = 'hmm', id = `h${++seq}`): ChatItem => ({ kind: 'thinking', id, index: 0, text: body, done: true, ts: 1 });

const ref = (it: ChatItem) => msgRef((it as { text: string }).text);
const pick = (m: ReturnType<typeof replyGroups>, id: string) => m.get(id);

describe('replyGroups', () => {
  it('three messages answered out of order: three groups, each to the right message', () => {
    const a = owner('Fix the Orbit login page');
    const b = owner('And rename the pricing card');
    const c = owner('What is the deploy status?');
    const tc = text('The deploy is green.', [ref(c)]);
    const ta = text('The login page is fixed.', [ref(a)]);
    const k = tool();
    const tb = text('Renamed it.', [ref(b)]);
    const m = replyGroups([a, b, c, tc, ta, k, tb]);
    // C is right above its answer: no strip there; A and B show theirs.
    expect(pick(m, tc.id)).toMatchObject({ targets: [c.id], first: true, strip: false });
    expect(pick(m, ta.id)).toMatchObject({ targets: [a.id], first: true, strip: true });
    expect(pick(m, k.id)).toMatchObject({ groupId: `rg-${tb.id}`, targets: [b.id], first: true, strip: true });
    expect(pick(m, tb.id)).toMatchObject({ groupId: `rg-${tb.id}`, first: false });
  });

  it('one block marked with two refs: one group, both targets in the mark\'s order', () => {
    const a = owner('one');
    const b = owner('two');
    const t = text('Both done.', [ref(b), ref(a)]);
    expect(pick(replyGroups([a, b, t]), t.id)).toMatchObject({ targets: [b.id, a.id], strip: true });
  });

  it('unmarked with exactly one waiting message: linked (hidden when right above); with three: none', () => {
    const a = owner('one');
    const t = text('Done.');
    expect(pick(replyGroups([a, t]), t.id)).toMatchObject({ targets: [a.id], strip: false });
    const x = owner('x'); const y = owner('y'); const z = owner('z');
    const t3 = text('Hm.');
    expect(pick(replyGroups([x, y, z, t3]), t3.id)).toMatchObject({ targets: [], strip: false });
  });

  it('a later unmarked text in the same turn continues the group; a new message ends it', () => {
    const a = owner('a');
    const b = owner('b');
    const t1 = text('Answer to a.', [ref(a)]);
    const k = tool();
    const t2 = text('More on that.');
    const m = replyGroups([a, b, t1, k, t2]);
    expect(pick(m, t2.id)).toMatchObject({ groupId: `rg-${t1.id}`, targets: [a.id] });
    expect(pick(m, k.id)?.groupId).toBe(`rg-${t1.id}`);
  });

  it('tool and thinking rows before a text join it; rows after the turn\'s last text join the last group', () => {
    const a = owner('a');
    const h = thinking();
    const k1 = tool();
    const t = text('Started the job.');
    const k2 = tool();
    const k3 = tool();
    const b = owner('b');
    const m = replyGroups([a, h, k1, t, k2, k3, b]);
    for (const id of [h.id, k1.id, t.id, k2.id, k3.id]) expect(pick(m, id)?.groupId).toBe(`rg-${t.id}`);
    expect(pick(m, h.id)?.first).toBe(true);
    expect(m.has(b.id)).toBe(false);
  });

  it('the same words twice: the nearest preceding copy', () => {
    const a1 = owner('ok');
    const t1 = text('First.');
    const a2 = owner('ok');
    const x = owner('another');
    const t2 = text('Second.', [msgRef('ok')]);
    expect(pick(replyGroups([a1, t1, a2, x, t2]), t2.id)?.targets).toEqual([a2.id]);
  });

  it('event turns are never owner messages, live or replayed; a question answer is his', () => {
    expect(isOwnerMessage(event('[super events] x', true))).toBe(false);
    expect(isOwnerMessage(event('[super recap] item=q-1', false))).toBe(false);
    expect(isOwnerMessage(owner('[super answer] item=q-ask-1\nQ: Which?\nA: The first'))).toBe(true);
    for (const live of [true, false]) {
      const a = owner('a');
      const ev = event('[super events] batch=b-2 items=1', live);
      const note = text('Event note.');
      // An event turn's note answers no message of his, and leaves his message waiting.
      const b = owner('b');
      const k = tool();
      const t = text('Answer.');
      const m = replyGroups([a, ev, note, b, k, t]);
      expect(pick(m, note.id)).toMatchObject({ targets: [], strip: false });
      expect(pick(m, t.id)?.targets).toEqual([]);
      // A marked answer inside an event turn still links, and shows its strip (not right above).
      const marked = text('About a.', [ref(a)]);
      expect(pick(replyGroups([a, ev, marked]), marked.id)).toMatchObject({ targets: [a.id], strip: true });
    }
  });

  it('a ref to a message no longer in the transcript drops silently', () => {
    const a = owner('a');
    const t = text('Answer.', ['zzzzzz', ref(a)]);
    expect(pick(replyGroups([a, owner('b'), t]), t.id)?.targets).toEqual([a.id]);
    const gone = text('Answer.', ['zzzzzz']);
    expect(pick(replyGroups([owner('c'), owner('d'), gone]), gone.id)).toMatchObject({ targets: [], strip: false });
  });

  it('an empty text (a pending head, the no-delta empty-then-full pair) never splits a group', () => {
    const a = owner('a');
    const b = owner('b');
    const k = tool();
    const empty = text('');
    const full = text('Done.', [ref(a)]);
    const m = replyGroups([a, b, k, empty, full]);
    expect(m.has(empty.id)).toBe(false);
    expect(pick(m, k.id)).toMatchObject({ groupId: `rg-${full.id}`, first: true, targets: [a.id] });
  });

  it('the same transcript split three ways gives the same map (it runs on the concatenation)', () => {
    const entries = [owner('a'), owner('b'), tool(), text('A first.', [msgRef('a')]), tool(), text('Then b.', [msgRef('b')]), owner('c'), text('C.')];
    const run = (history: ChatItem[], items: ChatItem[]) => [...replyGroups([...history, ...items]).entries()];
    const whole = run(entries, []);
    expect(run([], entries)).toEqual(whole);
    expect(run(entries.slice(0, 4), entries.slice(4))).toEqual(whole);
    expect(whole.length).toBeGreaterThan(0);
  });

  it('a streamed item joins its group on the update where its body first shows', () => {
    const a = owner('a');
    const b = owner('b');
    const id = 'live-1';
    expect(replyGroups([a, b, text('', undefined, id)]).has(id)).toBe(false);
    expect(pick(replyGroups([a, b, text('H', [ref(b)], id)]), id)?.targets).toEqual([b.id]);
  });
});

describe('ChatPane reads it once per render', () => {
  const pane = readFileSync(join(fileURLToPath(new URL('../../', import.meta.url)), 'dashboard/src/components/sleepy/ChatPane.tsx'), 'utf-8');
  it('over the whole conversation, only in a Super view, and its memo key reads replyTo', () => {
    expect(pane).toMatch(/const replyMap = useMemo\(\(\) => \(superView \? replyGroups\(questEntries\) : null\), \[superView, questEntries\]\);/);
    expect(pane).toMatch(/it\.kind === 'text' && it\.replyTo \? it\.replyTo\.join\(\) : ''/);
  });
});

describe('the bubble and the queue draw a reply as a strip', () => {
  // The transcript's markdown stack reads the worker global `self` at import; node has none.
  (globalThis as { self?: unknown }).self ??= globalThis;
  const ROOT = fileURLToPath(new URL('../../', import.meta.url));
  const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');

  it('his reply: a ↩ strip with the quote above his own words; malformed stays text; an agenda About still draws', async () => {
    const { createElement } = await import('../../dashboard/node_modules/react/index.js');
    const { renderToStaticMarkup } = await import('../../dashboard/node_modules/react-dom/server.node.js');
    const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
    const { ItemView } = await import('../../dashboard/src/components/sleepy/chat/TranscriptItem.js');
    const { replyAboutBlock, agendaAboutBlock } = await import('../../dashboard/src/components/sleepy/super/superHandover.js');
    const draw = (t: string) => renderToStaticMarkup(createElement(I18nProvider, null, createElement(ItemView as never, {
      item: { kind: 'user', id: 'u-9', text: t, ts: 1 }, onOpenFile: () => {}, onQuote: () => {}, onReplyJump: () => {},
    })));
    const reply = draw(`${replyAboutBlock('Here is the plan for the Orbit checkout form.', 'super')}\n\nyes, go`);
    expect(reply).toMatch(/data-testid="chat-msg-reply".*↩.*To Super.*Here is the plan for the Orbit checkout form\./);
    expect(reply).toMatch(/<button type="button" class="chat-msg-about chat-msg-about--reply"/);
    expect(reply).toMatch(/<div class="chat-msg-user-bubble">yes, go<\/div>/);
    expect(reply).not.toContain('[Reply to message');
    expect(reply).toContain('data-item-id="u-9"');
    const bad = '[Reply to message ref=abcdef from=super]\nquote: x\n\nhi';
    expect(draw(bad)).not.toContain('chat-msg-reply');
    expect(draw(bad)).toContain('[Reply to message ref=abcdef from=super]');
    const agenda = draw(`${agendaAboutBlock({ key: 'n:n7', section: 'waiting', text: 'Try it in Safari', note: 'n7', at: 1 })}\n\nok`);
    expect(agenda).toMatch(/data-testid="chat-msg-about" data-kind="note"/);
  });

  it('a Super answer row carries its group and its id; tool rows carry the group', () => {
    // The answer's markdown needs the app's theme; its row attributes are pinned in the source.
    expect(read('dashboard/src/components/sleepy/chat/TranscriptItem.tsx'))
      .toMatch(/className="chat-msg-assistant-row" data-done=\{item\.done\} data-item-id=\{item\.id\} data-reply-grp=\{replyGroup\}/);
    for (const f of ['ToolCard.tsx', 'ToolRunCard.tsx', 'DreamActionCard.tsx', 'molecules.tsx']) {
      expect(read(`dashboard/src/components/sleepy/chat/${f}`)).toContain('data-reply-grp={replyGroup}');
    }
  });

  it('every new word exists in EN and TR; touch shows the ↩ bar on a tapped row', () => {
    const i18n = read('dashboard/src/context/I18nContext.tsx');
    const tr = i18n.indexOf('const TR_PARTIAL');
    for (const k of ['toSuper', 'toOwn', 'yourMessage', 'nMessages', 'chipSuper', 'chipOwn', 'placeholder']) {
      expect(i18n.slice(0, tr)).toContain(`'super.reply.${k}':`);
      expect(i18n.slice(tr)).toContain(`'super.reply.${k}':`);
    }
    const css = read('dashboard/src/components/sleepy/chat/molecules.css');
    expect(css).toMatch(/@media \(hover: none\) \{\s*\.chat-msg-user-row:focus-within \.chat-m-hoverbar,/);
  });
});

/** A Super text as the session holds it: the raw marked text split the way chatSession does. */
const marked = (raw: string, done = true, id = `t${++seq}`): ChatItem => {
  const split = splitReplyMark(raw);
  return {
    kind: 'text', id, index: 0, text: split.body, done, ts: 1,
    ...(split.refs.length ? { replyTo: split.refs } : {}),
    ...(split.sections.length ? { replySections: split.sections } : {}),
  };
};
const mark = (...words: string[]) => `<!-- re:${words.map((w) => msgRef(w)).join(' ')} -->\n`;
/** The live map without the new field: what 0.34.5 can be compared on. */
const without = (m: ReturnType<typeof replyGroups>) => [...m.entries()].map(([id, g]) => [id, { groupId: g.groupId, first: g.first, targets: g.targets, strip: g.strip }]);

/**
 * Streams `raw` as item `id` after `before`, one character at a time (every prefix, done=false),
 * then done. At every prefix: no strip on a group it opened, and a section shown once keeps its place and
 * targets. Returns the done map.
 */
function stream(before: ChatItem[], raw: string, id = 'live', each?: (m: ReturnType<typeof replyGroups>) => void) {
  const shown = new Map<number, string>();
  const check = (m: ReturnType<typeof replyGroups>, done: boolean) => {
    const g = m.get(id);
    // A group whose first text streams draws no strip (one it continues keeps its own).
    if (!done && g?.groupId === `rg-${id}`) for (const v of m.values()) if (v.groupId === g.groupId) expect(v.strip).toBe(false);
    for (const [at, targets] of shown) expect(g?.sections?.find((x) => x.at === at)?.targets.join()).toBe(targets);
    for (const x of g?.sections ?? []) shown.set(x.at, x.targets.join());
    if (g?.sections) for (const v of m.values()) if (v.groupId === g.groupId) expect(v.strip).toBe(false);
    each?.(m);
  };
  for (let n = 1; n <= raw.length; n += 1) check(replyGroups([...before, marked(raw.slice(0, n), false, id)]), false);
  const done = replyGroups([...before, marked(raw, true, id)]);
  check(done, true);
  return done;
}

describe('a reply in sections (owner 2026-10-24, pick A)', () => {
  const A = 'Is the Orbit checkout form still running its tests?';
  const B = '[About agenda line note=n4 section=waiting]\nline: "Rename the pricing card"\n\nis it done?';
  const C = '[About agenda line note=n9 section=waiting]\nline: "Ship the Orbit deploy"\n\nand the deploy?';
  const BODY = (a = A, b = B, c = C) => `${mark(a)}The checkout tests are still running.\n\n${mark(b)}Yes, the card is renamed.\n\n${mark(c)}The deploy is green.`;
  const turn = () => {
    const a = owner(A); const k1 = tool(); const b = owner(B); const k2 = tool(); const c = owner(C); const k3 = tool();
    return { a, b, c, k3, before: [a, k1, b, k2, c, k3] };
  };

  it('three sections resolve to the three owner messages, steered About ones included: one group, no strip', () => {
    const { a, b, c, k3, before } = turn();
    const m = stream(before, BODY());
    expect(m.get('live')).toMatchObject({ groupId: 'rg-live', strip: false, targets: [a.id, b.id, c.id] });
    expect(m.get('live')?.sections?.map((x) => x.targets)).toEqual([[a.id], [b.id], [c.id]]);
    expect(m.get(k3.id)).toMatchObject({ groupId: 'rg-live', first: true, strip: false });
    expect([...m.values()].filter((g) => g.strip)).toEqual([]);
  });

  it('every prefix, eight shapes: no strip while it streams, a head shown never goes, and at done the heads', () => {
    const variants: Array<[string, (t: ReturnType<typeof turn>) => [ChatItem[], string]]> = [
      ['measured', (t) => [t.before, BODY()]],
      ['preamble', (t) => [t.before, `Looking at all three.\n\n${BODY()}`]],
      ['stacked', (t) => [t.before, `${mark(A)}\n${mark(B)}Both are fine.\n\n${mark(C)}The deploy is green.`]],
      ['mixed', (t) => [t.before, `${mark(A)}Still running.\n\n${mark(B, C)}Both done.`]],
      ['0-ref line', (t) => [t.before, `${mark(A)}Still running.\n\n<!-- re: -->\nAnd one more thing.`]],
      ['unmarked first', (t) => [[...t.before, marked('Bakıyorum.'), tool(), tool()], BODY()]],
      ['1 waiting, non-adjacent', () => {
        const a = owner(A); const done = marked(`${mark(A)}Tests started.`); const b = owner(B);
        return [[a, done, b, tool()], `${mark(A)}Still running.\n\n${mark(B)}Renamed.`];
      }],
    ];
    for (const [name, make] of variants) {
      const [before, raw] = make(turn());
      const m = stream(before, raw, `live-${name}`);
      const secs = m.get(`live-${name}`)?.sections;
      expect(secs?.length, name).toBeGreaterThanOrEqual(2);
      expect(m.get(`live-${name}`)?.strip, name).toBe(false);
    }
  });

  it('the eighth: a text that continued a group and then becomes SECTIONED leaves that group as it was', () => {
    const a = owner(A); const b = owner(B);
    const first = marked(`${mark(A)}Tests started.`);
    const k1 = tool(); const k2 = tool();
    const before = [a, b, first, k1, k2];
    const base = replyGroups(before);
    const members = (m: ReturnType<typeof replyGroups>) => [...m.entries()].filter(([id, g]) => id !== 'live' && g.groupId === `rg-${first.id}`).map(([id, g]) => [id, g.strip, g.first]);
    expect(base.get(first.id)).toMatchObject({ strip: true, targets: [a.id] });
    const want = members(base);
    const m = stream(before, `${mark(A)}More on the tests.\n\n${mark(B)}And the card is renamed.`, 'live', (mm) => expect(members(mm)).toEqual(want));
    expect(m.get('live')).toMatchObject({ groupId: 'rg-live', first: true, strip: false });
    expect(m.get(k1.id)?.groupId).toBe(`rg-${first.id}`);
  });

  it('a single answer still streaming draws no strip; at done it gets exactly its 0.34.5 strip', () => {
    const a = owner(A); const b = owner(B); const c = owner(C);
    const raw = `${mark(A)}The checkout tests are still running.`;
    const m = stream([a, b, c, tool()], raw);
    const ref0345 = replyGroups0345([a, b, c, marked(raw, true, 'live')]);
    expect(m.get('live')?.strip).toBe(ref0345.get('live')?.strip);
    expect(m.get('live')).toMatchObject({ strip: true, targets: [a.id] });
  });

  it('every block ending with fewer than two sections: the done map is 0.34.5\'s', () => {
    const a = owner('Fix the Orbit login page'); const b = owner('And rename the pricing card'); const c = owner('What is the deploy status?');
    const shapes: ChatItem[][] = [
      // out of order: an answer right under its message shows nothing, its siblings their strips
      [a, b, c, marked(`${mark(c.text as string)}Green.`), marked(`${mark(a.text as string)}Fixed.`), tool(), marked(`${mark(b.text as string)}Renamed.`)],
      // one mark, one message waiting
      [owner('one'), marked(`${mark('one')}Done.`)],
      // the old combined head mark ("To N")
      [owner('one'), owner('two'), marked(`${mark('two', 'one')}Both done.`)],
      // a single non-adjacent answer with two waiting
      [owner('x1'), owner('x2'), tool(), marked(`${mark('x1')}About x1.`)],
      // stale waiting after a turn with no text
      [owner('s1'), tool(), owner('s2'), marked('Unmarked.'), tool()],
      // a preamble and one section
      [owner('p1'), owner('p2'), marked(`Looking.\n\n${mark('p1')}About p1.`)],
    ];
    for (const entries of shapes) {
      const m = replyGroups(entries);
      expect(without(m)).toEqual([...replyGroups0345(entries).entries()]);
      for (const g of m.values()) expect(g.sections).toBeUndefined();
    }
  });

  it('an unresolved section ref gives targets []; the map is the same over the three cuts', () => {
    const { a, before } = turn();
    const raw = `${mark(A)}Running.\n\n<!-- re:zzzzzz -->\nNobody asked this.`;
    const m = replyGroups([...before, marked(raw, true, 'live')]);
    expect(m.get('live')?.sections?.map((x) => x.targets)).toEqual([[a.id], []]);
    const entries = [...before, marked(raw, true, 'live')];
    const run = (h: ChatItem[], i: ChatItem[]) => [...replyGroups([...h, ...i]).entries()];
    const whole = run(entries, []);
    expect(run([], entries)).toEqual(whole);
    expect(run(entries.slice(0, 3), entries.slice(3))).toEqual(whole);
  });
});

// W2 (owner 2026-10-24, pick A): what each section's head shows, as plain memoized data.
describe('section heads', () => {
  const A = 'Is the Orbit checkout form still running its tests?';
  const B = '[About agenda line note=n4 section=waiting]\nline: "Rename the pricing card"\n\nis it done?';
  const quote = (items: Map<string, ChatItem>) => (id: string) => {
    const it = items.get(id) as { text?: string } | undefined;
    return (it?.text ?? '').replace(/^\[About[^\n]*\nline: "[^\n]*"\n\n/, '');
  };

  it('an About message heads with its agenda line; a plain one with ↩ and his words; an unresolved one has none', () => {
    const a = owner(A); const b = owner(B);
    const items = new Map([[a.id, a], [b.id, b]]);
    const heads = sectionHeads([{ at: 0, targets: [a.id] }, { at: 20, targets: [b.id] }, { at: 40, targets: [] }, { at: 60, targets: [a.id, b.id] }], items, quote(items));
    expect(heads).toEqual([
      { at: 0, kind: 'reply', count: 1, quotes: [A], targetId: a.id },
      { at: 20, kind: 'about', about: { kind: 'note', id: 'n4', section: 'waiting', line: 'Rename the pricing card' }, count: 1, quotes: ['is it done?'], targetId: b.id },
      { at: 60, kind: 'reply', count: 2, quotes: [A, 'is it done?'], targetId: a.id },
    ]);
  });

  it('only SECTIONED texts get heads, and an unchanged text keeps the SAME array (the row memo holds)', () => {
    const a = owner(A); const b = owner(B);
    const answer = marked(`${mark(A)}Running.\n\n${mark(B)}Renamed.`, true, 'live');
    const single = marked(`${mark(A)}Just one.`, true, 'one');
    const entries = [a, b, single, answer];
    const items = new Map(entries.map((it) => [it.id, it] as const));
    const first = replyHeadsById(replyGroups(entries), items, quote(items));
    expect([...first.keys()]).toEqual(['live']);
    // Another stream's token: a new map, the same content, the same arrays.
    const more = [...entries, owner('later'), marked('Streaming...', false, 'other')];
    const items2 = new Map(more.map((it) => [it.id, it] as const));
    const second = replyHeadsById(replyGroups(more), items2, quote(items2), first);
    expect(second.get('live')).toBe(first.get('live'));
    // Its own heads changing gives a new array.
    const third = replyHeadsById(replyGroups(more), items2, (id) => `${quote(items2)(id)}!`, second);
    expect(third.get('live')).not.toBe(second.get('live'));
  });

  it('the speech highlight never walks into a head; Copy copies the text, never a head', () => {
    const ROOT = new URL('../../', import.meta.url).pathname;
    const speech = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/chat/useSpokenHighlight.ts'), 'utf-8');
    expect(speech).toMatch(/closest\('\[data-reply-head\]'\) \? NodeFilter\.FILTER_REJECT/);
    const item = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/chat/TranscriptItem.tsx'), 'utf-8');
    expect(item).toContain('onClick={() => copyText(item.text)}');
    expect(readFileSync(join(ROOT, 'dashboard/src/components/sleepy/chat/AgendaAboutStrip.tsx'), 'utf-8')).toMatch(/data-reply-head=""\s+data-testid="chat-reply-head"/);
    const pane = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/ChatPane.tsx'), 'utf-8');
    expect(pane).toMatch(/const handleReplyTarget = useCallback\(\(targetId: string, part\?: number\) => \{\s+replyJumpRef\.current\.jumpToReplyTarget\(targetId, part\);\s+\}, \[\]\);/);
    expect(pane).toMatch(/replyHeads=\{replyHeads\?\.get\(item\.id\)\}/);
  });
});


/**
 * Part refs (owner 2026-10-24, rev 12): a message with several references answers to one ref per
 * part, so a section's head names ONE chip inside it.
 */
describe('part refs', () => {
  const NOTE = (id: string, line: string) => `[About agenda line note=${id} section=waiting]\nline: ${JSON.stringify(line)}`;
  const REPLY = (r: string, q: string) => `[Reply to message ref=${r} from=super]\nquote: ${JSON.stringify(q)}`;
  const multi = () => owner(`Two things:\n\n${NOTE('n1', 'Windows tests')}\n\nyes, CLI only\n\n${NOTE('n2', 'Docs')}\n\n${REPLY('k3f9q0', 'the plan')}\n\ngo`);
  const pmark = (it: ChatItem, ...parts: number[]) => parts.map((j) => `<!-- re:${partRefs((it as { text: string }).text)[j - 1]} -->\n`).join('');

  it('a sectioned answer: each section resolves to the message with its part; stacked parts are one section', () => {
    const m = multi();
    const ans = marked(`${pmark(m, 1)}Adding the Windows tests.\n${pmark(m, 2, 3)}Docs done, and going with the plan.`);
    const g = pick(replyGroups([m, ans]), ans.id)!;
    expect(g.sections?.map((x) => [x.targets, x.parts])).toEqual([[[m.id], [1]], [[m.id], [2, 3]]]);
    const items = new Map([[m.id, m], [ans.id, ans]]);
    const heads = sectionHeads(g.sections!, items, () => 'whole message');
    expect(heads.map((h) => [h.parts, h.partAbouts?.map((a) => a.kind), h.quotes])).toEqual([
      [[1], ['note'], ['yes, CLI only']],
      // A stacked part shares the words of the part it is stacked on.
      [[2, 3], ['note', 'reply'], ['go']],
    ]);
  });

  it('nearest preceding wins; an unknown part ref resolves to nothing; the message ref still works (rev 11)', () => {
    const m1 = multi();
    const m2 = multi();
    const ans = marked(`${pmark(m2, 1)}one`);
    expect(pick(replyGroups([m1, m2, ans]), ans.id)!.targets).toEqual([m2.id]);
    const stranger = marked('<!-- re:zzzzzz -->\nnothing');
    expect(pick(replyGroups([m1, stranger]), stranger.id)!.targets).toEqual([]);
    const old = marked(`<!-- re:${msgRef(m1.text)} -->\nas before`);
    const g = pick(replyGroups([m1, old]), old.id)!;
    expect(g.targets).toEqual([m1.id]);
    expect(g.parts).toBeUndefined();
  });

  it('a single-section answer whose mark is a part ref: the strip treatment, with that part', () => {
    const m = multi();
    const between = owner('another message');
    const ans = marked(`${pmark(m, 2)}Docs are done.`);
    const g = pick(replyGroups([m, between, ans]), ans.id)!;
    expect(g).toMatchObject({ targets: [m.id], strip: true, parts: [2] });
    expect(messagePart(m, 2)).toMatchObject({ about: { kind: 'note', id: 'n2' }, words: 'go' });
    expect(messagePart(m, 9)).toBeNull();
  });
});
