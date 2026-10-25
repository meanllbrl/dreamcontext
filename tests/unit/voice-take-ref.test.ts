/**
 * A dictated message carries its take to the agent (task sesli-giris-bozuk…, AC7): the frame's
 * `voiceTake` is bound once, synchronously, from the same vault, under 10 minutes, and the turn
 * gets a `<voice-take ref lang quality/>` block built only from the stored record — which the
 * replay drops, so the owner's bubble shows his words alone. Drives the REAL `startChatSession`
 * with a scripted child, the way chat-account-switch-hold.test.ts does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/voice-take-ref-home-`);
  process.env.DREAMCONTEXT_SWITCH_STALL_MS = '150';
});

const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4246;
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      spawned.push(child);
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});

const accountsState = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  rejections: {} as Record<string, { until: number; window: string }>,
}));
vi.mock('../../src/lib/claude-accounts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-accounts.js')>();
  return { ...real, listClaudeAccounts: vi.fn(() => accountsState.accounts) };
});
vi.mock('../../src/lib/claude-limit-rejections.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-limit-rejections.js')>();
  return { ...real, readAccountRejections: vi.fn(() => accountsState.rejections) };
});
vi.mock('../../src/lib/claude-usage-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-usage-probe.js')>();
  const probe = vi.fn(async () => ({ status: 'healthy-unmeasured', reason: 'test' }));
  return { ...real, probeAccountUsage: probe, probeAccountForDecision: probe };
});

const { startChatSession } = await import('../../src/server/routes/agent-chat.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');
const { keepTake, voiceTakeBlock } = await import('../../src/lib/voice/voiceLog.js');
const { userPromptOf } = await import('../../src/lib/transcript-history.js');
const { CHAT_SURFACE_BRIEFING } = await import('../../src/server/chat-surface.js');

const ROOT = '/tmp/voice-take-ref-test';
/** The chat's vault as the server knows it (and as `/stt` stamps a take). */
const CTX = `${ROOT}/_dream_context`;

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

function start(sessionId = '') {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, ROOT, {
    bypass: false, sessionId, resumeId: '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
    account: '', mode: 'basic', vault: 'acme-app',
  });
  return { ws, child: spawned[spawned.length - 1] };
}

/** Every user frame written to the CLI, as its content blocks' texts. */
function turns(child: FakeChild): string[][] {
  return child.stdin.write.mock.calls
    .map(([chunk]) => { try { return JSON.parse(String(chunk)); } catch { return null; } })
    .filter((f) => f?.type === 'user')
    .map((f) => (f.message.content as Array<{ text: string }>).map((b) => b.text));
}

const say = (ws: FakeWs, text: string, voiceTake?: unknown) =>
  ws.emit('message', JSON.stringify({ type: 'user', text, ...(voiceTake !== undefined ? { voiceTake } : {}) }));

/** A take as `/stt` keeps it: the words it heard are `text`. */
const take = (text: string, over: Record<string, unknown> = {}, at?: number) =>
  keepTake(Buffer.from('RIFF....WAVE'), { contextRoot: CTX, quality: 'suspect', language: 'tr', chars: text.length, text, ...over }, undefined, at)!;

const blockOf = (t: string[]) => t.find((x) => x.startsWith('<voice-take'));

beforeEach(() => {
  spawned.length = 0;
  _resetChatRegistry();
  accountsState.accounts = [];
  accountsState.rejections = {};
});
afterEach(() => { accountsState.accounts = []; accountsState.rejections = {}; });

describe('the take ref rides with a dictated message', () => {
  it('a quote or attachment block around the heard words still counts as unchanged', async () => {
    const { ws, child } = start();
    const ref = take('ne durumdayız');
    say(ws, '> quoted line\n\nne durumdayız', ref);
    await vi.waitFor(() => expect(turns(child)).toHaveLength(1));
    expect(blockOf(turns(child)[0])).toBeDefined();
  });

  it('an unchanged dictated message carries the block, built from the stored record; the replay drops it', async () => {
    const { ws, child } = start();
    const ref = take('ne durumdayız');
    say(ws, 'ne durumdayız', ref);
    await vi.waitFor(() => expect(turns(child)).toHaveLength(1));
    const [t] = turns(child);
    expect(t[0]).toBe('ne durumdayız');
    expect(blockOf(t)).toBe(`<voice-take ref="${ref}" lang="tr" quality="suspect"/>`);
    // The replay of the owner's turn shows his words alone.
    expect(userPromptOf({ type: 'user', message: { role: 'user', content: t.map((text) => ({ type: 'text', text })) } })).toBe('ne durumdayız');
  });

  it('a forged, foreign-vault, stale, garbled or edited (no ref) message carries no block', async () => {
    const { ws, child } = start();
    say(ws, 'forged', `vt_${'a'.repeat(32)}`);
    say(ws, 'shape', '../../etc/passwd');
    say(ws, 'foreign', take('foreign', { contextRoot: '/tmp/other-vault' }));
    say(ws, 'stale', take('stale', {}, Date.now() - 11 * 60_000));
    say(ws, 'garbled', take('garbled', { quality: 'garbled' }));
    say(ws, 'no ref');
    // Edited before sending: the server checks too — the heard words are no longer in it.
    say(ws, 'something else entirely', take('what was heard'));
    await vi.waitFor(() => expect(turns(child)).toHaveLength(7));
    for (const t of turns(child)) expect(blockOf(t), t[0]).toBeUndefined();
  });

  it('two frames carrying one ref bind it once', async () => {
    const { ws, child } = start();
    const ref = take('again');
    say(ws, 'again', ref);
    say(ws, 'again', ref);
    await vi.waitFor(() => expect(turns(child)).toHaveLength(2));
    expect(blockOf(turns(child)[0])).toBeDefined();
    expect(blockOf(turns(child)[1])).toBeUndefined();
  });

  it('a message resent on a restarted pane (after an account switch) carries no block, even if its ref came back', async () => {
    const a = start('pane-1');
    const ref = take('held');
    say(a.ws, 'held', ref);
    await vi.waitFor(() => expect(turns(a.child)).toHaveLength(1));
    const b = start('pane-1');
    say(b.ws, 'held', ref);
    await vi.waitFor(() => expect(turns(b.child)).toHaveLength(1));
    expect(blockOf(turns(b.child)[0])).toBeUndefined();
  });

  it('a message held for a switch and released by the stall valve keeps its ref', async () => {
    accountsState.accounts = [
      { id: 'main', accountUuid: 'uuid-main', email: 'main@example.test', organizationUuid: 'org', organizationName: 'Acme', tier: 'max', configDir: null, preferred: true },
      { id: 'spare', accountUuid: 'uuid-spare', email: 'spare@example.test', organizationUuid: 'org', organizationName: 'Acme', tier: 'max', configDir: '/tmp/voice-take-ref-spare', preferred: false },
    ];
    accountsState.rejections = { main: { until: Date.now() + 3_600_000, window: 'weekly' } };
    const { ws, child } = start();
    const ref = take('held one');
    say(ws, 'held one', ref);
    await vi.waitFor(() => expect(turns(child)).toHaveLength(1), { timeout: 2_000 });
    expect(blockOf(turns(child)[0])).toBe(`<voice-take ref="${ref}" lang="tr" quality="suspect"/>`);
    // It really was held and released by the valve, not sent straight through.
    const metas = ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw))).filter((f) => f.subtype === 'account_switch');
    expect(metas.at(-1)).toMatchObject({ switched: false, reason: 'switch_stalled' });
  });
});

describe('voiceTakeBlock', () => {
  it('nothing outside the stored, validated values can reach an attribute', () => {
    expect(voiceTakeBlock({ ref: 'vt_x" onload="y', language: 'tr', quality: 'clean' })).toBeNull();
    expect(voiceTakeBlock({ ref: `vt_${'b'.repeat(32)}`, language: 'tr"><x' as string, quality: 'clean' }))
      .toBe(`<voice-take ref="vt_${'b'.repeat(32)}" lang="unknown" quality="clean"/>`);
    expect(voiceTakeBlock({ ref: `vt_${'b'.repeat(32)}`, language: 'tr', quality: 'garbled' })).toBeNull();
  });

  it('the chat briefing carries the rule: retry once, quote, else ask', () => {
    expect(CHAT_SURFACE_BRIEFING).toContain('run `dreamcontext voice retry <ref>` once first');
    expect(CHAT_SURFACE_BRIEFING).toContain('Never act on garbled text.');
  });
});
