// The notch Assistant's latency plumbing (task: the-notch-assistant-answers-without-the-15-40-s-
// of-plumbing-in-front-of-every-turn, lane A). Each block pins one criterion at the SPAWN — the
// argv and env `startChatSession` hands `claude` — with a mocked spawn, plus the pure helpers.
//
//   • --allowedTools 'Bash(dreamcontext assistant:*)' only on the Assistant, only under auto;
//   • autonomy auto → ask respawns a live Assistant in place, without --allowedTools;
//   • recall env: hybrid/raw for the Assistant only; every other chat (delegated or not) keeps its vault's mode;
//   • --effort: the Assistant's own (default medium); a delegated basic chat defaults to medium;
//   • the delegation marker survives a respawn of the same conversation, and dies with the entry;
//   • the Assistant's index is built in the background, once, never with the model absent.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A throwaway HOME for everything that reads ~ (assistant config, accounts, roster).
const fakeHome = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-assistant-latency-home-'));
  process.env.HOME = dir;
  return dir;
});

const state = vi.hoisted(() => ({
  modelOnDisk: false,
  transcripts: new Set<string>(),
  embedCalls: 0,
  releaseEmbed: null as null | (() => void),
  /** When set, auto-switch runs a (blind) usage probe that waits on this promise — a message
   *  then sits in the switch gate for as long as the test wants. */
  slowProbe: null as null | Promise<void>,
}));

vi.mock('../../src/lib/claude-accounts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-accounts.js')>();
  return {
    ...real,
    autoSwitchEnabled: (...a: Parameters<typeof real.autoSwitchEnabled>) => (state.slowProbe ? true : real.autoSwitchEnabled(...a)),
    listClaudeAccounts: (...a: Parameters<typeof real.listClaudeAccounts>) => (state.slowProbe
      ? [{ id: 'acct-a' }, { id: 'acct-b', configDir: '/nonexistent-b' }] as ReturnType<typeof real.listClaudeAccounts>
      : real.listClaudeAccounts(...a)),
    switchStrategyFor: (...a: Parameters<typeof real.switchStrategyFor>) => (state.slowProbe ? 'parallel' : real.switchStrategyFor(...a)),
  };
});

vi.mock('../../src/lib/claude-usage.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-usage.js')>();
  return {
    ...real,
    usageReadingIsCurrent: (...a: Parameters<typeof real.usageReadingIsCurrent>) => (state.slowProbe ? false : real.usageReadingIsCurrent(...a)),
  };
});

vi.mock('../../src/lib/claude-usage-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-usage-probe.js')>();
  return {
    ...real,
    probeAccountUsage: async () => {
      await state.slowProbe;
      return { status: 'error' } as unknown as Awaited<ReturnType<typeof real.probeAccountUsage>>;
    },
    probeAccountForDecision: async () => {
      await state.slowProbe;
      return { status: 'error' } as unknown as Awaited<ReturnType<typeof real.probeAccountUsage>>;
    },
  };
});

const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4242;
  script = '';
  env: Record<string, string | undefined> = {};
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((_cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
      const child = new FakeChild();
      child.script = args[args.length - 1] ?? '';
      child.env = opts?.env ?? {};
      spawned.push(child);
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});

vi.mock('../../src/lib/embeddings/embedder.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/embeddings/embedder.js')>();
  return {
    ...real,
    isEmbedModelDownloaded: () => state.modelOnDisk,
    // The routes ask the COMPLETE question (graph and weights); a fake model on disk is both.
    isEmbedModelComplete: () => state.modelOnDisk,
    // A slow fake model: the build stays `building` until the test releases it.
    embedPassages: vi.fn(async (texts: string[]) => {
      state.embedCalls += 1;
      await new Promise<void>((r) => { state.releaseEmbed = r; });
      return texts.map(() => new Float32Array([1, 0, 0]));
    }),
  };
});

vi.mock('../../src/server/routes/agent-spawn-shared.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/server/routes/agent-spawn-shared.js')>();
  return { ...real, claudeConversationExists: (id: string) => state.transcripts.has(id) };
});

const {
  startChatSession, assistantAllowedTools, recallEnvFor, spawnEffortFor, notifyAssistantAutonomy,
} = await import('../../src/server/routes/agent-chat.js');
const { registerChat, isDelegatedConversation, GONE_TTL_MS, _resetChatRegistry } = await import(
  '../../src/lib/assistant/chat-registry.js'
);
const {
  writeAssistantConfig, assistantProjectRoot, sanitizeConfigPatch, DEFAULT_ASSISTANT_CONFIG,
} = await import('../../src/lib/assistant/home.js');
const { setAutoSwitchEnabled } = await import('../../src/lib/claude-accounts.js');
const { _resetIndexRuns } = await import('../../src/server/routes/embeddings.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

const CONV = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-8999-aaaaaaaaaaaa';

let projectRoot: string;

type Mode = 'basic' | 'plan' | 'develop' | 'assistant';
function spawnChat(o: {
  mode?: Mode; resumeId?: string; sessionId?: string; fromAssistant?: boolean; effort?: string; bypass?: boolean;
} = {}): { ws: FakeWs; child: FakeChild } {
  const ws = new FakeWs();
  const isAssistant = o.mode === 'assistant';
  startChatSession(ws as unknown as import('ws').WebSocket, isAssistant ? assistantProjectRoot() : projectRoot, {
    bypass: o.bypass ?? false,
    sessionId: o.sessionId ?? '',
    resumeId: o.resumeId ?? '',
    model: '',
    effort: o.effort ?? '',
    mode: o.mode ?? 'basic',
    account: '',
    initialPrompt: '',
    deferPrompt: false,
    vault: isAssistant ? '__assistant__' : 'demo-vault',
    fromAssistant: o.fromAssistant,
  });
  return { ws, child: spawned[spawned.length - 1] };
}

/** The argv, unquoted, out of the login-shell script. */
function argvOf(child: FakeChild): string[] {
  return [...child.script.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}
function flagValue(child: FakeChild, flag: string): string | null {
  const a = argvOf(child);
  const i = a.indexOf(flag);
  return i >= 0 ? a[i + 1] : null;
}

function makeAssistantVault(autonomy: 'ask' | 'auto' | 'bypass', extra: Record<string, unknown> = {}): void {
  const ctx = join(assistantProjectRoot(fakeHome), '_dream_context');
  mkdirSync(join(ctx, 'knowledge'), { recursive: true });
  writeFileSync(join(ctx, 'knowledge', 'owner.md'), '---\nname: Owner\ndescription: who the owner is\n---\n\n# Owner\n\nThe owner likes short answers.\n');
  writeAssistantConfig({ autonomy, ...extra }, fakeHome);
}

beforeEach(() => {
  spawned.length = 0;
  state.modelOnDisk = false;
  state.transcripts.clear();
  state.embedCalls = 0;
  state.releaseEmbed = null;
  state.slowProbe = null;
  _resetChatRegistry();
  _resetIndexRuns();
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-assistant-latency-proj-'));
  mkdirSync(join(projectRoot, '_dream_context'), { recursive: true });
  // No usage probe (it would spawn): report-only auto-switch.
  setAutoSwitchEnabled(false, fakeHome);
});

afterEach(() => {
  // Every child exits, so no conversation stays held in the route's live set.
  // (A handed-off child's exit starts a successor — closed by the same loop.)
  while (spawned.length) spawned.shift()!.emit('close', 0);
  state.releaseEmbed?.();
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(join(fakeHome, '.dreamcontext', 'assistant'), { recursive: true, force: true });
});

// ─── --allowedTools ─────────────────────────────────────────────────────────────────

describe('assistantAllowedTools', () => {
  it('pre-approves the assistant verbs under auto only', () => {
    expect(assistantAllowedTools('auto')).toEqual(['--allowedTools', 'Bash(dreamcontext assistant:*)']);
    expect(assistantAllowedTools('ask')).toEqual([]);
    expect(assistantAllowedTools('bypass')).toEqual([]);
  });

  for (const autonomy of ['auto', 'ask', 'bypass'] as const) {
    it(`the __assistant__ spawn under ${autonomy} ${autonomy === 'auto' ? 'carries' : 'carries no'} --allowedTools`, () => {
      makeAssistantVault(autonomy);
      const { child } = spawnChat({ mode: 'assistant' });
      expect(flagValue(child, '--allowedTools')).toBe(autonomy === 'auto' ? 'Bash(dreamcontext assistant:*)' : null);
    });
  }

  it('no project spawn ever carries --allowedTools, even with the Assistant set to auto', () => {
    makeAssistantVault('auto');
    for (const mode of ['basic', 'plan', 'develop'] as const) {
      for (const bypass of [false, true]) {
        for (const fromAssistant of [false, true]) {
          const { child } = spawnChat({ mode, bypass, fromAssistant });
          expect(argvOf(child)).not.toContain('--allowedTools');
        }
      }
    }
  });
});

// ─── Autonomy change respawns a live Assistant ──────────────────────────────────────

describe('autonomy auto → ask while the Assistant lives', () => {
  it('respawns it in place with --resume and without --allowedTools, before the next turn', async () => {
    makeAssistantVault('auto', { conversationId: CONV });
    state.transcripts.add(CONV);
    const { ws, child: first } = spawnChat({ mode: 'assistant', resumeId: CONV });
    expect(flagValue(first, '--allowedTools')).toBe('Bash(dreamcontext assistant:*)');
    expect(flagValue(first, '--resume')).toBe(CONV);

    writeAssistantConfig({ autonomy: 'ask' }, fakeHome);
    notifyAssistantAutonomy('ask');
    // Idle → drained once the switch gate settles; the socket is NOT closed (the notch keeps
    // its session).
    await vi.waitFor(() => expect(first.stdin.end).toHaveBeenCalledTimes(1));
    expect(spawned).toHaveLength(1);

    // The owner types during the hand-off: held, never written to the old process.
    const msg = JSON.stringify({ type: 'user', text: 'what is running?' });
    ws.emit('message', Buffer.from(msg));
    const wroteTo = (c: FakeChild) => c.stdin.write.mock.calls.map(([s]) => String(s)).join('');
    expect(wroteTo(first)).not.toContain('what is running?');

    first.emit('close', 0);
    expect(spawned).toHaveLength(2);
    const second = spawned[1];
    expect(argvOf(second)).not.toContain('--allowedTools');
    expect(flagValue(second, '--permission-mode')).toBe('default');
    expect(flagValue(second, '--resume')).toBe(CONV);
    expect(ws.close).not.toHaveBeenCalled();
    const frames = ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>);
    expect(frames.some((f) => f.subtype === 'exit')).toBe(false);

    // …and the held message reaches the successor.
    await vi.waitFor(() => expect(wroteTo(second)).toContain('what is running?'));
  });

  it('waits for a running turn to end before respawning', () => {
    makeAssistantVault('auto', { conversationId: CONV });
    state.transcripts.add(CONV);
    const { ws, child: first } = spawnChat({ mode: 'assistant', resumeId: CONV });
    // A turn is running (wake/initial prompt path counts it; drive it through a user frame).
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'user', text: 'long job' })));
    return vi.waitFor(() => expect(first.stdin.write).toHaveBeenCalled()).then(async () => {
      writeAssistantConfig({ autonomy: 'ask' }, fakeHome);
      notifyAssistantAutonomy('ask');
      expect(first.stdin.end).not.toHaveBeenCalled();
      first.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'));
      await vi.waitFor(() => expect(first.stdin.end).toHaveBeenCalledTimes(1));
    });
  });

  it('switching back before the turn ends replays the held message to the same process', async () => {
    makeAssistantVault('auto', { conversationId: CONV });
    state.transcripts.add(CONV);
    const { ws, child: first } = spawnChat({ mode: 'assistant', resumeId: CONV });
    const wrote = () => first.stdin.write.mock.calls.map(([s]) => String(s)).join('');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'user', text: 'long job' })));
    await vi.waitFor(() => expect(wrote()).toContain('long job'));

    notifyAssistantAutonomy('ask');                 // respawn pending behind the turn
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'user', text: 'held one' })));
    await new Promise((r) => setTimeout(r, 10));
    expect(wrote()).not.toContain('held one');

    notifyAssistantAutonomy('auto');                // back to what it was spawned with
    await vi.waitFor(() => expect(wrote()).toContain('held one'));
    expect(first.stdin.end).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
  });

  it('a message still in the switch gate when autonomy changes reaches the successor, not an ended stdin', async () => {
    makeAssistantVault('auto', { conversationId: CONV });
    state.transcripts.add(CONV);
    const { ws, child: first } = spawnChat({ mode: 'assistant', resumeId: CONV });
    // Same tick: the message is inside maybeSwitchAccount (not yet counted as a turn) when the
    // autonomy change lands.
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'user', text: 'racing message' })));
    writeAssistantConfig({ autonomy: 'ask' }, fakeHome);
    notifyAssistantAutonomy('ask');

    await vi.waitFor(() => expect(first.stdin.end).toHaveBeenCalledTimes(1));
    const wroteTo = (c: FakeChild) => c.stdin.write.mock.calls.map(([s]) => String(s)).join('');
    expect(wroteTo(first)).not.toContain('racing message');

    first.emit('close', 0);
    expect(spawned).toHaveLength(2);
    await vi.waitFor(() => expect(wroteTo(spawned[1])).toContain('racing message'));
  });

  it('a turn ending while a message is still in the switch gate waits for it, then respawns exactly once', async () => {
    makeAssistantVault('auto', { conversationId: CONV });
    state.transcripts.add(CONV);
    const { ws, child: first } = spawnChat({ mode: 'assistant', resumeId: CONV });
    const wroteTo = (c: FakeChild) => c.stdin.write.mock.calls.map(([s]) => String(s)).join('');
    const tick = () => new Promise((r) => setTimeout(r, 10));

    // M1 is a running turn.
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'user', text: 'first turn' })));
    await vi.waitFor(() => expect(wroteTo(first)).toContain('first turn'));

    // M2 enters the gate and waits on a slow account probe.
    let releaseProbe!: () => void;
    state.slowProbe = new Promise<void>((r) => { releaseProbe = r; });
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'user', text: 'second message' })));
    await tick();

    // Autonomy changes; then M1's turn ends while M2 is still deciding.
    writeAssistantConfig({ autonomy: 'ask' }, fakeHome);
    notifyAssistantAutonomy('ask');
    first.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'));
    await tick();
    // The respawn must NOT run under M2: stdin stays open until the gate settles.
    expect(first.stdin.end).not.toHaveBeenCalled();
    if (first.stdin.end.mock.calls.length) first.emit('close', 0); // (what the child would do)

    releaseProbe();
    await vi.waitFor(() => expect(first.stdin.end).toHaveBeenCalledTimes(1));
    expect(wroteTo(first)).not.toContain('second message');
    first.emit('close', 0);
    await tick();
    expect(spawned).toHaveLength(2); // one respawn, not two
    await vi.waitFor(() => expect(wroteTo(spawned[1])).toContain('second message'));
    expect(first.stdin.end).toHaveBeenCalledTimes(1);
  });

  it('an unchanged autonomy does not respawn', () => {
    makeAssistantVault('auto', { conversationId: CONV });
    const { child } = spawnChat({ mode: 'assistant', resumeId: CONV });
    notifyAssistantAutonomy('auto');
    expect(child.stdin.end).not.toHaveBeenCalled();
  });
});

// ─── Recall env ─────────────────────────────────────────────────────────────────────

describe('recallEnvFor — Assistant vs everyone else × model present/absent', () => {
  for (const modelOnDisk of [true, false]) {
    it(`a non-Assistant chat, model ${modelOnDisk ? 'present' : 'absent'} → {} (the vault's own mode stands)`, () => {
      expect(recallEnvFor({ isAssistant: false, modelOnDisk })).toEqual({});
    });
  }

  it('the Assistant is hybrid with the model on disk, else raw', () => {
    expect(recallEnvFor({ isAssistant: true, modelOnDisk: true }))
      .toEqual({ DREAMCONTEXT_RECALL_MODE: 'hybrid' });
    expect(recallEnvFor({ isAssistant: true, modelOnDisk: false }))
      .toEqual({ DREAMCONTEXT_RECALL_MODE: 'raw' });
  });

  it('at the spawn: the Assistant env carries it; a delegated chat and an owner chat do not', () => {
    makeAssistantVault('ask');
    state.modelOnDisk = true;
    expect(spawnChat({ mode: 'assistant' }).child.env.DREAMCONTEXT_RECALL_MODE).toBe('hybrid');
    state.modelOnDisk = false;
    expect(spawnChat({ mode: 'assistant' }).child.env.DREAMCONTEXT_RECALL_MODE).toBe('raw');

    const inherited = process.env.DREAMCONTEXT_RECALL_MODE;
    state.modelOnDisk = true;
    expect(spawnChat({ fromAssistant: true }).child.env.DREAMCONTEXT_RECALL_MODE).toBe(inherited);
    expect(spawnChat({ fromAssistant: false }).child.env.DREAMCONTEXT_RECALL_MODE).toBe(inherited);
  });
});

// ─── Delegation marker survives respawn-in-place ────────────────────────────────────

describe('the delegation marker', () => {
  it('is found while the entry lives or lingers gone, and not after it is deleted', () => {
    vi.useFakeTimers();
    try {
      const h = registerChat({ sessionId: CONV, conversationId: CONV, vault: 'v', mode: 'basic', origin: 'assistant' });
      registerChat({ sessionId: OTHER, conversationId: OTHER, vault: 'v', mode: 'basic' });
      expect(isDelegatedConversation(CONV)).toBe(true);
      expect(isDelegatedConversation(OTHER)).toBe(false);
      h.exited();
      expect(isDelegatedConversation(CONV)).toBe(true); // gone, within GONE_TTL_MS
      vi.advanceTimersByTime(GONE_TTL_MS + 1);
      expect(isDelegatedConversation(CONV)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a --resume spawn of a delegated conversation inherits it (effort), with no URL flag', () => {
    state.transcripts.add(CONV);
    state.modelOnDisk = true;
    const first = spawnChat({ resumeId: CONV, fromAssistant: true });
    expect(flagValue(first.child, '--effort')).toBe('medium');
    first.child.emit('close', 0); // close …

    const again = spawnChat({ resumeId: CONV }); // … + resume the same id, no origin
    expect(flagValue(again.child, '--resume')).toBe(CONV);
    expect(flagValue(again.child, '--effort')).toBe('medium');
  });

  it('after the entry is deleted a resume is an ordinary chat again', () => {
    state.transcripts.add(CONV);
    state.modelOnDisk = true;
    const first = spawnChat({ resumeId: CONV, fromAssistant: true });
    first.child.emit('close', 0);
    _resetChatRegistry(); // the entry's death
    const again = spawnChat({ resumeId: CONV });
    expect(again.child.env.DREAMCONTEXT_RECALL_MODE).toBe(process.env.DREAMCONTEXT_RECALL_MODE);
    expect(argvOf(again.child)).not.toContain('--effort');
  });

  it('an ordinary chat resuming an ordinary conversation never gains it', () => {
    state.transcripts.add(OTHER);
    const first = spawnChat({ resumeId: OTHER });
    first.child.emit('close', 0);
    expect(isDelegatedConversation(OTHER)).toBe(false);
  });
});

// ─── Effort ─────────────────────────────────────────────────────────────────────────

describe('effort', () => {
  it('spawnEffortFor', () => {
    expect(spawnEffortFor({ isAssistant: true, delegated: false, mode: 'assistant', urlEffort: 'xhigh' })).toBe('medium');
    expect(spawnEffortFor({ isAssistant: true, assistantEffort: 'high', delegated: false, mode: 'assistant', urlEffort: '' })).toBe('high');
    expect(spawnEffortFor({ isAssistant: false, delegated: true, mode: 'basic', urlEffort: '' })).toBe('medium');
    expect(spawnEffortFor({ isAssistant: false, delegated: true, mode: 'basic', urlEffort: 'low' })).toBe('low');
    expect(spawnEffortFor({ isAssistant: false, delegated: true, mode: 'plan', urlEffort: '' })).toBe('');
    expect(spawnEffortFor({ isAssistant: false, delegated: true, mode: 'develop', urlEffort: '' })).toBe('');
    expect(spawnEffortFor({ isAssistant: false, delegated: false, mode: 'basic', urlEffort: '' })).toBe('');
  });

  // `max` joined 2026-10-04: an effort the owner picks in the notch's composer (which offers
  // max) becomes the Assistant's own default, so the config has to be able to hold it.
  it('the config accepts only low|medium|high|xhigh|max and defaults to medium', () => {
    expect(DEFAULT_ASSISTANT_CONFIG.effort).toBe('medium');
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) expect(sanitizeConfigPatch({ effort: e }).effort).toBe(e);
    for (const e of ['ultra', '', 'HIGH', 3, null]) expect(sanitizeConfigPatch({ effort: e }).effort).toBeUndefined();
  });

  it('the __assistant__ spawn runs its configured effort, not the URL one', () => {
    makeAssistantVault('ask');
    expect(flagValue(spawnChat({ mode: 'assistant', effort: 'xhigh' }).child, '--effort')).toBe('medium');
    writeAssistantConfig({ effort: 'high' }, fakeHome);
    expect(flagValue(spawnChat({ mode: 'assistant' }).child, '--effort')).toBe('high');
  });

  it('a delegated basic chat defaults to medium; plan/develop delegations keep the default', () => {
    expect(flagValue(spawnChat({ fromAssistant: true }).child, '--effort')).toBe('medium');
    expect(flagValue(spawnChat({ fromAssistant: true, effort: 'high' }).child, '--effort')).toBe('high');
    expect(argvOf(spawnChat({ fromAssistant: true, mode: 'plan' }).child)).not.toContain('--effort');
    expect(argvOf(spawnChat({ fromAssistant: true, mode: 'develop' }).child)).not.toContain('--effort');
    expect(argvOf(spawnChat({}).child)).not.toContain('--effort');
  });
});

// ─── The Assistant's index ──────────────────────────────────────────────────────────

describe("the Assistant's embedding index", () => {
  it('two spawns during one build start one build', async () => {
    makeAssistantVault('ask');
    state.modelOnDisk = true;
    spawnChat({ mode: 'assistant' });
    await vi.waitFor(() => expect(state.embedCalls).toBe(1));
    spawnChat({ mode: 'assistant' });
    await new Promise((r) => setTimeout(r, 20));
    expect(state.embedCalls).toBe(1);
  });

  it('never builds with the model absent (and so never triggers the download)', async () => {
    makeAssistantVault('ask');
    state.modelOnDisk = false;
    spawnChat({ mode: 'assistant' });
    await new Promise((r) => setTimeout(r, 20));
    expect(state.embedCalls).toBe(0);
  });
});
