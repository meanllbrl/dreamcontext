/**
 * A SECTIONED Super reply drawn (owner 2026-10-24, pick A): one answer body, every part opening
 * with the head of the message it answers, a dashed rule before each later part; a section whose
 * refs resolved to nothing keeps its rule and has no head; the same text without heads draws as
 * before. Server-rendered with the app's providers; the browser check is scripts/verify/super-reply.mjs.
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

const TEXT = 'The checkout tests still run.\n\nThe card is renamed.\n\nNobody asked this.';
const item = { kind: 'text', id: 't-1', index: 0, text: TEXT, done: true, ts: 1, replySections: [{ at: 0, refs: ['aaaaaa'] }, { at: 31, refs: ['bbbbbb'] }, { at: 53, refs: ['zzzzzz'] }] };
const heads = [
  { at: 0, kind: 'reply', count: 1, quotes: ['Is the Orbit checkout form green?'], targetId: 'u-1' },
  { at: 31, kind: 'about', about: { kind: 'note', id: 'n4', section: 'waiting', line: 'Rename the pricing card' }, count: 1, quotes: ['is it done?'], targetId: 'u-2' },
];
const count = (html: string, s: string) => html.split(s).length - 1;

describe('a sectioned reply', () => {
  it('one body, a head per resolved section, a rule before each later part, no mark', () => {
    const html = draw({ item, replyHeads: heads });
    expect(count(html, 'class="chat-msg-assistant-body"')).toBe(1);
    expect(count(html, 'data-testid="chat-reply-head"')).toBe(2);
    expect(count(html, 'chat-reply-part--divider')).toBe(2);
    // Three parts in order (markdown fills its bodies after mount): ↩ head, About head, no head.
    expect(count(html, 'class="chat-reply-part')).toBe(3);
    expect(html).toMatch(/<div class="chat-reply-part"><button[^>]*data-kind="reply">.*↩.*To your message.*Is the Orbit checkout form green\?<\/span><\/button><div class="md-preview">/s);
    expect(html).toMatch(/chat-reply-part--divider"><button[^>]*data-kind="about"><span class="chat-msg-about-dot".*About.*Rename the pricing card.*is it done\?/s);
    expect(html).toMatch(/chat-reply-part--divider"><div class="md-preview">/);
    expect(html).not.toContain('&lt;!--');
    expect(html).not.toContain('To 3 messages');
  });

  it('the same text with no heads (not sectioned) draws exactly as before: no head, no part', () => {
    const html = draw({ item });
    expect(html).not.toContain('chat-reply-head');
    expect(html).not.toContain('chat-reply-part');
    expect(html).toBe(draw({ item: { ...item, replySections: undefined } }));
  });
});
