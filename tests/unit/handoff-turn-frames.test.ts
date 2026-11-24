/**
 * D3 (super-cocuk-tasarruf), criterion 5: nothing the owner sends during a handoff turn is lost.
 * While this pane's TASK handoff record is pending, a user frame written mid-turn would fold into
 * the old conversation (or run as its own turn after the result) and the rotation's `/clear` would
 * wipe it. The bridge holds it and releases it ONCE at the turn's end, through the same admission
 * a fresh socket frame takes: after `/clear` and the continue prompt when the pane rotates, to the
 * live conversation when it does not (a throw, a Stop with no result).
 *
 * Driven through the real `startChatSession` socket path with a fake CLI child (the harness of
 * agent-chat-rotated-hold.test.ts). Fixtures are synthetic: a fictional "Acme" project.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-handoff-frames-home-'));
});

const flags = vi.hoisted(() => ({ digestThrows: false }));

const spawned: FakeChild[] = [];
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4646;
  print(obj: unknown): void { this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')); }
  /** Every stdin frame, parsed. */
  frames(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const [raw] of this.stdin.write.mock.calls) {
      for (const line of String(raw).split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* not a frame */ }
      }
    }
    return out;
  }
  /** The text of every USER frame written to stdin, in order. */
  userTexts(): string[] {
    return this.frames().filter((f) => f.type === 'user').map((f) => {
      const content = (f.message as { content?: unknown } | undefined)?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map((c) => (c as { text?: string }).text ?? '').join('');
      return '';
    });
  }
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

vi.mock('../../src/server/routes/agent-spawn-shared.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/server/routes/agent-spawn-shared.js')>();
  return { ...real, claudeConversationExists: () => true };
});

vi.mock('../../src/lib/super/resume-digest.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/super/resume-digest.js')>();
  return {
    ...real,
    withResumeDigest: (...a: Parameters<typeof real.withResumeDigest>) => {
      if (flags.digestThrows) throw new Error('acme: digest failed');
      return real.withResumeDigest(...a);
    },
  };
});

const { startChatSession } = await import('../../src/server/routes/agent-chat.js');
const { crewHandle, onChatUserSent } = await import('../../src/lib/assistant/chat-registry.js');
const { noteSuperSend, takeSuperSend, _resetSuperSends } = await import('../../src/lib/super/owner-wait.js');
const { writeHandoffRecord, readHandoffRecord } = await import('../../src/lib/context-watch.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
  ping = vi.fn(() => { this.emit('pong'); });
  terminate = vi.fn(() => { this.readyState = 3; this.emit('close'); });
}

const PIN = '4e5f6071-8293-4a4b-9c5d-6e7f80910a1b';
let projectRoot: string;
let contextRoot: string;

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function open(o: { crew?: boolean } = {}): { ws: FakeWs; child: FakeChild } {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, projectRoot, {
    bypass: false, sessionId: '', resumeId: PIN, model: '', effort: '', mode: 'basic', account: '',
    initialPrompt: '', deferPrompt: false, vault: 'acme-vault', ...(o.crew ? { leanMcp: [] as string[] } : {}),
  });
  const child = spawned[spawned.length - 1];
  child.print({ type: 'system', subtype: 'init', session_id: PIN, model: 'claude-opus-5-5', cwd: projectRoot });
  return { ws, child };
}

/** The owner types in the Composer (a marked frame, as the client sends it). */
const say = (ws: FakeWs, text: string) => ws.emit('message', JSON.stringify({ type: 'user', text, typed: true, own: text }));

/** The agent ran `dreamcontext tasks handoff` in this turn: a pending task record for the pane. */
const pendingRecord = () => writeHandoffRecord(contextRoot, PIN, {
  task: 'acme-build', title: 'Acme build', at: new Date().toISOString(), contextTokens: 120_000, fromSession: PIN, tab: null,
});

const result = (child: FakeChild, extra: Record<string, unknown> = {}) =>
  child.print({ type: 'result', subtype: 'success', is_error: false, ...extra });

const count = (texts: string[], t: string) => texts.filter((x) => x === t).length;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-handoff-frames-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  spawned.length = 0;
  flags.digestThrows = false;
  _resetSuperSends();
});

afterEach(() => {
  for (const c of spawned) c.emit('close', 0);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('a frame sent during a handoff turn', () => {
  it('with no pending record is written at once (the hold changes nothing else)', async () => {
    const { ws, child } = open();
    say(ws, 'build the Acme page');
    await settle();
    say(ws, 'also the footer');
    await settle();
    expect(child.userTexts()).toEqual(['build the Acme page', 'also the footer']);
  });

  it('is held until the turn ends, then written once after /clear and the continue prompt; two keep their order', async () => {
    const { ws, child } = open();
    say(ws, 'build the Acme page');
    await settle();
    pendingRecord();
    say(ws, 'use the blue header');
    await settle();
    say(ws, 'and the wide logo');
    await settle();
    // Mid-turn: neither reached the old conversation.
    expect(child.userTexts()).toEqual(['build the Acme page']);

    result(child);
    await settle(60);
    const texts = child.userTexts();
    expect(texts[0]).toBe('build the Acme page');
    expect(texts[1]).toBe('/clear');
    expect(texts[2]).toContain('acme-build');
    expect(texts.slice(3)).toEqual(['use the blue header', 'and the wide logo']);
    expect(count(texts, 'use the blue header')).toBe(1);
    expect(readHandoffRecord(contextRoot, PIN)?.actedAt).toBeTruthy();

    // Released frames are never held again: the next results write nothing more of them.
    result(child);
    result(child);
    await settle();
    expect(count(child.userTexts(), 'use the blue header')).toBe(1);
    expect(count(child.userTexts(), 'and the wide logo')).toBe(1);
  });

  it('a frame after the release is written behind the released ones', async () => {
    const { ws, child } = open();
    say(ws, 'build the Acme page');
    await settle();
    pendingRecord();
    say(ws, 'use the blue header');
    await settle();
    result(child);
    say(ws, 'then ship it');
    await settle(60);
    const texts = child.userTexts();
    expect(texts.indexOf('use the blue header')).toBeGreaterThan(texts.indexOf('/clear'));
    expect(texts.indexOf('then ship it')).toBeGreaterThan(texts.indexOf('use the blue header'));
    expect(count(texts, 'then ship it')).toBe(1);
  });

  it('a record a resume banner already consumed (consumedAt, no actedAt) holds nothing', async () => {
    const { ws, child } = open();
    say(ws, 'build the Acme page');
    await settle();
    writeHandoffRecord(contextRoot, PIN, {
      task: 'acme-build', title: 'Acme build', at: new Date().toISOString(), contextTokens: 120_000, fromSession: PIN, tab: null,
      consumedAt: new Date().toISOString(),
    });
    say(ws, 'use the blue header');
    await settle();
    expect(child.userTexts()).toEqual(['build the Acme page', 'use the blue header']);
  });

  it('a rotation that throws writes the held frames to the live conversation, once', async () => {
    flags.digestThrows = true;
    const { ws, child } = open();
    say(ws, 'build the Acme page');
    await settle();
    pendingRecord();
    say(ws, 'use the blue header');
    await settle();
    expect(child.userTexts()).toEqual(['build the Acme page']);

    result(child);
    await settle(60);
    const texts = child.userTexts();
    expect(count(texts, 'use the blue header')).toBe(1);
    expect(texts[texts.length - 1]).toBe('use the blue header');
  });

  it('a Stop the CLI acks with no result releases the held frames at the settle, once, in order', async () => {
    const { ws, child } = open();
    say(ws, 'build the Acme page');
    await settle();
    pendingRecord();
    say(ws, 'use the blue header');
    await settle();
    say(ws, 'and the wide logo');
    await settle();

    ws.emit('message', JSON.stringify({ type: 'interrupt' }));
    await settle();
    const req = child.frames().find((f) => f.type === 'control_request' && (f.request as { subtype?: string } | undefined)?.subtype === 'interrupt');
    expect(req).toBeTruthy();
    child.print({ type: 'control_response', response: { subtype: 'success', request_id: req!.request_id } });
    expect(child.userTexts()).toEqual(['build the Acme page']);

    // The settle waits the watchdog window for a real abort `result` (INTERRUPT_WATCHDOG_MS).
    await settle(5_400);
    const texts = child.userTexts();
    expect(texts.slice(1)).toEqual(['use the blue header', 'and the wide logo']);
  }, 10_000);

  // A frame leaves the hold with every mark it came in with (round 1, held-frame-keeps-its-delivery-marks).
  it('an owner card receipt held past its 30 s proof window still resolves as seen, written once after /clear', async () => {
    const { ws, child } = open({ crew: true });
    say(ws, 'build the Acme page');
    await settle();
    pendingRecord();
    const handle = crewHandle(PIN);
    expect(handle?.sendOwnerReceipt).toBeTruthy();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let seen: boolean | null = null;
    try {
      const receiptText = 'Card acme-run-1: Approved by the owner';
      void handle!.sendOwnerReceipt!(receiptText, { kind: 'run', id: 'acme-run-1' }).then((ok) => { seen = ok; });
      await vi.advanceTimersByTimeAsync(31_000);
      // Held, and NOT timed out to "not seen" (the inbox would resend it).
      expect(seen).toBeNull();
      expect(count(child.userTexts(), receiptText)).toBe(0);
      result(child);
      await vi.advanceTimersByTimeAsync(200);
      expect(seen).toBe(true);
      const texts = child.userTexts();
      expect(count(texts, receiptText)).toBe(1);
      expect(texts.indexOf(receiptText)).toBeGreaterThan(texts.indexOf('/clear'));
    } finally {
      vi.useRealTimers();
    }
  });

  it("the Super's send note taken at the hold is back for the released frame (the registry reads it as the Super's)", async () => {
    const sent: Array<{ text: string; server: boolean }> = [];
    const off = onChatUserSent((sid, text, _source, server) => { if (sid === PIN) sent.push({ text, server }); });
    try {
      const { ws, child } = open();
      say(ws, 'build the Acme page');
      await settle();
      pendingRecord();
      noteSuperSend(PIN, 'Super: also add the Acme footer');
      ws.emit('message', JSON.stringify({ type: 'user', text: 'Super: also add the Acme footer' }));
      await settle();
      expect(child.userTexts()).toEqual(['build the Acme page']);
      // Taken while held: nothing left for a stray reader in the meantime.
      expect(takeSuperSend(PIN, 'Super: also add the Acme footer')).toBe(false);
      result(child);
      await settle(60);
      expect(count(child.userTexts(), 'Super: also add the Acme footer')).toBe(1);
      // Released, it is still the Super's send (server-attributed), never his words.
      expect(sent.find((x) => x.text === 'Super: also add the Acme footer')?.server).toBe(true);
      expect(sent.find((x) => x.text === 'build the Acme page')?.server).toBe(false);
    } finally {
      off();
    }
  });
});
