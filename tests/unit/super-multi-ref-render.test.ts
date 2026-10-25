/**
 * Several references in one message, drawn (owner 2026-10-24): the sent bubble shows each part's
 * chip inline with his words, in its slot, and never a header's text; a one-chip message keeps
 * 0.34.5's strip; a Super head naming parts shows those parts' chips in their slots (stacked:
 * side by side). Server-rendered with the app's providers, the way super-reply-sections-render
 * does it; the browser check is scripts/verify/super-multi-ref.mjs.
 */
import { describe, it, expect, beforeAll } from 'vitest';

(globalThis as { self?: unknown }).self ??= globalThis;
let draw: (props: Record<string, unknown>) => string;

beforeAll(async () => {
  (globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as Record<string, unknown>).window ??= globalThis;
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const { createElement } = await import('../../dashboard/node_modules/react/index.js');
  const { renderToStaticMarkup } = await import('../../dashboard/node_modules/react-dom/server.node.js');
  const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
  const { ThemeProvider } = await import('../../dashboard/src/context/ThemeContext.js');
  const { ItemView } = await import('../../dashboard/src/components/sleepy/chat/TranscriptItem.js');
  draw = (props) => renderToStaticMarkup(createElement(ThemeProvider, null, createElement(I18nProvider, null,
    createElement(ItemView as never, { onOpenFile: () => {}, readOnly: true, ...props }))));
}, 60_000);

const NOTE = (id: string, line: string) => `[About agenda line note=${id} section=waiting]\nline: ${JSON.stringify(line)}`;
const REPLY = (q: string) => `[Reply to message ref=k3f9q0 from=super]\nquote: ${JSON.stringify(q)}`;
const superSession = { mode: 'super', superMirror: false, claudeId: 'sup-1' };
const count = (html: string, s: string) => html.split(s).length - 1;

describe('a sent message with several references', () => {
  const text = `Two things:\n\n${NOTE('n1', 'Windows tests for the CLI')}\n\nyes, CLI only\n\n${NOTE('n2', 'Docs page')}\n\n${REPLY('Here is the plan')}\n\nlet's do it`;
  const item = { kind: 'user', id: 'u-1', text, ts: 1 };

  it('one bubble, his words in order, each chip inline in its slot, no header text', () => {
    const html = draw({ item, session: superSession });
    expect(count(html, 'data-testid="chat-msg-parts"')).toBe(1);
    expect([...html.matchAll(/class="chat-ref-chip"[^>]*data-slot="(\d)"/g)].map((m) => m[1])).toEqual(['1', '2', '3']);
    expect([...html.matchAll(/data-ref-part="(\d)"/g)].map((m) => m[1])).toEqual(['1', '2', '3']);
    expect(html).toMatch(/Two things:.*Windows tests for the CLI.*yes, CLI only.*Docs page.*Super: Here is the plan.*let&#x27;s do it/s);
    expect(html).not.toContain('[About agenda line');
    expect(html).not.toContain('[Reply to message');
    expect(html).not.toContain('line: ');
    // No strip above: the chips are in the text.
    expect(html).not.toContain('data-testid="chat-msg-about"');
  });

  it('a one-chip message looks exactly as 0.34.5: the strip above, his words in the bubble', () => {
    const one = { kind: 'user', id: 'u-2', text: `${NOTE('n1', 'Windows tests')}\n\nyes`, ts: 1 };
    const html = draw({ item: one, session: superSession });
    expect(html).toContain('data-testid="chat-msg-about"');
    expect(html).not.toContain('chat-ref-chip');
    expect(html).toMatch(/<div class="chat-msg-user-bubble">yes<\/div>/);
  });

  it('outside the Super view a multi-part text is not read as parts', () => {
    const html = draw({ item });
    expect(html).not.toContain('chat-ref-chip');
  });
});

describe('a Super head naming parts', () => {
  const TEXT = 'Adding the Windows tests.\n\nBoth done.';
  const answer = { kind: 'text', id: 't-1', index: 0, text: TEXT, done: true, ts: 1, replySections: [{ at: 0, refs: ['aaaaaa'] }, { at: 27, refs: ['bbbbbb', 'cccccc'] }] };
  const heads = [
    { at: 0, kind: 'about', count: 1, quotes: ['yes, CLI only'], targetId: 'u-1', parts: [1], partAbouts: [{ kind: 'note', id: 'n1', section: 'waiting', line: 'Windows tests for the CLI' }] },
    {
      at: 27, kind: 'about', count: 1, quotes: ['both fine'], targetId: 'u-1', parts: [2, 3],
      partAbouts: [{ kind: 'note', id: 'n2', section: 'waiting', line: 'Docs page' }, { kind: 'reply', ref: 'k3f9q0', from: 'super', quote: 'Here is the plan' }],
    },
  ];

  it('each head shows its parts\' chips in their slots, then his words; stacked parts side by side', () => {
    const html = draw({ item: answer, replyHeads: heads });
    expect(count(html, 'data-testid="chat-reply-head"')).toBe(2);
    expect([...html.matchAll(/data-parts="([\d,]+)"/g)].map((m) => m[1])).toEqual(['1', '2,3']);
    expect([...html.matchAll(/class="chat-ref-chip"[^>]*data-slot="(\d)"/g)].map((m) => m[1])).toEqual(['1', '2', '3']);
    expect(html).toMatch(/Windows tests for the CLI.*yes, CLI only.*Docs page.*Super: Here is the plan.*both fine/s);
  });
});
