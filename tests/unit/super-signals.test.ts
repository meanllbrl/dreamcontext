/**
 * What a child's frame tells the Super Agent's stage (jarvis plan r9, S1-S2): a loopback pin, a
 * pin withdrawn, a call to the overridden Playwright server. Anything else is nothing.
 */
import { describe, it, expect } from 'vitest';
import { signalsOf } from '../../src/lib/super/signals.js';

const text = (t: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const pin = (spec: unknown) => text(`Started.\n\n\`\`\`dream-view\n${JSON.stringify(spec)}\n\`\`\`\n`);

describe('signalsOf', () => {
  it('a pin with a loopback url is a dev-server signal; drop is its withdrawal', () => {
    expect(signalsOf(pin({ type: 'pin', id: 'dev', facts: [{ label: ':5173', url: 'http://localhost:5173' }] }), null))
      .toEqual([{ kind: 'devserver', url: 'http://localhost:5173/' }]);
    expect(signalsOf(pin({ type: 'pin', id: 'dev', drop: true }), null)).toEqual([{ kind: 'devserver-drop' }]);
  });

  it('a call to the overridden Playwright server is a browser signal, only when there is an override', () => {
    const call = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__playwright__browser_navigate', input: {} }] } };
    expect(signalsOf(call, 'playwright')).toEqual([{ kind: 'browser' }]);
    expect(signalsOf(call, null)).toEqual([]);
    expect(signalsOf(call, 'other')).toEqual([]);
  });

  it('nothing for broken JSON, a partial fence, an https pin, a fence inside a tool result, or another frame type', () => {
    expect(signalsOf(text('```dream-view\n{"type":"pin", "facts": [\n```'), null)).toEqual([]);
    expect(signalsOf(text('```dream-view\n{"type":"pin","facts":[{"url":"http://localhost:5173"}]}'), null)).toEqual([]);
    expect(signalsOf(pin({ type: 'pin', facts: [{ url: 'https://example.com' }] }), null)).toEqual([]);
    expect(signalsOf(pin({ type: 'pin', facts: [{ url: 'http://0.0.0.0:5173' }] }), null)).toEqual([]);
    const quoted = { type: 'user', message: { content: [{ type: 'tool_result', content: '```dream-view\n{"type":"pin","facts":[{"url":"http://localhost:3000"}]}\n```' }] } };
    expect(signalsOf(quoted, 'playwright')).toEqual([]);
    expect(signalsOf({ type: 'assistant', message: { content: [{ type: 'tool_result', content: '"pin" dream-view' }] } }, null)).toEqual([]);
    expect(signalsOf(null, null)).toEqual([]);
    expect(signalsOf('x', null)).toEqual([]);
  });
});
