/**
 * Which Super answer is to which owner message (owner 2026-10-23, picks 1A and 2A): the pure
 * map ChatPane draws its strips and group lines from. Every case runs on the live shape (an
 * event turn carries `superEvent`) and the replayed one (only its `[super …]` text). Fictional
 * words throughout.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { msgRef } from '../../dashboard/src/lib/superTypes.js';
import { isOwnerMessage, replyGroups } from '../../dashboard/src/components/sleepy/chat/replyLinks.js';
import type { ChatItem } from '../../dashboard/src/components/sleepy/chatSession.js';
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
