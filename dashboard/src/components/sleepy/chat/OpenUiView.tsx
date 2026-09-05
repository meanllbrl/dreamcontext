/**
 * A ```dream-ui block — OpenUI Lang the AGENT wrote, drawn as real components.
 *
 * EXPERIMENTAL, and off unless `chatRender: 'openui'` is chosen in Settings → Agents. This
 * is the seam only: everything that actually knows about OpenUI lives in `OpenUiRenderer`,
 * behind a lazy import, so a user who never enables the mode never downloads a byte of it.
 *
 * HOW THIS DIFFERS FROM `dream-html`, because the difference is the whole experiment.
 * `HtmlView` renders agent-authored MARKUP, and its safety story is containment: a sandboxed
 * iframe with no `allow-same-origin` and a `default-src 'none'` CSP, so whatever the agent
 * wrote cannot reach the network or this origin no matter what it says. This view has no
 * such boundary — the components mount in the app's own React tree. Its safety story is
 * VOCABULARY instead: the agent writes a compact grammar, not markup, and the parser only
 * ever resolves it against a closed library of typed components. No string the agent wrote
 * becomes an element, an attribute or a URL by itself.
 *
 * That trade is real and it is the reason this ships behind a setting rather than as a
 * default. Three bounds keep it honest, and they belong HERE rather than in a later wave
 * because each one is cheap now and expensive to retrofit:
 *
 *   • `toolProvider={null}` — the renderer accepts a function map or an MCP client, which
 *     would let agent-authored UI CALL things. Categorically out. Pinned by a test.
 *   • `onAction` is not wired to anything that acts. A generated button can ask; it cannot
 *     do. Wiring it into the composer is Wave 5, and it goes through the gates
 *     `dream-actions` already passes, not around them.
 *   • An error is contained. A malformed answer must degrade to a notice, never take the
 *     transcript down with it — which an in-process render can otherwise do and an iframe
 *     never could.
 */
import { Component, Suspense, useEffect, useState, type ReactNode } from 'react';
import { lazyWithReload } from '../../../lib/lazyWithReload';
import { readAgentSettings, AGENT_SETTINGS_EVENT } from '../../../lib/agentSettings';
import './HtmlView.css';
import './OpenUiView.css';

/** The whole OpenUI dependency tree — parser, component library, charts — behind one
 *  dynamic import. Vite emits it as its own chunk, which is what makes A3 ("flag off →
 *  nothing is downloaded") a build fact rather than a promise. */
const OpenUiRenderer = lazyWithReload('OpenUiRenderer', () => import('./OpenUiRenderer'));

/**
 * A block whose fence has closed. `source` is OpenUI Lang, never markup.
 *
 * GATED on the setting, not merely on the agent's behaviour. In the default mode the agent
 * is never told this fence exists, so one should never arrive — but "should never arrive" is
 * not the same as "cannot", and the contract this experiment shipped under is that a brain
 * which has not opted in behaves exactly as it did before the mode existed. A pasted
 * example, a resumed transcript written in the other mode, or an agent inventing the fence
 * must therefore not silently mount 2MB of renderer and draw components at someone who
 * never asked for them. Off → a notice, which is what any unrenderable block gets.
 */
export function OpenUiView({ source, onAsk }: { source: string; onAsk?: (text: string) => void }) {
  if (!useOpenUiEnabled()) {
    return (
      <ul className="chat-view-notice">
        <li>A UI block was written here but not drawn — answer rendering is set to written HTML. (Settings → Agents → Answer rendering.)</li>
      </ul>
    );
  }
  return <OpenUiMount source={source} onAsk={onAsk} />;
}

/** The live setting. Subscribed rather than read once, so flipping it in Settings updates an
 *  open transcript — the SPAWN-time half (which mode the agent is briefed for) is a separate
 *  thing and deliberately does not move under a running session. */
function useOpenUiEnabled(): boolean {
  const [on, setOn] = useState(() => readAgentSettings().chatRender === 'openui');
  useEffect(() => {
    const sync = () => setOn(readAgentSettings().chatRender === 'openui');
    window.addEventListener(AGENT_SETTINGS_EVENT, sync);
    return () => window.removeEventListener(AGENT_SETTINGS_EVENT, sync);
  }, []);
  return on;
}

/** The lazy renderer behind its Suspense fallback and its error boundary. One place, so the
 *  finished block and the still-writing one cannot drift apart in how they fail. */
function OpenUiMount({ source, streaming, onAsk }: { source: string; streaming?: boolean; onAsk?: (text: string) => void }) {
  return (
    <OpenUiBoundary>
      <Suspense fallback={<OpenUiSkeleton label="Loading the renderer…" />}>
        <OpenUiRenderer source={source} streaming={streaming} onAsk={onAsk} />
      </Suspense>
    </OpenUiBoundary>
  );
}

/**
 * A `dream-ui` fence that is still being written — DRAWN, not stood in for.
 *
 * THE ONE PLACE THIS SURFACE BREAKS ITS OWN RULE, deliberately. `chatActions.ts` hides every
 * open fence because "half-written markup must never flash on screen", and for markup that
 * is exactly right: a partial `<div` is not a smaller picture, it is a broken document.
 *
 * openui-lang is not markup. It is line-oriented, every line is a complete statement, and
 * the parser is built to resolve partial input — so a partial program is a SMALLER version
 * of the same picture rather than a damaged one. Measured on a six-line program: the card is
 * on screen after line 1 and the table after line 4, and a cut in the MIDDLE of a line
 * renders the lines before it rather than throwing.
 *
 * The exception is therefore narrow and it is about this notation, not about a change of
 * mind: `dream-html`, `dream-view` and `dream-actions` all still hide until they close.
 *
 * `done` is what separates "still arriving" from "stopped here". A fence that never closed
 * because the answer ended is not a block in progress; it is a block that failed, and it
 * says so rather than spinning forever.
 */
export function OpenUiPending({ partial, done }: { partial: string; done?: boolean }) {
  const enabled = useOpenUiEnabled();
  const lines = partial.split('\n').filter((l) => l.trim()).length;

  // Off: the same neutral pill a still-writing `dream-view` gets. Promising "an interface"
  // that will then refuse to draw would be a worse lie than saying nothing specific.
  if (!enabled) return <OpenUiSkeleton label="Writing…" />;

  // The answer ended mid-block. Whatever arrived is incomplete by definition, and drawing a
  // truncated picture as though it were the answer would be the more confusing outcome.
  if (done) {
    return (
      <ul className="chat-view-notice">
        <li>A UI block was left unfinished — the answer ended before it closed. Its text is unaffected.</li>
      </ul>
    );
  }

  // Nothing legible yet (the fence line landed, the first statement has not). A skeleton is
  // honest here; an empty bordered box would read as a block that failed.
  if (lines === 0) return <OpenUiSkeleton label="Building an interface…" />;

  // No `onAsk` while streaming: a follow-up clicked from a half-written block would send a
  // question the answer had not finished proposing. The renderer disables form interaction
  // during streaming anyway; this makes the same statement about the one action we accept.
  return <OpenUiMount source={partial} streaming />;
}

function OpenUiSkeleton({ label }: { label: string }) {
  return (
    <div className="chat-view-pending" role="status" aria-live="polite">
      <span className="chat-view-pending-dots" aria-hidden>
        <span /><span /><span />
      </span>
      <span>{label}</span>
    </div>
  );
}

/**
 * Containment for an in-process render of agent-authored content.
 *
 * `dream-html` never needed one: a broken body breaks inside its own iframe document and the
 * transcript around it does not notice. Here a throw during render unmounts the nearest
 * boundary above it — which, without this, is the whole chat. The degradation contract this
 * surface already keeps for a dropped block ("the prose always survives") is therefore only
 * true in this mode if the failure stops at the block.
 */
class OpenUiBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Console rather than a report: this is an experiment the user opted into, and the
    // message is the developer's evidence for WHICH construct broke.
    console.error('[dream-ui] render failed', error);
  }

  render() {
    if (this.state.failed) {
      return (
        <ul className="chat-view-notice">
          <li>A UI block could not be drawn — the answer's text is unaffected. (Answer rendering is set to OpenUI, which is experimental.)</li>
        </ul>
      );
    }
    return this.props.children;
  }
}
