/**
 * Learning loop C3 (D15), criterion 3: the write points of the owner-words ledger, one case per
 * row. The REAL `startChatSession` runs with a scripted child; `appendOwnerTurn` is captured.
 * Then the pieces that build the mark before it reaches the server: the phone mirror, the
 * Telegram hub's `own`, and the Composer's own words and its arm.
 *
 * Fixtures are synthetic (a fictional project, "Acme"), never the owner's real words.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/owner-words-home-`);
  process.env.DREAMCONTEXT_SWITCH_STALL_MS = '150';
});

const ledger = vi.hoisted(() => ({ lines: [] as Array<Record<string, unknown>> }));
vi.mock('../../src/lib/owner-words.js', () => ({
  appendOwnerTurn: vi.fn((line: Record<string, unknown>) => { ledger.lines.push(line); }),
  newOwnerTurnId: vi.fn(() => `turn-${ledger.lines.length + 1}`),
  readOwnerTurns: vi.fn(() => []),
  sameConversation: vi.fn(() => false),
  occasion: vi.fn((t: { session: string }) => t.session),
}));

const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4377;
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

const { startChatSession, serverBuiltFrameForTests, carryHeldOwnerMark, heldOwnerMarkCountForTests, LIMIT_CONTINUE_TEXT } = await import('../../src/server/routes/agent-chat.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');
const { MirrorSet, MIRROR_MAX_TEXT, mirrorOwnerFrame, mirrorOwnerText, mirrorUserFrame } = await import('../../src/lib/super/phone-mirror.js');
const { telegramOwnText } = await import('../../src/server/telegram/hub.js');
const { ownWords, armTypedSend, disarmTypedSend, typedOwnFor, __resetScratchForTests } = await import('../../dashboard/src/components/sleepy/chat/composerScratch.js');
const { refToken } = await import('../../dashboard/src/components/sleepy/chat/composerRefs.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

/** A fresh project per test, with a brain (`_dream_context`), removed after it: the ledger's
 *  `vault` is the realpath of the project root whose brain the chat runs in. */
let PROJECT = '';

function start(o: { sessionId?: string; mode?: string } = {}) {
  const ws = new FakeWs();
  const sessionId = o.sessionId ?? randomUUID();
  startChatSession(ws as unknown as import('ws').WebSocket, PROJECT, {
    bypass: false, sessionId, resumeId: '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
    account: '', mode: (o.mode ?? 'basic') as never, vault: 'acme',
  });
  return { ws, child: spawned[spawned.length - 1]!, sessionId };
}

function userFrames(child: FakeChild): string[] {
  return child.stdin.write.mock.calls
    .map(([chunk]) => { try { return JSON.parse(String(chunk)); } catch { return null; } })
    .filter((f) => f?.type === 'user')
    .map((f) => f.message.content[0].text as string);
}

const marked = (text: string, own: string) => JSON.stringify({ type: 'user', text, typed: true, own });
const plain = (text: string) => JSON.stringify({ type: 'user', text });
const emit = (child: FakeChild, frame: unknown) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`));
const settle = () => new Promise((r) => setTimeout(r, 40));

const account = (id: string, configDir: string | null, preferred: boolean) => ({
  id, accountUuid: `uuid-${id}`, email: `${id}@example.test`, organizationUuid: 'org', organizationName: 'Acme',
  tier: 'max', configDir, preferred,
});

describe('the ledger is written where the server sees him type', () => {
  beforeEach(() => {
    PROJECT = mkdtempSync(join(tmpdir(), 'owner-words-acme-'));
    mkdirSync(join(PROJECT, '_dream_context'), { recursive: true });
    spawned.length = 0;
    ledger.lines.length = 0;
    _resetChatRegistry();
    accountsState.accounts = [];
    accountsState.rejections = {};
  });
  afterEach(() => {
    for (const c of spawned) c.emit('close', 0);
    accountsState.accounts = [];
    accountsState.rejections = {};
    rmSync(PROJECT, { recursive: true, force: true });
  });

  it('a composer-marked frame (send) writes one line with only his own words', async () => {
    const { ws, child, sessionId } = start();
    ws.emit('message', marked('[About agenda line 2]\n\nship the Acme build', 'ship the Acme build'));
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(1));
    expect(ledger.lines).toHaveLength(1);
    expect(ledger.lines[0]).toMatchObject({ via: 'composer', own: 'ship the Acme build', surface: 'basic', vault: realpathSync(PROJECT), session: sessionId });
    expect(ledger.lines[0]!.keys).toContain(sessionId);
    expect(String(ledger.lines[0]!.own)).not.toContain('About agenda');
  });

  it('a steer (a second marked frame mid-turn) and a queued message (marked, after the turn) each write once', async () => {
    const { ws, child } = start();
    ws.emit('message', marked('build it', 'build it'));
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(1));
    ws.emit('message', marked('also the docs', 'also the docs'));
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(2));
    emit(child, { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 'conv-1' });
    ws.emit('message', marked('then tag it', 'then tag it'));
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(3));
    expect(ledger.lines.map((l) => l.own)).toEqual(['build it', 'also the docs', 'then tag it']);
  });

  it('the occasion is the live session the server last observed, and every id is a key', async () => {
    const { ws, child, sessionId } = start();
    emit(child, { type: 'system', subtype: 'init', session_id: 'conv-live-acme' });
    ws.emit('message', marked('keep it short', 'keep it short'));
    await vi.waitFor(() => expect(ledger.lines).toHaveLength(1));
    expect(ledger.lines[0]!.session).toBe('conv-live-acme');
    expect(ledger.lines[0]!.keys).toEqual(expect.arrayContaining([sessionId, 'conv-live-acme']));
  });

  it.each([
    ['window send', plain('run the Acme report')],
    ['a delegate brief through the window', plain('Brief: build the Acme page')],
    ['a draft an app prefilled, then sent', plain('open the Acme app')],
    ['typed without own', JSON.stringify({ type: 'user', text: 'hello', typed: true })],
    ['a slash command, even marked', marked('/effort high', '/effort high')],
  ])('not written: %s', async (_row, frame) => {
    const { ws, child } = start();
    ws.emit('message', frame);
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(1));
    expect(ledger.lines).toEqual([]);
  });

  it('not written: a server continue', async () => {
    const { ws, child } = start();
    ws.emit('message', marked(LIMIT_CONTINUE_TEXT, LIMIT_CONTINUE_TEXT));
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(1));
    expect(ledger.lines).toEqual([]);
  });

  it('not written: an answer frame from a question card', async () => {
    const { ws } = start();
    ws.emit('message', JSON.stringify({ type: 'answer', requestId: 'req-1', behavior: 'allow', updatedInput: { answers: { q: 'Option A' } } }));
    await settle();
    expect(ledger.lines).toEqual([]);
  });

  it('a marked frame from the phone mirror is `phone`; one without the mark writes nothing', async () => {
    const { ws, child } = start();
    ws.emit('message', serverBuiltFrameForTests({ type: 'user', text: '> an earlier reply\n\nno, the other one', typed: true, own: 'no, the other one' }, 'phone-mirror'));
    ws.emit('message', serverBuiltFrameForTests({ type: 'user', text: 'not marked' }, 'phone-mirror'));
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(2));
    expect(ledger.lines).toHaveLength(1);
    expect(ledger.lines[0]).toMatchObject({ via: 'phone', own: 'no, the other one' });
  });

  it('a phone frame replayed on another session (a successor) is still `phone`, and written there once', async () => {
    const frame = serverBuiltFrameForTests({ type: 'user', text: 'carry on', typed: true, own: 'carry on' }, 'phone-mirror');
    const next = start();
    next.ws.emit('message', frame);
    await vi.waitFor(() => expect(userFrames(next.child)).toHaveLength(1));
    expect(ledger.lines.map((l) => l.via)).toEqual(['phone']);
  });

  it.each([
    ['a crew server turn', 'crew-server-turn'],
    ['an owner receipt', 'owner-receipt'],
  ] as const)('not written: %s, even carrying a mark', async (_row, origin) => {
    const { ws, child } = start();
    ws.emit('message', serverBuiltFrameForTests({ type: 'user', text: 'Allow once: granted', typed: true, own: 'Allow once: granted' }, origin));
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(1));
    expect(ledger.lines).toEqual([]);
  });

  it('not written: a Telegram frame whose ref this chat did not honour (a non-Super chat)', async () => {
    const { ws, child } = start();
    ws.emit('message', serverBuiltFrameForTests({ type: 'user', text: 'ship it', own: 'ship it' }, 'telegram-injector'));
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(1));
    expect(ledger.lines).toEqual([]);
  });

  it('not written: an injected Telegram card answer (no own)', async () => {
    const { ws, child } = start();
    ws.emit('message', serverBuiltFrameForTests({ type: 'user', text: 'Answer: Option A' }, 'telegram-injector'));
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(1));
    expect(ledger.lines).toEqual([]);
  });

  it('a marked message held for an account switch is written once, with its source, when it is released', async () => {
    accountsState.accounts = [account('main', null, true), account('spare', '/tmp/owner-words-spare', false)];
    accountsState.rejections = { main: { until: Date.now() + 3_600_000, window: 'weekly' } };
    const { ws, child } = start();
    ws.emit('message', marked('ship the Acme build', 'ship the Acme build'));
    await settle();
    // Held: nothing reached the CLI, nothing is in the ledger yet.
    expect(userFrames(child)).toEqual([]);
    expect(ledger.lines).toEqual([]);
    // Nobody restarts: past the stall it goes out here, with the source it arrived with.
    await vi.waitFor(() => expect(userFrames(child)).toEqual(['ship the Acme build']), { timeout: 2_000 });
    expect(ledger.lines).toHaveLength(1);
    expect(ledger.lines[0]).toMatchObject({ via: 'composer', own: 'ship the Acme build' });
    expect(heldOwnerMarkCountForTests()).toBe(0);
  });

  it("a held turn's text resubmitted to the restarted pane takes the source it arrived with, once", async () => {
    const id = randomUUID();
    carryHeldOwnerMark(id, 'devam et', { writes: true, via: 'phone', own: 'devam et' });
    const { ws, child } = start({ sessionId: id });
    ws.emit('message', plain('devam et'));
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(1));
    ws.emit('message', plain('devam et'));
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(2));
    expect(ledger.lines).toHaveLength(1);
    expect(ledger.lines[0]).toMatchObject({ via: 'phone', own: 'devam et' });
  });
});

// ── The phone mirror carries the mark through ───────────────────────────────────────────

class FakeSock extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  ping = vi.fn();
  terminate = vi.fn();
}

describe('phone mirror: mirrorOwnerFrame and the mirror set', () => {
  it('keeps `own` beside the text when the Composer marked it', () => {
    expect(mirrorOwnerFrame(JSON.stringify({ type: 'user', text: '> quote\n\nmine', typed: true, own: 'mine' })))
      .toEqual({ text: '> quote\n\nmine', own: 'mine' });
  });
  it('drops `own` without the mark, and a mark with no words', () => {
    expect(mirrorOwnerFrame(JSON.stringify({ type: 'user', text: 'x', own: 'x' }))).toEqual({ text: 'x' });
    expect(mirrorOwnerFrame(JSON.stringify({ type: 'user', text: 'x', typed: true, own: '  ' }))).toEqual({ text: 'x' });
  });
  it('keeps MIRROR_MAX_TEXT on own as on text', () => {
    expect(mirrorOwnerFrame(JSON.stringify({ type: 'user', text: 'x', typed: true, own: 'y'.repeat(MIRROR_MAX_TEXT + 1) }))).toEqual({ text: 'x' });
    expect(mirrorOwnerFrame(JSON.stringify({ type: 'user', text: 'y'.repeat(MIRROR_MAX_TEXT + 1), typed: true, own: 'y' }))).toBeNull();
  });
  it('still drops slash commands, and a slash own is no mark', () => {
    expect(mirrorOwnerFrame(JSON.stringify({ type: 'user', text: '/model opus', typed: true, own: '/model opus' }))).toBeNull();
    expect(mirrorOwnerFrame(JSON.stringify({ type: 'user', text: 'x', typed: true, own: '/x' }))).toEqual({ text: 'x' });
  });
  it('mirrorOwnerText reads as it always did', () => {
    expect(mirrorOwnerText(JSON.stringify({ type: 'user', text: 'hi', typed: true, own: 'hi' }))).toBe('hi');
    expect(mirrorOwnerText(JSON.stringify({ type: 'answer', requestId: 'r' }))).toBeNull();
  });
  it('the mirror set hands the chat a frame with the mark, never one rebuilt from text alone', () => {
    const got: string[] = [];
    const set = new MirrorSet<string>({ valid: () => true, onOwnerFrame: (raw) => { got.push(raw); }, holder: () => null, key: (d) => d });
    const sock = new FakeSock();
    set.add(sock as never, 'phone-a');
    sock.emit('message', Buffer.from(JSON.stringify({ type: 'user', text: '> reply\n\nok go', typed: true, own: 'ok go' })));
    sock.emit('message', Buffer.from(JSON.stringify({ type: 'user', text: 'plain' })));
    expect(got.map((r) => JSON.parse(r))).toEqual([
      { type: 'user', text: '> reply\n\nok go', typed: true, own: 'ok go' },
      { type: 'user', text: 'plain' },
    ]);
    expect(mirrorUserFrame({ text: 'a' })).toBe(JSON.stringify({ type: 'user', text: 'a' }));
    set.closeAll(4410, 'end');
  });
});

// ── The Telegram hub's own ──────────────────────────────────────────────────────────────

describe("telegramOwnText: only his own words from a Telegram message", () => {
  it('his text', () => {
    expect(telegramOwnText({ text: 'ship the Acme build' }, null)).toBe('ship the Acme build');
  });
  it('a forward is not his', () => {
    expect(telegramOwnText({ text: 'from someone else', forward_origin: { type: 'user' } }, null)).toBe('');
  });
  it('never the quote ("Alıntı") or the replied-to message ("Yanıtlanan mesaj")', () => {
    const own = telegramOwnText({ text: 'yes, that', quote: { text: 'the quoted part' }, reply_to_message: { text: 'an earlier bot message' } }, null);
    expect(own).toBe('yes, that');
    expect(own).not.toContain('quoted part');
    expect(own).not.toContain('earlier bot message');
  });
  it('a voice note is its transcript; with text too, his text first', () => {
    expect(telegramOwnText({}, 'keep the reports short')).toBe('keep the reports short');
    expect(telegramOwnText({ text: 'and in Turkish' }, 'keep the reports short')).toBe('and in Turkish\n\nkeep the reports short');
  });
  it('a file alone (its caption is data, its path is never in own) is nothing', () => {
    expect(telegramOwnText({ caption: 'see this', document: { file_name: 'acme.pdf' } }, null)).toBe('');
  });
});

// ── The Composer: his own words, and the arm the delivery reads ─────────────────────────

describe('composer: ownWords and the typed arm', () => {
  beforeEach(() => { __resetScratchForTests(); });

  it('his words without any chip token (a reply quote, an About block, a picked element, a card, a file)', () => {
    const chip = refToken({ id: 'r1', name: 'Reply to an earlier message', text: '> quoted', kind: 'about' });
    const card = refToken({ id: 'c2', name: 'Acme card', text: '@card:c2 "Acme card"', kind: 'card' });
    const draft = `${chip} not like that ${card} please`;
    const own = ownWords(draft);
    expect(own).toContain('not like that');
    expect(own).toContain('please');
    expect(own).not.toContain('quoted');
    expect(own).not.toContain('@card');
  });

  it('a slash command is no message of his', () => {
    expect(ownWords('/model opus')).toBe('');
  });

  it('the arm is read only for the exact message, and gone after the delivery', () => {
    armTypedSend('[About agenda line 1]\n\nship it', 'ship it');
    expect(typedOwnFor('[About agenda line 1]\n\nship it')).toBe('ship it');
    expect(typedOwnFor('some other text')).toBeNull();
    disarmTypedSend();
    expect(typedOwnFor('[About agenda line 1]\n\nship it')).toBeNull();
  });

  it('an empty own arms nothing', () => {
    armTypedSend('a message', '   ');
    expect(typedOwnFor('a message')).toBeNull();
  });
});

describe('composer and session source: the mark is set only by the Composer own submit', () => {
  it('Composer arms around all three deliveries and never for sendVia or a prefilled draft', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../dashboard/src/components/sleepy/chat/Composer.tsx', import.meta.url), 'utf-8');
    const commit = src.slice(src.indexOf('const commit = (mode: SubmitMode) => {'), src.indexOf('const submit = (mode: SubmitMode'));
    expect(commit).toMatch(/const own = slash \|\| \(prefill && text\.includes\(prefill\)\) \? '' : ownWords\(text\);/);
    // sendVia (a host's own routing) is before any arm.
    expect(commit.indexOf('if (sendVia)')).toBeLessThan(commit.indexOf('deliver(() =>'));
    expect(commit.slice(commit.indexOf('if (sendVia)'), commit.indexOf('if (sendVia)') + 80)).not.toContain('deliver');
    // Both delivery blocks (taken over and here) go through the arm.
    expect(commit.match(/deliver\(\(\) => \{/g)).toHaveLength(2);
    expect(src).toMatch(/prefilledRef\.current = detail\.text\.trim\(\) \|\| null;/);
  });

  it('chatSession writes the mark only from the arm or a marked queue row, never by default', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../dashboard/src/components/sleepy/chatSession.ts', import.meta.url), 'utf-8');
    expect(src).toMatch(/const wire = own \? \{ \.\.\.frame, typed: true as const, own \} : frame;/);
    expect(src).toMatch(/writeUser\(withAbout\(text\), \{ steered: false, own: own \?\? typedOwnFor\(text\) \}\)/);
    expect(src).toMatch(/writeUser\(withAbout\(text\), \{ steered: true, own: own \?\? typedOwnFor\(text\) \}\)/);
    // A resubmitted row never carries one; an edited row loses it.
    expect(src).toMatch(/const own = opts\?\.resubmit \? null : typedOwnFor\(text\);/);
    expect(src).toMatch(/if \(was !== text\) queuedOwn\.delete\(qid\);/);
    // Only the two writeUser calls exist, and only they can set the mark.
    expect(src.match(/writeUser\(/g)).toHaveLength(3); // the definition and the two calls
  });
});
