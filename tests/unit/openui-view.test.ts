/**
 * Source-level locks on the `dream-ui` experiment (Settings → Agents → "Answer rendering").
 *
 * Why these are asserted against the SOURCE rather than exercised at runtime: both are
 * properties of how the module is WIRED, and the failure modes they guard are silent. A
 * `toolProvider` handed to the renderer would not throw; it would quietly let agent-authored
 * UI call tools. A static import of the OpenUI tree would not throw either; it would quietly
 * put ~370 packages into the main bundle of every user who never turned the mode on.
 *
 * This is the same shape as the project's other marker tests: the thing that must not drift
 * is spelled out once, here, so a well-meaning edit fails a test instead of shipping.
 */
import { describe, it, expect } from 'vitest';
import { askTextFor, ASK_MAX_CHARS } from '../../dashboard/src/components/sleepy/chat/openuiAction.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CHAT_DIR = 'dashboard/src/components/sleepy/chat';
const read = (p: string) => readFileSync(p, 'utf-8');

describe('dream-ui — the renderer may never be handed tools', () => {
  const renderer = read(join(CHAT_DIR, 'OpenUiRenderer.tsx'));

  it('passes toolProvider={null} explicitly', () => {
    // Explicit, not omitted: the prop is optional, so leaving it out would also disable
    // tools today — but it would read as an oversight, and the next person adding a
    // `toolProvider` would not be contradicting anything visible.
    expect(renderer).toMatch(/toolProvider=\{null\}/);
  });

  it('never passes anything else as a toolProvider', () => {
    const providers = renderer.match(/toolProvider=\{[^}]*\}/g) ?? [];
    expect(providers).toEqual(['toolProvider={null}']);
  });

  it('does not import an MCP client into the chat surface', () => {
    expect(renderer).not.toContain('@modelcontextprotocol');
  });
});

describe('dream-ui — the dependency tree stays behind a lazy import', () => {
  /** Every source file under the chat surface, so the check cannot be dodged by adding the
   *  import somewhere else in the same folder. */
  const chatFiles = readdirSync(CHAT_DIR)
    .filter((f) => /\.(ts|tsx)$/.test(f) && statSync(join(CHAT_DIR, f)).isFile());

  it('only the renderer and the library definition import @openuidev', () => {
    // Two legitimate importers, and no third. `openuiLibrary.ts` OWNS the vocabulary (it is
    // what the briefing generator reads); `OpenUiRenderer.tsx` renders against it. Both sit
    // behind the same dynamic import, which is what keeps the tree out of the main bundle.
    const importers = chatFiles.filter((f) => /from '@openuidev\//.test(read(join(CHAT_DIR, f)))).sort();
    expect(importers).toEqual(['OpenUiRenderer.tsx', 'openuiLibrary.ts']);
  });

  it('nothing eagerly loaded reaches the library either', () => {
    // The subtler half of the same guarantee: `openuiLibrary.ts` pulls in the whole dependency
    // tree, so ANY statically-loaded file importing it would undo the split just as surely as
    // importing @openuidev directly. Only the lazy renderer may.
    const eager = chatFiles
      .filter((f) => f !== 'OpenUiRenderer.tsx' && f !== 'openuiLibrary.ts')
      .filter((f) => /from '\.\/openuiLibrary/.test(read(join(CHAT_DIR, f))));
    expect(eager).toEqual([]);
  });

  it('OpenUiView reaches it through lazyWithReload, never a static import', () => {
    const view = read(join(CHAT_DIR, 'OpenUiView.tsx'));
    expect(view).toContain("lazyWithReload('OpenUiRenderer'");
    expect(view).toMatch(/import\('\.\/OpenUiRenderer'\)/);
    // A static import of the renderer module would pull the whole tree into the parent
    // chunk and defeat the dynamic one sitting right next to it.
    expect(view).not.toMatch(/^import .* from '\.\/OpenUiRenderer'/m);
  });

  it('nothing outside the chat surface pulls it in either', () => {
    // The transcript reaches a ui block through ChatViews' dispatch, which imports the SEAM
    // (OpenUiView), not the renderer.
    expect(read(join(CHAT_DIR, 'ChatViews.tsx'))).toContain("from './OpenUiView'");
    expect(read(join(CHAT_DIR, 'ChatViews.tsx'))).not.toContain('OpenUiRenderer');
  });
});

describe('dream-ui — the setting gates the RENDER, not just the briefing', () => {
  const view = read(join(CHAT_DIR, 'OpenUiView.tsx'));

  it('consults chatRender before mounting anything', () => {
    // The briefing (which tells the agent the fence exists) is a Wave 2 concern and lives
    // server-side. This is the other half: a transcript that already contains a `dream-ui`
    // block — pasted, resumed from a session in the other mode, or invented — must not draw
    // components at a user who never opted in. Without this the "flag off changes nothing"
    // contract is false for exactly the case nobody tests by hand.
    expect(view).toMatch(/chatRender === 'openui'/);
    expect(view).toContain('readAgentSettings');
  });

  it('degrades to a notice rather than to silence when the mode is off', () => {
    expect(view).toContain('chat-view-notice');
    expect(view).toMatch(/not drawn/);
  });

  it('follows a live change to the setting', () => {
    // Subscribed, not read once: flipping the setting with a transcript open should not need
    // a reload to take effect.
    expect(view).toContain('AGENT_SETTINGS_EVENT');
  });
});

describe('dream-ui — an in-process render is contained', () => {
  const view = read(join(CHAT_DIR, 'OpenUiView.tsx'));

  it('wraps the render in an error boundary', () => {
    // `dream-html` needs none: a broken body breaks inside its own iframe. This one mounts
    // in the app's React tree, so without a boundary a throw takes the transcript with it —
    // and the surface's degradation contract ("the prose always survives") would be false
    // in this mode only.
    expect(view).toContain('getDerivedStateFromError');
    expect(view).toContain('componentDidCatch');
  });
});

describe('dream-ui — the streaming exception is bounded and the failures are named', () => {
  const view = read(join(CHAT_DIR, 'OpenUiView.tsx'));
  const renderer = read(join(CHAT_DIR, 'OpenUiRenderer.tsx'));

  it('draws a still-open fence instead of standing in for it', () => {
    // The exception itself. Justified by measurement, not by the vendor's claim — see
    // `openui-streaming.test.ts`, which proves a partial program is a smaller picture.
    expect(view).toMatch(/streaming\b/);
    expect(renderer).toContain('isStreaming={streaming}');
  });

  it('applies the exception to `ui` ONLY', () => {
    // `dream-html`, `dream-view` and `dream-actions` keep hiding until they close: partial
    // markup is a broken document, not a smaller one.
    const actions = read(join(CHAT_DIR, 'chatActions.ts'));
    expect(actions).toContain('half-written markup must never flash on screen');
    const views = read(join(CHAT_DIR, 'ChatViews.tsx'));
    expect(views).toContain("segment.fence === 'html'");
    expect(views).toMatch(/HtmlPending/);
  });

  it('reports a fence that never closed instead of spinning forever', () => {
    // An answer that ended mid-block is a failure, not work in progress. Without the `done`
    // signal the skeleton would spin for the life of the transcript.
    expect(view).toMatch(/done\?: boolean|done\}/);
    expect(view).toContain('left unfinished');
  });

  it('reports a block that drew NOTHING — the silent failure of this grammar', () => {
    // The first hand-written sample in this project rendered empty with no error at all,
    // because the grammar is positional. A parse-result check would not have caught it; the
    // program parsed and resolved to nothing. So the question is asked of the DOM.
    expect(renderer).toContain('drewNothing');
    expect(renderer).toMatch(/querySelector\('\*'\)/);
    expect(renderer).toContain('drew nothing');
  });

  it('never renders the parser error text itself', () => {
    // A parser message quotes the source. Raw openui-lang in the transcript is the one
    // thing this surface must not show — the reason is named by KIND, never by excerpt.
    expect(renderer).toContain('raw openui-lang spilled into the');
    expect(renderer).not.toMatch(/\{errors\[0\]/);
    expect(renderer).not.toMatch(/JSON\.stringify\(errors/);
  });
});

describe('dream-ui — the action gate is a whitelist of one', () => {
  const ev = (over = {}) => ({ type: 'continue_conversation', params: {}, humanFriendlyMessage: 'Tell me more', ...over });

  it('accepts a continue-the-conversation and returns its TEXT', () => {
    expect(askTextFor(ev())).toBe('Tell me more');
    expect(askTextFor(ev({ params: { message: 'Show the numbers' } }))).toBe('Show the numbers');
  });

  it('REFUSES open_url — the whole reason Button is not in the vocabulary', () => {
    // `dream-actions` gates its `url` kind to https on the client AND again in Rust. An
    // OpenUrl action arriving through a component would be a second route to the same
    // affordance with none of that. Refused by type, before the URL is even looked at.
    expect(askTextFor(ev({ type: 'open_url', params: { url: 'https://example.com' } }))).toBeNull();
    expect(askTextFor(ev({ type: 'open_url', params: { url: 'file:///etc/passwd' } }))).toBeNull();
  });

  it('refuses anything it does not recognise, including a future type', () => {
    for (const type of ['run_tool', 'submit_form', 'custom', '', null, undefined, 42]) {
      expect(askTextFor(ev({ type })), `accepted ${String(type)}`).toBeNull();
    }
    expect(askTextFor(null)).toBeNull();
    expect(askTextFor('continue_conversation')).toBeNull();
  });

  it('refuses empty text and bounds the length', () => {
    expect(askTextFor(ev({ humanFriendlyMessage: '   ' }))).toBeNull();
    expect(askTextFor(ev({ params: { message: 'x'.repeat(ASK_MAX_CHARS + 1) }, humanFriendlyMessage: '' }))).toBeNull();
    expect(askTextFor(ev({ params: { message: 'x'.repeat(ASK_MAX_CHARS) } }))).toHaveLength(ASK_MAX_CHARS);
  });

  it('carries no payload beyond the text', () => {
    // Whatever else the event holds — form state, params, a tool name — only a string comes
    // out. That is what makes "may ask, cannot act" a property rather than an intention.
    const out = askTextFor(ev({ params: { message: 'Go on', url: 'https://x.test', toolName: 'rm' } }));
    expect(typeof out).toBe('string');
    expect(out).toBe('Go on');
  });
});

describe('dream-ui — the ask reuses the dream-actions validator', () => {
  const item = read(join(CHAT_DIR, 'TranscriptItem.tsx'));

  it('converts a follow-up into an ordinary ask through toAction', () => {
    // One definition of what an "ask" may be, not two. A second hand-rolled path here would
    // be free to drift from the one every button already takes.
    expect(item).toContain('toAction({');
    expect(item).toMatch(/action: 'ask'/);
  });

  it('renders the follow-up inert on a host with no action sink', () => {
    expect(item).toContain('if (!onAction) return undefined;');
  });

  it('does not accept clicks while the block is still streaming', () => {
    const view = read(join(CHAT_DIR, 'OpenUiView.tsx'));
    expect(view).toContain('No `onAsk` while streaming');
    expect(view).toMatch(/<OpenUiMount source=\{partial\} streaming \/>/);
  });
});
