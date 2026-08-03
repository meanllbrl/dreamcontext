import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * The automation-run → chat bridge (`dashboard/src/lib/automationRunChat.ts`).
 *
 * Tested from here rather than from a dashboard-side runner for the same reason
 * `chat-actions.test.ts` is: the module is pure TS with no React in it, and this suite
 * already reaches into `dashboard/src` by path.
 *
 * `requestAutomationRunChat` talks to `window`, which a node-environment vitest run does
 * not have — so the test installs a bare `EventTarget` as `window`. That is not a
 * convenience: it is exactly the contract the function needs (addEventListener /
 * dispatchEvent, dispatch running its listeners INLINE), so a stub that satisfies it
 * proves the real thing works for the reason the real thing works.
 */

let listeners: Array<{ type: string; fn: EventListener }> = [];

beforeEach(async () => {
  const target = new EventTarget();
  const realAdd = target.addEventListener.bind(target);
  // Track registrations so each test can tear its own down — a leaked listener would make
  // the "no surface mounted" case pass for the wrong reason in whatever test ran next.
  (target as EventTarget & { addEventListener: EventTarget['addEventListener'] }).addEventListener = ((
    type: string, fn: EventListener,
  ) => {
    listeners.push({ type, fn });
    realAdd(type, fn);
  }) as EventTarget['addEventListener'];
  (globalThis as unknown as { window: EventTarget }).window = target;
});

afterEach(() => {
  const target = (globalThis as unknown as { window?: EventTarget }).window;
  for (const l of listeners) target?.removeEventListener(l.type, l.fn);
  listeners = [];
  delete (globalThis as unknown as { window?: EventTarget }).window;
});

async function load() {
  // Imported AFTER the window stub exists. The module has no import-time window access
  // today, and this ordering keeps the test honest if that ever changes.
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

describe('automationRunTabTitle', () => {
  it('names the automation and its run, not the conversation', async () => {
    const { automationRunTabTitle } = await load();
    expect(automationRunTabTitle('CalBuddy Funnel Watch', 1)).toBe('CalBuddy Funnel Watch · run #1');
  });

  it('keeps the run marker whole when the name has to be clipped', async () => {
    const { automationRunTabTitle } = await load();
    const title = automationRunTabTitle('An automation with a really quite long name', 12);
    // The marker is the half that tells two tabs apart — clipping it would defeat the
    // entire reason this function exists.
    expect(title.endsWith(' · run #12')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(34);
    expect(title).toContain('…');
  });

  it('falls back to a name rather than rendering an empty tab', async () => {
    const { automationRunTabTitle } = await load();
    expect(automationRunTabTitle('   ', 3)).toBe('Automation · run #3');
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

describe('requestAutomationRunChat', () => {
  it('reports FALSE when no surface is mounted to take it', async () => {
    const { requestAutomationRunChat } = await load();
    // A button that silently does nothing is exactly what the ACK exists to prevent.
    expect(requestAutomationRunChat(RUN)).toBe(false);
  });

  it('reports FALSE when a mounted surface declines (guards rejected)', async () => {
    const { requestAutomationRunChat, AUTOMATION_RUN_CHAT_EVENT } = await load();
    // A listener that looks but never acks — not desktop, no claude CLI, Agents disabled.
    window.addEventListener(AUTOMATION_RUN_CHAT_EVENT, () => { /* declines */ });
    expect(requestAutomationRunChat(RUN)).toBe(false);
  });

  it('reports TRUE synchronously once the surface acks', async () => {
    const { requestAutomationRunChat, AUTOMATION_RUN_CHAT_EVENT } = await load();
    window.addEventListener(AUTOMATION_RUN_CHAT_EVENT, (e) => {
      (e as CustomEvent<{ accepted?: boolean }>).detail.accepted = true;
    });
    // Synchronous by construction: dispatchEvent runs listeners inline. If anything async
    // is ever introduced between the dispatch and the read, this is the test that fails.
    expect(requestAutomationRunChat(RUN)).toBe(true);
  });

  it('carries every field the resumed tab needs to describe itself', async () => {
    const { requestAutomationRunChat, AUTOMATION_RUN_CHAT_EVENT } = await load();
    let seen: Record<string, unknown> | null = null;
    window.addEventListener(AUTOMATION_RUN_CHAT_EVENT, (e) => {
      seen = { ...(e as CustomEvent).detail };
      (e as CustomEvent<{ accepted?: boolean }>).detail.accepted = true;
    });
    requestAutomationRunChat(RUN);
    expect(seen).toMatchObject(RUN);
    // `seen` is the detail as it ARRIVED (copied before this listener acked): the ACK field
    // must start false. A detail that arrived pre-accepted would make the surface's answer
    // unreadable — every request would report success.
    expect((seen as unknown as { accepted: boolean }).accepted).toBe(false);
  });

  it('never mutates the caller\'s run object', async () => {
    const { requestAutomationRunChat, AUTOMATION_RUN_CHAT_EVENT } = await load();
    window.addEventListener(AUTOMATION_RUN_CHAT_EVENT, (e) => {
      (e as CustomEvent<{ accepted?: boolean }>).detail.accepted = true;
    });
    const original = { ...RUN };
    requestAutomationRunChat(RUN);
    expect(RUN).toEqual(original);
    expect('accepted' in RUN).toBe(false);
  });
});
