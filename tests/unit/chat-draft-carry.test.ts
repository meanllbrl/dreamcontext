/**
 * A chat control that RELOADS the conversation must not eat the half-typed message.
 *
 * Two of the composer's four controls respawn the process rather than switching it live:
 *
 *   • MODE (Basic/Plan/Develop) is an `--append-system-prompt-file`, fixed at spawn — there is
 *     no live-switch control frame for it, so `changeChatMode` disposes and re-spawns.
 *   • PERMISSION → Bypass is attempted live first, but CLI 2.1.220 REFUSES every live switch
 *     into bypass, so `resumeChatSession` (the documented fallback) is the path it
 *     actually takes — the normal case, not an edge case.
 *
 * A chat pane's identity IS its session object (`ChatPaneHost` is keyed by session id and
 * portaled into that session's own container), and the textarea's text is LOCAL React state.
 * So a respawn unmounts the pane holding the draft. Nothing about that is visible at either
 * respawn site — the loss came from code that ISN'T there — which is exactly the class of
 * defect review does not catch and a source scan does.
 *
 * The last test here is about the same respawn from the other side: iterating the LIVE session
 * Map while the fallback registers a replacement into it re-enters, so one click could spawn
 * `claude` without bound. Both properties are invisible at the call site.
 *
 * Checked against the SOURCE because root vitest runs under plain Node (no jsdom) and
 * `AgentSurface.tsx` is a React module with CSS imports it could not load anyway. The live
 * behaviour is asserted separately, against a real Chromium and a real process, by
 * `scripts/verify/chat-composer-ui.mjs` (§12).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const SURFACE = 'dashboard/src/components/sleepy/AgentSurface.tsx';
const COMPOSER = 'dashboard/src/components/sleepy/chat/Composer.tsx';
const SESSION = 'dashboard/src/components/sleepy/chatSession.ts';

/**
 * Source with COMMENTS removed but strings kept.
 *
 * Comments have to go: all three files document this mechanism at length, and a naive
 * substring scan would pass on the prose that explains the rule rather than the code that
 * holds it — which teaches the next person to delete the explanation instead of the property.
 * Strings have to STAY: the respawn sites are identified by their `'chat'` kind argument.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // line comments (not the // of a URL)
}

/**
 * Every `spawn(…, 'chat', …)` call in AgentSurface, tagged with the name of the callback it
 * sits in and the slice of that callback which PRECEDES it. Two things are read off that
 * slice: whether the site replaces a session it just disposed (a RESPAWN, as opposed to
 * opening a new conversation), and whether the session it replaces is a chat one — only a
 * chat session has a mirrored `conv.draft` to inherit.
 */
function chatSpawnSites(src: string): Array<{ name: string; index: number; before: string }> {
  const out: Array<{ name: string; index: number; before: string }> = [];
  const re = /spawn\((?:[^()\n]|\([^()\n]*\))*\)/g;
  for (const m of src.matchAll(re)) {
    if (!/(?:,|\()\s*'chat'/.test(m[0])) continue;
    const index = m.index ?? 0;
    const head = src.slice(0, index);
    const declAt = head.lastIndexOf('= useCallback(');
    const nameAt = head.lastIndexOf('const ', declAt);
    out.push({
      name: head.slice(nameAt + 6, head.indexOf(' ', nameAt + 6)),
      index,
      before: head.slice(declAt),
    });
  }
  return out;
}

describe('a chat respawn carries the composer draft', () => {
  it('has exactly one carry helper, and it uses the epoch-bumping insert path', () => {
    const src = code(read(SURFACE));
    expect(src).toContain('function carryDraftInto(');
    // `sendText`, NOT `syncDraft`. `syncDraft` is a mirror-only write with no subscriber fire
    // and no `draftEpoch` bump by design, so a Composer that mounted BEFORE the carry (a
    // render ordering this code must not depend on) would never adopt it. `sendText` bumps the
    // epoch, which is the adoption signal.
    const helper = src.slice(src.indexOf('function carryDraftInto('));
    const body = helper.slice(0, helper.indexOf('\n}') + 2);
    expect(body).toContain('sendText');
    expect(body).not.toContain('syncDraft');
    // Guarded on a non-empty draft: an unconditional call would bump `draftEpoch` on every
    // respawn, making a fresh Composer run its adoption effect (and reset any history walk)
    // for a draft that does not exist.
    expect(body).toMatch(/if\s*\(\s*draft\s*\)/);
  });

  it('carries the draft at EVERY chat-to-chat respawn site', () => {
    const src = code(read(SURFACE));
    const sites = chatSpawnSites(src);
    // Sanity: if this drops to zero the regex has rotted and every assertion below is vacuous.
    expect(sites.length, 'no spawn(…, chat, …) call sites found — re-derive this test').toBeGreaterThan(2);

    // A RESPAWN replaces a session it just disposed. A spawn of a NEW conversation (⌘T, the
    // Plan→Develop hand-off, the skill-insert fallback, a DORMANT tab's resume — whose session
    // object is long gone) has no draft to inherit and must not be forced to carry one.
    const replacements = sites.filter((s) => /\.dispose\(\)/.test(s.before));
    // …and only a CHAT session has a mirrored draft. The type marker is what says so: the
    // callback either takes a `ChatSession` or narrows one out of the roster's union.
    const fromChat = replacements.filter((s) => /ChatSession/.test(s.before));
    const fromTerminal = replacements.filter((s) => !/ChatSession/.test(s.before));

    // Named, not merely excluded: terminal→chat conversion disposes a PTY session whose
    // half-typed line lives in the CLI's own readline, not in a model this app can read. If a
    // NEW respawn path lands in this bucket, this assertion fails and somebody has to decide
    // which bucket it belongs in — which is the whole point of counting them.
    expect(fromTerminal.map((s) => s.name)).toEqual(['openAgentInChat']);
    expect(
      fromChat.map((s) => s.name).sort(),
      'expected exactly the mode switch and the permission/resume fallback',
    ).toEqual(['changeChatMode', 'resumeChatSession']);

    for (const site of fromChat) {
      // 1. The draft is READ, and read BEFORE the dispose that ends the outgoing session.
      const readAt = site.before.search(/getModel\(\)\.draft/);
      const disposeAt = site.before.search(/\.dispose\(\)/);
      expect(readAt, `${site.name} does not read the outgoing draft`).toBeGreaterThan(-1);
      expect(readAt, `${site.name} reads the draft AFTER dispose — read it first`).toBeLessThan(disposeAt);
      // 2. It is handed to the incoming session, right where it is spawned.
      const after = src.slice(site.index, site.index + 400);
      expect(after, `${site.name} does not carry the draft over`).toContain('carryDraftInto(');
    }
  });

  /**
   * Found while fixing the draft loss, in the same function: the permission fallback is
   * REENTRANT unless the roster is snapshotted first.
   *
   * `Map.prototype.forEach` visits entries added during iteration. `setPermissionMode` fails
   * SYNCHRONOUSLY on a non-OPEN socket (`sendControl` returns false), so for an ended or
   * still-connecting tab the fallback respawn ran inside the loop, registered its replacement,
   * and the loop visited THAT — whose socket was necessarily still CONNECTING, so it failed the
   * same way and respawned again. One click, unbounded `claude` processes.
   */
  it('switches permission over a SNAPSHOT of the roster, never the live Map', () => {
    const src = code(read(SURFACE));
    const fn = src.slice(src.indexOf('const changeChatPermissionMode'));
    const body = fn.slice(0, fn.indexOf('}, [bus'));
    expect(body).toContain('Array.from(sessions.current.values())');
    expect(body, 'iterating the live Map re-enters through the respawn fallback')
      .not.toMatch(/sessions\.current\.forEach/);
    // The fallback itself is the whole reason the snapshot is needed — if this ever stops
    // respawning, re-derive the test rather than deleting it.
    expect(body).toMatch(/resumeChatSession\(cs[,)]/);
    // …and it must ask for the mode the user just PICKED. Handing the fallback `cs.bypass`
    // (which is what `resumeChatSession` defaults to, correctly, for the Session-ended
    // banner) respawns under the mode being LEFT — and since CLI 2.1.220 refuses every live
    // switch into bypass, that respawn is the ONLY route to Bypass. Getting this wrong does
    // not fail loudly: the click reconnects the session and it lands back on `auto`, forever.
    expect(body, 'the fallback must respawn under the REQUESTED mode, not the current one')
      .toContain("resumeChatSession(cs, mode === 'bypass')");
  });

  it('lands on first paint: the Composer seeds its textarea from the model', () => {
    // The carry writes `conv.draft` on a session whose pane has not mounted yet, so the
    // mechanism that delivers it is the useState INITIALIZER — not the epoch effect, which is
    // only the belt to this braces. If this becomes `useState('')` the carry silently stops
    // arriving on the first render and the fix regresses to a flicker at best.
    expect(code(read(COMPOSER))).toContain('useState(() => conv.draft)');
  });

  it('sendText bumps draftEpoch, which is what a late-mounting Composer adopts', () => {
    const src = code(read(SESSION));
    const fn = src.slice(src.indexOf('function sendText('));
    const body = fn.slice(0, fn.indexOf('\n  }') + 4);
    expect(body).toContain('draftEpoch: conv.draftEpoch + 1');
    // The adoption side of that contract.
    expect(code(read(COMPOSER))).toMatch(/if\s*\(draftEpoch\s*>\s*0\)/);
  });
});
