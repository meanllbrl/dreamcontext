/**
 * Learning loop C3 (D15), criterion 3: the source of every owner turn is decided ONCE, by one
 * classifier in `onWsMessage`, and `writeOwnerTurn` takes it as a required argument. This file
 * holds the table: every frame kind the classifier can see, with the source it must get, and the
 * code's own call sites, so coverage is what the code does, never what a plan claims.
 *
 * Fixtures are synthetic (a fictional project, "Acme"), never the owner's real words.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../src/lib/owner-words.js', () => ({
  appendOwnerTurn: vi.fn(),
  newOwnerTurnId: vi.fn(() => 'turn-fixed'),
  readOwnerTurns: vi.fn(() => []),
  sameConversation: vi.fn(() => false),
  occasion: vi.fn((t: { session: string }) => t.session),
}));

const {
  classifyOwnerFrame, settleOwnerTurnSource, ownerLedgerSurface, ownerTurnLine, silentOwnerTurn,
  carryHeldOwnerMark, takeHeldOwnerMark, heldOwnerMarkCountForTests, ownerFrameOrigin, serverBuiltFrameForTests,
  OWNER_OWN_MAX_CHARS,
} = await import('../../src/server/routes/agent-chat.js');

type Origin = 'socket' | 'phone-mirror' | 'telegram-injector' | 'crew-server-turn' | 'owner-receipt';
type Expect = { via: 'composer' | 'phone' | 'telegram' } | { silent: string } | null;

const marked = (text: string, own: string) => ({ type: 'user', text, typed: true, own });
const plain = (text: string) => ({ type: 'user', text });

/** Every frame kind `onWsMessage` can see, by who built it, with the source it must get. */
const TABLE: Array<{ row: string; origin: Origin; msg: unknown; deviceSocket?: boolean; expect: Expect }> = [
  // The Composer's own submit (send, steer and a queued message all reach the server as this frame).
  { row: 'composer send', origin: 'socket', msg: marked('[About agenda line 3]\n\nship the Acme build', 'ship the Acme build'), expect: { via: 'composer' } },
  { row: 'composer steer (a second marked frame mid-turn)', origin: 'socket', msg: marked('also the docs', 'also the docs'), expect: { via: 'composer' } },
  { row: 'composer queued message (sent at the turn end)', origin: 'socket', msg: marked('then tag it', 'then tag it'), expect: { via: 'composer' } },
  { row: 'composer on a phone socket holding the chat', origin: 'socket', msg: marked('keep it short', 'keep it short'), deviceSocket: true, expect: { via: 'phone' } },
  // Socket frames with no mark: everything the client sends that he did not type in the Composer.
  { row: 'window send', origin: 'socket', msg: plain('run the Acme report'), expect: { silent: 'unmarked' } },
  { row: 'delegate brief through the window', origin: 'socket', msg: plain('Brief: build the Acme page'), expect: { silent: 'unmarked' } },
  { row: 'draft an app prefilled', origin: 'socket', msg: plain('/apps '), expect: { silent: 'unmarked' } },
  { row: 'held replay that lost its mark (account switch resubmit)', origin: 'socket', msg: plain('devam'), expect: { silent: 'unmarked' } },
  { row: 'an MCP grant receipt', origin: 'socket', msg: plain('MCP connected: acme-db'), expect: { silent: 'unmarked' } },
  { row: 'typed with no own', origin: 'socket', msg: { type: 'user', text: 'hi', typed: true }, expect: { silent: 'unmarked' } },
  { row: 'typed with an empty own', origin: 'socket', msg: { type: 'user', text: 'hi', typed: true, own: '   ' }, expect: { silent: 'unmarked' } },
  { row: 'typed with a non-string own', origin: 'socket', msg: { type: 'user', text: 'hi', typed: true, own: 42 }, expect: { silent: 'unmarked' } },
  { row: 'own without typed', origin: 'socket', msg: { type: 'user', text: 'hi', own: 'hi' }, expect: { silent: 'unmarked' } },
  { row: 'typed: "true" (a string) is no mark', origin: 'socket', msg: { type: 'user', text: 'hi', typed: 'true', own: 'hi' }, expect: { silent: 'unmarked' } },
  { row: 'a slash command as own', origin: 'socket', msg: marked('/model opus', '/model opus'), expect: { silent: 'unmarked' } },
  { row: 'own over the cap', origin: 'socket', msg: marked('x', 'x'.repeat(OWNER_OWN_MAX_CHARS + 1)), expect: { silent: 'unmarked' } },
  // The phone's mirror of the Super: the mark decides, the mirror set proves nothing.
  { row: 'phone mirror, marked', origin: 'phone-mirror', msg: marked('> an earlier reply\n\nno, the other one', 'no, the other one'), expect: { via: 'phone' } },
  { row: 'phone mirror, unmarked', origin: 'phone-mirror', msg: plain('no, the other one'), expect: { silent: 'phone-unmarked' } },
  // The Telegram injector: `own` only for a message he wrote.
  { row: 'telegram text with the own the hub passed', origin: 'telegram-injector', msg: { type: 'user', text: 'tg-ref⁠body', own: 'body' }, expect: { via: 'telegram' } },
  { row: 'telegram card tap, rich ask, member pick (no own)', origin: 'telegram-injector', msg: plain('Answer: Option A'), expect: { silent: 'telegram-card' } },
  { row: 'telegram run report or schedule (no own)', origin: 'telegram-injector', msg: plain('Run report: acme nightly'), expect: { silent: 'telegram-card' } },
  // Server turns are never his, whatever they carry.
  { row: 'crew server turn', origin: 'crew-server-turn', msg: plain('Allow once: granted'), expect: { silent: 'crew-server-turn' } },
  { row: 'crew server turn carrying a forged mark', origin: 'crew-server-turn', msg: marked('Allow once', 'Allow once'), expect: { silent: 'crew-server-turn' } },
  { row: 'owner receipt', origin: 'owner-receipt', msg: plain('Card result: approved'), expect: { silent: 'owner-receipt' } },
  { row: 'owner receipt carrying a forged mark', origin: 'owner-receipt', msg: marked('approved', 'approved'), expect: { silent: 'owner-receipt' } },
  // Not an owner turn at all: never reaches `writeOwnerTurn`.
  { row: 'answer frame from a question card', origin: 'socket', msg: { type: 'answer', requestId: 'r1', behavior: 'allow', updatedInput: { answers: { q: 'A' } } }, expect: null },
  { row: 'answer frame on the phone mirror', origin: 'phone-mirror', msg: { type: 'answer', requestId: 'r1', behavior: 'allow' }, expect: null },
  { row: 'interrupt', origin: 'socket', msg: { type: 'interrupt' }, expect: null },
  { row: 'setModel', origin: 'socket', msg: { type: 'setModel', model: 'opus' }, expect: null },
  { row: 'empty user text', origin: 'socket', msg: { type: 'user', text: '', typed: true, own: 'x' }, expect: null },
  { row: 'not an object', origin: 'socket', msg: 'hello', expect: null },
];

describe('classifyOwnerFrame: every frame kind and the source it gets', () => {
  for (const r of TABLE) {
    it(r.row, () => {
      const got = classifyOwnerFrame({ origin: r.origin, msg: r.msg, deviceSocket: r.deviceSocket ?? false });
      if (r.expect === null) { expect(got).toBeNull(); return; }
      if ('via' in r.expect) {
        expect(got).toMatchObject({ writes: true, via: r.expect.via });
      } else {
        expect(got).toEqual({ writes: false, silent: r.expect.silent });
      }
    });
  }

  it('own is only what he typed: never the text that carries the blocks', () => {
    const got = classifyOwnerFrame({ origin: 'socket', msg: marked('[About agenda line 3]\n\n> quoted\n\nship it', '  ship it  ') });
    expect(got).toEqual({ writes: true, via: 'composer', own: 'ship it' });
  });
});

describe('ownerFrameOrigin: who built the frame, by identity', () => {
  it('a frame off the wire is the socket, even when it copies a server frame byte for byte', () => {
    const built = serverBuiltFrameForTests(marked('hi', 'hi'), 'phone-mirror');
    expect(ownerFrameOrigin(built)).toBe('phone-mirror');
    expect(ownerFrameOrigin(Buffer.from(built.toString('utf-8'), 'utf-8'))).toBe('socket');
    expect(ownerFrameOrigin(built.toString('utf-8'))).toBe('socket');
  });

  it('every server origin is kept on the Buffer it built', () => {
    for (const o of ['phone-mirror', 'telegram-injector', 'crew-server-turn', 'owner-receipt'] as const) {
      expect(ownerFrameOrigin(serverBuiltFrameForTests(plain('x'), o))).toBe(o);
    }
  });
});

describe('settleOwnerTurnSource: what writeOwnerTurn writes once the text is parsed', () => {
  const composer = { writes: true as const, via: 'composer' as const, own: 'ship it' };
  const telegram = { writes: true as const, via: 'telegram' as const, own: 'ship it' };
  const base = { text: 'ship it', serverText: false, ledgerChat: true };

  it('a composer turn in a ledger chat is written', () => {
    expect(settleOwnerTurnSource(composer, base)).toEqual(composer);
  });
  it('a chat that keeps no ledger (Assistant, card, app, member) writes nothing', () => {
    expect(settleOwnerTurnSource(composer, { ...base, ledgerChat: false })).toEqual(silentOwnerTurn('not-a-ledger-chat'));
  });
  it('a server continue writes nothing', () => {
    expect(settleOwnerTurnSource(composer, { ...base, serverText: true })).toEqual(silentOwnerTurn('server-continue'));
  });
  it('a slash command writes nothing', () => {
    expect(settleOwnerTurnSource(composer, { ...base, text: '/effort high' })).toEqual(silentOwnerTurn('slash-command'));
  });
  it('a Telegram text whose ref this chat honoured is written', () => {
    expect(settleOwnerTurnSource(telegram, { ...base, telegram: 'telegram-text' })).toEqual(telegram);
  });
  it('a Telegram frame whose ref was not honoured writes nothing', () => {
    expect(settleOwnerTurnSource(telegram, base)).toEqual(silentOwnerTurn('telegram-unconfirmed'));
  });
  it('a run report and a schedule write nothing, whatever the frame said', () => {
    expect(settleOwnerTurnSource(telegram, { ...base, telegram: 'run-report' })).toEqual(silentOwnerTurn('run-report'));
    expect(settleOwnerTurnSource(composer, { ...base, telegram: 'schedule' })).toEqual(silentOwnerTurn('schedule'));
  });
  it('a composer frame that carries an honoured Telegram ref is no composer turn', () => {
    expect(settleOwnerTurnSource(composer, { ...base, telegram: 'telegram-text' })).toEqual(silentOwnerTurn('telegram-unconfirmed'));
  });
  it('a silent source stays silent', () => {
    expect(settleOwnerTurnSource(silentOwnerTurn('crew-server-turn'), base)).toEqual(silentOwnerTurn('crew-server-turn'));
  });
});

describe('ownerLedgerSurface: which chats keep a ledger', () => {
  const chat = { mode: 'plain', isAssistant: false, card: false, app: false, member: false, superChild: false, bridgeTool: null };
  it.each([
    ['plain chat', chat, 'plain'],
    ['Super', { ...chat, mode: 'super' }, 'super'],
    ['Plan', { ...chat, mode: 'plan' }, 'plan'],
    ['Develop', { ...chat, mode: 'develop' }, 'develop'],
    ['a Super child tab', { ...chat, mode: 'develop', superChild: true }, 'child'],
    ['a Codex pane', { ...chat, bridgeTool: 'codex' }, 'codex'],
    ['an Antigravity pane', { ...chat, bridgeTool: 'antigravity' }, 'antigravity'],
    ['the Assistant', { ...chat, mode: 'assistant', isAssistant: true }, null],
    ['a board card', { ...chat, card: true }, null],
    ['an app chat', { ...chat, app: true }, null],
    ["a member's own chat", { ...chat, member: true }, null],
  ] as const)('%s', (_row, input, want) => {
    expect(ownerLedgerSurface(input)).toBe(want);
  });
});

describe('ownerTurnLine', () => {
  it('keeps every id once, drops empty ones, and writes only own', () => {
    const line = ownerTurnLine({
      source: { via: 'composer', own: 'ship it' }, vault: '/tmp/acme', surface: 'super',
      keys: ['pin-1', 'pin-1', '', 'conv-2'], session: 'conv-2', at: '2026-11-13T10:00:00.000Z', turn: 't1',
    });
    expect(line).toEqual({
      at: '2026-11-13T10:00:00.000Z', turn: 't1', vault: '/tmp/acme', surface: 'super', via: 'composer',
      keys: ['pin-1', 'conv-2'], session: 'conv-2', own: 'ship it',
    });
  });
  it('mints a turn id when none is given', () => {
    const line = ownerTurnLine({ source: { via: 'phone', own: 'x' }, vault: '', surface: 'super', keys: [], session: '' });
    expect(line.turn).toBe('turn-fixed');
    expect(typeof line.at).toBe('string');
  });
});

describe('a held turn keeps its source (account switch)', () => {
  const phone = { writes: true as const, via: 'phone' as const, own: 'devam et' };
  it('taken once, by chat and exact text', () => {
    carryHeldOwnerMark('chat-a', 'devam et', phone, 1_000);
    expect(takeHeldOwnerMark('chat-b', 'devam et', 1_001)).toBeNull();
    expect(takeHeldOwnerMark('chat-a', 'devam', 1_001)).toBeNull();
    expect(takeHeldOwnerMark('chat-a', 'devam et', 1_002)).toEqual(phone);
    expect(takeHeldOwnerMark('chat-a', 'devam et', 1_003)).toBeNull();
    expect(heldOwnerMarkCountForTests()).toBe(0);
  });
  it('a silent source is never carried', () => {
    carryHeldOwnerMark('chat-a', 'x', silentOwnerTurn('unmarked'), 1_000);
    expect(heldOwnerMarkCountForTests()).toBe(0);
  });
  it('an entry dies past its time', () => {
    carryHeldOwnerMark('chat-a', 'late', phone, 1_000);
    expect(takeHeldOwnerMark('chat-a', 'late', 1_000 + 16 * 60 * 1000)).toBeNull();
    expect(heldOwnerMarkCountForTests()).toBe(0);
  });
});

// ── The call sites, read from the code itself ──────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT_CHAT = readFileSync(join(ROOT, 'src/server/routes/agent-chat.ts'), 'utf-8');
/** Code lines only: comment lines name the functions too. */
const codeLines = (src: string): string[] => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('writeOwnerTurn: every call names its source', () => {
  it('the source is a required argument', () => {
    expect(AGENT_CHAT).toMatch(/const writeOwnerTurn = \(raw: string, source: OwnerTurnSource\): void =>/);
  });

  it('its call sites are exactly these three, each with a source', () => {
    const calls = codeLines(AGENT_CHAT).filter((l) => l.includes('writeOwnerTurn(')).map((l) => l.trim());
    expect(calls).toEqual([
      "writeOwnerTurn(RESET_CONTINUE_TEXT, silentOwnerTurn('server-continue'));",
      "for (const text of texts) writeOwnerTurn(text, takeHeldOwnerMark(chatRegistryId, text) ?? silentOwnerTurn('held-replay'));",
      'writeOwnerTurn(text, source);',
    ]);
  });

  it('the classifier runs once, in onWsMessage, on the frame and its origin', () => {
    const calls = codeLines(AGENT_CHAT).filter((l) => l.includes('classifyOwnerFrame(') && !l.includes('export function'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('classifyOwnerFrame({ origin: ownerFrameOrigin(raw), msg, deviceSocket: ownerDevice !== null })');
  });

  it('every server-built user frame goes through serverBuiltFrame with its origin', () => {
    const built = codeLines(AGENT_CHAT).filter((l) => l.includes('serverBuiltFrame(') && !l.includes('function serverBuiltFrame') && !l.includes('return serverBuiltFrame('));
    const origins = built.map((l) => /'(phone-mirror|telegram-injector|crew-server-turn|owner-receipt)'/.exec(l)?.[1]).sort();
    expect(origins).toEqual(['crew-server-turn', 'owner-receipt', 'phone-mirror', 'telegram-injector']);
    // No other server code builds a raw user frame Buffer for onWsMessage.
    expect(codeLines(AGENT_CHAT).filter((l) => /Buffer\.from\(JSON\.stringify\(\{ type: 'user'/.test(l))).toEqual([]);
  });

  it('appendOwnerTurn has one caller in the whole server and CLI: writeOwnerTurn (the hook, member threads and runs never write)', () => {
    const callers = walk(join(ROOT, 'src'))
      .filter((p) => !p.endsWith(join('lib', 'owner-words.ts')))
      .flatMap((p) => codeLines(readFileSync(p, 'utf-8')).filter((l) => l.includes('appendOwnerTurn(')).map(() => p.slice(ROOT.length + 1)));
    expect(callers).toEqual(['src/server/routes/agent-chat.ts']);
    const at = AGENT_CHAT.indexOf('appendOwnerTurn(ownerTurnLine(');
    const def = AGENT_CHAT.indexOf('const writeOwnerTurn = (raw: string, source: OwnerTurnSource)');
    const next = AGENT_CHAT.indexOf('\n  };\n', def);
    expect(def).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(def);
    expect(at).toBeLessThan(next);
  });

  it('the answer frame path never reaches writeOwnerTurn', () => {
    const start = AGENT_CHAT.indexOf("if (msg.type === 'answer' && typeof msg.requestId === 'string'");
    expect(start).toBeGreaterThan(0);
    const block = AGENT_CHAT.slice(start, start + 6000);
    const end = block.indexOf("\n    if (msg.type === '", 10);
    expect((end > 0 ? block.slice(0, end) : block)).not.toContain('writeOwnerTurn(');
  });
});
