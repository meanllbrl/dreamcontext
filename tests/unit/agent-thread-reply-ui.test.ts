/**
 * The thread panel's reply surface — the properties a review misses and a scan catches.
 *
 * WHY THIS FILE IS A SOURCE SCAN. `AgentThreadPanel.tsx` and `agentsChannelHost.ts` are React
 * modules with CSS imports behind them, and root vitest runs under plain Node with no jsdom,
 * so they cannot be mounted here. The repo already answers this exact problem the same way —
 * `voice-composer-guard.test.ts` pins a render CONDITION by reading the source, and
 * `chat-draft-carry.test.ts` pins two respawn sites the same way "because the bug came from
 * code that ISN'T there".
 *
 * WHAT THAT BUYS AND WHAT IT DOES NOT. A scan proves the property is WRITTEN — the refusal
 * returns false, the composer is the shared one, the blocked branch draws no field. It cannot
 * prove the runtime behaviour, which is what `scripts/verify/agent-threads.mjs` drives in a
 * real browser. The two are complementary: the scan fails fast in the unit suite on a
 * refactor that deletes a guard, the verify script proves the guard does its job.
 *
 * EVERY ASSERTION HERE WAS MUTATION-TESTED — each one was shown to fail against the mutant
 * that removes the property it pins, before it was accepted.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const PANEL = 'dashboard/src/components/agents/AgentThreadPanel.tsx';
const HOST = 'dashboard/src/components/agents/agentsChannelHost.ts';
const MESSAGE = 'dashboard/src/components/agents/AgentMessage.tsx';
const TABS = 'dashboard/src/components/sleepy/AgentTabs.tsx';
const SURFACE = 'dashboard/src/components/sleepy/AgentSurface.tsx';
const PAGE = 'dashboard/src/pages/AutomationsPage.tsx';
const HOOKS = 'dashboard/src/hooks/useAutomations.ts';

/**
 * Source with COMMENTS removed but strings kept.
 *
 * Comments have to go: every mechanism below is documented at length at its own site, and a
 * naive substring scan would pass on the prose EXPLAINING the rule rather than the code
 * holding it — which teaches the next person to delete the explanation instead of the
 * property. Strings stay: the i18n keys and class names ARE string literals.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // line comments (not the // of a URL)
}

const panel = code(read(PANEL));
const host = code(read(HOST));
const message = code(read(MESSAGE));
const tabs = code(read(TABS));
const surface = code(read(SURFACE));
const page = code(read(PAGE));
const hooks = code(read(HOOKS));

// ── The composer is the shared one ───────────────────────────────────────────────────────

describe('the thread composer is the chat\'s own component', () => {
  it('mounts <Composer>, and does not hand-roll a textarea', () => {
    // pattern-component-reuse-over: the panel shipped with a disabled bespoke `<textarea>` in
    // step 2 precisely because replying did not exist yet. Now that it does, a textarea here
    // would be the hand-rolled copy the pattern exists to refuse — no slash menu, no
    // attachments, no drafts, and drifting the moment the real composer moves.
    expect(panel).toMatch(/<Composer\b/);
    expect(panel).not.toMatch(/<textarea\b/);
  });

  it('suppresses the model trigger rather than forking the component', () => {
    // An automation replies on the model IT is configured with, so the picker would change
    // nothing. `showModel={false}` is the component's own prop for that — the precedent it
    // documents — and NOT a second Composer with the control deleted.
    expect(panel).toMatch(/showModel=\{false\}/);
  });

  it('passes busy={false} — a reply is a job, not a steerable turn', () => {
    // `busy` draws the steer/queue affordances, and there is no live turn behind them here:
    // the reply is polled through `reply-job/:id`. Drawing them would offer a control whose
    // delivery is an unreachable no-op.
    expect(panel).toMatch(/busy=\{false\}/);
  });
});

// ── The refusal contract: a refused send keeps the draft AND the chips ────────────────────

describe('useAgentThreadHost refuses without clearing', () => {
  it('returns false on an empty body, never undefined', () => {
    // THE WHOLE MECHANISM. `commit()` early-returns before any clearing when `send` answers
    // false, so the sentence and any staged attachment chips are simply never taken away.
    // Returning `undefined` (the delivered signal) would let the clear run and drop the
    // chips silently — the exact failure the channel's own review caught and fixed.
    const send = host.slice(host.indexOf('export function useAgentThreadHost'));
    expect(send).toMatch(/return false as const/);
  });

  it('names its own scratch bucket, per slug', () => {
    // `claudeId: ''` means "no conversation", and `composerScratch` keys attachments by that
    // id — so an unnamed bucket would pool this panel's staged files with the channel's and
    // the meeting room's, which is the collision the channel had to name its bucket to escape.
    // The id is built in `threadScratchId` (which also registers it for the page's revoke);
    // what this pins is that it is still PER SLUG rather than one shared key.
    expect(host).toMatch(/const id = `agents-thread-\$\{slug\}`/);
    expect(host).toMatch(/function threadScratchId\(slug: string\)/);
  });

  it('clears the draft only on the delivered path', () => {
    const fn = host.slice(host.indexOf('export function useAgentThreadHost'));
    // The assignment must come AFTER the refusal returns — a clear above the guard would
    // empty the field for a send that never happened.
    expect(fn.indexOf('return false as const')).toBeLessThan(fn.indexOf("draft.current = ''"));
  });
});

// ── A control is drawn only when there is something behind it ─────────────────────────────

describe('a disabled or unapproved agent gets no field at all', () => {
  it('derives the block from enabled AND approved', () => {
    // These are the server's first two refusal rungs (`reply_disabled`, `reply_unapproved`),
    // checked before it reads the body — so a composer on an agent failing either could only
    // ever be told no.
    expect(panel).toMatch(/agent\.enabled/);
    expect(panel).toMatch(/agent\.approved/);
  });

  it('renders the Composer only on the unblocked branch', () => {
    // The ternary is the guard: `blocked ? <p…> : <><Composer…></>`. A Composer outside it
    // would be a field whose every use is already decided against.
    expect(panel).toMatch(/blocked \?[\s\S]*?<Composer/);
  });
});

// ── The refusals speak the server's words ────────────────────────────────────────────────

describe('refusals quote the server, except the one rung a user reaches by accident', () => {
  it('reads the error CODE, not the English of the message', () => {
    // Matching on the prose would be a UI that breaks the first time a route rewords itself.
    // `RequestError` carries the route's own `error` slug for exactly this.
    expect(panel).toMatch(/\.code/);
  });

  it('translates stale_run and only stale_run', () => {
    // Every other rung names a state the reader can see (off, unapproved, busy, a question
    // open). `stale_run` is the one that fires during ordinary use — a scheduled fire or
    // someone's @mention opened a newer run while the panel sat open — so it is the one
    // written for that moment rather than quoted from a validator.
    expect(panel).toMatch(/code === 'stale_run'[\s\S]{0,80}agents\.thread\.stale/);
  });

  it('opens the question inline on question_pending', () => {
    // The refusal names the one thing that has to happen before a reply can land, so the
    // block that does it is rendered where the refusal was read.
    expect(panel).toMatch(/code === 'question_pending'/);
    expect(panel).toMatch(/<AgentQuestionBlock/);
  });
});

// ── The message's two controls ───────────────────────────────────────────────────────────

describe('the message names actions it can now perform', () => {
  it('says "Reply in thread" through i18n, not a hardcoded string', () => {
    // The step-2 wording was "Open thread" because replying did not exist. It does now, and
    // the label has to survive Turkish — so it comes from `t()`, not from the JSX.
    expect(message).toMatch(/t\('agents\.thread\.reply'\)/);
    expect(message).not.toMatch(/>\s*Open thread\s*</);
  });

  it('reports the Open-session ACK instead of assuming it opened', () => {
    // `openAutomationRunChat` returns whether a surface actually took the hand-off; a button
    // that silently does nothing is the failure that ACK exists to make impossible.
    expect(message).toMatch(/const accepted = openAutomationRunChat/);
    expect(message).toMatch(/if \(!accepted\)[\s\S]{0,60}agents\.openSessionFailed/);
  });
});

// ── The chat tab wears the agent's face ──────────────────────────────────────────────────

describe('an automation tab is drawn as its agent, not as a glyph', () => {
  it('the view-model carries the slug, read off the roster entry', () => {
    // The producer half. `SessionMeta.automation` is already round-tripped through the
    // server roster, so this persists nothing new — it only stops the strip throwing the
    // provenance away on its way into the tab.
    expect(surface).toMatch(/automationSlug: meta\?\.automation\?\.slug/);
  });

  it('TabVM declares the field as optional', () => {
    // OPTIONAL is the compatibility contract: an automation tab restored from a roster
    // written before this existed has no slug, and must fall through to the glyph rather
    // than render a broken avatar.
    expect(tabs).toMatch(/automationSlug\?: string/);
  });

  it('draws the agents surface\'s own avatar, not a second image element', () => {
    // The same component the roster and the channel use, so a photo replaced in place looks
    // the same in all three — and its initials fallback comes along for free.
    expect(tabs).toMatch(/import \{ AgentAvatar \} from '\.\.\/agents\/AgentAvatar'/);
    expect(tabs).toMatch(/<AgentAvatar[\s\S]{0,120}size=\{14\}/);
  });

  it('resolves the photo ONLY for an automation tab that has one', () => {
    // Three guards, and each one is a case where the avatar would be a lie: the wrong kind,
    // a roster entry with no slug, and an agent with no photo (initials in a 14px mono slot
    // beside the title that already says the name is noise).
    expect(tabs).toMatch(/tab\.sessionKind !== 'automation' \|\| !tab\.automationSlug/);
    expect(tabs).toMatch(/!agent\?\.hasPhoto/);
  });

  it('keeps the glyph as the fallback, and every other kind untouched', () => {
    // The whole ternary survives behind `photoFor(tab) ?? (…)`: a shell is still `>_`, a
    // chat still `◆`, an agent still `◇`, and an automation with no photo still `⬡`.
    expect(tabs).toMatch(/photoFor\(tab\) \?\? \(/);
    for (const glyph of ['>_', '◆', '⬡', '◇']) expect(tabs).toContain(glyph);
  });
});

// ── The thread composer's object URLs are revoked ────────────────────────────────────────

describe('thread scratch buckets are dropped, and dropped in the right place', () => {
  it('the page revokes them on unmount, beside the channel\'s', () => {
    // WITHOUT THIS a pasted image in a thread reply holds its object URL for the life of the
    // app run, one bucket per agent — `dropScratch` is otherwise only ever called for
    // 'agents-channel', 'meeting-room' and real conversations.
    expect(page).toMatch(/dropScratch\('agents-channel'\)/);
    expect(page).toMatch(/dropThreadScratch\(\)/);
  });

  it('the drop does NOT hang off the panel\'s own unmount', () => {
    // `composerScratch`'s header: a chip is revoked "NOT when a pane unmounts, which is the
    // whole point of this module". `AgentThreadPanel` is `{openThread && …}`, so it unmounts
    // on every close — a cleanup in the hook would bin a file staged a second earlier, which
    // is the exact bug the CHANNEL already hit and fixed by moving its drop up to the page.
    const fn = host.slice(host.indexOf('export function useAgentThreadHost'));
    expect(fn).not.toMatch(/dropScratch/);
  });

  it('every minted bucket is registered, so the page can find them', () => {
    // The page cannot name them — there is one per agent and it does not know which threads
    // were opened — so the host that mints the ids keeps the list.
    expect(host).toMatch(/threadScratchIds\.add\(id\)/);
    expect(host).toMatch(/scratchId: threadScratchId\(/);
  });
});

// ── The reply poller is bounded and cancellable ──────────────────────────────────────────

describe('the reply poll chain cannot outlive its component or a dead server', () => {
  it('cancels the pending timer on unmount', () => {
    // `setTimeout` outlives the component that armed it. Without this, navigating away
    // mid-turn leaves a request loop running against a cache nothing reads.
    expect(hooks).toMatch(/clearTimeout\(timer\.current\)/);
    expect(hooks).toMatch(/alive\.current = false/);
  });

  it('refuses to arm another tick once unmounted', () => {
    // The in-flight request resolves AFTER the cleanup ran, so the guard has to be on the
    // arming path too — clearing the handle alone would not stop the next one.
    expect(hooks).toMatch(/if \(!alive\.current\) return;[\s\S]{0,80}timer\.current = setTimeout/);
  });

  it('stops after a consecutive-error budget instead of retrying forever', () => {
    // A 404 was already terminal; every other failure retried every 2s for as long as the tab
    // lived. Past the budget the server is not answering and `unknown` is the honest report.
    expect(hooks).toMatch(/REPLY_POLL_MAX_ERRORS = \d+/);
    expect(hooks).toMatch(/\+\+errors >= REPLY_POLL_MAX_ERRORS/);
  });

  it('resets the budget on any answered poll', () => {
    // A long turn punctuated by the odd blip must still run to its real end, so the counter
    // measures CONSECUTIVE failures rather than total ones.
    //
    // Pinned to the SUCCESS PATH specifically — the reset has to follow the answered
    // request. A looser `/errors = 0/` also matches the `let errors = 0` declaration, so it
    // passed against a mutant that deleted the reset entirely.
    expect(hooks).toMatch(/await api\.get<\{ job: ReplyJobState \}>[^;]*;\s*errors = 0;/);
  });
});
