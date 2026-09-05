/**
 * Does `dream-ui` actually DRAW anything? The one question Wave 1 exists to answer.
 *
 * Every other lock on this experiment is structural — the setting coerces, the fence parses,
 * the chunk splits. None of them would notice if the grammar never rendered a single node,
 * which is exactly the failure this project has named before: a designed capability that was
 * never wired, green all the way to the user.
 *
 * So this renders a REAL block through the REAL library and asserts DOM comes out. No JSX
 * (the root vitest glob is `*.test.ts`), and no browser: `renderToString` is enough to prove
 * the parse→component path, and it fails loudly if the library needs something we haven't
 * given it. The package resolution rides the aliases in `vitest.config.ts`.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Renderer } from '@openuidev/react-lang';
import { openuiChatLibrary } from '@openuidev/react-ui';

/** The library's OWN documented example shape (`openuiChatExamples[0]`), trimmed. Taken from
 *  the package rather than invented, so this test measures the renderer and not my guess at
 *  the syntax — the first hand-written attempt used named arguments and rendered NOTHING,
 *  silently, which is the single most useful thing learned in Wave 1 and the reason the
 *  briefing (Wave 2) must be generated from the library instead of written by hand. */
const SAMPLE = [
  'root = Card([title, tbl])',
  'title = TextContent("Top Languages", "large-heavy")',
  'tbl = Table([Col("Language", langs), Col("Users (M)", users)])',
  'langs = ["Python", "JavaScript", "Java"]',
  'users = [15.7, 14.2, 12.1]',
].join('\n');

function render(source: string) {
  const errors: unknown[] = [];
  const html = renderToString(createElement(Renderer, {
    response: source,
    library: openuiChatLibrary,
    isStreaming: false,
    toolProvider: null,
    onError: (e: unknown) => { errors.push(e); },
  } as never));
  return { html, errors };
}

describe('dream-ui renders', () => {
  it('turns OpenUI Lang into real DOM, with no errors', () => {
    const { html, errors } = render(SAMPLE);
    expect(errors).toEqual([]);
    expect(html.length).toBeGreaterThan(200);
  });

  it('draws the CONTENT, not just a container', () => {
    const { html } = render(SAMPLE);
    // The words the source asked for have to survive the round trip; a card with an empty
    // body would pass a length check and fail the user.
    expect(html).toContain('Top Languages');
    expect(html).toContain('Python');
    expect(html).toContain('15.7');
    // And it must be a table, not a paragraph that happens to hold the words.
    expect(html).toContain('<table');
  });

  it('degrades quietly on garbage instead of throwing', () => {
    // The expected failure of this experiment: the model writes something the grammar does
    // not accept. It must not take the render down — `OpenUiView`'s boundary is the backstop,
    // not the first line of defence.
    expect(() => render('this is not openui lang at all {{{')).not.toThrow();
    expect(() => render('')).not.toThrow();
  });

  it('a plausible-but-wrong syntax renders nothing rather than something wrong', () => {
    // Named arguments look right and are not. Documented here because it is the shape of
    // mistake Wave 6 has to measure, and because a silent empty render is worse than an
    // error — it looks like the feature is broken rather than the answer.
    const { html } = render('root = Stack([t])\nt = TextContent(content="hello")');
    expect(html).not.toContain('hello');
  });
});
