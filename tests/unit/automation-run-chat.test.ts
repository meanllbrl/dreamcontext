import { describe, it, expect } from 'vitest';

/**
 * The automation-run → chat bridge (`dashboard/src/lib/automationRunChat.ts`).
 *
 * Tested from here rather than from a dashboard-side runner for the same reason
 * `chat-actions.test.ts` is: the module is pure TS with no React in it, and this suite
 * already reaches into `dashboard/src` by path.
 *
 * This suite used to install a bare `EventTarget` as a fake `window`, because the request
 * was broadcast there. It no longer needs one: `openAutomationRunChat` takes the caller's
 * INSTANCE BUS explicitly, so a plain `new EventTarget()` per test IS the production object,
 * not a stand-in for it — and the absence of any `window` in this file is itself the check
 * that nothing crept back onto the global.
 */

async function load() {
  return import('../../dashboard/src/lib/automationRunChat.js');
}

const RUN = {
  slug: 'calbuddy-funnel-watch',
  automationTitle: 'CalBuddy Funnel Watch',
  runNumber: 1,
  sessionId: '0199e2f1-6c1a-7a52-9d3b-2f2c9d4e1a77',
  firedAt: '2026-08-03T08:00:00.000Z',
  status: 'ok',
  costUsd: 0.79,
  numTurns: 9,
  durationMs: 41_000,
  outputPath: '/Users/x/p/_dream_context/automations/output/calbuddy-funnel-watch/2026-08-03-2.md',
};

/**
 * The marker used to be `· run #1`; D7 changed it to the run's DATE, because app-open now
 * restores every run since you last looked and a strip of tabs has to say WHEN without a
 * click. These tests assert the properties that make the title do its job, not the exact
 * rendered date — the helper formats with `toLocaleDateString`, so hardcoding "Aug 3" would
 * pin the test to whatever timezone and locale the machine running it happens to have.
 */
describe('automationRunTabTitle', () => {
  const AUG_3 = '2026-08-03T08:00:00.000Z';
  const AUG_9 = '2026-08-09T08:00:00.000Z';

  it('names the automation and marks the run, not the conversation', async () => {
    const { automationRunTabTitle } = await load();
    const title = automationRunTabTitle('CalBuddy Funnel Watch', AUG_3);
    expect(title.startsWith('CalBuddy Funnel Watch · ')).toBe(true);
    // The conversation's own first prompt is the approved automation brief — identical
    // across every run of the same job — so it can never be the source of the name.
    expect(title).not.toContain('You are scheduled');
  });

  it('tells two runs of the SAME automation apart — the whole reason the marker exists', async () => {
    const { automationRunTabTitle } = await load();
    expect(automationRunTabTitle('CalBuddy Funnel Watch', AUG_3))
      .not.toBe(automationRunTabTitle('CalBuddy Funnel Watch', AUG_9));
  });

  it('keeps the date marker whole when the name has to be clipped', async () => {
    const { automationRunTabTitle } = await load();
    const title = automationRunTabTitle('An automation with a really quite long name', AUG_3);
    // The marker is the half that tells two tabs apart — clipping it would defeat the
    // entire reason this function exists.
    const marker = automationRunTabTitle('x', AUG_3).slice('x'.length);
    expect(title.endsWith(marker)).toBe(true);
    expect(title.length).toBeLessThanOrEqual(34);
    expect(title).toContain('…');
  });

  it('falls back to a name rather than rendering an empty tab', async () => {
    const { automationRunTabTitle } = await load();
    expect(automationRunTabTitle('   ', AUG_3).startsWith('Automation · ')).toBe(true);
  });

  it('renders an unparseable timestamp verbatim rather than "Invalid Date"', async () => {
    const { automationRunTabTitle } = await load();
    // Degrade legibly: a raw ISO-ish string still tells the user something, where the
    // Date object's own failure string tells them only that the app is broken.
    expect(automationRunTabTitle('Watch', 'not-a-date')).toBe('Watch · not-a-date');
  });
});

describe('runChatUnavailableReason', () => {
  it('passes a run that has both a session and a transcript', async () => {
    const { runChatUnavailableReason } = await load();
    expect(runChatUnavailableReason({ sessionId: 'abc', transcriptPath: '/tmp/abc.jsonl' })).toBeNull();
  });

  it('refuses a run that never started a session (blocked / deferred / orphaned)', async () => {
    const { runChatUnavailableReason } = await load();
    const reason = runChatUnavailableReason({ sessionId: null, transcriptPath: null });
    expect(reason).toMatch(/never started/i);
  });

  it('refuses a session id with no transcript on disk — the fresh-pin trap', async () => {
    const { runChatUnavailableReason } = await load();
    // This is the case that must NOT open a chat: `--resume` against a missing transcript
    // silently fresh-pins a NEW empty conversation under the same uuid, and the user would
    // be looking at a blank chat claiming to be their run.
    const reason = runChatUnavailableReason({ sessionId: 'abc', transcriptPath: null });
    expect(reason).toMatch(/no transcript/i);
  });
});

describe('openAutomationRunChat', () => {
  it('reports FALSE when no surface is mounted to take it', async () => {
    const { openAutomationRunChat } = await load();
    // A button that silently does nothing is exactly what the ACK exists to prevent.
    expect(openAutomationRunChat(new EventTarget(), RUN)).toBe(false);
  });

  it('reports FALSE when a mounted surface declines (guards rejected)', async () => {
    const { openAutomationRunChat, AUTOMATION_RUN_CHAT_EVENT } = await load();
    const bus = new EventTarget();
    // A listener that looks but never acks — not desktop, no claude CLI, Agents disabled.
    bus.addEventListener(AUTOMATION_RUN_CHAT_EVENT, () => { /* declines */ });
    expect(openAutomationRunChat(bus, RUN)).toBe(false);
  });

  it('reports TRUE synchronously once the surface acks', async () => {
    const { openAutomationRunChat, AUTOMATION_RUN_CHAT_EVENT } = await load();
    const bus = new EventTarget();
    bus.addEventListener(AUTOMATION_RUN_CHAT_EVENT, (e) => {
      (e as CustomEvent<{ accepted?: boolean }>).detail.accepted = true;
    });
    // Synchronous by construction: dispatchEvent runs listeners inline. If anything async
    // is ever introduced between the dispatch and the read, this is the test that fails.
    expect(openAutomationRunChat(bus, RUN)).toBe(true);
  });

  it('carries every field the resumed tab needs to describe itself', async () => {
    const { openAutomationRunChat, AUTOMATION_RUN_CHAT_EVENT } = await load();
    const bus = new EventTarget();
    let seen: Record<string, unknown> | null = null;
    bus.addEventListener(AUTOMATION_RUN_CHAT_EVENT, (e) => {
      seen = { ...(e as CustomEvent).detail };
      (e as CustomEvent<{ accepted?: boolean }>).detail.accepted = true;
    });
    openAutomationRunChat(bus, RUN);
    expect(seen).toMatchObject(RUN);
    // `seen` is the detail as it ARRIVED (copied before this listener acked): the ACK field
    // must start false. A detail that arrived pre-accepted would make the surface's answer
    // unreadable — every request would report success.
    expect((seen as unknown as { accepted: boolean }).accepted).toBe(false);
  });

  it('never mutates the caller\'s run object', async () => {
    const { openAutomationRunChat, AUTOMATION_RUN_CHAT_EVENT } = await load();
    const bus = new EventTarget();
    bus.addEventListener(AUTOMATION_RUN_CHAT_EVENT, (e) => {
      (e as CustomEvent<{ accepted?: boolean }>).detail.accepted = true;
    });
    const original = { ...RUN };
    openAutomationRunChat(bus, RUN);
    expect(RUN).toEqual(original);
    expect('accepted' in RUN).toBe(false);
  });

  it('reaches ONLY the project it was asked of (M0)', async () => {
    const { openAutomationRunChat, AUTOMATION_RUN_CHAT_EVENT } = await load();
    // Two live projects in one window, each with its own agent surface listening on its own
    // bus. Broadcast, B would also `--resume` A's conversation uuid — two live CLIs appending
    // to one transcript, neither seeing the other's turns — and whichever listener ran first
    // would set the ACK, so A's panel could report success for a tab that opened in B.
    const busA = new EventTarget();
    const busB = new EventTarget();
    let bSaw = 0;
    busA.addEventListener(AUTOMATION_RUN_CHAT_EVENT, (e) => {
      (e as CustomEvent<{ accepted?: boolean }>).detail.accepted = true;
    });
    busB.addEventListener(AUTOMATION_RUN_CHAT_EVENT, () => { bSaw += 1; });
    expect(openAutomationRunChat(busA, RUN)).toBe(true);
    expect(bSaw).toBe(0);
  });
});
