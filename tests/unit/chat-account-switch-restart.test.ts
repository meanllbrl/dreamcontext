/**
 * The auto-switch restart must not restart the session it just created, and must not drop
 * the turn it was created to carry.
 *
 * ── What broke, and why it was invisible ─────────────────────────────────────────────────
 * `AgentSurface.armAccountSwitch` watches `conv.accountSwitch` and, on a `switched: true`
 * notice, respawns the conversation on the named account. It then does two things to the
 * REPLACEMENT: copies the notice onto it (so the switch stays visible) and hands it the turn
 * the server held back.
 *
 * Both of those had a defect that no reading of the call site reveals, because in both cases
 * the damage is done by code that is somewhere else:
 *
 *   1. THE NOTICE RE-TRIGGERS THE WATCHER. Every chat session gets its own `armAccountSwitch`
 *      at spawn, reading the same field the copy is written into — and `noteAccountSwitch`
 *      FLUSHES its subscribers rather than coalescing them. So the copy restarted the new
 *      session synchronously, which copied the notice again, until the stack overflowed.
 *      `createChatSession.fireSubscribers` wraps every subscriber in a try/catch, so the
 *      overflow was swallowed and the only evidence was the end state: a roster entry whose
 *      session had been disposed — an amber `starting` tab over an empty pane, unrecoverable.
 *      The guard is the server's own rule: it never announces a switch to the account a
 *      session is already on, so a notice naming this session's `accountId` is the carried
 *      copy and nothing else.
 *
 *   2. THE RESUBMIT WAS DROPPED. The replacement's WebSocket is CONNECTING for as long as it
 *      takes to open, and `writeUser` refuses every frame on a socket that is not OPEN. So
 *      `next.send(pendingText)` returned `false` — not sometimes, every time — and the user's
 *      message vanished at exactly the moment the feature promises to preserve it. It is
 *      enqueued instead, and `chatSession`'s open edge drains the queue.
 *
 * Checked against the SOURCE, like `chat-draft-carry.test.ts` beside it and for the same
 * reason: root vitest runs under plain Node, and `AgentSurface.tsx` is a React module with CSS
 * imports it could not load. The live behaviour is asserted against a real Chromium and real
 * processes by `scripts/verify/claude-auth-switch.mjs`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const SURFACE = 'dashboard/src/components/sleepy/AgentSurface.tsx';
const SESSION = 'dashboard/src/components/sleepy/chatSession.ts';

/** Source with comments stripped, so a scan can never pass on the prose that explains a rule
 *  instead of the code that holds it (which would teach the next reader to delete the
 *  explanation rather than the property). Strings are kept — call shapes live in them. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** The body of `const <name> = useCallback((…) => { … })`, brace-matched. */
function callbackBody(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} not found in ${SURFACE}`).toBeGreaterThan(-1);
  const open = src.indexOf('{', src.indexOf('=>', start));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe('auto-switch restart', () => {
  const surface = code(read(SURFACE));
  const arm = callbackBody(surface, 'armAccountSwitch');

  it('refuses a notice that names the account this session is already running on', () => {
    // Written either way round; both are the same comparison.
    const guard = /move\.accountId === cs\.accountId|cs\.accountId === move\.accountId/;
    expect(guard.test(arm), 'armAccountSwitch must ignore a carried notice').toBe(true);
  });

  it('makes that refusal BEFORE it can respawn', () => {
    // A guard after the restart is not a guard — the recursion happens inside the restart.
    const guardAt = arm.search(/move\.accountId === cs\.accountId|cs\.accountId === move\.accountId/);
    const respawnAt = arm.indexOf('resumeChatRef.current');
    expect(respawnAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(respawnAt);
  });

  it('leaves the watcher armed for a genuine later switch', () => {
    // `stop()` unsubscribes for the session's life. The carried-notice arm must not use it:
    // the account this session just moved to can hit a limit of its own.
    const line = arm.split('\n').find((l) => /move\.accountId === cs\.accountId|cs\.accountId === move\.accountId/.test(l)) ?? '';
    expect(line.includes('stop()'), 'the carried-notice guard must not disarm the watcher').toBe(false);
  });

  it('enqueues the held turn instead of writing it to a socket that is still connecting', () => {
    expect(arm).toMatch(/next\.enqueue\(move\.pendingText\)/);
    expect(arm.includes('next.send('), 'send() cannot reach a CONNECTING socket').toBe(false);
  });
});

describe('chat session', () => {
  const session = code(read(SESSION));

  it('drains the queue on the socket open edge', () => {
    const open = session.indexOf('ws.onopen');
    expect(open).toBeGreaterThan(-1);
    const next = session.indexOf('ws.onmessage', open);
    const handler = session.slice(open, next > -1 ? next : session.length);
    expect(handler).toMatch(/maybeFlushQueue\(\)/);
  });

  it('still refuses to write a user frame on a socket that is not open', () => {
    // The property the enqueue exists to work WITH — if this ever softened, a resubmit could
    // be "sent" into a void again and the queue would stop being the safety net.
    expect(session).toMatch(/ws\.readyState !== WebSocket\.OPEN\) return false/);
  });
});
