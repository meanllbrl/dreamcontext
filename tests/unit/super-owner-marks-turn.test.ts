/**
 * Task ajanda-gunluk C5, criterion 9: the owner's hand marks ride his NEXT message to the Super as
 * one `<super-owner-marks>` block (a desktop frame, a Telegram text), once: a slash command, a
 * server continue and a server-written turn carry none and leave them for his next message; after
 * the write only the carried marks clear. Fictional project (synthetic fixtures).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/owner-marks-turn-home-`);
});

const spawned: Array<{ child: FakeChild }> = [];
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4251;
}
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      spawned.push({ child });
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});
vi.mock('../../src/lib/claude-accounts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-accounts.js')>();
  return { ...real, listClaudeAccounts: vi.fn(() => []) };
});
vi.mock('../../src/lib/claude-limit-rejections.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-limit-rejections.js')>();
  return { ...real, readAccountRejections: vi.fn(() => ({})) };
});
vi.mock('../../src/lib/claude-usage-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-usage-probe.js')>();
  const probe = vi.fn(async () => ({ status: 'healthy-unmeasured', reason: 'test' }));
  return { ...real, probeAccountUsage: probe, probeAccountForDecision: probe };
});

const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { startChatSession, continueWithTelegramRef } = await import('../../src/server/routes/agent-chat.js');
const reg = await import('../../src/lib/assistant/chat-registry.js');
const { SUPER_STATE_REL, readSuperState, resetSuperIndex } = await import('../../src/lib/super/store.js');
const { emptySuperState, ownerMsgBlock, partRefs, msgRef, TELEGRAM_OWNER_BLOCK_RE } = await import('../../src/lib/super/types.js');
const { _resetSuperInbox, writeSuper } = await import('../../src/lib/super/inbox.js');
const { applyOwnerMark } = await import('../../src/lib/super/owner-marks.js');
const { RESET_CONTINUE_TEXT } = await import('../../src/lib/resume-at-reset.js');
const { TG_SENTINEL, withTelegramRef, TG_PENDING_REF_TTL_MS } = await import('../../src/lib/telegram/contract.js');
const { parseTranscriptHistory } = await import('../../src/lib/transcript-history.js');
const wc = await import('../../src/lib/window-control.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

const SUPER = '11111111-2222-4333-8444-555555555555';
let project: string;
let root: string;

async function record(state: Record<string, unknown>): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, ...state }));
  await readSuperState(root);
}
function start() {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, project, {
    bypass: false, sessionId: SUPER, resumeId: '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
    account: '', mode: 'super' as never, vault: 'acme',
  });
  return { ws, child: spawned[spawned.length - 1].child };
}
function userFrames(child: FakeChild): string[][] {
  return child.stdin.write.mock.calls
    .map(([chunk]) => { try { return JSON.parse(String(chunk)); } catch { return null; } })
    .filter((f) => f?.type === 'user')
    .map((f) => (f.message.content as Array<{ text: string }>).map((b) => b.text));
}
const ownerBlock = (frame: string[]) => frame.find((t) => t.startsWith('<owner-msg ')) ?? null;
const metas = (ws: FakeWs) => ws.send.mock.calls
  .map(([raw]) => { try { return JSON.parse(String(raw)); } catch { return null; } })
  .filter((f) => f?.type === '_meta');
const result = (child: FakeChild) => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success' })}\n`));
const owner = (ws: FakeWs, text: string) => ws.emit('message', JSON.stringify({ type: 'user', text }));
const entry = { updateId: 1, at: Date.now(), written: false, kind: 'text' as const };

beforeEach(() => {
  spawned.length = 0;
  project = mkdtempSync(join(tmpdir(), 'owner-marks-turn-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  reg._resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
});
afterEach(() => {
  _resetSuperInbox();
  rmSync(project, { recursive: true, force: true });
  vi.useRealTimers();
});

const marksBlock = (frame: string[]) => frame.find((t) => t.startsWith('<super-owner-marks')) ?? null;
async function mark(key: string, text = 'Acme deploy'): Promise<void> {
  await writeSuper(root, (s) => { applyOwnerMark(s, { key, kind: 'pad-status', text, from: 'in-progress', to: 'done', at: Date.now() }); });
}

describe('the hand marks ride his next message', () => {
  it('a desktop message carries them once; the next carries none; they clear on disk', async () => {
    await record({ enabled: true });
    const { ws, child } = start();
    await mark('pad:n1');
    owner(ws, 'Acme: what next?');
    owner(ws, 'and the logo?');
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(2), { timeout: 10_000 });
    const [a, b] = userFrames(child);
    expect(marksBlock(a)).toContain('pad:n1');
    expect(marksBlock(b)).toBeNull();
    await vi.waitFor(async () => expect((await readSuperState(root)).ownerMarks).toBeUndefined(), { timeout: 10_000 });
  });

  it('a slash command, a server continue and a server-written turn carry none; his next real message does', async () => {
    await record({ enabled: true });
    const { ws, child } = start();
    await mark('pad:n2');
    owner(ws, '/model sonnet');
    owner(ws, RESET_CONTINUE_TEXT);
    owner(ws, '[ran in chat] npm test: exit 0');
    owner(ws, 'Acme status?');
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(4), { timeout: 10_000 });
    const frames = userFrames(child);
    expect(frames.slice(0, 3).map(marksBlock)).toEqual([null, null, null]);
    expect(marksBlock(frames[3])).toContain('pad:n2');
  });

  it('a Telegram text carries them', async () => {
    await record({ enabled: true });
    const { child } = start();
    await mark('pad:n3');
    const inj = reg.chatInjector(SUPER)!;
    reg.telegramRefs.put(SUPER, 'tg0m01', entry);
    await inj.sendOwnerText(withTelegramRef('tg0m01', 'Acme from the phone'), { ref: 'tg0m01', source: 'telegram-text' });
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(1), { timeout: 10_000 });
    expect(marksBlock(userFrames(child)[0])).toContain('pad:n3');
  });

  it('a mark made after the block was built stays for the next message', async () => {
    await record({ enabled: true });
    const { ws, child } = start();
    await mark('pad:n4');
    owner(ws, 'first');
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(1), { timeout: 10_000 });
    await mark('pad:n5');
    await vi.waitFor(async () => expect((await readSuperState(root)).ownerMarks?.map((m) => m.key)).toEqual(['pad:n5']), { timeout: 10_000 });
    owner(ws, 'second');
    await vi.waitFor(() => expect(userFrames(child)).toHaveLength(2), { timeout: 10_000 });
    expect(marksBlock(userFrames(child)[1])).toContain('pad:n5');
    expect(marksBlock(userFrames(child)[1])).not.toContain('pad:n4');
  });
});
